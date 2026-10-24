import { Texture, TextureSource, type WebGPURenderer } from 'pixi.js';

import type { TextureAllocator } from '@pmndrs/upscaler-core/textures';
import { getGPUTexture } from './pixiWebGPU';

/**
 * The core's texture allocator for pixi: each published texture is a pixi
 * `storage` `TextureSource`, so a `Sprite` or filter samples it like any
 * texture, while the passes bind the `GPUTexture` pixi created for it — one
 * allocation, two views.
 * @param renderer - The renderer owning the textures
 * @returns An allocator for `UpscalerCore`'s `allocateTexture` option
 */
export function createPixiTextureAllocator(renderer: WebGPURenderer): TextureAllocator<Texture> {
    return (descriptor) => {
        const source = new TextureSource({
            label: descriptor.label,
            width: descriptor.width,
            height: descriptor.height,
            resolution: 1,
            format: descriptor.format,
            storage: true,
            // Storage views must cover exactly one mip level.
            autoGenerateMipmaps: false,
            // r32float is non-filterable — pixi must sample it nearest.
            scaleMode: descriptor.format === 'r32float' ? 'nearest' : 'linear',
            // The output carries the input's alpha, and pixi renders premultiplied.
            alphaMode: 'premultiplied-alpha',
            // pixi's GC unloads sources it hasn't sampled lately; the passes
            // bind these every frame through the raw handle, which it can't see.
            autoGarbageCollect: false,
        });
        const texture = new Texture({ source, label: descriptor.label });
        // Freed with unload(), not destroy(): pixi keeps batch bind groups
        // around after a Sprite switches textures and warns when a source
        // they reference is destroyed. unload() releases the GPUTexture
        // without that event.
        return {
            gpu: getGPUTexture(renderer, source),
            handle: texture,
            destroy: () => {
                source.unload();
                texture.destroy(false);
            },
        };
    };
}
