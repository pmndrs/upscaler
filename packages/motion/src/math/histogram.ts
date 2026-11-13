/**
 * Distances between two luma histograms, for cut (scene-change) detection.
 * Both are scale-free: histograms of different pixel counts compare as
 * distributions.
 */

function normalize(histogram: ArrayLike<number>): number[] {
    let total = 0;
    for (let i = 0; i < histogram.length; i++) total += histogram[i];
    return Array.from(histogram, (value) => (total > 0 ? value / total : 0));
}

/**
 * Jensen–Shannon divergence in bits, `[0, 1]`: 0 for identical
 * distributions, 1 for disjoint ones. Symmetric and finite on empty bins.
 * @param a - First histogram
 * @param b - Second histogram (same bin count)
 * @returns Divergence in bits
 */
export function jensenShannon(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) throw new Error('Histograms must have the same bin count.');
    const p = normalize(a);
    const q = normalize(b);
    let divergence = 0;
    for (let i = 0; i < p.length; i++) {
        const m = 0.5 * (p[i] + q[i]);
        if (p[i] > 0) divergence += 0.5 * p[i] * Math.log2(p[i] / m);
        if (q[i] > 0) divergence += 0.5 * q[i] * Math.log2(q[i] / m);
    }
    return Math.max(0, divergence);
}

/**
 * Earth mover's distance between two 1-D histograms, in bins: how far the
 * luma mass had to move. A global brightness ramp moves mass a little; a cut
 * reshuffles it.
 * @param a - First histogram
 * @param b - Second histogram (same bin count)
 * @returns Distance in bins
 */
export function earthMovers(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) throw new Error('Histograms must have the same bin count.');
    const p = normalize(a);
    const q = normalize(b);
    let carried = 0;
    let distance = 0;
    for (let i = 0; i < p.length; i++) {
        carried += p[i] - q[i];
        distance += Math.abs(carried);
    }
    return distance;
}
