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
import * as accumulateModule from './accumulate';
import { ACCUMULATE_SHADER } from './accumulate';
import * as blitModule from './blit';
import { BLIT_SHADER } from './blit';
import { DEBUG_SHADER } from './debug';
import * as easuModule from './easu';
import { EASU_SHADER } from './easu';
import { GENERATE_REACTIVE_SHADER } from './generateReactive';
import { LUMINANCE_PYRAMID_SHADER } from './luminancePyramid';
import { MOMENTS_SHADER } from './moments';
import * as rcasModule from './rcas';
import {
    RCAS_HOISTED_EXPOSURE_SHADER,
    RCAS_LEGACY_SHADER,
    RCAS_PER_TAP_SHADER,
    RCAS_SHADER,
    RCAS_TONEMAP_SPACE_SHADER,
} from './rcas';
import { RECONSTRUCT_SHADER } from './reconstruct';
import { SHADING_CHANGE_SHADER } from './shadingChange';
import { assembleShader } from './wgsl';

const ALL_SHADERS: Record<string, string> = {
    blit: BLIT_SHADER,
    easu: EASU_SHADER,
    rcas: RCAS_SHADER,
    reconstruct: RECONSTRUCT_SHADER,
    shadingChange: SHADING_CHANGE_SHADER,
    accumulate: ACCUMULATE_SHADER,
    luminancePyramid: LUMINANCE_PYRAMID_SHADER,
    generateReactive: GENERATE_REACTIVE_SHADER,
    debug: DEBUG_SHADER,
    moments: MOMENTS_SHADER,
};

const BASELINE_BINDING_COUNTS: Record<string, number> = {
    // blit 6 / rcas 5 since 2026-08-25: the alpha-source binding (issue #15).
    blit: 6,
    easu: 3,
    rcas: 5,
    reconstruct: 7,
    shadingChange: 9,
    accumulate: 13,
    luminancePyramid: 7,
    // 5 since 2026-07-22: incoming-mask binding for merge-not-overwrite.
    generateReactive: 5,
    debug: 10,
    // Added 2026-07-22: standalone signal-agnostic moments (guides spec M5).
    moments: 4,
};

