import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

import { decodePng } from './image-metrics.mjs';
import {
    aggregate,
    defaultHeatFrames,
    expandConditions,
    heatToPng,
    relativeDelta,
    scenarioPlan,
    summarizeSegments,
} from './motion-stability.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const registry = await import(pathToFileURL(join(ROOT, 'bench/src/benchmark/scenarios.ts')).href);
const warp = (meanError, extra = {}) => ({ meanError, scored: 0.9, occluded: 0.05, over: 0.01, offscreen: 0.05, ...extra });

describe('scenarioPlan', () => {
    test('Q19 takes its segments from the bench registry', () => {
        const plan = scenarioPlan('Q19', registry);
        expect(plan.segments).toEqual(registry.Q19_SEGMENTS.map((s) => ({ ...s })));
        expect(plan.end).toBe(registry.BENCHMARK_SCENARIOS.Q19.endFrame);
    });

    test('Q21 takes its segments from the bench registry and covers the scenario', () => {
        const plan = scenarioPlan('Q21', registry);
        expect(plan.segments).toEqual(registry.Q21_SEGMENTS.map((s) => ({ ...s })));
        expect(plan.segments.at(-1).end).toBe(registry.BENCHMARK_SCENARIOS.Q21.endFrame);
        expect(plan.end).toBe(registry.BENCHMARK_SCENARIOS.Q21.endFrame);
    });

    test('Q4 and Q3 cover their scenario exactly, contiguously', () => {
        for (const id of ['Q4', 'Q3']) {
            const plan = scenarioPlan(id, registry);
            expect(plan.segments[0].start).toBe(0);
            expect(plan.segments.at(-1).end).toBe(registry.BENCHMARK_SCENARIOS[id].endFrame);
            for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].start).toBe(plan.segments[i - 1].end + 1);
        }
    });

    test('rejects a scenario without a plan', () => {
        expect(() => scenarioPlan('Q1', registry)).toThrowError(/No motion-stability plan/);
    });
});

describe('expandConditions', () => {
    test('one variant: conditions are named by mode; native runs once', () => {
        expect(expandConditions(['native', 'temporal'], ['production'])).toEqual([
            { name: 'native', path: 'native', variant: null },
            { name: 'temporal', path: 'temporal', variant: 'production' },
        ]);
    });

    test('two variants: every upscaled mode runs both', () => {
        expect(expandConditions(['native', 'spatial', 'temporal'], ['a', 'b']).map((c) => c.name)).toEqual([
            'native',
            'spatial@a',
            'spatial@b',
            'temporal@a',
            'temporal@b',
        ]);
    });

    test('reference, like native, has no upscaler and runs once', () => {
        expect(expandConditions(['reference', 'temporal'], ['a', 'b'])).toEqual([
            { name: 'reference', path: 'reference', variant: null },
            { name: 'temporal@a', path: 'temporal', variant: 'a' },
            { name: 'temporal@b', path: 'temporal', variant: 'b' },
        ]);
    });

    test('rejects unknown modes and repeated variants', () => {
        expect(() => expandConditions(['taa'], ['a'])).toThrowError(/Unknown mode taa/);
        expect(() => expandConditions(['temporal'], ['a', 'a'])).toThrowError(/Repeated variant/);
        expect(() => expandConditions(['temporal'], [])).toThrowError(/At least one variant/);
    });
});

describe('summarizeSegments / aggregate', () => {
    const segments = [
        { name: 'still', start: 0, end: 9 },
        { name: 'pan', start: 10, end: 19 },
        { name: 'hold-1', start: 20, end: 29 },
        { name: 'dolly', start: 30, end: 39 },
    ];

    test('averages per segment, skips frames without a warp and segments before the window', () => {
        const frames = [
            { frame: 8, warp: warp(1) },
            { frame: 10, warp: null },
            { frame: 11, warp: warp(0.002) },
            { frame: 12, warp: warp(0.004, { scored: 0.7 }) },
            { frame: 25, warp: warp(0.0002) },
            { frame: 30, warp: warp(0.006) },
        ];
        const rows = summarizeSegments(frames, segments, 10);
        expect(rows.map((r) => r.segment)).toEqual(['pan', 'hold-1', 'dolly']);
        expect(rows[0]).toMatchObject({ hold: false, frames: 2, maxError: 0.004 });
        expect(rows[0].meanError).toBeCloseTo(0.003, 12);
        expect(rows[0].scored).toBeCloseTo(0.8, 12);
        expect(rows[1]).toMatchObject({ hold: true, frames: 1 });

        const totals = aggregate(rows);
        // Segments weigh equally: (0.003 + 0.006) / 2, not a frame-weighted mean.
        expect(totals.motion).toBeCloseTo(0.0045, 12);
        expect(totals.holds).toBeCloseTo(0.0002, 12);
        expect(totals.motionMax).toBe(0.006);
    });

    test('an empty segment reads null, not 0', () => {
        const rows = summarizeSegments([], segments, 0);
        expect(rows[0]).toMatchObject({ frames: 0, meanError: null, maxError: null });
        expect(aggregate(rows)).toEqual({ motion: null, holds: null, motionMax: null });
    });
});

test('relativeDelta', () => {
    expect(relativeDelta(0.002, 0.003)).toBeCloseTo(0.5, 12);
    expect(relativeDelta(0, 0.003)).toBeNull();
    expect(relativeDelta(null, 0.003)).toBeNull();
});

test('defaultHeatFrames: the middle of each measured motion segment', () => {
    const plan = scenarioPlan('Q19', registry);
    const frames = defaultHeatFrames(plan.segments, plan.start);
    expect(frames).toContain(149); // dolly-back 120–179
    expect(frames.every((frame) => frame >= plan.start)).toBe(true);
    expect(frames).toHaveLength(plan.segments.filter((s) => !/^(still|hold)/.test(s.name)).length);
});

test('heatToPng drops alpha and round-trips through the PNG decoder', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 128, 255, 7, 1, 2, 3, 0, 40, 50, 60, 255]);
    const png = heatToPng({ width: 2, height: 2, rgba: Buffer.from(rgba).toString('base64') });
    const image = decodePng(png);
    expect([image.width, image.height, image.bytesPerPixel]).toEqual([2, 2, 3]);
    expect([...image.raw]).toEqual([255, 0, 0, 0, 128, 255, 1, 2, 3, 40, 50, 60]);
    expect(() => heatToPng({ width: 2, height: 2, rgba: 'AAAA' })).toThrowError(/expected 16/);
});
