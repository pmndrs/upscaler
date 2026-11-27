import { describe, expect, it } from 'vitest';

import * as accumulateModule from './accumulate';
import { ACCUMULATE_SHADER } from './accumulate';
import * as blitModule from './blit';
import { BLIT_SHADER } from './blit';
import { DEBUG_SHADER } from './debug';
import * as easuModule from './easu';
import { EASU_SHADER } from './easu';
import { GENERATE_REACTIVE_SHADER } from './generateReactive';
import { createScalarKernel } from '@pmndrs/downsampler/webgpu';

import {
    everyTexelDispatchShape,
    everyTexelExposureLayout,
    everyTexelKernelOptions,
} from '../internal/EveryTexelExposure';
import {
    EXPOSURE_EVERY_QUAD_BINDINGS,
    EXPOSURE_EVERY_TEXEL_BINDINGS,
    LUMINANCE_PYRAMID_SERIAL_SHADER,
    LUMINANCE_PYRAMID_SHADER,
    exposureEveryTexelFinish,
} from './luminancePyramid';
import { MOMENTS_SHADER } from './moments';
import * as rcasModule from './rcas';
import {
    RCAS_HOISTED_EXPOSURE_SHADER,
    RCAS_LEGACY_SHADER,
    RCAS_PER_TAP_SHADER,
    RCAS_SHADER,
    RCAS_TONEMAP_SPACE_SHADER,
} from './rcas';
import { DEPTH_CLIP_SHADER, RECONSTRUCT_SHADER } from './reconstruct';
import {
    DEPTH_CLIP_VARIANTS,
    RECONSTRUCT_CROSS_FRAME_SHADER,
    buildDepthClipVariant,
} from './reconstructVariants';
import { FLAG_SHADING_PRIME, WGSL_CONSTANTS } from './common';
import { SHADING_CHANGE_SHADER } from './shadingChange';
import { assembleShader } from './wgsl';

const ALL_SHADERS: Record<string, string> = {
    blit: BLIT_SHADER,
    easu: EASU_SHADER,
    rcas: RCAS_SHADER,
    reconstruct: RECONSTRUCT_SHADER,
    depthClip: DEPTH_CLIP_SHADER,
    // Frozen bench identity (reconstruct-cross-frame-v1), pre-#67 production.
    reconstructCrossFrame: RECONSTRUCT_CROSS_FRAME_SHADER,
    shadingChange: SHADING_CHANGE_SHADER,
    accumulate: ACCUMULATE_SHADER,
    luminancePyramid: LUMINANCE_PYRAMID_SHADER,
    // Frozen bench identity (exposure-serial-v1), pre-parallel production.
    luminancePyramidSerial: LUMINANCE_PYRAMID_SERIAL_SHADER,
    generateReactive: GENERATE_REACTIVE_SHADER,
    debug: DEBUG_SHADER,
    moments: MOMENTS_SHADER,
};

