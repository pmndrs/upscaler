declare type BenchmarkMode = 'interactive' | 'performance' | 'capture';
declare type BenchmarkVariantId =
    | 'baseline'
    | 'local-baseline-5d6a65e'
    | 'local-baseline-through-e00-harness'
    | 'rcas-fsr315-limiter'
    | 'rcas-fsr315-numeric'
    | 'source-filter-bundle-v1'
    | 'source-structural-bundle-v1'
    | 'source-spd-resolver-bundle-v1';
declare type BenchmarkScenarioId =
    | 'Q0'
    | 'Q1'
    | 'Q2'
    | 'Q3'
    | 'Q4'
    | 'Q5'
    | 'Q6'
    | 'Q7'
    | 'Q8'
    | 'Q9'
    | 'Q10';
declare type BenchmarkDebugView =
    | 'final'
    | 'motion-vectors'
    | 'disocclusion'
    | 'accumulation-age'
    | 'locks'
    | 'exposure'
    | 'shading-change'
    | 'reactivity';

declare interface BenchmarkDimensions {
    width: number;
    height: number;
    devicePixelRatio: number;
}

declare interface BenchmarkRunConfig {
    experiment: 'E00';
    mode: BenchmarkMode;
    variant: BenchmarkVariantId;
    comparison: BenchmarkVariantId;
    scenario: BenchmarkScenarioId;
    subrun: string | null;
    ratio: number;
    dimensions: BenchmarkDimensions;
    timestepSeconds: number;
    warmupFrames: number;
    sampleFrames: number;
    authoritativeTiming: boolean;
}

declare interface BenchmarkPipelineMetadata {
    shaderKey: string;
    pipelineKey: string;
    assembledChunks: readonly string[];
    wgslOverrides: Readonly<Record<string, number | boolean>>;
    timingPassLabels: readonly string[];
}

declare interface BenchmarkVariantMetadata {
    id: BenchmarkVariantId;
    name: string;
    supportedRatios: readonly number[];
    settings: Readonly<Record<string, boolean | number | string>>;
    resourceGraph: readonly string[];
    pipeline: BenchmarkPipelineMetadata;
}

declare interface BenchmarkResolverConfigure {
    displayWidth: number;
    displayHeight: number;
    ratio: number;
    path: 'bilinear' | 'spatial' | 'temporal';
}

declare interface BenchmarkResolverDispatch {
    color: unknown;
    depth?: unknown;
    velocity?: unknown;
    reactive?: unknown;
    transparencyAndComposition?: unknown;
    preExposureTexture?: unknown;
    deltaTime: number;
    frameTag: number;
}

declare interface BenchmarkResolver {
    readonly metadata: BenchmarkVariantMetadata;
    readonly outputTexture: unknown;
    readonly renderWidth: number;
    readonly renderHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly upscaleRatio: number;
    readonly jitterPhaseCount: number;
    readonly timestampQuerySupported: boolean;
    readonly unjitteredProjectionMatrix: unknown;
    readonly settings: Record<string, unknown>;
    readonly timings: ReadonlyMap<string, number>;
    configure(config: BenchmarkResolverConfigure): void;
    beginFrame(camera: unknown): void;
    endFrame(camera: unknown): void;
    dispatch(inputs: BenchmarkResolverDispatch, camera: unknown): void;
    reset(): void;
    resetTiming(): void;
    setAuthoritativeTiming(authoritative: boolean): void;
    waitForTimingCapacity(): Promise<void>;
    drainTiming(): Promise<void>;
    takeTimingSamples(): BenchmarkGpuFrameSample[];
    dispose(): void;
}

declare type BenchmarkResolverFactory = (
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
) => BenchmarkResolver;

declare interface BenchmarkVariantDefinition {
    metadata: BenchmarkVariantMetadata;
    create: BenchmarkResolverFactory;
}

declare interface BenchmarkGpuPassSample {
    label: string;
    milliseconds: number;
}

declare interface BenchmarkGpuFrameSample {
    frameTag: number;
    sequence: number;
    passes: BenchmarkGpuPassSample[];
}

