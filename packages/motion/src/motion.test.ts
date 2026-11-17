import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { decodeCompare, decodeStats, HISTOGRAM_SLOTS, RESIDUAL_SLOTS } from './MotionAnalyzer';
import { earthMovers, jensenShannon } from './math/histogram';
import { cameraMotionAt } from './math/reprojection';
import { CAMERA_MOTION_SHADER } from './shaders/cameraMotion';
import { HISTOGRAM_BINS, LUMA_HISTOGRAM_SHADER } from './shaders/lumaHistogram';
import {
    COMPARE_CANDIDATE_WORDS,
    COMPARE_CAP_PIXELS,
    COMPARE_FIXED_POINT,
    COMPARE_HEADER_WORDS,
    COMPARE_OBJECT_STRIDE,
    COMPARE_OBJECTS,
    COMPARE_WORDS,
    MOTION_COMPARE_SHADER,
} from './shaders/motionCompare';
import { CANDIDATE_FIELDS, MAX_CANDIDATES, MOTION_RESIDUAL_SHADER, STATS_STRIDE } from './shaders/motionResidual';

//* Camera Helpers
function camera(position: [number, number, number], target: [number, number, number] = [0, 0, 0]) {
    const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 200);
    cam.position.set(...position);
    cam.lookAt(...target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
}

function viewProjection(cam: PerspectiveCamera, projection = cam.projectionMatrix): Matrix4 {
    return new Matrix4().multiplyMatrices(projection, cam.matrixWorldInverse);
}

/** Pixel UV + device depth of a world point as `cam` rasterizes it. */
function rasterize(point: Vector3, cam: PerspectiveCamera, projection = cam.projectionMatrix) {
    const clip = point.clone().applyMatrix4(viewProjection(cam, projection));
    return { uv: [(clip.x + 1) / 2, (1 - clip.y) / 2] as [number, number], depth: clip.z };
}

function ndc(point: Vector3, cam: PerspectiveCamera): [number, number] {
    const p = point.clone().project(cam);
    return [p.x, p.y];
}

describe('cameraMotionAt (CPU mirror of cameraMotion.ts)', () => {
    const point = new Vector3(0.7, 0.4, -1.2);

    it('reports zero motion and the view depth for a still camera', () => {
        const cam = camera([3, 2, 6]);
        const { uv, depth } = rasterize(point, cam);
        const vp = viewProjection(cam);
        const sample = cameraMotionAt(uv, depth, vp.clone().invert().elements, vp.elements, vp.elements, cam.matrixWorldInverse.elements, cam.matrixWorldInverse.elements);
        expect(sample.velocity[0]).toBeCloseTo(0, 6);
        expect(sample.velocity[1]).toBeCloseTo(0, 6);
        const viewDepth = -point.clone().applyMatrix4(cam.matrixWorldInverse).z;
        expect(sample.depth).toBeCloseTo(viewDepth, 4);
        expect(sample.previousDepth).toBeCloseTo(viewDepth, 4);
    });

    it("matches three's projected NDC delta when the camera moves", () => {
        const previous = camera([3, 2, 6]);
        const current = camera([2.6, 2.1, 5.7], [0.1, 0, 0]);
        const { uv, depth } = rasterize(point, current);
        const vp = viewProjection(current);
        const sample = cameraMotionAt(
            uv, depth, vp.clone().invert().elements, vp.elements, viewProjection(previous).elements,
            current.matrixWorldInverse.elements, previous.matrixWorldInverse.elements,
        );
        const [cx, cy] = ndc(point, current);
        const [px, py] = ndc(point, previous);
        expect(sample.velocity[0]).toBeCloseTo(cx - px, 4);
        expect(sample.velocity[1]).toBeCloseTo(cy - py, 4);
        expect(sample.previousDepth).toBeCloseTo(-point.clone().applyMatrix4(previous.matrixWorldInverse).z, 3);
    });

    it('stays jitter-free when the depth was rasterized under a jittered projection', () => {
        const previous = camera([3, 2, 6]);
        const current = camera([2.8, 2, 6.2]);
        // A half-pixel jitter at 960 px wide, applied like setViewOffset does.
        const jittered = current.projectionMatrix.clone();
        jittered.elements[8] += (2 * 0.5) / 960;
        jittered.elements[9] += (2 * -0.25) / 540;
        const { uv, depth } = rasterize(point, current, jittered);
        const sample = cameraMotionAt(
            uv, depth, viewProjection(current, jittered).invert().elements, viewProjection(current).elements,
            viewProjection(previous).elements, current.matrixWorldInverse.elements, previous.matrixWorldInverse.elements,
        );
        const [cx, cy] = ndc(point, current);
        const [px, py] = ndc(point, previous);
        expect(sample.velocity[0]).toBeCloseTo(cx - px, 4);
        expect(sample.velocity[1]).toBeCloseTo(cy - py, 4);
    });

    it('flags a point that was behind the previous camera', () => {
        const previous = camera([0, 0, -3], [0, 0, -10]);
        const current = camera([0, 0, 4]);
        const { uv, depth } = rasterize(new Vector3(0, 0, 0), current);
        const vp = viewProjection(current);
        const sample = cameraMotionAt(
            uv, depth, vp.clone().invert().elements, vp.elements, viewProjection(previous).elements,
            current.matrixWorldInverse.elements, previous.matrixWorldInverse.elements,
        );
        expect(sample.previousDepth).toBe(-1);
        expect(sample.velocity).toEqual([0, 0]);
    });
});

