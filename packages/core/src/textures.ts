/**
 * Formats of the textures the core publishes (output and temporal guides).
 * Working textures nobody else samples stay raw `device.createTexture()`
 * allocations and never reach the allocator.
 */
export type CoreTextureFormat = 'r32float' | 'rgba8unorm' | 'rgba16float';

/** What the core asks an allocator for. */
export interface CoreTextureDescriptor {
    /** Debug label (`upscale-…`), for engine names and GPU captures. */
    readonly label: string;
    readonly width: number;
    readonly height: number;
    readonly format: CoreTextureFormat;
}

/**
 * A texture the core binds and an engine samples: one allocation, two views.
 * Passes bind {@link gpu}; consumers get {@link handle} (a three `Texture`, a
 * Babylon `InternalTexture`, … or the `GPUTexture` itself).
 *
 * Requirements on {@link gpu}: exactly the descriptor's size and format, one
 * mip level, one sample, and `TEXTURE_BINDING | STORAGE_BINDING` usage.
 * `r32float` is not filterable, so an engine handle for it must sample nearest.
 */
export interface CoreTexture<THandle = GPUTexture> {
    readonly gpu: GPUTexture;
    readonly handle: THandle;
    /** Frees the allocation (the engine's own dispose when it owns the texture). */
    destroy(): void;
}

/**
 * Allocates a published texture. The engine-adapter seam: an adapter wraps
 * its own texture type so the products stay sampleable by the engine.
 */
export type TextureAllocator<THandle = GPUTexture> = (descriptor: CoreTextureDescriptor) => CoreTexture<THandle>;

/**
 * The default allocator: plain `device.createTexture()`, with the
 * `GPUTexture` as its own handle. `COPY_SRC` is added so a raw consumer can
 * read results back.
 * @param device - The device the core runs on
 * @returns An allocator for {@link UpscalerCore}'s `allocateTexture` option
 */
export function createDeviceTextureAllocator(device: GPUDevice): TextureAllocator<GPUTexture> {
    return (descriptor) => {
        const gpu = device.createTexture({
            label: descriptor.label,
            size: { width: descriptor.width, height: descriptor.height },
            format: descriptor.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        return { gpu, handle: gpu, destroy: () => gpu.destroy() };
    };
}
