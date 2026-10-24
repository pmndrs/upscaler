import { describe, expect, it } from 'vitest';
import { ComputePass } from '@pmndrs/upscaler-core/internal/ComputePass';

import { BenchmarkClock } from './clock';
import { BenchmarkCollector } from './collector';
import { getBenchmarkScenario, resolveCaptureFrames } from './scenarios';
import { SingleVariantRegistry, getActiveResolverCount } from './variants';

describe('E00 benchmark foundation', () => {
    it('enforces a single active resolver without a GPU', () => {
        let created = 0;
        let disposed = 0;
        const metadata: BenchmarkVariantMetadata = {
            id: 'baseline',
            name: 'fake baseline',
            supportedRatios: [2],
            settings: {},
            resourceGraph: [],
            pipeline: {
                shaderKey: 'fake',
                pipelineKey: 'fake',
                assembledChunks: [],
                wgslOverrides: {},
                timingPassLabels: ['fake'],
            },
        };
        const fakeResolver = {
            dispose: () => disposed++,
        } as unknown as BenchmarkResolver;
        const registry = new SingleVariantRegistry([
            {
                metadata,
                create: () => {
                    created++;
                    return fakeResolver;
                },
            },
        ]);

        expect(registry.resolve('baseline', 2)).toBe(metadata);
        expect(() => registry.resolve('unknown', 2)).toThrow(/Unknown benchmark variant/);
        expect(() => registry.resolve('baseline', 3)).toThrow(/does not support ratio/);
        expect(created).toBe(0);
        expect(registry.create('baseline', 2, {})).toBe(fakeResolver);
        expect(getActiveResolverCount()).toBe(1);
        expect(() => registry.create('baseline', 2, {})).toThrow(/already active/);
        expect(created).toBe(1);
        registry.disposeActive();
        expect(disposed).toBe(1);
        expect(getActiveResolverCount()).toBe(0);
    });

    it('registers three distinct cumulative candidate profiles', () => {
        const registry = new SingleVariantRegistry();
        const filter = registry.resolve('source-filter-bundle-v1', 2);
        const structural = registry.resolve('source-structural-bundle-v1', 2);
        const resolver = registry.resolve('source-spd-resolver-bundle-v1', 2);

        expect(
            new Set([
                filter.pipeline.pipelineKey,
                structural.pipeline.pipelineKey,
                resolver.pipeline.pipelineKey,
            ]).size,
        ).toBe(3);
        expect(filter.pipeline.wgslOverrides).toMatchObject({
            prepareStructuralSignals: false,
            depthClipMotionDivergence: false,
        });
        expect(structural.pipeline.wgslOverrides).toMatchObject({
            prepareStructuralSignals: true,
            depthClipMotionDivergence: true,
        });
        expect(filter.resourceGraph).toContain('prepare-inputs-atomic-depth');
        expect(filter.resourceGraph).not.toContain(
            'prepare-inputs-atomic-depth-farthest-luma',
        );
        expect(structural.resourceGraph).toContain(
            'prepare-inputs-atomic-depth-farthest-luma',
        );
        expect(resolver.resourceGraph).toContain('source-resolver-history-lock-alpha');
    });

    it('uses an integer 60 Hz clock and exact scenario events', () => {
        const clock = new BenchmarkClock();
        expect(clock.step()).toBe(0);
        expect(clock.frame).toBe(1);
        expect(clock.time).toBe(1 / 60);
        clock.seek(120);
        expect(clock.time).toBe(2);
        clock.reset();
        expect(clock.frame).toBe(0);

        expect(getBenchmarkScenario('Q9').frame(60).directionalIntensity).toBe(8);
        expect(getBenchmarkScenario('Q9').frame(179).directionalIntensity).toBe(2);
        expect(getBenchmarkScenario('Q10').frame(120).resize).toEqual({
            width: 1280,
            height: 720,
            devicePixelRatio: 1,
        });
        expect(getBenchmarkScenario('Q6', 'gtao').unsupported).toBeNull();
        expect(getBenchmarkScenario('Q7').unsupported).toBeNull();
        expect(getBenchmarkScenario('Q8', 'recurrent').unsupported).toBeNull();
        expect(resolveCaptureFrames(['0', 'P-1', 'P', '2*P-1'], 32)).toEqual([
            0, 31, 32, 63,
        ]);
    });

    it('summarizes fresh samples and reports missing frames', () => {
        const collector = new BenchmarkCollector([10, 11, 12]);
        collector.add([
            {
                frameTag: 10,
                sequence: 1,
                passes: [
                    { label: 'a', milliseconds: 1 },
                    { label: 'b', milliseconds: 2 },
                ],
            },
            {
                frameTag: 11,
                sequence: 2,
                passes: [
                    { label: 'a', milliseconds: 3 },
                    { label: 'b', milliseconds: 4 },
                ],
            },
        ]);
        const summary = collector.summarize();
        expect(summary.missingFrameCount).toBe(1);
        expect(summary.computeSum.samples).toEqual([3, 7]);
        expect(summary.computeSum.median).toBe(5);
        expect(summary.passes.find((pass) => pass.label === 'a')?.p95).toBe(2.9);
        expect(summary.invalidityCount).toBe(1);
    });

    it('rejects malformed authoritative timing evidence', () => {
        const collector = new BenchmarkCollector([20, 21]);
        collector.add([
            {
                frameTag: 19,
                sequence: 0,
                passes: [{ label: 'a', milliseconds: 1 }],
            },
            {
                frameTag: 20,
                sequence: 1,
                passes: [
                    { label: 'a', milliseconds: 1 },
                    { label: 'a', milliseconds: -1 },
                ],
            },
            {
                frameTag: 21,
                sequence: 2,
                passes: [{ label: 'b', milliseconds: 2 }],
            },
        ]);
        const summary = collector.summarize();
        expect(summary.unexpectedFrameCount).toBe(1);
        expect(summary.duplicatePassLabelCount).toBe(1);
        expect(summary.invalidValueCount).toBe(1);
        expect(summary.invalidityCount).toBeGreaterThan(0);
        expect(summary.computeSum.samples).toEqual([2]);
    });

    it('threads optional pipeline constants and metadata', async () => {
        let descriptor: GPUComputePipelineDescriptor | null = null;
        const pipeline = { getBindGroupLayout: () => ({}) } as unknown as GPUComputePipeline;
        const device = {
            createShaderModule: () => ({}),
            lost: new Promise<GPUDeviceLostInfo>(() => {}),
            createComputePipelineAsync: (value: GPUComputePipelineDescriptor) => {
                descriptor = value;
                return pipeline;
            },
        } as unknown as GPUDevice;
        const pass = await ComputePass.create(device, 'test', '@compute fn main() {}', {
            constants: { SAMPLE_COUNT: 4 },
            shaderKey: 'test-key',
            assembledChunks: ['common', 'body'],
        });

        expect(descriptor!.compute.constants).toEqual({ SAMPLE_COUNT: 4 });
        expect(pass.metadata).toEqual({
            shaderKey: 'test-key',
            constants: { SAMPLE_COUNT: 4 },
            assembledChunks: ['common', 'body'],
        });
    });
});