declare interface BenchmarkPassSummary {
    label: string;
    samples: number[];
    median: number | null;
    p95: number | null;
    missingCount: number;
}

declare interface BenchmarkTimingSummary {
    expectedFrames: number;
    receivedFrames: number;
    missingFrameCount: number;
    duplicateFrameCount: number;
    duplicateSequenceCount: number;
    unexpectedFrameCount: number;
    duplicatePassLabelCount: number;
    invalidValueCount: number;
    inconsistentPassSetCount: number;
    invalidityCount: number;
    expectedPassLabels: string[];
    invalidSamples: BenchmarkInvalidTimingSample[];
    passes: BenchmarkPassSummary[];
    computeSum: BenchmarkPassSummary;
    raw: BenchmarkGpuFrameSample[];
}

declare interface BenchmarkInvalidTimingSample {
    frameTag: number;
    sequence: number;
    reason:
        | 'unexpected-frame'
        | 'duplicate-frame'
        | 'duplicate-sequence'
        | 'duplicate-pass-label'
        | 'invalid-pass-value'
        | 'inconsistent-pass-set';
    detail: string;
}

declare interface BenchmarkUnsupportedCapability {
    code: string;
    capability: string;
    reason: string;
}

declare interface BenchmarkScenarioDefinition {
    id: BenchmarkScenarioId;
    name: string;
    endFrame: number;
    captures: readonly string[];
    debugViews: readonly BenchmarkDebugView[];
    rois: Readonly<Record<string, readonly [number, number, number, number]>>;
    subruns: readonly string[];
    unsupported: BenchmarkUnsupportedCapability | null;
    frame(frame: number): BenchmarkFrameState;
}

declare interface BenchmarkFrameState {
    frame: number;
    time: number;
    cameraPosition: readonly [number, number, number];
    cameraTarget: readonly [number, number, number];
    sceneTime: number;
    animateScene: boolean;
    directionalIntensity: number;
    resetHistory: boolean;
    resize: BenchmarkDimensions | null;
    particlesVisible: boolean;
}

declare interface BenchmarkCaptureRequest {
    frame: number;
    debugView: BenchmarkDebugView;
}

declare interface BenchmarkCaptureResult {
    scenario: BenchmarkScenarioId;
    subrun: string | null;
    ratio: number;
    frame: number;
    debugView: BenchmarkDebugView;
    width: number;
    height: number;
    jitterPeriod: number;
}

declare interface BenchmarkRunOptions {
    warmupFrames?: number;
    sampleFrames?: number;
}

declare interface BenchmarkValidationRecord {
    channel: string;
    level: string;
    text: string;
    timestamp: number;
}

declare interface BenchmarkEnvironment {
    browser: string;
    operatingSystem: string;
    adapter: string;
    backend: string;
    webgpuFeatures: string[];
    threeVersion: string;
    dimensions: BenchmarkDimensions;
    ratio: number;
    fixedTimestep: number;
}

declare interface BenchmarkResult {
    status: 'ready' | 'complete' | 'unsupported' | 'failed';
    experiment: 'E00';
    manifestDigest: string;
    config: BenchmarkRunConfig;
    variant: BenchmarkVariantMetadata;
    scenario: BenchmarkScenarioId;
    unsupported: BenchmarkUnsupportedCapability | null;
    environment: BenchmarkEnvironment;
    timing: BenchmarkTimingSummary | null;
    captures: BenchmarkCaptureResult[];
    validation: BenchmarkValidationRecord[];
}

declare interface UpscalerBenchmarkApi {
    readonly ready: boolean;
    readonly config: BenchmarkRunConfig;
    readonly metadata: BenchmarkVariantMetadata;
    readonly result: BenchmarkResult;
    step(frame?: number): Promise<number>;
    reset(): Promise<void>;
    capture(request: BenchmarkCaptureRequest): Promise<BenchmarkCaptureResult>;
    run(options?: BenchmarkRunOptions): Promise<BenchmarkResult>;
}

interface Window {
    __UPSCALER_BENCH__?: UpscalerBenchmarkApi;
}
