import * as THREE from 'three/webgpu';

import type { TextureAllocator } from '../../src/index';

// Copied glue (MOTION-VECTORS-PLAN §3.4), the same as the upscaler's
// internal/threeWebGPU.ts + textureAllocator.ts. It becomes the /three
// subpath's allocator after extraction.

/**
 * The raw `GPUTexture` behind a three texture (three internals, r184–r186).
 * @param renderer - The renderer owning the texture
 * @param texture - A texture three has already created on the GPU
 * @returns Its `GPUTexture`
 */
export function getGPUTexture(renderer: THREE.WebGPURenderer, texture: THREE.Texture): GPUTexture {
    const backend = (renderer as unknown as { backend: { get(object: object): { texture?: GPUTexture } | undefined } }).backend;
    const gpuTexture = backend.get(texture)?.texture;
    if (!gpuTexture)
        throw new Error(`motion lab: no GPUTexture behind "${texture.name || texture.uuid}"; render to it or initTexture() it first.`);
    return gpuTexture;
}

/**
 * Allocates published textures as three `StorageTexture`s, so the lab can
 * present them with ordinary three materials.
 * @param renderer - The renderer owning the textures
 * @returns An allocator for `MotionAnalyzer`
 */
export function createThreeTextureAllocator(renderer: THREE.WebGPURenderer): TextureAllocator<THREE.StorageTexture> {
    return (descriptor) => {
        const texture = new THREE.StorageTexture(descriptor.width, descriptor.height);
        texture.name = descriptor.label;
        texture.colorSpace = THREE.NoColorSpace;
        // A mip chain would break the single-level storage view.
        texture.generateMipmaps = false;
        if (descriptor.format === 'r32float') {
            texture.format = THREE.RedFormat;
            texture.type = THREE.FloatType;
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
        } else {
            texture.format = THREE.RGBAFormat;
            texture.type = descriptor.format === 'rgba8unorm' ? THREE.UnsignedByteType : THREE.HalfFloatType;
        }
        renderer.initTexture(texture);
        return { gpu: getGPUTexture(renderer, texture), handle: texture, destroy: () => texture.dispose() };
    };
}
