/**
 * The engine seam for the textures this package publishes. A deliberate copy
 * of the upscaler core's `TextureAllocator` contract (pmndrs/motion-vectors docs/PLAN.md §3.4:
 * small glue is copied, not shared), so the package depends on no other
 * project. The shapes match, so an upscaler allocator can be passed as-is.
 */

/** Formats of the textures this package publishes. */
export type MotionTextureFormat = 'r32float' | 'rgba8unorm' | 'rgba16float';

/** What the analyzer asks an allocator for. */
export interface MotionTextureDescriptor {
    /** Debug label (`motion-…`), for engine names and GPU captures. */
    readonly label: string;
    readonly width: number;
    readonly height: number;
    readonly format: MotionTextureFormat;
}

/**
 * A texture the passes bind and an engine samples: one allocation, two views.
 * Passes bind {@link gpu}; consumers get {@link handle} (a three `Texture`, …
 * or the `GPUTexture` itself).
 *
 * Requirements on {@link gpu}: exactly the descriptor's size and format, one
 * mip level, one sample, and `TEXTURE_BINDING | STORAGE_BINDING` usage.
 * `r32float` is not filterable, so an engine handle for it must sample nearest.
 */
export interface MotionTexture<THandle = GPUTexture> {
    readonly gpu: GPUTexture;
    readonly handle: THandle;
    /** Frees the allocation (the engine's own dispose when it owns the texture). */
    destroy(): void;
}

/** Allocates a published texture; an engine adapter wraps its own texture type. */
export type TextureAllocator<THandle = GPUTexture> = (descriptor: MotionTextureDescriptor) => MotionTexture<THandle>;

/**
 * The default allocator: plain `device.createTexture()`, with the `GPUTexture`
 * as its own handle. `COPY_SRC` is added so a raw consumer can read results back.
 * @param device - The device the passes run on
 * @returns An allocator for {@link MotionAnalyzer}
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
