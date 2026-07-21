const RATIOS = [1, 1.5, 2, 3] as const;
const VARIANTS = [
    'baseline',
    'local-baseline-5d6a65e',
    'local-baseline-through-e00-harness',
    'rcas-fsr315-limiter',
    'rcas-fsr315-numeric',
    'rcas-hoisted-exposure-v1',
    'rcas-tonemap-space-v1',
    'source-filter-bundle-v1',
    'source-structural-bundle-v1',
    'source-spd-resolver-bundle-v1',
] as const;
const SCENARIOS = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11'] as const;

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid benchmark ${name}: ${raw}`);
    return value;
}

function enumParam<T extends string>(
    params: URLSearchParams,
    name: string,
    values: readonly T[],
    fallback: T,
): T {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!values.includes(raw as T)) throw new Error(`Invalid benchmark ${name}: ${raw}`);
    return raw as T;
}

/**
 * Parses the deterministic E00 browser configuration.
 * @param search - URL query string, including or excluding the leading `?`
 * @returns A validated benchmark configuration
 */
export function parseBenchmarkConfig(search = window.location.search): BenchmarkRunConfig {
    const params = new URLSearchParams(search);
    const mode = enumParam(
        params,
        'benchMode',
        ['interactive', 'performance', 'capture'] as const,
        'interactive',
    );
    const ratio = numberParam(params, 'ratio', 2);
    if (!RATIOS.includes(ratio as (typeof RATIOS)[number]))
        throw new Error(`Unsupported benchmark ratio: ${ratio}`);

    const width = Math.floor(numberParam(params, 'width', mode === 'interactive' ? window.innerWidth : 1920));
    const height = Math.floor(
        numberParam(params, 'height', mode === 'interactive' ? window.innerHeight : 1080),
    );
    if (width < 1 || height < 1) throw new Error('Benchmark dimensions must be positive integers.');

    const variant = enumParam(params, 'variant', VARIANTS, 'baseline');
    const comparison = enumParam(params, 'comparison', VARIANTS, 'baseline');
    const scenario = enumParam(params, 'scenario', SCENARIOS, 'Q1');
    const experiment = params.get('experiment') ?? 'E00';
    if (experiment !== 'E00') throw new Error(`Unsupported benchmark experiment: ${experiment}`);

    const warmupFrames = Math.floor(numberParam(params, 'warmup', 240));
    const sampleFrames = Math.floor(numberParam(params, 'samples', 600));
    if (warmupFrames < 0 || sampleFrames < 1)
        throw new Error('Benchmark warmup must be non-negative and samples must be positive.');

    return {
        experiment: 'E00',
        mode,
        variant,
        comparison,
        scenario,
        subrun: params.get('subrun'),
        ratio,
        dimensions: {
            width,
            height,
            devicePixelRatio: mode === 'interactive' ? Math.min(window.devicePixelRatio, 2) : 1,
        },
        timestepSeconds: 1 / 60,
        warmupFrames,
        sampleFrames,
        authoritativeTiming: mode === 'performance',
    };
}

/** Ratios accepted by the immutable E00 manifest. */
export const BENCHMARK_RATIOS: readonly number[] = RATIOS;
