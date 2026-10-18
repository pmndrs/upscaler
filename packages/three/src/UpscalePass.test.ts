import { describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import type * as THREE from 'three/webgpu';

// GPU-free: the Upscaler (device, pipelines, textures) is replaced by a stub, so
// only UpscalePass's own three objects — plain JS until a renderer touches
// them — are exercised.
vi.mock('./Upscaler', () => ({
    Upscaler: class {
        readonly unjitteredProjectionMatrix = new Matrix4();
        init = vi.fn();
        dispose = vi.fn();
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
