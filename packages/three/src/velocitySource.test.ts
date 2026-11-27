import { describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import { velocity, vec4 } from 'three/tsl';
import type * as THREE from 'three/webgpu';

// GPU-free: the Upscaler (device, pipelines, textures) is replaced by a stub, so
// only the surfaces' own three objects — plain JS until a renderer touches them
// — are exercised.
vi.mock('./Upscaler', () => ({
    Upscaler: class {
        readonly unjitteredProjectionMatrix = new Matrix4();
        readonly isReady = true;
        init = vi.fn();
        dispose = vi.fn();
        beginFrame = vi.fn();
        endFrame = vi.fn();
        dispatch = vi.fn();
        configure = vi.fn();
    },
}));

const { resolveVelocitySource } = await import('./velocitySource');
const { UpscalePass } = await import('./UpscalePass');
const { UpscalerNode, upscaleScene } = await import('./UpscalerNode');

/** A stand-in for `MotionVectors.for(renderer)`: a node plus projection + frame hooks. */
function producer() {
    return { velocity: vec4(0), projectionMatrix: null as Matrix4 | null, beginFrame: vi.fn() };
}

describe('resolveVelocitySource', () => {
    it("defaults to three's velocity and pins its projection", () => {
        const spy = vi.spyOn(velocity as unknown as { setProjectionMatrix(m: Matrix4 | null): void }, 'setProjectionMatrix');
        const resolved = resolveVelocitySource();
        const matrix = new Matrix4();
        resolved.setProjection(matrix);
        expect(resolved.node).toBe(velocity);
        expect(spy).toHaveBeenLastCalledWith(matrix);
        spy.mockRestore();
    });

    it("sets a producer's projectionMatrix and drives its beginFrame", () => {
        const source = producer();
        const resolved = resolveVelocitySource(source);
        const matrix = new Matrix4();
        resolved.setProjection(matrix);
        resolved.beginFrame();
        expect(resolved.node).toBe(source.velocity);
        expect(source.projectionMatrix).toBe(matrix);
        expect(source.beginFrame).toHaveBeenCalledTimes(1);
        resolved.setProjection(null);
        expect(source.projectionMatrix).toBeNull();
    });

    it('takes a plain node as is: no projection hook, no frame', () => {
        const node = vec4(1);
        const resolved = resolveVelocitySource(node);
        expect(resolved.node).toBe(node);
        expect(() => resolved.setProjection(new Matrix4())).not.toThrow();
        expect(() => resolved.beginFrame()).not.toThrow();
    });

    it('rejects anything else', () => {
        expect(() => resolveVelocitySource({} as never)).toThrow(TypeError);
        expect(() => resolveVelocitySource({ velocity: 1 } as never)).toThrow(/velocityNode/);
    });
});

describe('UpscalePass velocityNode', () => {
    type Internals = { _mrtFull: { outputNodes: Record<string, unknown> }; _rt: unknown; _path: string };

    function drawOnce(pass: InstanceType<typeof UpscalePass>, path: 'temporal' | 'spatial', calls: string[]) {
        const target = { textures: [{}, {}], depthTexture: {} };
        Object.assign(pass as unknown as Internals, { _rt: target, _path: path });
        pass.draw({} as THREE.Scene, {} as THREE.PerspectiveCamera, 1 / 60);
        return calls;
    }

    function stubRenderer(calls: string[]) {
        return {
            setMRT: vi.fn(),
            setRenderTarget: vi.fn(),
            render: vi.fn(() => calls.push('render')),
        } as unknown as THREE.WebGPURenderer;
    }

    it("keeps three's velocity under the name 'velocity' by default", () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        expect((pass as unknown as Internals)._mrtFull.outputNodes.velocity).toBe(velocity);
    });

    it("writes a producer's node as 'velocity', pins its projection and begins one frame per temporal draw", () => {
        const calls: string[] = [];
        const source = producer();
        source.beginFrame.mockImplementation(() => calls.push('beginFrame'));
        const pass = new UpscalePass(stubRenderer(calls), { velocityNode: source });
        const outputs = (pass as unknown as Internals)._mrtFull.outputNodes;
        expect(Object.keys(outputs)).toEqual(['output', 'velocity']);
        expect(outputs.velocity).toBe(source.velocity);
        expect(source.projectionMatrix).toBe(pass.upscaler.unjitteredProjectionMatrix);

        expect(drawOnce(pass, 'temporal', calls)).toEqual(['beginFrame', 'render']);
        calls.length = 0;
        expect(drawOnce(pass, 'spatial', calls)).toEqual(['render']);
    });

    it('leaves the projection alone with shareVelocityMatrix: false', () => {
        const source = producer();
        new UpscalePass({} as THREE.WebGPURenderer, { velocityNode: source, shareVelocityMatrix: false });
        expect(source.projectionMatrix).toBeNull();
    });
});

describe('UpscalerNode velocityNode', () => {
    type NodeInternals = {
        _upscaler: unknown;
        _setJitterActive(active: boolean): void;
        _configured: boolean;
        _pipelineHooks: { before(): void; after(): void };
    };

    it('hands the producer the unjittered projection while jittering and null on a view-offset conflict', () => {
        const source = producer();
        const node = new UpscalerNode(null, null, null, {}, { velocityNode: source });
        const internals = node as unknown as NodeInternals;
        const upscaler = { unjitteredProjectionMatrix: new Matrix4(), configure: vi.fn() };
        internals._upscaler = upscaler;
        internals._setJitterActive(false);
        expect(source.projectionMatrix).toBeNull();
        internals._setJitterActive(true);
        expect(source.projectionMatrix).toBe(upscaler.unjitteredProjectionMatrix);
    });

    it('begins one producer frame per pipeline frame', () => {
        const source = producer();
        const node = new UpscalerNode(null, null, null, {}, { velocityNode: source });
        const internals = node as unknown as NodeInternals;
        internals._upscaler = {
            isReady: true,
            beginFrame: vi.fn(),
            endFrame: vi.fn(),
            jitter: { x: 0, y: 0 },
        };
        internals._configured = true;
        internals._pipelineHooks.before();
        internals._pipelineHooks.before(); // a duplicate registration: still one frame
        internals._pipelineHooks.after();
        expect(source.beginFrame).toHaveBeenCalledTimes(1);
    });

    it("upscaleScene writes the producer's node as the pass's 'velocity' output", () => {
        const source = producer();
        const node = upscaleScene({}, { isCamera: true }, { velocityNode: source });
        const passNode = (node as unknown as { _velocity: { passNode: { getMRT(): { outputNodes: Record<string, unknown> } } } })
            ._velocity.passNode;
        const outputs = passNode.getMRT().outputNodes;
        expect(Object.keys(outputs)).toEqual(['output', 'velocity']);
        expect(outputs.velocity).toBe(source.velocity);
    });

    it("upscaleScene keeps three's velocity by default", () => {
        const node = upscaleScene({}, { isCamera: true });
        const passNode = (node as unknown as { _velocity: { passNode: { getMRT(): { outputNodes: Record<string, unknown> } } } })
            ._velocity.passNode;
        expect(passNode.getMRT().outputNodes.velocity).toBe(velocity);
    });
});
