import type { JitterOffset } from './types.js';

/**
 * Compose jitter with an existing projection without modifying the caller's matrix.
 *
 * @param projection - Sixteen column-major projection elements.
 * @param jitter - Offset in render pixels, with X right and Y down.
 * @param width - Positive render width in pixels.
 * @param height - Positive render height in pixels.
 * @returns A translated projection preserving existing projection terms.
 * @throws If the matrix length or render dimensions are invalid.
 */
export function jitterProjection(projection: ArrayLike<number>, jitter: JitterOffset, width: number, height: number): Float32Array {
    if (projection.length !== 16 || width <= 0 || height <= 0) throw new Error('UpscalerCore: invalid projection or jitter dimensions.');
    const result = Float32Array.from(projection);
    for (let column = 0; column < 4; column++) {
        result[column * 4] -= 2 * jitter.x / width * projection[column * 4 + 3];
        result[column * 4 + 1] += 2 * jitter.y / height * projection[column * 4 + 3];
    }
    return result;
}
