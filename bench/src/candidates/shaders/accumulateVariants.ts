import { ACCUMULATE_SHADER } from '@pmndrs/upscaler-core/shaders/accumulate';

/**
 * Accumulate-pass candidates for the motion-gap diagnosis
 * (bench/docs/REFERENCE-QUALITY.md, "Why temporal trails FSR1 in motion").
 * Each is production `ACCUMULATE_SHADER` with one block rewritten, so the
 * bindings, the rectification and every other constant stay production's. A
 * missing anchor throws at module load: production changed and the candidate
 * must be re-derived, not silently built from a stale shader.
 */

const BLEND = /* wgsl */ `    let newCount = min(sampleCount + 1.0, C.maxAccumulation);
    let baseAlpha = clamp(confidence / newCount, 1.0 / C.maxAccumulation, 1.0);
    var alpha = max(baseAlpha * (1.0 - LOCK_HISTORY_BOOST * lockLife), 1.0 / (C.maxAccumulation * 2.0));`;
const HISTORY_FETCH = 'var history = sampleHistoryCatmullRom(prevUV);';

function replaceOnce(source: string, anchor: string, replacement: string): string {
    const index = source.indexOf(anchor);
    if (index < 0 || source.indexOf(anchor, index + 1) >= 0)
        throw new Error(`accumulateVariants: anchor not found exactly once: ${anchor.slice(0, 60)}`);
    return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

/** Options for {@link buildMotionCapAccumulateShader}. */
export interface MotionCapOptions {
    /** Accumulation cap (frames) at and above `hi` render px/frame of motion. */
    cap: number;
    /** Motion (render px/frame) where the cap starts to apply. */
    lo: number;
    /** Motion (render px/frame) where the cap is fully applied. */
    hi: number;
}

/**
 * Motion-adaptive accumulation cap: the blend's effective `maxAccumulation`
 * falls from the setting toward `cap` as the pixel's motion rises from `lo` to
 * `hi` render px/frame. Every frame of history is a Catmull-Rom resample of the
 * last, so under motion a long history is a long chain of resamples and
 * reprojection error; a still pixel (motion < `lo`) keeps the full setting, so
 * still-scene convergence is untouched. The stored age stays
 * `newCount / maxAccumulation`, so history regrows normally once motion stops.
 * @param options - Cap and motion ramp
 * @returns A full accumulate shader with production's bindings
 */
export function buildMotionCapAccumulateShader({ cap, lo, hi }: MotionCapOptions): string {
    return replaceOnce(
        ACCUMULATE_SHADER,
        BLEND,
        /* wgsl */ `    // Candidate: motion-adaptive accumulation cap (bench-only).
    let motionCap = mix(C.maxAccumulation, min(${cap.toFixed(4)}, C.maxAccumulation),
        smoothstep(${lo.toFixed(4)}, ${hi.toFixed(4)}, motionTexels));
    let newCount = min(sampleCount + 1.0, motionCap);
    let baseAlpha = clamp(confidence / newCount, 1.0 / motionCap, 1.0);
    var alpha = max(baseAlpha * (1.0 - LOCK_HISTORY_BOOST * lockLife), 1.0 / (motionCap * 2.0));`,
    );
}

/**
 * Diagnostic only: history fetched with one bilinear tap instead of
 * Catmull-Rom. Bilinear is the softer filter, so how much worse this scores
 * under motion measures how sensitive the motion deficit is to the history
 * resampling filter.
 */
export const ACCUMULATE_BILINEAR_HISTORY_SHADER = replaceOnce(
    ACCUMULATE_SHADER,
    HISTORY_FETCH,
    'var history = textureSampleLevel(historyIn, linearSampler, prevUV, 0.0);',
);

/** The registered candidates, by bench identity. */
export const ACCUMULATE_VARIANTS = {
    'accumulate-motion-cap2-v1': buildMotionCapAccumulateShader({ cap: 2, lo: 0.5, hi: 1.5 }),
    'accumulate-motion-cap4-v1': buildMotionCapAccumulateShader({ cap: 4, lo: 0.5, hi: 1.5 }),
    // Ramp on the still-scene relax's own fade (STILL_MOTION_LO/HI), so the
    // cap engages exactly where the relax stops.
    'accumulate-motion-cap2-early-v1': buildMotionCapAccumulateShader({ cap: 2, lo: 0.05, hi: 0.5 }),
    'accumulate-bilinear-history-v1': ACCUMULATE_BILINEAR_HISTORY_SHADER,
} as const;
