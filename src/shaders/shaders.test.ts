import { describe, expect, it } from 'vitest';

import { BenchmarkClock } from '../../bench/src/benchmark/clock';
import { BenchmarkCollector } from '../../bench/src/benchmark/collector';
import {
    getBenchmarkScenario,
    resolveCaptureFrames,
} from '../../bench/src/benchmark/scenarios';
import {
    SingleVariantRegistry,
    getActiveResolverCount,
} from '../../bench/src/benchmark/variants';
import { ComputePass } from '../internal/ComputePass';
import { ACCUMULATE_SHADER } from './accumulate';
import { BLIT_SHADER } from './blit';
import {
    DEBUG_SOURCE_FILTER_SHADER,
    DEBUG_SOURCE_RESOLVER_SHADER,
    DEBUG_SOURCE_STRUCTURAL_SHADER,
} from './candidateDebug';
import {
    ACCUMULATE_SOURCE_FILTER_SHADER,
    ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
    EASU_SOURCE_APPROX_SHADER,
} from './candidateFilters';
import {
    DEPTH_CLIP_SOURCE_SHADER,
    GENERATE_REACTIVE_SOURCE_SHADER,
    PREPARE_INPUTS_SOURCE_SHADER,
    PREPARE_REACTIVITY_SOURCE_SHADER,
} from './candidateInputs';
import {
    ACCUMULATE_SOURCE_RESOLVER_SHADER,
    EXPOSURE_HISTORY_SOURCE_SHADER,
    LUMA_INSTABILITY_SOURCE_SHADER,
    LUMA_SPD_SOURCE_SHADER,
    SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
    SHADING_CHANGE_SPD_SOURCE_SHADER,
} from './candidateTemporal';
import { DEBUG_SHADER } from './debug';
import { EASU_SHADER } from './easu';
import { GENERATE_REACTIVE_SHADER } from './generateReactive';
import { LUMINANCE_PYRAMID_SHADER } from './luminancePyramid';
import { RCAS_LEGACY_SHADER, RCAS_SHADER } from './rcas';
import { RECONSTRUCT_SHADER } from './reconstruct';
import { assembleShader } from './wgsl';

const ALL_SHADERS: Record<string, string> = {
    blit: BLIT_SHADER,
    easu: EASU_SHADER,
    rcas: RCAS_SHADER,
    reconstruct: RECONSTRUCT_SHADER,
    accumulate: ACCUMULATE_SHADER,
    luminancePyramid: LUMINANCE_PYRAMID_SHADER,
    generateReactive: GENERATE_REACTIVE_SHADER,
    debug: DEBUG_SHADER,
};

const BASELINE_BINDING_COUNTS: Record<string, number> = {
    blit: 5,
    easu: 3,
    rcas: 4,
    reconstruct: 7,
    accumulate: 11,
    luminancePyramid: 6,
    generateReactive: 4,
    debug: 10,
};

const BASELINE_FINGERPRINTS: Record<string, string> = {
    blit: '673108e1',
    easu: '11632358',
    rcas: 'c803572b',
    reconstruct: '1ced83aa',
    accumulate: 'd0973222',
    luminancePyramid: '7a806c41',
    generateReactive: '6ed4b549',
    debug: 'e30ebd6c',
};

const CANDIDATE_SHADERS: Record<string, string> = {
    easuSourceApprox: EASU_SOURCE_APPROX_SHADER,
    exposureHistory: EXPOSURE_HISTORY_SOURCE_SHADER,
    generateReactiveSource: GENERATE_REACTIVE_SOURCE_SHADER,
    prepareInputsSource: PREPARE_INPUTS_SOURCE_SHADER,
    depthClipSource: DEPTH_CLIP_SOURCE_SHADER,
    prepareReactivitySource: PREPARE_REACTIVITY_SOURCE_SHADER,
    accumulateSourceFilter: ACCUMULATE_SOURCE_FILTER_SHADER,
    accumulateSourceStructural: ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
    lumaSpdSource: LUMA_SPD_SOURCE_SHADER,
    shadingSpdSource: SHADING_CHANGE_SPD_SOURCE_SHADER,
    shadingResolveSource: SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
    lumaInstabilitySource: LUMA_INSTABILITY_SOURCE_SHADER,
    accumulateSourceResolver: ACCUMULATE_SOURCE_RESOLVER_SHADER,
    debugSourceFilter: DEBUG_SOURCE_FILTER_SHADER,
    debugSourceStructural: DEBUG_SOURCE_STRUCTURAL_SHADER,
    debugSourceResolver: DEBUG_SOURCE_RESOLVER_SHADER,
};