const BASELINE_FINGERPRINTS: Record<string, string> = {
    // Updated 2026-08-25: alpha passthrough (issue #15) — blit/rcas gained the
    // alpha-source binding, easu carries alpha as a fourth kernel channel.
    blit: 'ef2eec52',
    easu: '48248d62',
    // Updated 2026-07-21: conditioned-space sharpening adopted (NEXT-STEPS item 1);
    // 2026-08-25: alpha passthrough; 2026-10-02: the spatial path conditions its
    // linear/HDR taps the same way (anchored, gain-capped inversion);
    // 2026-10-02: the temporal inversion is gain-capped too (issue #32).
    rcas: '0addd34e',
    // Updated 2026-07-22: depth-clip flicker fix — reference tap-skip semantics
    // (no all-taps veto), jitter-delta-compensated reprojection, and a
    // neighborhood-relief-widened separation tolerance (grazing-angle planes).
    reconstruct: '669ee05e',
    // Added 2026-07-21: multi-scale shading-change detector (NEXT-STEPS item 4);
    // 2026-10-03: the contrast floor reads both frames' spread, not just the
    // current frame's (issue #22, NEXT-STEPS §9).
    shadingChange: '061f55cd',
    // Updated 2026-07-21: DeltaPreExposure history correction (NEXT-STEPS item 2);
    // 2026-08-25: alpha resolved alongside color into the locks buffer's .a;
    // 2026-10-02: the alpha clamp takes the color path's still-scene relax;
    // 2026-10-02: alphaRelax guarded against STILL_CLAMP_RELAX = 0 (NEXT-STEPS
    // §8) — GPU captures byte-identical at the shipped 8;
    // 2026-10-03: clipToAABB's epsilon moved onto the extents too, so a
    // zero-extent (achromatic) axis no longer collapses the clip (issue #51,
    // NEXT-STEPS §11).
    accumulate: '76b5017b',
    luminancePyramid: 'b74eee0d',
    // Updated 2026-07-22: reactive merge-not-overwrite (guides spec M3) — the
    // generator max-merges an incoming mask instead of being suppressed by it.
    generateReactive: '9d0739e5',
    debug: 'e30ebd6c',
    // Added 2026-07-22: standalone signal-agnostic moments (guides spec M5).
    moments: 'ec1952d4',
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

describe('RCAS on the spatial path', () => {
    // FSR1's limiter assumes [0,1]. On linear HDR, hitMax switches sharpening
    // off wherever the ring straddles 1.0 and divides 0/0 on a flat 1.0 ring,
    // so production RCAS conditions the spatial path's taps like the temporal
    // path's history (GPU probes, 2026-10-02).
    it('conditions linear taps only when the input is not accumulate history', () => {
        const conditioned = RCAS_SHADER.split('if (!hasFlag(FLAG_INPUT_REINHARD)) {')[1] ?? '';
        expect(conditioned).not.toBe('');
        for (const tap of ['b', 'd', 'e', 'f', 'h']) {
            expect(RCAS_SHADER).toContain(`var ${tap} = ${tap}In;`);
            expect(conditioned).toContain(`${tap} = tonemapInvertible(${tap}In);`);
        }
    });

    it('inverts once, anchored on the linear center and capped at linear RCAS gain', () => {
        expect(RCAS_SHADER).toContain(
            'eIn + tonemapInvert(max(pix, vec3f(0.0))) - tonemapInvert(e),',
        );
        expect(RCAS_SHADER).toContain('let maxGain = 1.0 / (1.0 - 4.0 * RCAS_LIMIT * peak);');
        expect(RCAS_SHADER).toContain('maxIn * maxGain');
    });

    it('leaves the frozen benchmark forms sharpening in linear space', () => {
        for (const source of [
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(source).not.toContain('tonemapInvertible(eIn)');
            expect(source).toContain('let e = rcasLoad(sp');
        }
    });
});

describe('RCAS on the temporal path', () => {
    // Sharpening conditioned history and inverting once can push an isolated
    // peak to ~1 in conditioned space, which inverts to a ~1000x firefly
    // (issue #32: a lone sub-pixel 16 on black became 1754; converged Q1/Q2
    // highlights reached 316/423 next to ~17/~65 neighbours).
    it('caps the single inversion at linear RCAS gain over the inverted tap maximum', () => {
        const temporal = RCAS_SHADER.split('if (hasFlag(FLAG_INPUT_REINHARD)) {')[1]?.split('} else {')[0] ?? '';
        expect(temporal).not.toBe('');
        expect(temporal).toContain(
            'let maxIn = tonemapInvert(max(max(mx4, e), vec3f(0.0))) / exposure;',
        );
        // The uncapped expression is main's, so uncapped pixels stay bit-exact.
        expect(temporal).toContain(
            'pix = min(tonemapInvert(max(pix, vec3f(0.0))) / exposure, maxIn * maxGain);',
        );
        // One shared cap definition, ahead of the uniform branch.
        const resolve = RCAS_SHADER.split('//* Resolve')[1] ?? '';
        expect(resolve.indexOf('let maxGain')).toBeGreaterThan(-1);
        expect(resolve.indexOf('let maxGain')).toBeLessThan(
            resolve.indexOf('if (hasFlag(FLAG_INPUT_REINHARD))'),
        );
        expect(RCAS_SHADER.match(/let maxGain/g)).toHaveLength(1);
    });

    it('leaves the frozen benchmark forms uncapped', () => {
        for (const source of [
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(source).not.toContain('maxGain');
        }
    });
});

describe('RCAS load-strategy experiment shaders', () => {
    // These are built by string transforms over the production shader — a
    // silently missed replacement would produce WGSL that only fails on a real
    // device. Assert every transform actually landed.
    it('hoisted-exposure moves the exposure load out of the tap function', () => {
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'fn rcasLoad(p : vec2i, rcpExposure : f32) -> vec3f {',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'rcpExposure = 1.0 / max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain('rcasLoad(sp, rcpExposure)');
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'rcasLoad(sp + vec2i(0, -1), rcpExposure)',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).not.toContain('tonemapInvert(c) / exposure');
        // Same sharpening math as production.
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain('lowerLimiterMultiplier');
    });

    it('tonemap-space uses plain tap loads and inverts once on the result', () => {
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain(
            'return textureLoad(inputColor, clamped, 0).rgb;\n}',
        );
        expect(RCAS_TONEMAP_SPACE_SHADER).not.toContain('tonemapInvert(c)');
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain(
            'pix = tonemapInvert(max(pix, vec3f(0.0))) / exposure;',
        );
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain('lowerLimiterMultiplier');
    });
});

// Alpha passthrough is unconditional (issue #15, review of PR #18): there is
// one build of each pass, as in three's FSR1Node. With an opaque input every
// stage reduces to alpha exactly 1, so an RGB-only variant would buy a
// micro-optimisation at the price of a second code path and an option whose
// renderer-derived default selected the RGBA build for nearly everyone anyway.
describe('alpha passthrough is unconditional', () => {
    const bindings = (source: string) =>
        [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => Number(m[1]));

    it('exports no RGB-only shader builds', () => {
        for (const module of [accumulateModule, blitModule, easuModule, rcasModule]) {
            for (const name of Object.keys(module)) expect(name).not.toMatch(/OPAQUE/);
        }
    });

    it('declares the RCAS alpha source in every form Upscaler can be handed', () => {
        // `_rcasShader` overrides (the bench's frozen identities and load-strategy
        // experiments) share _encodeRcas's five-entry bind group, so each must
        // declare binding 4 or bind-group creation fails on device.
        for (const source of [
            RCAS_SHADER,
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(bindings(source)).toEqual([0, 1, 2, 3, 4]);
            expect(source).toContain('@group(0) @binding(4) var alphaSource : texture_2d<f32>;');
            expect(source).toContain('vec4f(pix, textureLoad(alphaSource, sp, 0).a)');
            expect(source).not.toContain('vec4f(pix, 1.0)');
        }
    });

    it('carries alpha through blit and EASU instead of writing 1.0', () => {
        expect(bindings(BLIT_SHADER)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(BLIT_SHADER).toContain('textureStore(outputColor, gid.xy, vec4f(c, a));');
        expect(BLIT_SHADER).not.toContain('vec4f(c, 1.0)');
        // EASU filters all four channels with one kernel and one dering clamp.
        expect(EASU_SHADER).toContain('fn easuLoad(p : vec2i) -> vec4f {');
        expect(EASU_SHADER).toContain('var aC = vec4f(0.0);');
        expect(EASU_SHADER).toContain('textureStore(outputColor, gid.xy, pix);');
        expect(EASU_SHADER).not.toContain('vec4f(pix, 1.0)');
    });

    it('keeps the resolved alpha in the locks buffer, never the history age', () => {
        // History .a is the accumulation age on its Catmull-Rom reprojection;
        // alpha must ride the locks buffer's spare .a on both store paths.
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(locksOut, gid.xy, vec4f(0.0, 0.0, 0.0, currentAlpha));',
        );
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(locksOut, gid.xy, vec4f(lockLife, lockedLuma, shadingChange, resultAlpha));',
        );
        expect(ACCUMULATE_SHADER).not.toContain('textureStore(locksOut, gid.xy, vec4f(0.0));');
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(historyOut, gid.xy, vec4f(result, newCount / C.maxAccumulation));',
        );
    });

    it('lets a zero-extent axis leave the variance clip unconstrained', () => {
        // Issue #51: with the epsilon only on |dir|, an axis whose extent AND
        // offset are both 0 (Co/Cg in any exactly achromatic 3×3) gave
        // scale = 0 / 1e-6 = 0, snapping history to the box mean every frame.
        expect(ACCUMULATE_SHADER).toContain(
            'let scale = (extents + 1.0e-6) / max(abs(dir), vec3f(1.0e-6));',
        );
        expect(ACCUMULATE_SHADER).not.toContain('let scale = extents / max(abs(dir)');
    });

    it('relaxes the alpha clamp on the same still-scene signal as the color box', () => {
        // Convergence rule 2 (CLAUDE.md), applied to coverage: a sub-texel
        // feature's all-0 / all-1 jitter phases must not re-snap converged alpha
        // on a still scene, while motion, disocclusion, shading change and
        // reactivity (all folded into stillRelax) restore the hard clamp.
        // Guarded so STILL_CLAMP_RELAX = 0 (relax off) cannot divide 0 by 0.
        expect(ACCUMULATE_SHADER).toContain(
            'let alphaRelax = stillRelax / max(STILL_CLAMP_RELAX, 1.0e-6);',
        );
        expect(ACCUMULATE_SHADER).toContain(
            'let rectifiedAlpha = mix(clamp(lockPrev.a, alphaMin, alphaMax), lockPrev.a, alphaRelax);',
        );
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

describe('auto-exposure clamp', () => {
    // EXPOSURE_MAX is the dark-scene highlight ceiling: history resolves at most
    // 999 / exposure (issue #49, bench/docs/NEXT-STEPS.md §10). 80 clipped at 12.5.
    it('caps brightening at 8 and still clamps the auto target', () => {
        expect(LUMINANCE_PYRAMID_SHADER).toContain('const EXPOSURE_MAX : f32 = 8.0;');
        expect(LUMINANCE_PYRAMID_SHADER).toContain(
            'clamp(EXPOSURE_KEY / max(avgLum, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX)',
        );
    });
});
