import { describe, expect, it } from 'vitest';

import { parseBenchmarkConfig } from './config';
import { BENCHMARK_SCENARIOS, getBenchmarkScenario, resolveCaptureFrames } from './scenarios';

const capture = (scenario: string) =>
    parseBenchmarkConfig(`?benchMode=capture&scenario=${scenario}&width=1280&height=720`);

describe('benchmark scenario registry', () => {
    it('defines every scenario the page-side allowlist accepts, under its own id', () => {
        for (const id of Object.keys(BENCHMARK_SCENARIOS)) {
            expect(id).toMatch(/^Q\d+$/);
            expect(BENCHMARK_SCENARIOS[id as BenchmarkScenarioId].id).toBe(id);
            expect(capture(id).scenario).toBe(id);
        }
        expect(() => capture('Q99')).toThrow(/Invalid benchmark scenario/);
    });

    it('resolves every capture expression within the scenario', () => {
        for (const scenario of Object.values(BENCHMARK_SCENARIOS))
            for (const period of [8, 18, 32, 72]) {
                const frames = resolveCaptureFrames(scenario.captures, period);
                expect(frames.every((frame) => Number.isInteger(frame) && frame >= 0)).toBe(true);
            }
    });
});

describe('Q13 merged-reactive-masks', () => {
    const q13 = getBenchmarkScenario('Q13');

    it('drives both reactive sources on a still, frozen scene', () => {
        const first = q13.frame(0);
        for (const frame of [1, 23, 64, q13.endFrame]) {
            const state = q13.frame(frame);
            expect(state.reactiveMerge).toBe(true);
            expect(state.animateScene).toBe(false);
            expect(state.particlesVisible).toBe(false);
            expect(state.cameraPosition).toEqual(first.cameraPosition);
            expect(state.cameraTarget).toEqual(first.cameraTarget);
            expect(state.directionalIntensity).toBe(first.directionalIntensity);
        }
    });

    it('captures the reactivity view and declares one ROI per merge region', () => {
        expect(q13.debugViews).toContain('reactivity');
        expect(Object.keys(q13.rois)).toEqual(
            expect.arrayContaining(['explicit_only', 'overlap', 'diff_only']),
        );
    });

    it('is the only scenario that enables the merged-reactive fixture', () => {
        for (const scenario of Object.values(BENCHMARK_SCENARIOS)) {
            if (scenario.id === 'Q13') continue;
            expect(scenario.frame(0).reactiveMerge ?? false).toBe(false);
        }
    });
});

describe('Q16 sparse-wires-empty-background', () => {
    const q16 = getBenchmarkScenario('Q16');

    it('holds a still camera on the sparse-wire scene, light steady until the step', () => {
        const first = q16.frame(0);
        expect(first.scene).toBe('sparse-wires');
        for (const frame of [1, 180, 211, 299, 300, q16.endFrame]) {
            const state = q16.frame(frame);
            expect(state.scene).toBe('sparse-wires');
            expect(state.animateScene).toBe(false);
            expect(state.cameraPosition).toEqual(first.cameraPosition);
            expect(state.cameraTarget).toEqual(first.cameraTarget);
        }
        // Anything the shading-change view shows before 300 is a false positive.
        expect(q16.frame(299).directionalIntensity).toBe(first.directionalIntensity);
        expect(q16.frame(300).directionalIntensity).toBeCloseTo(first.directionalIntensity / 4);
    });

    it('captures the shading-change and disocclusion views', () => {
        expect(q16.debugViews).toEqual(expect.arrayContaining(['shading-change', 'disocclusion']));
    });
});

describe('Q18 fine-line-chart', () => {
    const q18 = getBenchmarkScenario('Q18');

    it('holds a still camera on the chart scene, light steady until the step', () => {
        const first = q18.frame(0);
        expect(first.scene).toBe('chart');
        for (const frame of [1, 180, 211, 299, 300, q18.endFrame]) {
            const state = q18.frame(frame);
            expect(state.scene).toBe('chart');
            expect(state.animateScene).toBe(false);
            expect(state.cameraPosition).toEqual(first.cameraPosition);
            expect(state.cameraTarget).toEqual(first.cameraTarget);
        }
        // Anything the shading-change view shows before 300 is a false positive.
        expect(q18.frame(299).directionalIntensity).toBe(first.directionalIntensity);
        expect(q18.frame(300).directionalIntensity).toBeCloseTo(first.directionalIntensity / 4);
    });

    it('declares the chart regions as ROIs inside the frame', () => {
        expect(q18.debugViews).toEqual(expect.arrayContaining(['shading-change', 'accumulation-age']));
        expect(Object.keys(q18.rois)).toEqual(
            expect.arrayContaining(['bars_vertical', 'bars_horizontal', 'siemens_star', 'flat_swatches']),
        );
        for (const [x, y, w, h] of Object.values(q18.rois)) {
            expect(x + w).toBeLessThanOrEqual(1);
            expect(y + h).toBeLessThanOrEqual(1);
        }
    });
});

describe('Q20 emitter-pan-overshoot', () => {
    const q20 = getBenchmarkScenario('Q20');

    it('converges still, then pans laterally on the hot-spot wall and holds', () => {
        const at = (frame: number) => q20.frame(frame).cameraPosition[0];
        expect(q20.frame(0).scene).toBe('hot-spots');
        expect(at(119)).toBe(at(0));
        expect(at(121)).toBeGreaterThan(at(120));
        expect(at(299)).toBe(at(240));
        expect(at(419)).toBe(at(360));
        // The camera looks straight at the wall: the target pans with it.
        expect(q20.frame(200).cameraTarget[0]).toBe(at(200));
    });
});

describe('Q30 dense-geometry-disocclusion', () => {
    const q30 = getBenchmarkScenario('Q30');
    const position = (frame: number) => q30.frame(frame).cameraPosition;

    it('holds still in every hold segment and moves in the pan and the orbit', () => {
        expect(q30.frame(0).scene).toBe('dense');
        expect(position(59)).toEqual(position(0));
        expect(position(239)).toEqual(position(180));
        expect(position(419)).toEqual(position(360));
        expect(position(61)[0]).toBeGreaterThan(position(60)[0]);
        expect(position(241)).not.toEqual(position(240));
    });

    it('orbits about the panned target at a fixed distance', () => {
        const distance = (frame: number) => {
            const [px, , pz] = position(frame);
            const [tx, , tz] = q30.frame(frame).cameraTarget;
            return Math.hypot(px - tx, pz - tz);
        };
        expect(distance(300)).toBeCloseTo(distance(200), 9);
        expect(q30.frame(300).cameraTarget).toEqual(q30.frame(200).cameraTarget);
    });
});
