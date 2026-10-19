import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';

import { createDeviceTextureAllocator, type TextureAllocator } from '@pmndrs/upscaler-core/textures';
import { asWebGPUEngine } from './babylonWebGPU';

// Constants.TEXTURE_NEAREST_SAMPLINGMODE — a value, not an import, so this
// module pulls in no Babylon runtime code.
const NEAREST_SAMPLINGMODE = 1;

/**
 * The core's texture allocator for Babylon: the core creates each published
 * texture on the device itself and hands Babylon a wrapper around the same
 * allocation (`WebGPUEngine.wrapWebGPUTexture`). Passes bind the raw
 * `GPUTexture`; Babylon samples the `InternalTexture` (bind it to a material
 * or post process, or `importTexture()` it into a frame graph).
 * @param engine - The WebGPUEngine that samples the textures
 * @param device - The engine's device (where the core allocates)
 * @returns An allocator for `UpscalerCore`'s `allocateTexture` option
 */
export function createBabylonTextureAllocator(
    engine: AbstractEngine,
    device: GPUDevice,
): TextureAllocator<InternalTexture> {
    const webgpu = asWebGPUEngine(engine);
    const allocate = createDeviceTextureAllocator(device);
    return (descriptor) => {
        const texture = allocate(descriptor);
        const handle = webgpu.wrapWebGPUTexture(texture.gpu);
        handle.generateMipMaps = false;
        // wrapWebGPUTexture creates no sampling view (it serves render
        // targets); re-pointing at the same allocation builds one through
        // the public API.
        webgpu.updateWrappedWebGPUTexture(handle, texture.gpu);
        // r32float is non-filterable — Babylon must sample it nearest.
        if (descriptor.format === 'r32float') handle.samplingMode = NEAREST_SAMPLINGMODE;
        return {
            gpu: texture.gpu,
            handle,
            destroy: () => {
                handle.dispose();
                texture.destroy();
            },
        };
    };
}
