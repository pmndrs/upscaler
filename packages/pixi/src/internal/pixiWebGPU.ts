import type { Renderer, Texture, TextureSource, WebGPURenderer } from 'pixi.js';

/*
 * The pixi.js surface this adapter relies on — all public WebGPURenderer API
 * (verified against pixi.js 8.22): `renderer.gpu.device`, and
 * `renderer.texture.getGpuSource()` for the GPUTexture behind a source
 * (pixi documents that pairing for compute passes on `storage` textures).
 */

// RendererType.WEBGPU, inlined so this module stays import-free at runtime.
const WEBGPU = 2;

/**
 * Narrows a pixi renderer to a WebGPU one.
 * @param renderer - The application's renderer
 * @returns The same renderer, typed as WebGPU
 */
export function asWebGPURenderer(renderer: Renderer): WebGPURenderer {
    if (renderer.type !== WEBGPU) {
        throw new Error(
            "@pmndrs/upscaler/pixi: requires pixi's WebGPURenderer (got WebGL — pass preference: 'webgpu').",
        );
    }
    return renderer as WebGPURenderer;
}

/**
 * The renderer's `GPUDevice`, so the passes share pixi's queue.
 * @param renderer - An initialized WebGPURenderer
 * @returns The renderer-owned device
 */
export function getDevice(renderer: WebGPURenderer): GPUDevice {
    const device = renderer.gpu?.device;
    if (!device) throw new Error('@pmndrs/upscaler/pixi: the renderer has no GPU device yet — await its init first.');
    return device;
}

/**
 * The raw `GPUTexture` behind a pixi texture, creating it if pixi hasn't yet.
 * @param renderer - The renderer that owns the texture
 * @param texture - A pixi `Texture` (e.g. a `RenderTexture`) or its `TextureSource`
 * @returns The GPU allocation
 */
export function getGPUTexture(renderer: WebGPURenderer, texture: Texture | TextureSource): GPUTexture {
    // A TextureSource is its own `source`.
    return renderer.texture.getGpuSource(texture.source);
}
