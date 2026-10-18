import { FloatType, HalfFloatType, NearestFilter, NoColorSpace, RGBAFormat, RedFormat, UnsignedByteType } from 'three';
import { StorageTexture, type WebGPURenderer } from 'three/webgpu';

import type { TextureAllocator } from '@pmndrs/upscaler-core/textures';
import { getGPUTexture } from './threeWebGPU';

/**
 * The core's texture allocator for three: each published texture is a three
 * `StorageTexture`, so consumers sample it like any other texture, while the
 * passes bind the raw handle fetched back from three's backend — one
 * allocation, two views.
 * @param renderer - The renderer owning the textures
 * @returns An allocator for `UpscalerCore`'s `allocateTexture` option
 */
export function createThreeTextureAllocator(renderer: WebGPURenderer): TextureAllocator<StorageTexture> {
    return (descriptor) => {
        const tex = new StorageTexture(descriptor.width, descriptor.height);
        tex.name = descriptor.label;
        tex.colorSpace = NoColorSpace;
        // Texture.generateMipmaps defaults to true, which would make three
        // allocate a mip chain — storage views must cover exactly one level.
        tex.generateMipmaps = false;
        switch (descriptor.format) {
            case 'r32float':
                tex.format = RedFormat;
                tex.type = FloatType;
                // r32float is non-filterable — consumers must sample nearest.
                tex.minFilter = NearestFilter;
                tex.magFilter = NearestFilter;
                break;
            case 'rgba8unorm':
                tex.format = RGBAFormat;
                tex.type = UnsignedByteType;
                break;
            case 'rgba16float':
                tex.format = RGBAFormat;
                tex.type = HalfFloatType;
                break;
        }
        // initTexture forces GPU-side creation so the storage view exists
        // before the first dispatch.
        renderer.initTexture(tex);
        // dispose() destroys the backing GPUTexture through three — never
        // also .destroy() the raw handle.
        return { gpu: getGPUTexture(renderer, tex), handle: tex, destroy: () => tex.dispose() };
    };
}
