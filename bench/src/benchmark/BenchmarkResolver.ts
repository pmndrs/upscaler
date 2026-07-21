import type * as THREE from 'three/webgpu';

import { Upscaler } from '@pmndrs/upscaler';
import { RCAS_LEGACY_SHADER, RCAS_SHADER } from '../../../src/shaders/rcas';

interface BenchmarkTimerBridge {
    readonly enabled: boolean;
    setNextFrameTag(frameTag: number): void;
    setAuthoritative(authoritative: boolean): void;
    waitForAvailableSlot(): Promise<void>;
    drain(): Promise<void>;
    reset(): void;
    takeSamples(): Array<{
        frameTag: number;
        sequence: number;
        passes: Array<{ label: string; milliseconds: number }>;
    }>;
}

/**
 * Adapts the unchanged production upscaler to the benchmark lifecycle.
 */
export class BaselineBenchmarkResolver implements BenchmarkResolver {
    readonly metadata: BenchmarkVariantMetadata;

    private readonly _upscaler: Upscaler;

    constructor(
        renderer: THREE.WebGPURenderer,
        metadata: BenchmarkVariantMetadata,
        rcasShader?: string,
        candidateBundle?: string,
    ) {
        this.metadata = metadata;
        const options = {
            renderer,
            _rcasShader: rcasShader,
            _candidateBundle: candidateBundle,
        };
        this._upscaler = new Upscaler(options);
        this._upscaler.init();
        if (typeof metadata.settings.rcasDenoise === 'boolean')
            this._upscaler.settings.rcasDenoise = metadata.settings.rcasDenoise;
    }

    get outputTexture(): THREE.Texture {
        return this._upscaler.outputTexture;
    }

    get renderWidth(): number {
        return this._upscaler.renderWidth;
    }

    get renderHeight(): number {
        return this._upscaler.renderHeight;
    }

    get displayWidth(): number {
        return this._upscaler.displayWidth;
    }

    get displayHeight(): number {
        return this._upscaler.displayHeight;
    }

    get upscaleRatio(): number {
        return this._upscaler.upscaleRatio;
    }

    get jitterPhaseCount(): number {
        return this._upscaler.jitterPhaseCount;
    }

    get timestampQuerySupported(): boolean {
        return this._timer.enabled;
    }

    get unjitteredProjectionMatrix(): THREE.Matrix4 {
        return this._upscaler.unjitteredProjectionMatrix;
    }

    get settings(): Record<string, unknown> {
        return this._upscaler.settings as unknown as Record<string, unknown>;
    }

    get timings(): ReadonlyMap<string, number> {
        return this._upscaler.gpuTimings;
    }

    private get _timer(): BenchmarkTimerBridge {
        // The benchmark bridge deliberately stays private to the bench. Normal
        // library users retain the existing no-op/latest-map timing behavior.
        return (this._upscaler as unknown as { _timer: BenchmarkTimerBridge })._timer;
    }

    configure(config: BenchmarkResolverConfigure): void {
        this._upscaler.configure({
            displayWidth: config.displayWidth,
            displayHeight: config.displayHeight,
            customUpscaleRatio: config.ratio,
            path: config.path,
        });
    }

    beginFrame(camera: unknown): void {
        this._upscaler.beginFrame(camera as THREE.PerspectiveCamera);
    }

    endFrame(camera: unknown): void {
        this._upscaler.endFrame(camera as THREE.PerspectiveCamera);
    }

    dispatch(inputs: BenchmarkResolverDispatch, camera: unknown): void {
        this._timer.setNextFrameTag(inputs.frameTag);
        this._upscaler.dispatch(
            {
                color: inputs.color as THREE.Texture,
                depth: inputs.depth as THREE.Texture | undefined,
                velocity: inputs.velocity as THREE.Texture | undefined,
                reactive: inputs.reactive as THREE.Texture | undefined,
                transparencyAndComposition: inputs.transparencyAndComposition as
                    | THREE.Texture
                    | undefined,
                preExposureTexture: inputs.preExposureTexture as THREE.Texture | undefined,
                deltaTime: inputs.deltaTime,
            },
            camera as THREE.PerspectiveCamera,
        );
    }

    reset(): void {
        this._upscaler.resetHistory();
        this._timer.reset();
    }

    resetTiming(): void {
        this._timer.reset();
    }

    setAuthoritativeTiming(authoritative: boolean): void {
        this._timer.setAuthoritative(authoritative);
    }

    waitForTimingCapacity(): Promise<void> {
        return this._timer.waitForAvailableSlot();
    }

    drainTiming(): Promise<void> {
        return this._timer.drain();
    }

    takeTimingSamples(): BenchmarkGpuFrameSample[] {
        return this._timer.takeSamples();
    }

    dispose(): void {
        this._upscaler.dispose();
    }
}

/**
 * Creates the unchanged local baseline resolver.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the selected identity
 * @returns One baseline resolver instance
 */
export function createBaselineResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
    );
}

/**
 * Creates the isolated FSR 3.1.5 RCAS numeric candidate.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the candidate identity
 * @returns One candidate resolver instance
 */
export function createRcasNumericParityResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_SHADER,
    );
}

/**
 * Creates one of the cumulative source-style benchmark candidates.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the candidate bundle ID
 * @returns One candidate resolver instance
 */
export function createSourceBundleResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_SHADER,
        metadata.id,
    );
}
