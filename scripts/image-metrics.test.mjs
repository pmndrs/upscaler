import { describe, expect, test } from 'vitest';

import {
    SSIM_BORDER,
    decodePng,
    encodePng,
    present,
    psnr,
    referenceOffsets,
    regionMean,
    squaredErrorMap,
    ssimMap,
    temporalMaps,
} from './image-metrics.mjs';

const FULL = [0, 0, 1, 1];

/** A w×h interleaved-RGB test card: a diagonal gradient with a bright square. */
function card(w, h, offset = 0) {
    const rgb = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const square = x > w / 3 && x < w / 2 && y > h / 3 && y < h / 2 ? 0.5 : 0;
            for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.min(1, (x + y) / (w + h) + square * (c + 1) / 3 + offset);
        }
    return rgb;
}

describe('referenceOffsets', () => {
    test('are distinct sub-pixel offsets with an exactly zero mean', () => {
        for (const count of [1, 16, 64, 100]) {
            const offsets = referenceOffsets(count);
            const meanX = offsets.reduce((sum, [x]) => sum + x, 0) / count;
            const meanY = offsets.reduce((sum, [, y]) => sum + y, 0) / count;
            expect(Math.abs(meanX)).toBeLessThan(1e-12);
            expect(Math.abs(meanY)).toBeLessThan(1e-12);
            for (const [x, y] of offsets) expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThan(0.55);
            expect(new Set(offsets.map(String)).size).toBe(count);
        }
    });
});

describe('present', () => {
    test('keeps neutral greys neutral, monotonic and inside [0, 1]', () => {
        // Both ACES matrices have rows summing to 1, so a transposed matrix
        // (rows read as columns) tints greys — this pins the orientation.
        const greys = [0, 0.01, 0.18, 1, 4, 64, 1e4];
        const out = present(Float32Array.from(greys.flatMap((v) => [v, v, v])));
        let previous = -1;
        for (let i = 0; i < greys.length; i++) {
            expect(out[i * 3]).toBeCloseTo(out[i * 3 + 1], 5);
            expect(out[i * 3]).toBeCloseTo(out[i * 3 + 2], 5);
            expect(out[i * 3]).toBeGreaterThanOrEqual(previous);
            expect(out[i * 3]).toBeLessThanOrEqual(1);
            previous = out[i * 3];
        }
        expect(out[0]).toBeCloseTo(0, 3);
    });

    test('presents negative linear values as black, like the bench canvas', () => {
        // The ACES fit curves back up below zero; unclamped, RCAS undershoot
        // read up to 29/255 against a black canvas pixel.
        const out = present(Float32Array.from([-0.04, -0.03, -0.02, -0.04, 0.3, 0.3]));
        expect(out[0]).toBe(0);
        expect(out[1]).toBe(0);
        expect(out[2]).toBe(0);
        expect(Array.from(present(Float32Array.from([0, 0.3, 0.3])))).toEqual(Array.from(out.subarray(3)));
    });
});

describe('full-reference metrics', () => {
    test('identical images score PSNR ∞ and SSIM 1; a shift lowers both', () => {
        const w = 48;
        const h = 32;
        const reference = card(w, h);
        expect(psnr(regionMean(squaredErrorMap(reference, reference), w, h, FULL))).toBe(Infinity);
        expect(regionMean(ssimMap(reference, reference, w, h), w, h, FULL, SSIM_BORDER)).toBeCloseTo(1, 6);

        const brighter = card(w, h, 0.1);
        const mse = regionMean(squaredErrorMap(brighter, reference), w, h, FULL);
        expect(psnr(mse)).toBeGreaterThan(15);
        expect(psnr(mse)).toBeLessThan(21);
        expect(regionMean(ssimMap(brighter, reference, w, h), w, h, FULL, SSIM_BORDER)).toBeLessThan(0.99);
        expect(psnr(0.01)).toBeCloseTo(20, 10);
    });
});

describe('temporalMaps', () => {
    test('charges a frozen output for the change it misses, and nothing for tracking it', () => {
        const before = Float32Array.from([0.2, 0.2, 0.2]);
        const after = Float32Array.from([0.5, 0.5, 0.5]);
        const frozen = temporalMaps(before, before, after, before);
        expect(frozen.error[0]).toBeCloseTo(0.3, 6);
        expect(frozen.churn[0]).toBe(0);
        expect(frozen.referenceChurn[0]).toBeCloseTo(0.3, 6);
        const tracking = temporalMaps(after, before, after, before);
        expect(tracking.error[0]).toBe(0);
        expect(tracking.churn[0]).toBeCloseTo(0.3, 6);
    });
});

describe('PNG I/O', () => {
    test('round-trips 8-bit RGB', () => {
        const w = 5;
        const h = 3;
        const rgb = Float32Array.from({ length: w * h * 3 }, (_, i) => (i * 17 % 256) / 255);
        const decoded = decodePng(encodePng(rgb, w, h));
        expect([decoded.width, decoded.height, decoded.bytesPerPixel]).toEqual([w, h, 3]);
        expect([...decoded.raw]).toEqual([...rgb].map((v) => Math.round(v * 255)));
    });
});
