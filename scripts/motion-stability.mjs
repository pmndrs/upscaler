// Pure helpers for scripts/measure-motion-stability.mjs: the scenario plans
// (segments, measured window), the condition list (modes × variants), the
// per-segment summary of `WarpingError` results, the A/B delta and the heat
// map PNG. No GPU, so motion-stability.test.mjs runs in CI.
import { encodePng } from './image-metrics.mjs';

// reference: the probe's 2×2-supersampled render as the output (no upscaler):
// the meter's floor for a sharp, jitter-free image of the same motion.
export const MODES = ['native', 'bilinear', 'spatial', 'temporal', 'reference'];

/** A segment is a hold (camera and scene still) when its name says so. */
export const isHold = (segment) => /^(still|hold)/.test(segment.name);

/**
 * The scenarios the meter drives, as plans: segments, the first measured frame
 * (after the history has had time to converge) and the last simulated frame.
 * Q19's segments come from the bench registry itself, so they cannot drift.
 * @param {string} id - Scenario id (Q19, Q4 or Q3)
 * @param {{ Q19_SEGMENTS: readonly { name: string, start: number, end: number }[] }} registry - bench/src/benchmark/scenarios.ts
 * @returns {{ id: string, start: number, end: number, segments: { name: string, start: number, end: number }[] }} The plan
 * @throws {Error} On a scenario the meter has no plan for
 */
export function scenarioPlan(id, registry) {
    if (id === 'Q19') return { id, start: 100, end: 1119, segments: registry.Q19_SEGMENTS.map((s) => ({ ...s })) };
    // Q4 (camera-motion-hold): orbit, truck, a wider orbit, then a hold.
    if (id === 'Q4')
        return {
            id,
            start: 24,
            end: 479,
            segments: [
                { name: 'orbit', start: 0, end: 119 },
                { name: 'truck', start: 120, end: 239 },
                { name: 'orbit-wide', start: 240, end: 359 },
                { name: 'hold', start: 360, end: 479 },
            ],
        };
    // Q3 (object-motion-disocclusion): animated objects under a still camera.
    if (id === 'Q3') return { id, start: 24, end: 239, segments: [{ name: 'object-motion', start: 0, end: 239 }] };
    throw new Error(`No motion-stability plan for scenario ${id} (Q19, Q4 or Q3).`);
}

/**
 * Expands modes × variants into runs. native and reference have no upscaler, so they run once
 * whatever the variants; with one variant the condition is named by its mode.
 * @param {string[]} modes - Subset of {@link MODES}
 * @param {string[]} variants - One or two bench variant ids
 * @returns {{ name: string, path: string, variant: string | null }[]} Conditions, in run order
 * @throws {Error} On an unknown mode, no variant or a repeated one
 */
export function expandConditions(modes, variants) {
    if (!variants.length) throw new Error('At least one variant is needed.');
    if (new Set(variants).size !== variants.length) throw new Error(`Repeated variant in ${variants.join(',')}.`);
    const conditions = [];
    for (const mode of modes) {
        if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode} (${MODES.join(', ')}).`);
        if (mode === 'native' || mode === 'reference') conditions.push({ name: mode, path: mode, variant: null });
        else
            for (const variant of variants)
                conditions.push({ name: variants.length > 1 ? `${mode}@${variant}` : mode, path: mode, variant });
    }
    return conditions;
}

const average = (values) => {
    const finite = values.filter((value) => value !== null && value !== undefined && Number.isFinite(value));
    return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : null;
};

/**
 * Summarizes per-frame `WarpingResult`s per segment. Frames without a warp
 * (first frame, after a reset) count toward nothing.
 * @param {{ frame: number, warp: { meanError: number, scored: number, occluded: number, over: number, offscreen: number } | null }[]} frames - Probe records
 * @param {{ name: string, start: number, end: number }[]} segments - The plan's segments
 * @param {number} start - First measured frame (segments ending before it are dropped)
 * @returns {{ segment: string, hold: boolean, frames: number, meanError: number | null, maxError: number | null,
 *   scored: number | null, occluded: number | null, over: number | null, offscreen: number | null }[]} One row per segment
 */
export function summarizeSegments(frames, segments, start) {
    return segments
        .filter((segment) => segment.end >= start)
        .map((segment) => {
            const warps = frames
                .filter((f) => f.frame >= segment.start && f.frame <= segment.end && f.warp)
                .map((f) => f.warp);
            return {
                segment: segment.name,
                hold: isHold(segment),
                frames: warps.length,
                meanError: average(warps.map((w) => w.meanError)),
                maxError: warps.length ? Math.max(...warps.map((w) => w.meanError)) : null,
                scored: average(warps.map((w) => w.scored)),
                occluded: average(warps.map((w) => w.occluded)),
                over: average(warps.map((w) => w.over)),
                offscreen: average(warps.map((w) => w.offscreen)),
            };
        });
}

/**
 * The headline numbers: the mean of the motion segments' means and of the
 * holds' (segments weigh equally, as in pmndrs/motion-vectors MOTION.md §5).
 * @param {ReturnType<typeof summarizeSegments>} rows - Segment rows
 * @returns {{ motion: number | null, holds: number | null, motionMax: number | null }} Aggregates
 */
export function aggregate(rows) {
    const motion = rows.filter((row) => !row.hold);
    const maxima = motion.map((row) => row.maxError).filter((value) => value !== null);
    return {
        motion: average(motion.map((row) => row.meanError)),
        holds: average(rows.filter((row) => row.hold).map((row) => row.meanError)),
        motionMax: maxima.length ? Math.max(...maxima) : null,
    };
}

/**
 * Relative change of B against A.
 * @param {number | null} a - Baseline
 * @param {number | null} b - Comparison
 * @returns {number | null} b / a − 1, or null when either is missing or a is 0
 */
export const relativeDelta = (a, b) => (a === null || b === null || a === 0 ? null : b / a - 1);

/**
 * Default heat-map frames: the middle of every measured motion segment.
 * @param {{ name: string, start: number, end: number }[]} segments - The plan's segments
 * @param {number} start - First measured frame
 * @returns {number[]} Frames, ascending
 */
export function defaultHeatFrames(segments, start) {
    return segments
        .filter((segment) => !isHold(segment) && segment.end >= start)
        .map((segment) => Math.max(start, Math.floor((Math.max(segment.start, start) + segment.end) / 2)));
}

/**
 * Encodes a probe heat map (tightly packed rgba8, base64) as an RGB PNG.
 * @param {{ width: number, height: number, rgba: string }} snapshot - From `__motionLab.takeHeat()`
 * @returns {Buffer} PNG file bytes
 */
export function heatToPng(snapshot) {
    const bytes = Buffer.from(snapshot.rgba, 'base64');
    const pixels = snapshot.width * snapshot.height;
    if (bytes.length !== pixels * 4) throw new Error(`Heat map is ${bytes.length} bytes, expected ${pixels * 4}.`);
    const rgb = new Float32Array(pixels * 3);
    for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = bytes[p * 4 + c] / 255;
    return encodePng(rgb, snapshot.width, snapshot.height);
}
