import { describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import type * as THREE from 'three/webgpu';

// GPU-free: the Upscaler (device, pipelines, textures) is replaced by a stub, so
// only UpscalePass's own three objects — plain JS until a renderer touches
// them — are exercised.
vi.mock('./Upscaler', () => ({
    Upscaler: class {
        readonly unjitteredProjectionMatrix = new Matrix4();
        readonly isReady = true;
        init = vi.fn();
        dispose = vi.fn();
        beginFrame = vi.fn();
        endFrame = vi.fn();
        dispatch = vi.fn();
    },
}));

const { UpscalePass } = await import('./UpscalePass');

type PassInternals = {
    _quad: THREE.QuadMesh;
    _quadMaterial: THREE.NodeMaterial;
    _rt: THREE.RenderTarget | null;
};

describe('UpscalePass.dispose', () => {
    it('disposes the present material, the render target and the upscaler', () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        const internals = pass as unknown as PassInternals;
        const materialDisposed = vi.fn();
        internals._quadMaterial.addEventListener('dispose', materialDisposed);
        const rtDispose = vi.fn();
        internals._rt = { dispose: rtDispose } as unknown as THREE.RenderTarget;

        pass.dispose();

        expect(materialDisposed).toHaveBeenCalledTimes(1);
        expect(rtDispose).toHaveBeenCalledTimes(1);
        expect(internals._rt).toBeNull();
        expect(pass.upscaler.dispose).toHaveBeenCalledTimes(1);
    });

    it("leaves three's shared quad geometry alone", () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        const geometryDisposed = vi.fn();
        (pass as unknown as PassInternals)._quad.geometry.addEventListener('dispose', geometryDisposed);

        pass.dispose();

        expect(geometryDisposed).not.toHaveBeenCalled();
    });
});

describe('UpscalePass.setResetSignal', () => {
    // A draw against stub renderer/upscaler objects: records the call order.
    function drawOnce(
        path: 'temporal' | 'spatial',
        signal: Parameters<InstanceType<typeof UpscalePass>['setResetSignal']>[0],
        clearAfterSet = false,
    ) {
        const calls: string[] = [];
        const renderer = {
            setMRT: vi.fn(),
            setRenderTarget: vi.fn(),
            render: vi.fn(() => calls.push('render')),
        } as unknown as THREE.WebGPURenderer;
        const pass = new UpscalePass(renderer, { shareVelocityMatrix: false });
        const target = { textures: [{}, {}], depthTexture: {} } as unknown as THREE.RenderTarget;
        Object.assign(pass as unknown as { _rt: unknown; _path: string }, { _rt: target, _path: path });
        const upscaler = pass.upscaler as unknown as Record<string, ReturnType<typeof vi.fn>>;
        upscaler.endFrame.mockImplementation(() => calls.push('endFrame'));
        upscaler.dispatch.mockImplementation(() => calls.push('dispatch'));
        const update = vi.fn((_target: THREE.RenderTarget, _camera: THREE.Camera) => calls.push('update'));
        if (signal) pass.setResetSignal({ ...signal, update: (...args) => { update(...args); signal.update(...args); } });
        if (clearAfterSet) pass.setResetSignal(null);
        pass.draw({} as THREE.Scene, {} as THREE.PerspectiveCamera, 1 / 60);
        return { calls, update, inputs: upscaler.dispatch.mock.calls[0]?.[0], target };
    }
    const flag = {} as THREE.Texture;

    it('runs the producer between the render and endFrame, and passes its texture', () => {
        const { calls, update, inputs, target } = drawOnce('temporal', { texture: flag, update: () => {} });
        expect(calls).toEqual(['render', 'update', 'endFrame', 'dispatch']);
        expect(update.mock.calls[0]?.[0]).toBe(target);
        expect(inputs.resetTexture).toBe(flag);
    });

    it('clears texture and producer together', () => {
        const { calls, update, inputs } = drawOnce('temporal', { texture: flag, update: () => {} }, true);
        expect(calls).toEqual(['render', 'endFrame', 'dispatch']);
        expect(update).not.toHaveBeenCalled();
        expect(inputs.resetTexture).toBeUndefined();
    });

    it('skips both off the temporal path', () => {
        const { update, inputs } = drawOnce('spatial', { texture: flag, update: () => {} });
        expect(update).not.toHaveBeenCalled();
        expect(inputs.resetTexture).toBeUndefined();
    });
});
