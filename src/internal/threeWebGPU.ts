import type { Texture, WebGPURenderer } from 'three/webgpu';

/**
 * Typed access to three's WebGPU backend internals.
 *
 * The FSR passes are raw WebGPU compute pipelines, so they need the
 * `GPUDevice` three created and the `GPUTexture` handles behind three's
 * `Texture`/`RenderTarget` objects. Three doesn't expose these publicly —
 * the shapes below document exactly which internals we rely on (verified
 * against three r184: `WebGPUBackend.device` and `Backend.get(object)`
 * returning per-object data with a `.texture` GPUTexture).
 *
 * NOTE: These are internals and may shift between three releases. The
 * accessors throw loudly rather than limping along if the shape changes.
 */
interface WebGPUBackendInternals {
    device?: GPUDevice;
    get(object: object): { texture?: GPUTexture } | undefined;
}

/**
 * Returns the `GPUDevice` owned by a `WebGPURenderer`.
 *
 * @param renderer - An initialized `WebGPURenderer` (await `renderer.init()` first)
 * @returns The backing GPUDevice
 * @throws If the renderer isn't initialized or isn't backed by WebGPU
 */
export function getDevice(renderer: WebGPURenderer): GPUDevice {
    const backend = (renderer as unknown as { backend?: WebGPUBackendInternals }).backend;
    const device = backend?.device;
    if (!device) {
        throw new Error(
            'three-fsr3: renderer has no GPUDevice. ' +
                'Await renderer.init() and ensure the WebGPU backend is active (not the WebGL fallback).',
        );
    }
    return device;
}

/**
 * Returns the raw `GPUTexture` behind a three texture.
 *
 * The texture must already exist on the GPU — either it was rendered to, or
 * it was passed through `renderer.initTexture()`.
 *
 * @param renderer - The renderer owning the texture
 * @param texture - The three texture (render-target attachment, DepthTexture, StorageTexture…)
 * @returns The backing GPUTexture
 * @throws If the texture has not been uploaded/initialized yet
 */
export function getGPUTexture(renderer: WebGPURenderer, texture: Texture): GPUTexture {
    const backend = (renderer as unknown as { backend: WebGPUBackendInternals }).backend;
    const gpuTexture = backend.get(texture)?.texture;
    if (!gpuTexture) {
        throw new Error(
            `three-fsr3: no GPUTexture behind "${texture.name || texture.uuid}". ` +
                'Render to it once or call renderer.initTexture(texture) before dispatching.',
        );
    }
    return gpuTexture;
}
