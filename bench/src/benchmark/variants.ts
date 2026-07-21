import {
    createBaselineResolver,
    createRcasExperimentResolver,
    createRcasNumericParityResolver,
    createSourceBundleResolver,
} from './BenchmarkResolver';

const SUPPORTED_RATIOS = [1, 1.5, 2, 3] as const;
const RESOURCE_GRAPH = [
    'scene-color-depth-velocity',
    'exposure',
    'reconstruct',
    'accumulate-history-locks',
    'rcas-or-blit',
    'debug-or-output',
] as const;
const ASSEMBLED_CHUNKS = [
    'constants',
    'color',
    'depth',
    'tonemap',
    'pass-body',
] as const;

let activeResolverCount = 0;

function metadata(id: BenchmarkVariantId): BenchmarkVariantMetadata {
    const sourceBundle =
        id === 'source-filter-bundle-v1' ||
        id === 'source-structural-bundle-v1' ||
        id === 'source-spd-resolver-bundle-v1';
    const structural =
        id === 'source-structural-bundle-v1' || id === 'source-spd-resolver-bundle-v1';
    const spdResolver = id === 'source-spd-resolver-bundle-v1';
    const rcasExperiment =
        id === 'rcas-hoisted-exposure-v1' || id === 'rcas-tonemap-space-v1';
    const rcasLimiterParity = id === 'rcas-fsr315-limiter';
    const rcasNumericParity = rcasLimiterParity || id === 'rcas-fsr315-numeric' || rcasExperiment;
    const rcasDenoise = id === 'rcas-fsr315-numeric';
    const sourceResourceGraph = spdResolver
        ? [
              'scene-color-depth-velocity',
              'prepare-inputs-atomic-depth-farthest-luma',
              'luma-spd-frame-info',
              'depth-clip-motion-divergence',
              'signed-difference-shading-spd',
              'prepare-reactivity-accumulation-new-locks',
              'four-frame-luma-instability',
              'source-resolver-history-lock-alpha',
              'rcas-or-blit',
              'debug-or-output',
          ]
        : structural
          ? [
                'scene-color-depth-velocity',
                'prepare-inputs-atomic-depth-farthest-luma',
                'exposure-history-frame-info',
                'depth-clip-motion-divergence',
                'prepare-reactivity-accumulation-new-locks',
                'source-filter-local-state',
                'rcas-or-blit',
                'debug-or-output',
            ]
          : [
                'scene-color-depth-velocity',
                'prepare-inputs-atomic-depth',
                'exposure-history-frame-info',
                'depth-clip',
                'source-current-history-filters',
                'rcas-or-blit',
                'debug-or-output',
            ];
    const sourceTimingLabels = spdResolver
        ? [
              'prepareInputs',
              'lumaSpd',
              'depthClip',
              'shadingSpd',
              'shadingResolve',
              'prepareReactivity',
              'lumaInstability',
              'accumulate',
              'rcas',
          ]
        : structural
          ? [
                'prepareInputs',
                'exposure',
                'depthClip',
                'prepareReactivity',
                'accumulate',
                'rcas',
            ]
          : ['prepareInputs', 'exposure', 'depthClip', 'accumulate', 'rcas'];
    return {
        id,
        name: spdResolver
            ? 'Source SPD temporal resolver bundle v1'
            : structural
              ? 'Source structural inputs/reactivity bundle v1'
              : id === 'source-filter-bundle-v1'
                ? 'Source reconstruction/filter bundle v1'
                : id === 'rcas-hoisted-exposure-v1'
                  ? 'RCAS with hoisted exposure load'
                  : id === 'rcas-tonemap-space-v1'
                    ? 'RCAS sharpening in tonemap space'
                : rcasDenoise
            ? 'FSR 3.1.5 RCAS limiter + denoise'
            : rcasLimiterParity
              ? 'FSR 3.1.5 RCAS lower limiter'
            : id === 'local-baseline-through-e00-harness'
              ? 'Local baseline through E00 harness'
              : 'Local baseline 5d6a65e',
        supportedRatios: SUPPORTED_RATIOS,
        settings: {
            path: 'temporal',
            sharpness: 0.8,
            rcasDenoise,
            maxAccumulation: 24,
            exposure: 1,
            autoExposure: true,
            lockThinFeatures: true,
            detectShadingChanges: true,
        },
        resourceGraph: sourceBundle ? sourceResourceGraph : RESOURCE_GRAPH,
        pipeline: {
            shaderKey: sourceBundle || rcasExperiment
                ? id
                : rcasNumericParity
                ? rcasDenoise
                    ? 'rcas-fsr315-numeric'
                    : 'rcas-fsr315-limiter'
                : 'local-baseline-5d6a65e',
            pipelineKey: sourceBundle ? id : 'temporal-baseline',
            assembledChunks: sourceBundle
                ? [
                      'constants',
                      'source-inputs',
                      'source-filter',
                      ...(structural ? ['source-reactivity'] : []),
                      ...(spdResolver ? ['source-spd', 'source-resolver-state'] : []),
                      'rcas-source-math',
                  ]
                : ASSEMBLED_CHUNKS,
            wgslOverrides: sourceBundle
                ? {
                      motionInputAtDisplayResolution: false,
                      motionCancelJitter: false,
                      prepareStructuralSignals: structural,
                      depthClipMotionDivergence: structural,
                      reactiveUseComponentMax: true,
                      reactiveApplyThreshold: true,
                      reactiveBinary: false,
                      reactiveThreshold: 0.04,
                      reactiveScale: 2,
                      reactiveBinaryValue: 1,
                  }
                : {},
            timingPassLabels: sourceBundle
                ? sourceTimingLabels
                : ['exposure', 'reconstruct', 'accumulate', 'rcas'],
        },
    };
}

