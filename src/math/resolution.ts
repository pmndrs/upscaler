import { QualityMode } from '../types';

/**
 * Per-axis scaling ratios for each quality preset, matching the official
 * FSR3 documentation (display / render).
 */
export const QUALITY_MODE_RATIOS: Record<QualityMode, number> = {
    [QualityMode.NativeAA]: 1.0,
    [QualityMode.Quality]: 1.5,
    [QualityMode.Balanced]: 1.7,
    [QualityMode.Performance]: 2.0,
    [QualityMode.UltraPerformance]: 3.0,
};

/**
 * Resolves the render resolution for a display size and upscale ratio.
 *
 * Dimensions are floored (never rounded up) so the render target is always
 * ≤ display size, then clamped to at least 1 pixel.
 *
 * @param displayWidth - Display width in pixels
 * @param displayHeight - Display height in pixels
 * @param ratio - Upscale ratio (≥ 1)
 * @returns The render resolution `{ width, height }`
 */
export function getRenderResolution(
    displayWidth: number,
    displayHeight: number,
    ratio: number,
): { width: number; height: number } {
    return {
        width: Math.max(1, Math.floor(displayWidth / ratio)),
        height: Math.max(1, Math.floor(displayHeight / ratio)),
    };
}

/**
 * Resolves the ratio for a quality mode.
 * @param mode - The quality preset
 * @returns The per-axis upscale ratio
 */
export function getQualityModeRatio(mode: QualityMode): number {
    return QUALITY_MODE_RATIOS[mode];
}
