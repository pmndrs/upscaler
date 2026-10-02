import type * as THREE from 'three/webgpu';

import { Upscaler } from '@pmndrs/upscaler';
import { CandidateUpscaler } from '../candidates/CandidateUpscaler';
import {
    RCAS_HOISTED_EXPOSURE_SHADER,
    RCAS_LEGACY_SHADER,
    RCAS_PER_TAP_SHADER,
    RCAS_SHADER,
    RCAS_TONEMAP_SPACE_SHADER,
} from '../../../src/shaders/rcas';

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
class BenchmarkResolverAdapter implements BenchmarkResolver {
    readonly metadata: BenchmarkVariantMetadata;

    private readonly _upscaler: Upscaler | CandidateUpscaler;

    constructor(
        upscaler: Upscaler | CandidateUpscaler,
        metadata: BenchmarkVariantMetadata,
    ) {
        this.metadata = metadata;
        this._upscaler = upscaler;
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
        const dispatchInputs = {
            color: inputs.color as THREE.Texture,
            depth: inputs.depth as THREE.Texture | undefined,
            velocity: inputs.velocity as THREE.Texture | undefined,
            reactive: inputs.reactive as THREE.Texture | undefined,
            reactiveOpaqueColor: inputs.reactiveOpaqueColor as THREE.Texture | undefined,
            preExposureTexture: inputs.preExposureTexture as THREE.Texture | undefined,
            giFusion: inputs.giFusion
                ? {
                      ...inputs.giFusion,
                      signal: inputs.giFusion.signal as THREE.Texture,
                      albedo: inputs.giFusion.albedo as THREE.Texture,
                      occlusion: inputs.giFusion.occlusion as THREE.Texture | undefined,
                  }
                : undefined,
            deltaTime: inputs.deltaTime,
        };
        const dispatchCamera = camera as THREE.PerspectiveCamera;

        if (this._upscaler instanceof CandidateUpscaler) {
            this._upscaler.dispatch(
                {
                    ...dispatchInputs,
                    transparencyAndComposition: inputs.transparencyAndComposition as
                        | THREE.Texture
                        | undefined,
                },
                dispatchCamera,
            );
            return;
        }

        this._upscaler.dispatch(dispatchInputs, dispatchCamera);
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

function createProductionUpscaler(
    renderer: THREE.WebGPURenderer,
    rcasShader?: string,
    spatialRcasShader?: string,
): Upscaler {
    const options = { renderer, _rcasShader: rcasShader, _spatialRcasShader: spatialRcasShader };
    return new Upscaler(options);
}

function createCandidateUpscaler(
    renderer: THREE.WebGPURenderer,
    candidateBundle: string,
): CandidateUpscaler {
    const options = {
        renderer,
        // The source bundles run RCAS without FLAG_INPUT_REINHARD, where both
        // historical forms are identical.
        _rcasShader: RCAS_PER_TAP_SHADER,
        _candidateBundle: candidateBundle,
    };
    return new CandidateUpscaler(options);
}

/**
 * Adapts the production upscaler to the benchmark lifecycle.
 */
export class BaselineBenchmarkResolver extends BenchmarkResolverAdapter {
    constructor(
        renderer: THREE.WebGPURenderer,
        metadata: BenchmarkVariantMetadata,
        rcasShader?: string,
        spatialRcasShader?: string,
    ) {
        super(createProductionUpscaler(renderer, rcasShader, spatialRcasShader), metadata);
    }
}

/**
 * Adapts one frozen source-bundle snapshot to the benchmark lifecycle.
 */
export class CandidateBenchmarkResolver extends BenchmarkResolverAdapter {
    constructor(
        renderer: THREE.WebGPURenderer,
        metadata: BenchmarkVariantMetadata,
    ) {
        super(createCandidateUpscaler(renderer, metadata.id), metadata);
    }
}

/**
 * Creates the local baseline resolver. Its temporal path runs the frozen
 * `RCAS_LEGACY_SHADER` (the E00 `local-baseline-5d6a65e` shader identity), so
 * temporal captures and convergence records stay comparable across history.
 *
 * The spatial (FSR1) path differs by identity: `baseline` — the interactive
 * bench default — sharpens with production `RCAS_SHADER`, so spatial-path
 * changes show up in the bench. The two frozen E00 identities keep the legacy
 * shader on every path; `local-baseline-5d6a65e` is the explicit legacy FSR1
 * variant for A/B. No automated run uses the spatial path, so this changes no
 * recorded benchmark.
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
        metadata.id === 'baseline' ? RCAS_SHADER : undefined,
    );
}

/**
 * Creates the isolated FSR 3.1.5 RCAS numeric candidate. Pinned to the
 * per-tap shader (the production form when these identities were measured) so
 * their timings stay frozen; current production is `rcas-tonemap-space-v1`.
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
        RCAS_PER_TAP_SHADER,
    );
}

/**
 * Creates an RCAS load-strategy experiment candidate (item 1 of
 * bench/docs/NEXT-STEPS.md): production pipeline, only the RCAS shader varies.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the experiment identity
 * @returns One candidate resolver instance
 */
export function createRcasExperimentResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        metadata.id === 'rcas-hoisted-exposure-v1'
            ? RCAS_HOISTED_EXPOSURE_SHADER
            : RCAS_TONEMAP_SPACE_SHADER,
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
    return new CandidateBenchmarkResolver(renderer as THREE.WebGPURenderer, metadata);
}
