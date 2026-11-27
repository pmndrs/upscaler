import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, PerspectiveCamera } from 'three';
import { texture } from 'three/tsl';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler';
import { upscale } from './UpscalerNode';
import { generateJitterSequence } from '@pmndrs/upscaler-core/math/halton';
import type { UpscalePath } from './types';

//* Mock Renderer — answers every create* call with a stub (shape of
// Upscaler.timing.test.ts) plus the texture plumbing configure() needs, so the
// jitter contract is testable without a GPU (issue #68).

function mockRenderer() {
    const writes: Float32Array[] = [];
    const resource = (descriptor: { size?: number } = {}) => ({
        getBindGroupLayout: () => ({}),
        createView: () => ({}),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4),
        unmap: () => {},
        destroy: () => {},
    });
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        // Below the every-texel metering's 256 invocations: the taps meter at
        // every size, and no downsampler pipeline is built.
        limits: { maxComputeInvocationsPerWorkgroup: 128, maxComputeWorkgroupSizeX: 128, maxBindGroups: 4 },
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Float32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: resource,
    };
    const backing = new WeakMap<object, object>();
    const renderer = {
        backend: {
            device,
            get: (texture: object) => {
                if (!backing.has(texture)) backing.set(texture, { texture: resource() });
                return backing.get(texture);
            },
        },
        initTexture: () => {},
    } as unknown as WebGPURenderer;
    return { renderer, writes };
}

async function configured(path: UpscalePath = 'temporal', jitter = true) {
    const { renderer, writes } = mockRenderer();
    const upscaler = new Upscaler({ renderer });

    upscaler.configure({ displayWidth: 1280, displayHeight: 720, customUpscaleRatio: 2, path, jitter });
    await upscaler.init();
    return { upscaler, writes };
}

// One dispatched frame in the imperative order (begin → render → end →
// dispatch). The mock can't encode passes, but dispatch() has staged its
// constants — and counted the frame — before it throws.
function realFrame(upscaler: Upscaler, cam: PerspectiveCamera): void {
    upscaler.beginFrame(cam);
    upscaler.endFrame(cam);
    try {
        upscaler.dispatch({ color: {}, depth: {}, velocity: {} } as never, cam);
    } catch {
        // Encoding needs a real device.
    }
}

const camera = () => {
    const c = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    c.updateMatrixWorld();
    return c;
};

