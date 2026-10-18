import { describe, expect, it } from 'vitest';

import * as variants from '../benchmark/variants';
import {
    createBaselineResolver,
    createRcasExperimentResolver,
    createDepthClipVariantResolver,
    createReconstructExperimentResolver,
    createRcasNumericParityResolver,
    createSourceBundleResolver,
} from '../benchmark/BenchmarkResolver';
import { RCAS_PER_TAP_SHADER } from '@pmndrs/upscaler-core/shaders/rcas';
import {
    DEBUG_SOURCE_FILTER_SHADER,
    DEBUG_SOURCE_RESOLVER_SHADER,
    DEBUG_SOURCE_STRUCTURAL_SHADER,
} from './shaders/candidateDebug';
import {
    ACCUMULATE_SOURCE_FILTER_SHADER,
    ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
    EASU_SOURCE_APPROX_SHADER,
} from './shaders/candidateFilters';
import {
    DEPTH_CLIP_SOURCE_SHADER,
    GENERATE_REACTIVE_SOURCE_SHADER,
    PREPARE_INPUTS_SOURCE_SHADER,
    PREPARE_REACTIVITY_SOURCE_SHADER,
} from './shaders/candidateInputs';
import {
    ACCUMULATE_SOURCE_RESOLVER_SHADER,
    EXPOSURE_HISTORY_SOURCE_SHADER,
    LUMA_INSTABILITY_SOURCE_SHADER,
    LUMA_SPD_SOURCE_SHADER,
    SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
    SHADING_CHANGE_SPD_SOURCE_SHADER,
} from './shaders/candidateTemporal';

const CANDIDATE_SHADERS: Record<string, string> = {
    rcasPerTap: RCAS_PER_TAP_SHADER,
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
    // 5 since 2026-08-25: the alpha-source binding, added to every RCAS form.
    rcasPerTap: 5,
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

const CANDIDATE_FINGERPRINTS: Record<string, string> = {
    // Both re-fingerprinted 2026-08-25: alpha passthrough (issue #15) reaches
    // these through their production bases. The A/B pairings are unaffected —
    // candidate and baseline gained the same plumbing.
    rcasPerTap: '1246988b',
    easuSourceApprox: '0f58117c',
    exposureHistory: 'bf1c681d',
    generateReactiveSource: '57ab78cd',
    prepareInputsSource: 'ce97e835',
    depthClipSource: 'b24d2d16',
    prepareReactivitySource: 'e75e7462',
    accumulateSourceFilter: '77a25ca8',
    accumulateSourceStructural: '2100d06e',
    lumaSpdSource: '4c3b6837',
    shadingSpdSource: '65bb82d4',
    shadingResolveSource: '39852a6f',
    lumaInstabilitySource: '3ac0beff',
    accumulateSourceResolver: 'f9c3b249',
    debugSourceFilter: '700cb1a6',
    debugSourceStructural: 'eb6c2290',
    debugSourceResolver: '7d44eceb',
};

function fingerprint(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

describe.each(Object.entries(CANDIDATE_SHADERS))(
    '%s candidate shader',
    (name, source) => {
        it('keeps its frozen candidate fingerprint', () => {
            expect(fingerprint(source)).toBe(CANDIDATE_FINGERPRINTS[name]);
        });

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

describe('benchmark resolver ownership', () => {
    it('registers candidate and production factories for their owning identities', () => {
        const resolveFactory = (
            variants as typeof variants & {
                getBenchmarkResolverFactory?: (
                    id: BenchmarkVariantId,
                ) => BenchmarkVariantDefinition['create'];
            }
        ).getBenchmarkResolverFactory;

        for (const id of [
            'source-filter-bundle-v1',
            'source-structural-bundle-v1',
            'source-spd-resolver-bundle-v1',
        ] as const)
            expect(resolveFactory?.(id)).toBe(createSourceBundleResolver);

        for (const id of [
            'baseline',
            'local-baseline-5d6a65e',
            'local-baseline-through-e00-harness',
        ] as const)
            expect(resolveFactory?.(id)).toBe(createBaselineResolver);

        for (const id of ['rcas-fsr315-limiter', 'rcas-fsr315-numeric'] as const)
            expect(resolveFactory?.(id)).toBe(createRcasNumericParityResolver);

        for (const id of [
            'rcas-hoisted-exposure-v1',
            'rcas-tonemap-space-v1',
        ] as const)
            expect(resolveFactory?.(id)).toBe(createRcasExperimentResolver);

        for (const id of ['reconstruct-cross-frame-v1', 'reconstruct-camera-v1'] as const)
            expect(resolveFactory?.(id)).toBe(createReconstructExperimentResolver);

        for (const id of [
            'depth-clip-no-relief-v1',
            'depth-clip-mean-vote-v1',
            'depth-clip-upstream-tolerance-v1',
            'depth-clip-upstream-v1',
        ] as const)
            expect(resolveFactory?.(id)).toBe(createDepthClipVariantResolver);
    });
});