const CANDIDATE_BINDING_COUNTS: Record<string, number> = {
    easuSourceApprox: 3,
    exposureHistory: 7,
    generateReactiveSource: 4,
    prepareInputsSource: 8,
    depthClipSource: 5,
    prepareReactivitySource: 11,
    accumulateSourceFilter: 12,
    accumulateSourceStructural: 11,
    lumaSpdSource: 9,
    shadingSpdSource: 9,
    shadingResolveSource: 3,
    lumaInstabilitySource: 9,
    accumulateSourceResolver: 11,
    debugSourceFilter: 10,
    debugSourceStructural: 10,
    debugSourceResolver: 10,
};

function fingerprint(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('assembleShader', () => {
    it('deduplicates shared chunks', () => {
        const chunk = 'fn shared() -> f32 { return 1.0; }';
        const out = assembleShader(chunk, 'fn other() {}', chunk);
        expect(out.match(/fn shared/g)).toHaveLength(1);
    });

    it('drops empty parts', () => {
        expect(assembleShader('', 'fn a() {}', '  ')).toBe('fn a() {}\n');
    });
});

// Structural sanity for every assembled WGSL module — catches include
// mistakes (missing constants block, duplicate helpers, unbalanced braces)
// long before a GPU sees the source.
describe.each(Object.entries(ALL_SHADERS))('%s shader', (_name, source) => {
    it('has exactly one compute entry point named main', () => {
        expect(source.match(/@compute/g)).toHaveLength(1);
        expect(source).toMatch(/@compute @workgroup_size\(8, 8\)\s*\nfn main\(/);
    });

    it('binds the shared constants block at binding 0', () => {
        expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
        expect(source).toContain('@group(0) @binding(0) var<uniform> C : FsrConstants;');
    });

    it('has balanced braces and parens', () => {
        const count = (re: RegExp) => (source.match(re) ?? []).length;
        expect(count(/\{/g)).toBe(count(/\}/g));
        expect(count(/\(/g)).toBe(count(/\)/g));
    });

    it('declares no duplicate function names', () => {
        const names = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]);
        expect(new Set(names).size).toBe(names.length);
    });

    it('guards the dispatch grid against overrun', () => {
        expect(source).toMatch(
            /if \(any\(vec2f\(gid\.xy\) >= C\.(displaySize|renderSize)\)\) \{ return; \}/,
        );
    });

    it('keeps the reviewed production assembly', () => {
        expect(fingerprint(source)).toBe(BASELINE_FINGERPRINTS[_name]);
    });

    it('contains only the active baseline bindings and body', () => {
        const bindings = [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((match) =>
            Number(match[1]),
        );
        expect(bindings).toEqual(
            Array.from({ length: BASELINE_BINDING_COUNTS[_name] }, (_, index) => index),
        );
        expect(source).not.toMatch(/(?:^|\n)\s*override\s+|E00_CANDIDATE|candidate algorithm/i);
    });
});

describe.each(Object.entries(CANDIDATE_SHADERS))(
    '%s candidate shader',
    (name, source) => {
        it('assembles as one independent 8x8 pipeline', () => {
            expect(source.match(/@compute/g)).toHaveLength(1);
            expect(source).toMatch(/@compute @workgroup_size\(8, 8\)\s*\nfn main\(/);
            expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
            expect(source).toContain(
                '@group(0) @binding(0) var<uniform> C : FsrConstants;',
            );
            expect(source).toMatch(
                /if \(any\(vec2f\(gid\.xy\) >= C\.(displaySize|renderSize)\)\) \{ return; \}/,
            );
        });

        it('has contiguous candidate-only bindings', () => {
            const bindings = [
                ...source.matchAll(/@group\(0\) @binding\((\d+)\)/g),
            ].map((match) => Number(match[1]));
            expect(bindings).toEqual(
                Array.from(
                    { length: CANDIDATE_BINDING_COUNTS[name] },
                    (_, index) => index,
                ),
            );
        });

        it('has balanced syntax and unique function names', () => {
            const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
            expect(count(/\{/g)).toBe(count(/\}/g));
            expect(count(/\(/g)).toBe(count(/\)/g));
            const names = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)].map(
                (match) => match[1],
            );
            expect(new Set(names).size).toBe(names.length);
        });

        it('keeps presentation transforms outside the candidate', () => {
            expect(source).not.toMatch(/acesFilm|srgbEncode|displayTransform/);
        });
    },
);