describe('Upscaler jitter accessors', async () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('follows generateJitterSequence over a full cycle, phase by phase', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        let previous = sequence[0];
        for (let frame = 1; frame <= upscaler.jitterPhaseCount; frame++) {
            realFrame(upscaler, cam);
            // beginFrame advances before applying: phase 1 first, 0 closes the cycle.
            expect(upscaler.jitterPhase).toBe(frame % upscaler.jitterPhaseCount);
            const [x, y] = sequence[upscaler.jitterPhase];
            expect(upscaler.jitter).toEqual({ x, y });
            expect(upscaler.jitterPrevious).toEqual({ x: previous[0], y: previous[1] });
            previous = [x, y];
        }
    });

    it('matches the offset beginFrame applies to the camera view', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        upscaler.beginFrame(cam);
        expect(cam.view?.offsetX).toBe(upscaler.jitter.x);
        expect(cam.view?.offsetY).toBe(upscaler.jitter.y);
        upscaler.endFrame(cam);
    });

    it('reports the pure jitter under an app-set view offset', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        // A tiled setup: this camera renders the right half of a 2× wider wall
        // at twice the render resolution, so one render pixel is 2 view units.
        cam.setViewOffset(2560, 720, 1280, 0, 1280, 720);
        upscaler.beginFrame(cam);
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        const [x, y] = sequence[upscaler.jitterPhase];
        expect(upscaler.jitter).toEqual({ x, y });
        // The camera carries app offset + scaled jitter; the getter does not.
        expect(cam.view?.offsetX).toBeCloseTo(1280 + (x * 1280) / 640);
        upscaler.endFrame(cam);
        expect(cam.view?.offsetX).toBe(1280);
    });

    it('agrees with the jitter staged into the constants buffer', async () => {
        const { upscaler, writes } = await configured();
        const cam = camera();
        upscaler.beginFrame(cam);
        writes.length = 0;
        // The constants upload runs before any GPU texture lookup in dispatch.
        try {
            upscaler.dispatchGuides({ depth: {} as never, velocity: {} as never }, cam);
        } catch {
            // The mock can't encode passes; the constants were already written.
        }
        const constants = writes.find((data) => data.length === 64);
        expect(constants).toBeDefined();
        // Exposure reads the fixed metering bound from the final reserved UBO slot.
        expect(new Uint32Array(constants!.buffer)[23]).toBe(32);
        expect([constants![8], constants![9]]).toEqual([
            Math.fround(upscaler.jitter.x),
            Math.fround(upscaler.jitter.y),
        ]);
        expect([constants![10], constants![11]]).toEqual([
            Math.fround(upscaler.jitterPrevious.x),
            Math.fround(upscaler.jitterPrevious.y),
        ]);
    });

    it('restarts the phase on resetHistory()', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        for (let i = 0; i < 5; i++) realFrame(upscaler, cam);
        expect(upscaler.jitterPhase).toBe(5);
        upscaler.resetHistory();
        upscaler.beginFrame(cam);
        expect(upscaler.jitterPhase).toBe(1);
        upscaler.endFrame(cam);
    });

    it.each([
        ['temporal with jitter: false', 'temporal', false],
        ['spatial', 'spatial', true],
        ['bilinear', 'bilinear', true],
    ] as const)('reads (0, 0) and phase 0 on %s', async (_label, path, jitter) => {
        const { upscaler } = await configured(path, jitter);
        const cam = camera();
        upscaler.beginFrame(cam);
        expect(upscaler.jitter).toEqual({ x: 0, y: 0 });
        expect(upscaler.jitterPrevious).toEqual({ x: 0, y: 0 });
        expect(upscaler.jitterPhase).toBe(0);
        expect(cam.view).toBeNull();
        upscaler.endFrame(cam);
    });

    // Issue #92: an on-demand app's overlay-only redraw begins and ends a
    // frame (the TSL node's pipeline hooks fire) without dispatching.
    it('reuses a held frame\'s phase and restores the camera after it', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        cam.setViewOffset(2560, 720, 1280, 0, 1280, 720);
        for (let i = 0; i < 3; i++) realFrame(upscaler, cam);
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        for (let held = 0; held < 4; held++) {
            upscaler.beginFrame(cam);
            expect(upscaler.jitterPhase).toBe(4);
            expect(upscaler.jitterPrevious).toEqual({ x: sequence[3][0], y: sequence[3][1] });
            upscaler.endFrame(cam);
            expect(cam.view).toMatchObject({ offsetX: 1280, offsetY: 0, width: 1280, height: 720 });
        }
        realFrame(upscaler, cam);
        expect(upscaler.jitterPhase).toBe(4);
        expect(upscaler.jitterPrevious).toEqual({ x: sequence[3][0], y: sequence[3][1] });
        realFrame(upscaler, cam);
        expect(upscaler.jitterPhase).toBe(5);
    });

    it('refreshes the unjittered projection on the frame after a hold', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        realFrame(upscaler, cam);
        upscaler.beginFrame(cam); // held
        upscaler.endFrame(cam);
        cam.fov = 70;
        upscaler.beginFrame(cam);
        const unjittered = cam.clone();
        unjittered.clearViewOffset();
        unjittered.updateProjectionMatrix();
        expect(upscaler.unjitteredProjectionMatrix.elements).toEqual(unjittered.projectionMatrix.elements);
        upscaler.endFrame(cam);
    });

    // The TSL node path: RenderPipeline.render() fires the node's before/after
    // hooks every render; a held render skips updateBefore (no dispatch).
    it('keeps the node\'s pipeline hooks gapless across held renders', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        const node = upscale(texture(new DataTexture()), texture(new DataTexture()), texture(new DataTexture()), cam);
        const internals = node as unknown as {
            _upscaler: Upscaler;
            _configured: boolean;
            _pipelineHooks: { before(): void; after(): void };
        };
        internals._upscaler = upscaler;
        internals._configured = true;
        const render = (dispatch: boolean) => {
            internals._pipelineHooks.before();
            expect(node.jitterNode.value.toArray()).toEqual([upscaler.jitter.x, upscaler.jitter.y]);
            if (dispatch) {
                try {
                    upscaler.dispatch({ color: {}, depth: {}, velocity: {} } as never, cam);
                } catch {
                    // Encoding needs a real device.
                }
            }
            internals._pipelineHooks.after();
            expect(cam.view).toBeNull();
        };
        const phases: number[] = [];
        const previous: number[] = [];
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        const plan = [true, true, false, false, false, true, false, true, true];
        for (const dispatch of plan) {
            render(dispatch);
            if (!dispatch) continue;
            phases.push(upscaler.jitterPhase);
            previous.push(sequence.findIndex(([x, y]) => x === upscaler.jitterPrevious.x && y === upscaler.jitterPrevious.y));
        }
        expect(phases).toEqual([1, 2, 3, 4, 5]);
        expect(previous).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns stable objects', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        const first = upscaler.jitter;
        upscaler.beginFrame(cam);
        expect(upscaler.jitter).toBe(first);
        upscaler.endFrame(cam);
    });
});