describe('histogram distances', () => {
    it('Jensen–Shannon: 0 when identical, 1 when disjoint, scale-free', () => {
        expect(jensenShannon([1, 2, 3, 0], [2, 4, 6, 0])).toBeCloseTo(0, 9);
        expect(jensenShannon([1, 0], [0, 1])).toBeCloseTo(1, 9);
    });

    it("earth mover's distance counts bins moved", () => {
        expect(earthMovers([1, 0, 0, 0], [0, 0, 1, 0])).toBeCloseTo(2, 9);
        expect(earthMovers([0, 1, 1, 0], [0, 1, 1, 0])).toBe(0);
    });
});

describe('decodeStats', () => {
    it('decodes residual fixed point and shares, skipping unused slots', () => {
        const words = new Uint32Array(RESIDUAL_SLOTS * STATS_STRIDE + HISTOGRAM_SLOTS * HISTOGRAM_BINS);
        const base = 2 * STATS_STRIDE;
        words[base + MAX_CANDIDATES * CANDIDATE_FIELDS + 1] = 100; // pixels
        words[base + MAX_CANDIDATES * CANDIDATE_FIELDS] = 10; // none valid
        // candidate 1: residual sum 0.5 over 50 valid pixels, 40 best, 5 unexplained, 2 beaten
        const c1 = base + CANDIDATE_FIELDS;
        words.set([Math.round(0.5 * 1024), 50, 40, 5, 2, 30], c1);
        words[RESIDUAL_SLOTS * STATS_STRIDE + HISTOGRAM_BINS + 3] = 7;
        const stats = decodeStats(words, new Set([2]), new Set([1]));
        expect(stats.residuals[0]).toBeNull();
        const slot = stats.residuals[2]!;
        expect(slot.pixels).toBe(100);
        expect(slot.noneValid).toBeCloseTo(0.1);
        expect(slot.candidates[1].meanResidual).toBeCloseTo(0.01, 4);
        expect(slot.candidates[1]).toMatchObject({ valid: 0.5, best: 0.4, unexplained: 0.05, beaten: 0.02, moving: 0.3 });
        expect(stats.histograms[0]).toBeNull();
        expect(stats.histograms[1]![3]).toBe(7);
        expect(stats.compare).toBeNull();
    });

    it('decodes the oracle comparison per object, after the histograms', () => {
        const offset = RESIDUAL_SLOTS * STATS_STRIDE + HISTOGRAM_SLOTS * HISTOGRAM_BINS;
        const words = new Uint32Array(offset + COMPARE_WORDS);
        const base = offset + 3 * COMPARE_OBJECT_STRIDE;
        // Object 3: 200 valid pixels moving 1.5 px; candidate 1 errs 0.25 px on average.
        words.set([200, 4, 200 * 1.5 * COMPARE_FIXED_POINT], base);
        words.set([200 * 0.25 * COMPARE_FIXED_POINT, 50, 10], base + COMPARE_HEADER_WORDS + COMPARE_CANDIDATE_WORDS);
        const compare = decodeStats(words, new Set(), new Set(), true).compare!;
        expect(compare).toHaveLength(COMPARE_OBJECTS);
        expect(compare[0].valid).toBe(0);
        expect(compare[3]).toMatchObject({ valid: 200, noPrevious: 4, meanMotion: 1.5 });
        expect(compare[3].candidates[1]).toEqual({ meanError: 0.25, over025: 0.25, over1: 0.05 });
        expect(decodeCompare(words.subarray(offset))[3].valid).toBe(200);
    });

    it('cannot overflow the capped sums of a full frame up to 1920×1080', () => {
        expect(1920 * 1080 * COMPARE_CAP_PIXELS * COMPARE_FIXED_POINT).toBeLessThan(2 ** 32);
    });
});

describe('motion shader structure', () => {
    const bindings = (code: string) => [...code.matchAll(/@binding\((\d+)\)/g)].map((match) => Number(match[1]));

    it.each([
        ['cameraMotion', CAMERA_MOTION_SHADER, 4],
        ['motionResidual', MOTION_RESIDUAL_SHADER, 11],
        ['lumaHistogram', LUMA_HISTOGRAM_SHADER, 3],
        ['motionCompare', MOTION_COMPARE_SHADER, 6],
    ])('%s: 8×8 main entry, contiguous bindings, uniform at 0', (_name, code, count) => {
        expect(code).toMatch(/@compute @workgroup_size\(8, 8\)\s*\nfn main\(/);
        expect(bindings(code)).toEqual(Array.from({ length: count }, (_, i) => i));
        expect(code).toMatch(/@binding\(0\) var<uniform>/);
        // WGSL reserves these (CLAUDE.md landmine 9).
        expect(code).not.toMatch(/\b(let|var) (target|filter|enum|mat)\b/);
    });

    it('reduces into a workgroup array no larger than the workgroup', () => {
        expect(MAX_CANDIDATES * CANDIDATE_FIELDS + 2).toBeLessThanOrEqual(Math.min(64, STATS_STRIDE));
        expect(HISTOGRAM_BINS).toBe(64);
    });
});
