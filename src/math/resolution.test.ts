import { describe, expect, it } from 'vitest';

import { FSRQualityMode } from '../types';
import { getQualityModeRatio, getRenderResolution } from './resolution';

describe('quality presets', () => {
    it('matches the official FSR3 scaling ratios', () => {
        expect(getQualityModeRatio(FSRQualityMode.NativeAA)).toBe(1.0);
        expect(getQualityModeRatio(FSRQualityMode.Quality)).toBe(1.5);
        expect(getQualityModeRatio(FSRQualityMode.Balanced)).toBe(1.7);
        expect(getQualityModeRatio(FSRQualityMode.Performance)).toBe(2.0);
        expect(getQualityModeRatio(FSRQualityMode.UltraPerformance)).toBe(3.0);
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
