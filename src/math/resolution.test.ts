import { describe, expect, it } from 'vitest';

import { QualityMode } from '../types';
import { getPassRenderResolution, getQualityModeRatio, getRenderResolution } from './resolution';

describe('quality presets', () => {
    it('matches the official FSR3 scaling ratios', () => {
        expect(getQualityModeRatio(QualityMode.NativeAA)).toBe(1.0);
        expect(getQualityModeRatio(QualityMode.Quality)).toBe(1.5);
        expect(getQualityModeRatio(QualityMode.Balanced)).toBe(1.7);
        expect(getQualityModeRatio(QualityMode.Performance)).toBe(2.0);
        expect(getQualityModeRatio(QualityMode.UltraPerformance)).toBe(3.0);
    });
});

describe('getRenderResolution', () => {
    it('computes the documented render sizes for 4K', () => {
        expect(getRenderResolution(3840, 2160, 1.5)).toEqual({ width: 2560, height: 1440 });
        expect(getRenderResolution(3840, 2160, 2.0)).toEqual({ width: 1920, height: 1080 });
        expect(getRenderResolution(3840, 2160, 3.0)).toEqual({ width: 1280, height: 720 });
    });

    it('floors rather than rounds so render ≤ display', () => {
        const { width, height } = getRenderResolution(1919, 1079, 1.7);
        expect(width).toBe(Math.floor(1919 / 1.7));
        expect(height).toBe(Math.floor(1079 / 1.7));
    });

    it('never returns zero-sized targets', () => {
        expect(getRenderResolution(1, 1, 3.0)).toEqual({ width: 1, height: 1 });
    });
});

describe('getPassRenderResolution', () => {
    it('floors fractional sizes like three instead of rounding up (#88)', () => {
        // 1252 / 1.5 = 834.67: three renders 834, the node used to configure 835.
        expect(getPassRenderResolution(1252, 936, 1.5)).toEqual({ width: 834, height: 624 });
    });

    it("follows three's multiply-by-scale where custom ratios diverge", () => {
        // 39 * (1 / 1.3) = 29.999…; 39 / 1.3 = 30.
        expect(getPassRenderResolution(39, 39, 1.3).width).toBe(29);
        expect(getRenderResolution(39, 39, 1.3).width).toBe(30);
    });

    it('agrees with getRenderResolution at the preset ratios', () => {
        for (const ratio of [1, 1.5, 1.7, 2, 3]) {
            for (let size = 1; size <= 8192; size++) {
                if (getPassRenderResolution(size, 1, ratio).width !== getRenderResolution(size, 1, ratio).width) {
                    throw new Error(`size ${size} @ ratio ${ratio}`);
                }
            }
        }
    });
});
