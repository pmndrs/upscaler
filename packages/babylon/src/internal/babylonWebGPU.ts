import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';

/**
 * Every Babylon internal this adapter touches lives here — verified against
 * `@babylonjs/core` 9.31. Two are private and throw loudly when their shape
 * changes; re-verify them first on a Babylon upgrade:
 * - `engine._device` → the `GPUDevice`
 * - `internalTexture._hardwareTexture.underlyingResource` → the raw `GPUTexture`
 *
 * The rest is public WebGPUEngine API: `flushFramebuffer()` (orders our
 * submit after Babylon's work) and `wrapWebGPUTexture()` (the allocator).
 */

/**
 * Narrows an engine to an initialized WebGPUEngine.
 * @param engine - The host engine
 * @returns The same engine, typed as WebGPU
 */
export function asWebGPUEngine(engine: AbstractEngine): WebGPUEngine {
    if (!engine.isWebGPU) {
        throw new Error('@pmndrs/upscaler/babylon: requires a WebGPUEngine (got a WebGL engine).');
    }
    return engine as WebGPUEngine;
}

/**
 * The engine's `GPUDevice`, so the passes share Babylon's queue.
 * @param engine - An initialized WebGPUEngine
 * @returns The engine-owned device
 */
export function getDevice(engine: AbstractEngine): GPUDevice {
    const device = (asWebGPUEngine(engine) as unknown as { _device?: GPUDevice })._device;
    if (!device || typeof device.createCommandEncoder !== 'function') {
        throw new Error(
            '@pmndrs/upscaler/babylon: engine._device is missing — await engine.initAsync() first, or this ' +
                'Babylon version changed its internals (verified against 9.31).',
        );
    }
    return device;
}

/**
 * The raw `GPUTexture` behind a Babylon texture.
 * @param texture - A Babylon `InternalTexture` (a render-target attachment,
 *   a frame-graph texture, or one this adapter allocated)
 * @returns The GPU allocation
 */
export function getGPUTexture(texture: InternalTexture): GPUTexture {
    const hardware = texture._hardwareTexture as { underlyingResource?: GPUTexture | null } | null;
    const gpu = hardware?.underlyingResource;
    if (!gpu || typeof gpu.createView !== 'function') {
        throw new Error(
            '@pmndrs/upscaler/babylon: texture has no WebGPU allocation yet (render to it first), or this ' +
                'Babylon version changed _hardwareTexture.underlyingResource (verified against 9.31).',
        );
    }
    return gpu;
}
