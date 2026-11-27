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

/**
 * Diagnostic only (motion-onset study, bench/docs/NEXT-STEPS.md §20): the
 * still-scene relax switched off (`STILL_CLAMP_RELAX` 0, which `alphaRelax`
 * already guards). Tests whether a converged still pixel entering motion with
 * the widened box and old history is what the warp meter sees at onset.
 */
export const ACCUMULATE_NO_STILL_RELAX_SHADER = replaceOnce(
    ACCUMULATE_SHADER,
    'const STILL_CLAMP_RELAX : f32 = 8.0;',
    'const STILL_CLAMP_RELAX : f32 = 0.0;',
);

/** Production's de-ring block (issue #118), from its header to its return. */
function replaceHistoryDeRing(replacement: string): string {
    const start = ACCUMULATE_SHADER.indexOf('    //* De-ring (issue #118)');
    const endAnchor = 'return vec4f(clamp(result.rgb, texelLo, texelHi), max(result.a, 0.0));';
    const end = ACCUMULATE_SHADER.indexOf(endAnchor);
    if (start < 0 || end < start)
        throw new Error('accumulateVariants: the history de-ring block is not where expected');
    return ACCUMULATE_SHADER.slice(0, start) + replacement + ACCUMULATE_SHADER.slice(end + endAnchor.length);
}

/**
 * Frozen pre-#118 history resample: the Catmull-Rom result clamped from below
 * only, so its negative lobes overshoot the brightest history texel — next to
 * an HDR highlight under pre-exposure, into ~1000 / exposure. The A/B
 * reference for the de-ring (bench/docs/NEXT-STEPS.md §21).
 */
export const ACCUMULATE_UNCLAMPED_HISTORY_SHADER = replaceHistoryDeRing(
    '    return max(result, vec4f(0.0));',
);

/**
 * Rejected #118 form: the result bounded by the five bilinear taps already
 * fetched (zero extra loads). Fixes the overshoot like production's 2x2-texel
 * bound, but the taps are blurrier than the texels: −0.06 to −0.31 dB on Q4's
 * motion windows and +1.3 % Q19 warp error under motion (NEXT-STEPS §21).
 */
export const ACCUMULATE_TAP_CLAMP_HISTORY_SHADER = replaceHistoryDeRing(
    /* wgsl */ `    let tapW = textureSampleLevel(historyIn, linearSampler, vec2f(texPos0.x, texPos12.y), 0.0).rgb;
    let tapN = textureSampleLevel(historyIn, linearSampler, vec2f(texPos12.x, texPos0.y), 0.0).rgb;
    let tapC = textureSampleLevel(historyIn, linearSampler, texPos12, 0.0).rgb;
    let tapE = textureSampleLevel(historyIn, linearSampler, vec2f(texPos3.x, texPos12.y), 0.0).rgb;
    let tapS = textureSampleLevel(historyIn, linearSampler, vec2f(texPos12.x, texPos3.y), 0.0).rgb;
    let tapLo = min(min(min(tapW, tapN), min(tapC, tapE)), tapS);
    let tapHi = max(max(max(tapW, tapN), max(tapC, tapE)), tapS);
    return vec4f(clamp(result.rgb, tapLo, tapHi), max(result.a, 0.0));`,
);

/** Production's history exposure delta (issue #99), from its first load to its rescale. */
const HISTORY_EXPOSURE_DELTA = /* wgsl */ `    let framePrev = textureLoad(exposurePrevTex, vec2i(0), 0);
    var historyRatio = 1.0;
    if (framePrev.b > 1.0e-4 && frameInfo.b > 1.0e-4) { historyRatio = frameInfo.b / framePrev.b; }
    if ((!hasFlag(FLAG_AUTO_EXPOSURE) || hasFlag(FLAG_EXTERNAL_EXPOSURE)) && framePrev.r > 1.0e-4) {
        historyRatio = historyRatio * (exposure / framePrev.r);
    }
    if (abs(historyRatio - 1.0) > 1.0e-3) {
        history = vec4f(tonemapInvertible(tonemapInvert(history.rgb) * historyRatio), history.a);
    }`;

/**
 * Frozen pre-#99 history correction: host pre-exposure only, so a fixed or
 * app-supplied conditioning-exposure step decodes old history at the new
 * exposure (a 15–160 % one-frame pop on bench Q12/Q20). The A/B reference for
 * scripts/measure-exposure-step.mjs (bench/docs/NEXT-STEPS.md §23).
 */
export const ACCUMULATE_UNCORRECTED_CONDITIONING_SHADER = replaceOnce(
    ACCUMULATE_SHADER,
    HISTORY_EXPOSURE_DELTA,
    /* wgsl */ `    let hostPrev = textureLoad(exposurePrevTex, vec2i(0), 0).b;
    var hostRatio = 1.0;
    if (hostPrev > 1.0e-4 && frameInfo.b > 1.0e-4) { hostRatio = frameInfo.b / hostPrev; }
    if (abs(hostRatio - 1.0) > 1.0e-3) {
        history = vec4f(tonemapInvertible(tonemapInvert(history.rgb) * hostRatio), history.a);
    }`,
);

/**
 * Rejected #99 form: the conditioning-exposure correction under auto-exposure
 * too. Auto-exposure tracks the scene's brightness, so the uncorrected decode
 * moves old history toward the new lighting; correcting it measured Q15 drift
 * lag +55 % and Q9 +10 % (bench/docs/NEXT-STEPS.md §23).
 */
export const ACCUMULATE_CONDITIONING_CORRECTION_SHADER = replaceOnce(
    ACCUMULATE_SHADER,
    '(!hasFlag(FLAG_AUTO_EXPOSURE) || hasFlag(FLAG_EXTERNAL_EXPOSURE)) && framePrev.r > 1.0e-4',
    'framePrev.r > 1.0e-4',
);

/** The registered candidates, by bench identity. */
export const ACCUMULATE_VARIANTS = {
    'accumulate-history-unclamped-v1': ACCUMULATE_UNCLAMPED_HISTORY_SHADER,
    'accumulate-history-tap-clamp-v1': ACCUMULATE_TAP_CLAMP_HISTORY_SHADER,
    'accumulate-conditioning-correction-v1': ACCUMULATE_CONDITIONING_CORRECTION_SHADER,
    'accumulate-uncorrected-conditioning-v1': ACCUMULATE_UNCORRECTED_CONDITIONING_SHADER,
    'accumulate-motion-cap2-v1': buildMotionCapAccumulateShader({ cap: 2, lo: 0.5, hi: 1.5 }),
    'accumulate-motion-cap4-v1': buildMotionCapAccumulateShader({ cap: 4, lo: 0.5, hi: 1.5 }),
    // Ramp on the still-scene relax's own fade (STILL_MOTION_LO/HI), so the
    // cap engages exactly where the relax stops.
    'accumulate-motion-cap2-early-v1': buildMotionCapAccumulateShader({ cap: 2, lo: 0.05, hi: 0.5 }),
    'accumulate-bilinear-history-v1': ACCUMULATE_BILINEAR_HISTORY_SHADER,
    'accumulate-still-relax0-v1': ACCUMULATE_NO_STILL_RELAX_SHADER,
} as const;