describe('source candidate bundle structure', () => {
    it('keeps filter and resolver history-alpha semantics separate', () => {
        expect(ACCUMULATE_SOURCE_FILTER_SHADER).toContain(
            'newCount / C.maxAccumulation',
        );
        expect(ACCUMULATE_SOURCE_RESOLVER_SHADER).toContain(
            'vec4f(result, lock)',
        );
        expect(ACCUMULATE_SOURCE_RESOLVER_SHADER).not.toContain(
            'newCount / C.maxAccumulation',
        );
    });

    it('authors atomic depth scatter and distinct reactivity channels', () => {
        expect(PREPARE_INPUTS_SOURCE_SHADER).toContain(
            'atomicMax(&reconstructedDepth.values[index], encoded);',
        );
        expect(PREPARE_INPUTS_SOURCE_SHADER).toContain(
            'override PREPARE_STRUCTURAL_SIGNALS : bool = false;',
        );
        expect(DEPTH_CLIP_SOURCE_SHADER).toContain(
            'override DEPTH_CLIP_MOTION_DIVERGENCE : bool = false;',
        );
        expect(PREPARE_REACTIVITY_SOURCE_SHADER).toContain(
            'vec4f(softReactive, disocclusion, shading',
        );
        expect(PREPARE_REACTIVITY_SOURCE_SHADER).toContain(
            'aggressiveReactive = max(',
        );
        expect(PREPARE_REACTIVITY_SOURCE_SHADER).toContain(
            'accumulation = min(accumulation + 1.0 / max(C.maxAccumulation, 1.0), 1.0);',
        );
    });

    it('tracks conditioning and host pre-exposure independently', () => {
        expect(EXPOSURE_HISTORY_SOURCE_SHADER).toContain(
            'vec4f(conditioning, averageLuma, host',
        );
        expect(ACCUMULATE_SOURCE_FILTER_SHADER).toContain(
            'currentHost / previousHost',
        );
        expect(ACCUMULATE_SOURCE_RESOLVER_SHADER).toContain(
            'currentFrameInfo.b / max(previousFrameInfo.b',
        );
    });

    it('provides both SPD chains and persistent four-frame luma state', () => {
        expect(LUMA_SPD_SOURCE_SHADER).toContain(
            'var lumaMip2 : texture_storage_2d<rgba16float, write>',
        );
        expect(SHADING_CHANGE_SPD_SOURCE_SHADER).toContain(
            'fn signedDifference(',
        );
        expect(LUMA_INSTABILITY_SOURCE_SHADER).toContain(
            'history = vec4f(current, history.xyz);',
        );
        expect(SHADING_CHANGE_SPD_SOURCE_SHADER).toContain(
            'if (hasFlag(FLAG_RESET)) { return vec2f(0.0); }',
        );
        expect(LUMA_INSTABILITY_SOURCE_SHADER).toContain(
            'var history = vec4f(currentHostLuma);',
        );
    });

    it('keeps reconstruction weights independent from clamped border loads', () => {
        for (const source of [
            ACCUMULATE_SOURCE_FILTER_SHADER,
            ACCUMULATE_SOURCE_RESOLVER_SHADER,
        ]) {
            expect(source).toContain('let tapCoord = sourceBase + vec2i(x, y);');
            expect(source).toContain('let offset = vec2f(tapCoord) - sourcePosition;');
        }
    });
});

describe('FSR 3.1.5 RCAS numeric parity', () => {
    it('keeps a separate pipeline body with the source limiter and denoise luma', () => {
        expect(RCAS_SHADER).not.toBe(RCAS_LEGACY_SHADER);
        expect(RCAS_SHADER).toContain('let lowerLimiterMultiplier = clamp(');
        expect(RCAS_SHADER).toContain('let eL = 0.5 * e.r + e.g + 0.5 * e.b;');
        expect(RCAS_SHADER).toContain('let mn = min(min(min(bL, dL), eL), min(fL, hL));');
        expect(RCAS_SHADER).toContain(
            'let hitMin = mn4 / (4.0 * mx4) * lowerLimiterMultiplier;',
        );
        expect(RCAS_LEGACY_SHADER).not.toContain('lowerLimiterMultiplier');
    });
});

describe('linear HDR output domain', () => {
    it('keeps presentation transforms out of upscaling shaders', () => {
        for (const source of [BLIT_SHADER, EASU_SHADER, RCAS_SHADER]) {
            expect(source).not.toMatch(/acesFilm|srgbEncode|displayTransform/);
        }
    });

    it('writes final and debug output through rgba16float storage', () => {
        for (const source of [BLIT_SHADER, RCAS_SHADER, DEBUG_SHADER]) {
            expect(source).toContain('texture_storage_2d<rgba16float, write>');
            expect(source).not.toContain('texture_storage_2d<rgba8unorm, write>');
        }
    });
});

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

    it('threads optional pipeline constants and metadata', () => {
        let descriptor: GPUComputePipelineDescriptor | null = null;
        const pipeline = { getBindGroupLayout: () => ({}) } as unknown as GPUComputePipeline;
        const device = {
            createShaderModule: () => ({}),
            createComputePipeline: (value: GPUComputePipelineDescriptor) => {
                descriptor = value;
                return pipeline;
            },
        } as unknown as GPUDevice;
        const pass = new ComputePass(device, 'test', '@compute fn main() {}', {
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