const BASELINE_BINDING_COUNTS: Record<string, number> = {
    // blit 6 / rcas 5 since 2026-08-25: the alpha-source binding (issue #15).
    blit: 6,
    easu: 3,
    rcas: 5,
    // 6 since 2026-10-05: dilate + scatter, depth clip split out (issue #67).
    reconstruct: 6,
    // 7 since 2026-11-20: the GPU reset signal (issue #102).
    depthClip: 7,
    reconstructCrossFrame: 7,
    // 11 since 2026-10-05: per-block memory in/out (NEXT-STEPS §14).
    shadingChange: 11,
    accumulate: 13,
    // 8 since 2026-11-20: the GPU reset signal, resolved into exposure .a —
    // the frozen serial form too (it shares the head and epilogue).
    luminancePyramid: 8,
    luminancePyramidSerial: 8,
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
    // 2026-10-02: the temporal inversion is gain-capped too (issue #32);
    // 2026-10-03: both caps become the lobe applied in linear space against
    // the ring min (issue #50, HDR plateau overshoot).
    rcas: 'b0405308',
    // Updated 2026-07-22: depth-clip flicker fix — reference tap-skip semantics
    // (no all-taps veto), jitter-delta-compensated reprojection, and a
    // neighborhood-relief-widened separation tolerance (grazing-angle planes).
    // 2026-10-03: off-screen test on the motion-only reprojection (viewport
    // border no longer reads disoccluded under jitter).
    // 2026-10-05: reconstructed-previous-depth scatter (issue #67) — the
    // depth clip moved to its own pass; the old fused form is frozen below.
    reconstruct: '193dec98',
    // 2026-11-20: a reset frame (FLAG_RESET or the GPU reset signal) writes
    // every pixel disoccluded (issue #102).
    depthClip: '4300b381',
    reconstructCrossFrame: 'd944fd8f',
    // Added 2026-07-21: multi-scale shading-change detector (NEXT-STEPS item 4);
    // 2026-10-03: the contrast floor reads both frames' spread, not just the
    // current frame's (issue #22, NEXT-STEPS §9); 2026-10-03: the compared
    // previous value is clamped into the bilinear footprint's tap range;
    // 2026-10-05: per-block memory of the last 8 means, jump-gated range test
    // (fine-line aliasing on a still camera, NEXT-STEPS §14); 2026-10-05: an
    // all-zero (empty) memory restarts instead of pushing (NEXT-STEPS §14).
    // 2026-11-20: reset read from the exposure texel's resolved .a too (the
    // GPU reset signal), not FLAG_RESET alone. 2026-11-20: FLAG_SHADING_PRIME
    // runs a first frame after turning on mid-history as a reset (NEXT-STEPS §18).
    shadingChange: '9de820c9',
    // Updated 2026-07-21: DeltaPreExposure history correction (NEXT-STEPS item 2);
    // 2026-08-25: alpha resolved alongside color into the locks buffer's .a;
    // 2026-10-02: the alpha clamp takes the color path's still-scene relax;
    // 2026-10-02: alphaRelax guarded against STILL_CLAMP_RELAX = 0 (NEXT-STEPS
    // §8) — GPU captures byte-identical at the shipped 8;
    // 2026-10-03: clipToAABB's epsilon moved onto the extents too, so a
    // zero-extent (achromatic) axis no longer collapses the clip (issue #51,
    // NEXT-STEPS §11);
    // 2026-10-05: pre-exposure read guarded with max(…, 1e-4) like RCAS/blit,
    // so a fixed/external exposure of 0 no longer blacks out accumulation.
    // 2026-11-20: reset read from the exposure texel's resolved .a too.
    // 2026-11-27: Catmull-Rom history colour bounded by its 2x2 texels (#118).
    accumulate: 'de5cba82',
    // 2026-10-08: 1/16-stop adaptation dead-band, so the jitter-phase wobble of
    // the metered log-average no longer re-conditions history on still scenes.
    // 2026-11-11: the 1024 metering taps split across the 64 lanes, then a
    // workgroup tree sum (NEXT-STEPS §16); the serial form keeps its loop.
    // 2026-11-20: the GPU reset signal (binding 7), folded with FLAG_RESET
    // and published in .a for the rest of the late stage (issue #102). The
    // frozen serial form shares the head and epilogue, so it changes too
    // (was '30144ae9'); its metering loop is unchanged, and it now assembles
    // byte-identically to the reset branch's pre-parallel production shader.
    // 2026-11-27: publishes without metering when a fixed or app-supplied
    // exposure overrides the metered one (issue #98; was '3722103a').
    luminancePyramid: 'b2d0d970',
    luminancePyramidSerial: 'a1719dab',
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

    it('assembles deterministically across repeated calls', () => {
        for (const source of [BLIT_SHADER, EASU_SHADER, RCAS_SHADER, ACCUMULATE_SHADER,
            RECONSTRUCT_SHADER, DEPTH_CLIP_SHADER, DEBUG_SHADER, LUMINANCE_PYRAMID_SHADER]) {
            expect(assembleShader(source)).toBe(assembleShader(source));
        }
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

    it('inverts once, anchored on the linear center and capped by the lobe in linear space', () => {
        const spatial = RCAS_SHADER.split('//* Resolve')[1]?.split('} else {')[1] ?? '';
        expect(spatial).toContain('eIn + tonemapInvert(max(pix, vec3f(0.0))) - tonemapInvert(e),');
        // The linear taps are at hand: the ring min needs no inversion.
        expect(spatial).toContain(
            'let mnIn = max(min(min(bIn, dIn), min(fIn, hIn)), vec3f(0.0));',
        );
        expect(spatial).toContain(
            'let ceiling = max(eIn, vec3f(0.0)) - 4.0 * lobe * rcpL * max(eIn - mnIn, vec3f(0.0));',
        );
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
    // Issue #50: below the firefly range the same inversion still overshoots
    // converged HDR plateau edges — a 64 plateau corner read 127 at sharpness
    // 1 against 64-67 for linear RCAS. Both are bounded by one cap: the lobe
    // applied in linear space against the darkest ring tap.
    it('caps the single inversion by the lobe applied in linear space against the ring min', () => {
        const temporal =
            RCAS_SHADER.split('//* Resolve')[1]
                ?.split('if (hasFlag(FLAG_INPUT_REINHARD)) {')[1]
                ?.split('} else {')[0] ?? '';
        expect(temporal).not.toBe('');
        // One inversion each for the center and the per-channel ring min (the
        // inversion is monotone, so the min bounds every inverted ring tap).
        expect(temporal).toContain('let eLin = tonemapInvert(e);');
        expect(temporal).toContain('let mnLin = tonemapInvert(max(mn4, vec3f(0.0)));');
        expect(temporal).toContain(
            'let ceiling = eLin - 4.0 * lobe * rcpL * max(eLin - mnLin, vec3f(0.0));',
        );
        // The uncapped expression is unchanged, so uncapped pixels stay bit-exact.
        expect(temporal).toContain(
            'pix = min(tonemapInvert(max(pix, vec3f(0.0))) / exposure, ceiling / exposure);',
        );
        // The ceiling subsumes the #32 gain cap (at most center / (1 - 4 *
        // RCAS_LIMIT * peak) with a non-negative ring min), which is gone.
        expect(RCAS_SHADER).not.toContain('maxGain');
    });

    it('leaves the frozen benchmark forms uncapped', () => {
        for (const source of [
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(source).not.toContain('ceiling');
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

    it('bounds the Catmull-Rom history colour by its 2x2 texels, not the age', () => {
        // Issue #118: clamped from below only, the negative lobes overshot an
        // HDR highlight near 1 in tonemap space into ~1000 / exposure while the
        // camera moved. The age (.a) must keep its unclamped reprojection.
        const body = ACCUMULATE_SHADER.slice(
            ACCUMULATE_SHADER.indexOf('fn sampleHistoryCatmullRom'),
            ACCUMULATE_SHADER.indexOf('fn clipToAABB'),
        );
        expect(body.match(/textureLoad\(historyIn, /g)).toHaveLength(4);
        expect(body).toContain('let texel = vec2i(texPos1 - 0.5);');
        expect(body).toContain('return vec4f(clamp(result.rgb, texelLo, texelHi), max(result.a, 0.0));');
        expect(body).not.toContain('return max(result, vec4f(0.0));');
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

describe('parallel exposure metering', () => {
    // The 64 lanes share the serial form's 1024 taps (NEXT-STEPS §16): only the
    // summation order may differ, and the row loop keeps the uniform bound that
    // holds DXC's compile time down (docs/windows-followups.md).
    const tapMath = [
        'let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(EXPOSURE_TAPS);',
        'let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;',
        'logSum = logSum + log2(max(luma(c), 1.0e-4));',
    ];
    const main = (source: string) => source.slice(source.indexOf('@compute'));

    it('takes the serial form’s taps with the same per-tap math', () => {
        for (const line of tapMath) {
            expect(LUMINANCE_PYRAMID_SERIAL_SHADER).toContain(line);
            expect(LUMINANCE_PYRAMID_SHADER).toContain(line);
        }
        expect(LUMINANCE_PYRAMID_SHADER).toContain(
            'for (var y = gid.y; y < C.exposureTaps; y = y + EXPOSURE_LANES) {',
        );
        expect(LUMINANCE_PYRAMID_SHADER).toContain('let x = gid.x + i * EXPOSURE_LANES;');
    });

    it('reduces in workgroup memory before any lane returns', () => {
        // The one earlier return is the provided-exposure branch (issue #98):
        // its condition reads only uniform flags, so the barriers stay uniform.
        const provided = 'if (!hasFlag(FLAG_AUTO_EXPOSURE) || hasFlag(FLAG_EXTERNAL_EXPOSURE)) {\n' +
            '        if (lane == 0u) { publishProvidedExposure(); }\n        return;\n    }\n';
        const body = main(LUMINANCE_PYRAMID_SHADER);
        expect(body).toContain(provided);
        const metering = body.slice(body.indexOf(provided) + provided.length);
        expect(metering.indexOf('return;')).toBeGreaterThan(metering.lastIndexOf('workgroupBarrier();'));
        expect(body).toContain('logSum = laneLogSums[0];');
    });

    it('shares everything after the metering with the serial form', () => {
        const tail = (source: string) => source.slice(source.indexOf('    // Meter host-invariantly'));
        expect(tail(LUMINANCE_PYRAMID_SHADER)).toBe(tail(LUMINANCE_PYRAMID_SERIAL_SHADER));
    });
});

describe('every-texel exposure metering', () => {
    // NEXT-STEPS §17: the same epilogue as `finish` of a @pmndrs/downsampler
    // ScalarReduction, whose generated kernel owns @group(0).
    const tail = (source: string) => source.slice(source.indexOf('    // Meter host-invariantly'));
    const finish = exposureEveryTexelFinish();
    const bindingsOf = (wgsl: string) =>
        [...wgsl.matchAll(/@group\((\d)\) @binding\((\d+)\)/g)].map(([, group, binding]) => `${group}:${binding}`);

    it('runs the production epilogue with the log average in place of the tap sum', () => {
        expect(tail(finish)).toBe(
            tail(LUMINANCE_PYRAMID_SHADER).replace(
                'exp2(logSum / f32(EXPOSURE_TAPS * EXPOSURE_TAPS))',
                'exp2(logAverage)',
            ),
        );
        expect(finish).toContain('let logAverage = value.x;');
        expect(finish).toContain('> ADAPT_DEADBAND_STOPS');
    });

    it('drops only the dead-band when asked', () => {
        const open = exposureEveryTexelFinish(false);
        expect(open).toContain('abs(log2(targetExposure / prev)) > 0.0) {');
        expect(open.replace('prev)) > 0.0) {', 'prev)) > ADAPT_DEADBAND_STOPS) {')).toBe(finish);
    });

    it('declares group 1 only, in the layout the reduction is built with', () => {
        for (const form of ['texel', 'quad'] as const) {
            const wgsl = form === 'quad' ? EXPOSURE_EVERY_QUAD_BINDINGS : EXPOSURE_EVERY_TEXEL_BINDINGS;
            const declared = bindingsOf(wgsl).sort();
            const layout = everyTexelExposureLayout(form).map((entry) => `1:${entry.binding}`).sort();
            expect(declared).toEqual(layout);
        }
        expect(bindingsOf(EXPOSURE_EVERY_TEXEL_BINDINGS)).not.toContain('1:2');
    });

    it('assembles with the generated kernel without name collisions', () => {
        for (const form of ['texel', 'quad'] as const) {
            const wgsl = createScalarKernel(everyTexelKernelOptions(form));
            for (const name of ['load', 'finish', 'partials', 'combine'])
                expect(wgsl.match(new RegExp(`\\bfn ${name}\\(`, 'g'))).toHaveLength(1);
            // Only the generator's own declarations sit in group 0.
            expect(bindingsOf(wgsl).filter((b) => b.startsWith('0:')).sort()).toEqual(['0:0', '0:1']);
        }
        for (const ours of [EXPOSURE_EVERY_TEXEL_BINDINGS, EXPOSURE_EVERY_QUAD_BINDINGS, finish])
            expect(ours).not.toMatch(/\bds_/);
    });

    it('dispatches the generated kernel the way its ScalarReduction would', () => {
        // EveryTexelExposure compiles the kernel itself (async) and fills the
        // uniform and workgroup counts the library's class would: pin the
        // generated shape those depend on (@pmndrs/downsampler 0.1.0, exact).
        const wgsl = createScalarKernel(everyTexelKernelOptions('texel'));
        expect(wgsl).toContain(
            'struct DsParams {\n\tsize: vec2u,\n\tfirstLayer: u32,\n\tgroupsX: u32,\n\tpartialCount: u32,\n\tcount: u32,\n}',
        );
        expect(wgsl).toContain('@group(0) @binding(0) var<uniform> ds_params: DsParams;');
        expect(wgsl).toContain('@group(0) @binding(1) var<storage, read_write> ds_partials: array<vec4f>;');
        expect(wgsl).toContain('@compute @workgroup_size(16, 16)\nfn partials');
        expect(wgsl).toContain('@compute @workgroup_size(256)\nfn combine');
        expect(wgsl).toContain('let origin = group.xy * 64u + local.xy;');
        expect(everyTexelDispatchShape(960, 540)).toEqual({
            groups: [15, 9], params: [960, 540, 0, 15, 135, 518400],
        });
        expect(everyTexelDispatchShape(1, 1)).toEqual({ groups: [1, 1], params: [1, 1, 0, 1, 1, 1] });
    });
});

describe('shading-change block memory', () => {
    // Fine-line aliasing on a still camera (bench Q18, NEXT-STEPS §14): a block
    // mean inside the range of its last 8 means reads as no change, unless the
    // frame's jump exceeds the jumps the memory holds (a step after a ramp).
    it('ping-pongs a packed memory of 8 means per block', () => {
        expect(SHADING_CHANGE_SHADER).toContain(
            '@group(0) @binding(9) var blockMemoryIn : texture_2d<u32>;',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            '@group(0) @binding(10) var blockMemoryOut : texture_storage_2d<rgba32uint, write>;',
        );
        expect(SHADING_CHANGE_SHADER).toContain('const SHADING_MEMORY_SLOTS : u32 = 8u;');
        expect(SHADING_CHANGE_SHADER).toContain('const SHADING_MEMORY_JUMP_GAIN : f32 = 1.5;');
    });

    it('gates the range on the jump and only ever lowers the difference', () => {
        expect(SHADING_CHANGE_SHADER).toContain(
            '> SHADING_MEMORY_JUMP_GAIN * flicker) {\n        return 1.0;',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'let relative = min(1.0 - min(sums.x, sums.y) / maximum, memory);',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'scaleResponse(sums1, 16.0, SHADING_FLOOR_MID, midMemory)',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'scaleResponse(sums2, 64.0, SHADING_FLOOR_COARSE, coarseMemory)',
        );
    });

    it('restarts the memory of blocks that moved, disoccluded or reset', () => {
        expect(SHADING_CHANGE_SHADER).toContain('var moving = select(0.0, 1.0, frameReset);');
        expect(SHADING_CHANGE_SHADER).toContain(
            'select(memoryDistance(midWords, midMean), 1.0, moving1 > 0.5)',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'memoryUpdate(coarseWords, coarseMean, moving2 > 0.5)',
        );
        // One writer per block: its top-left thread.
        expect(SHADING_CHANGE_SHADER).toContain('if (all((lid.xy & vec2u(1u)) == vec2u(0u))) {');
        expect(SHADING_CHANGE_SHADER).toContain('if (all((lid.xy & vec2u(3u)) == vec2u(0u))) {');
    });

    it('restarts an empty (all-zero) memory instead of pushing into it', () => {
        // Pushed, the zeros stay in the range for 8 frames with a stored jump of 1,
        // so the gate never trips and a darkening step is hidden — e.g. right
        // after the detector is re-enabled, when Upscaler zeroes the memory.
        expect(SHADING_CHANGE_SHADER).toContain('if (restart || all(words == vec4u(0u))) {');
    });
});

describe('reconstructed previous depth (issue #67)', () => {
    it('scatters and gathers the same footprint', () => {
        // Same weight floor and the same motion-only previous position on
        // both sides; a mismatch would let a pixel miss its own scatter.
        const floor = /DEPTH_TAP_WEIGHT_FLOOR : f32 = ([\d.e-]+);/;
        expect(RECONSTRUCT_SHADER.match(floor)?.[1]).toBe(DEPTH_CLIP_SHADER.match(floor)?.[1]);
        expect(RECONSTRUCT_SHADER).toMatch(/let prevUV = \(vec2f\(gid\.xy\) \+ 0\.5\) \* C\.renderSizeInv - uvDelta;/);
        expect(DEPTH_CLIP_SHADER).toMatch(/let prevUV = uv - uvDelta;/);
        expect(DEPTH_CLIP_SHADER.split('fn main')[1]).not.toMatch(/jitterPrev/);
    });

    it('keeps the nearest depth and empties the next buffer before any early return', () => {
        expect(RECONSTRUCT_SHADER).toMatch(/atomicMin\(&reconstructedDepth/);
        const body = DEPTH_CLIP_SHADER.split('fn main')[1] ?? '';
        const clear = body.indexOf('nextReconstructedDepth[');
        expect(clear).toBeGreaterThan(0);
        // Off-screen pixels return early but must still empty their slot.
        expect(clear).toBeLessThan(body.indexOf('if (any(prevUV'));
        expect(DEPTH_CLIP_SHADER).toMatch(/EMPTY_DEPTH : u32 = 0x7f800000u/);
    });
});

describe('reset (issue #102)', () => {
    const resetSignal = /textureLoad\(resetSignal, vec2i\(0\), 0\)\.r > 0\.5/;

    it('writes every pixel disoccluded on a reset frame, after emptying the next buffer', () => {
        const sources = [DEPTH_CLIP_SHADER, ...Object.values(DEPTH_CLIP_VARIANTS).map(buildDepthClipVariant)];
        for (const source of sources) {
            const body = source.split('fn main')[1] ?? '';
            const reset = body.indexOf(
                'let reset = hasFlag(FLAG_RESET) || textureLoad(resetSignal, vec2i(0), 0).r > 0.5;',
            );
            expect(reset).toBeGreaterThan(0);
            // The ping-pong clear runs whatever the frame: the scatter keeps no
            // other cross-frame state, so a skipped clear is the only way a
            // reset could leak a stale nearer depth into the next frame.
            expect(body.indexOf('nextReconstructedDepth[')).toBeLessThan(reset);
            // Every store is 1 on a reset: the off-screen one always, the
            // final one through the reset select.
            const stores = [...body.matchAll(/textureStore\(maskOutput, gid\.xy, vec4f\(([^,]+),/g)].map((m) => m[1]);
            expect(stores.length).toBeGreaterThan(0);
            for (const value of stores) expect(['1.0', 'select(disocclusion']).toContain(value.trim());
            expect(body).toContain('vec4f(select(disocclusion, 1.0, reset), 0.0, 0.0, 1.0)');
        }
    });

    it('resolves the GPU signal once, in the exposure texel, for the late stage', () => {
        // The exposure pass folds FLAG_RESET and the signal into .a ...
        expect(LUMINANCE_PYRAMID_SHADER).toMatch(
            /let reset = hasFlag\(FLAG_RESET\) \|\| textureLoad\(resetSignal, vec2i\(0\), 0\)\.r > 0\.5;/,
        );
        expect(LUMINANCE_PYRAMID_SHADER).toMatch(/if \(!reset && prev > 0\.0\)/);
        expect(LUMINANCE_PYRAMID_SHADER).toContain('vec4f(exposure, avgLum, host, select(0.0, 1.0, reset))');
        expect(LUMINANCE_PYRAMID_SHADER).toMatch(resetSignal);
        // ... and every later pass that honours FLAG_RESET also reads it.
        expect(ACCUMULATE_SHADER).toContain('if (hasFlag(FLAG_RESET) || frameInfo.a > 0.5 || offscreen)');
        expect(SHADING_CHANGE_SHADER).toContain(
            'frameReset = hasFlag(FLAG_RESET) || hasFlag(FLAG_SHADING_PRIME) || frameInfo.a > 0.5;',
        );
        // The prime bit lives only in this shader; its literal must match the writer's.
        expect(SHADING_CHANGE_SHADER).toContain(`const FLAG_SHADING_PRIME : u32 = ${FLAG_SHADING_PRIME}u;`);
        expect(WGSL_CONSTANTS).not.toContain('FLAG_SHADING_PRIME');
        expect(SHADING_CHANGE_SHADER).toContain('if (frameReset) { return neutral; }');
        expect(SHADING_CHANGE_SHADER).toContain('var moving = select(0.0, 1.0, frameReset);');
        // No pass may honour the CPU flag alone (it would ignore a GPU cut).
        const sources = [
            ACCUMULATE_SHADER, SHADING_CHANGE_SHADER, LUMINANCE_PYRAMID_SHADER, DEPTH_CLIP_SHADER,
            LUMINANCE_PYRAMID_SERIAL_SHADER, exposureEveryTexelFinish(), exposureEveryTexelFinish(false),
        ];
        for (const source of sources) {
            const uses = [...source.matchAll(/hasFlag\(FLAG_RESET\)([^;{]*)/g)].map((match) => match[1]);
            expect(uses.length).toBeGreaterThan(0);
            for (const rest of uses) expect(rest).toMatch(/\|\| (frameInfo\.a > 0\.5|textureLoad\(resetSignal)/);
        }
    });

    it('binds the signal in every exposure form, which all publish the resolved .a', () => {
        // The late stage binds the reset whichever metering runs (taps, the
        // frozen serial identity, every texel / every quad in @group(1)), and
        // the store lives in the shared epilogue, so `finish` inherits it.
        const store = 'vec4f(exposure, avgLum, host, select(0.0, 1.0, reset))';
        for (const source of [LUMINANCE_PYRAMID_SHADER, LUMINANCE_PYRAMID_SERIAL_SHADER]) {
            expect(source).toContain('@group(0) @binding(7) var resetSignal : texture_2d<f32>;');
            expect(source).toContain(store);
        }
        expect(LUMINANCE_PYRAMID_SERIAL_SHADER.match(/textureStore\(exposureOut/g)).toHaveLength(1);
        // Production's second store is the provided-exposure publish (issue #98).
        expect(LUMINANCE_PYRAMID_SHADER.match(/textureStore\(exposureOut/g)).toHaveLength(2);
        expect(LUMINANCE_PYRAMID_SHADER).toContain(
            'vec4f(exposure, 0.0, host, select(0.0, 1.0, reset))',
        );
        for (const bindings of [EXPOSURE_EVERY_TEXEL_BINDINGS, EXPOSURE_EVERY_QUAD_BINDINGS]) {
            expect(bindings).toContain('@group(1) @binding(7) var resetSignal : texture_2d<f32>;');
        }
        for (const form of ['texel', 'quad'] as const) {
            expect(everyTexelExposureLayout(form).filter((entry) => entry.binding === 7)).toHaveLength(1);
        }
        for (const finish of [exposureEveryTexelFinish(), exposureEveryTexelFinish(false)]) {
            expect(finish.match(/textureStore\(exposureOut/g)).toHaveLength(1);
            expect(finish).toContain(store);
        }
    });
});

describe('depth-clip variants (issue #79)', () => {
    // Swapped in through Upscaler's _depthClipShader, which binds production's
    // seven entries, so every variant must declare exactly bindings 0–6.
    it.each(Object.entries(DEPTH_CLIP_VARIANTS))('%s keeps production bindings', (_id, options) => {
        const source = buildDepthClipVariant(options);
        const bindings = [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((match) =>
            Number(match[1]),
        );
        expect(bindings).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(source.match(/@compute/g)).toHaveLength(1);
        expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
        // Still empties next frame's slot before the off-screen early return.
        const body = source.split('fn main')[1] ?? '';
        expect(body.indexOf('nextReconstructedDepth[')).toBeLessThan(body.indexOf('if (any(prevUV'));
    });

    it('reads upstream tolerance as the full diagonal times Kfov', () => {
        const upstream = buildDepthClipVariant(DEPTH_CLIP_VARIANTS['depth-clip-upstream-tolerance-v1']);
        expect(upstream).toContain('kfov() * length(C.renderSize)');
        const ours = buildDepthClipVariant(DEPTH_CLIP_VARIANTS['depth-clip-no-relief-v1']);
        expect(ours).toContain('length(C.renderSize * 0.5)');
    });
});