const DEFAULT_DEFINITIONS: BenchmarkVariantDefinition[] = [
    'baseline',
    'local-baseline-5d6a65e',
    'local-baseline-through-e00-harness',
].map((id) => ({
    metadata: metadata(id as BenchmarkVariantId),
    create: createBaselineResolver,
}));
DEFAULT_DEFINITIONS.push({
    metadata: metadata('rcas-fsr315-limiter'),
    create: createRcasNumericParityResolver,
});
DEFAULT_DEFINITIONS.push({
    metadata: metadata('rcas-fsr315-numeric'),
    create: createRcasNumericParityResolver,
});
DEFAULT_DEFINITIONS.push({
    metadata: metadata('rcas-hoisted-exposure-v1'),
    create: createRcasExperimentResolver,
});
DEFAULT_DEFINITIONS.push({
    metadata: metadata('rcas-tonemap-space-v1'),
    create: createRcasExperimentResolver,
});
for (const id of [
    'source-filter-bundle-v1',
    'source-structural-bundle-v1',
    'source-spd-resolver-bundle-v1',
] as const) {
    DEFAULT_DEFINITIONS.push({
        metadata: metadata(id),
        create: createSourceBundleResolver,
    });
}

/**
 * Registry enforcing one active resolver across the page.
 */
export class SingleVariantRegistry {
    private readonly _definitions = new Map<string, BenchmarkVariantDefinition>();
    private _active: BenchmarkResolver | null = null;

    constructor(definitions: readonly BenchmarkVariantDefinition[] = DEFAULT_DEFINITIONS) {
        for (const definition of definitions) {
            if (this._definitions.has(definition.metadata.id))
                throw new Error(`Duplicate benchmark variant: ${definition.metadata.id}`);
            this._definitions.set(definition.metadata.id, definition);
        }
    }

    /**
     * Validates a variant without constructing its GPU graph.
     * @param id - Requested variant identity
     * @param ratio - Requested display/render ratio
     * @returns Immutable variant metadata
     */
    resolve(id: string, ratio: number): BenchmarkVariantMetadata {
        const definition = this._definitions.get(id);
        if (!definition) throw new Error(`Unknown benchmark variant: ${id}`);
        if (!definition.metadata.supportedRatios.includes(ratio))
            throw new Error(`Variant ${id} does not support ratio ${ratio}.`);
        return definition.metadata;
    }

    /**
     * Creates the page's sole active resolver.
     * @param id - Requested variant identity
     * @param ratio - Requested display/render ratio
     * @param renderer - Initialized renderer passed to the resolver factory
     * @returns The active resolver
     */
    create(id: string, ratio: number, renderer: unknown): BenchmarkResolver {
        const variantMetadata = this.resolve(id, ratio);
        if (this._active || activeResolverCount !== 0)
            throw new Error('A benchmark resolver is already active.');

        const definition = this._definitions.get(id)!;
        const resolver = definition.create(renderer, variantMetadata);
        this._active = resolver;
        activeResolverCount++;
        return resolver;
    }

    /** Disposes and releases the sole resolver lease. */
    disposeActive(): void {
        if (!this._active) return;
        this._active.dispose();
        this._active = null;
        activeResolverCount--;
    }

    /**
     * Releases a resolver already disposed by its owning pipeline.
     * @param resolver - Resolver whose GPU resources were explicitly disposed
     */
    releaseDisposed(resolver: BenchmarkResolver): void {
        if (this._active !== resolver)
            throw new Error('Cannot release a resolver that is not the active registry instance.');
        this._active = null;
        activeResolverCount--;
    }
}

/** Returns the number of active resolvers without requiring a GPU. */
export function getActiveResolverCount(): number {
    return activeResolverCount;
}
