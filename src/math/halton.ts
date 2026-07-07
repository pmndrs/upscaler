/**
 * Low-discrepancy sequence generation for temporal sub-pixel jitter.
 *
 * FSR2/3 jitter the projection with a Halton(2,3) sequence — it fills the
 * pixel footprint evenly so the temporal accumulation converges to a
 * super-sampled result instead of oscillating.
 */

/**
 * Computes the `index`-th element of the radical-inverse Halton sequence for
 * a given base. Values fall in `(0, 1)`.
 *
 * @param index - 1-based sequence index (index 0 always yields 0, so callers start at 1)
 * @param base - Prime base of the sequence (2 and 3 for x/y jitter)
 * @returns The Halton value in `(0, 1)`
 */
export function halton(index: number, base: number): number {
    let result = 0;
    let fraction = 1 / base;
    let i = index;
    while (i > 0) {
        result += (i % base) * fraction;
        i = Math.floor(i / base);
        fraction /= base;
    }
    return result;
}

/**
 * Generates a centered Halton(2,3) jitter sequence.
 *
 * @param count - Number of jitter phases
 * @returns `count` offsets in `[-0.5, 0.5]²`, in pixels
 */
export function generateJitterSequence(count: number): Array<[number, number]> {
    const sequence: Array<[number, number]> = [];
    for (let i = 1; i <= count; i++) {
        sequence.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    }
    return sequence;
}
