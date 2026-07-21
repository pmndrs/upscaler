import type * as THREE from 'three/webgpu';

import { DebugView } from '@pmndrs/upscaler';

import type { BenchPipeline } from '../BenchPipeline';
import type { BenchScene } from '../BenchScene';
import { BenchmarkClock } from './clock';
import { BenchmarkCollector } from './collector';

interface BenchmarkApiContext {
    renderer: THREE.WebGPURenderer;
    camera: THREE.PerspectiveCamera;
    bench: BenchScene;
    pipeline: BenchPipeline | null;
    config: BenchmarkRunConfig;
    metadata: BenchmarkVariantMetadata;
    scenario: BenchmarkScenarioDefinition;
    environment: BenchmarkEnvironment;
    manifestDigest: string;
    validation: BenchmarkValidationRecord[];
    resize(dimensions: BenchmarkDimensions): void;
}

const DEBUG_VIEWS: Record<BenchmarkDebugView, DebugView> = {
    final: DebugView.None,
    'motion-vectors': DebugView.MotionVectors,
    disocclusion: DebugView.Disocclusion,
    'accumulation-age': DebugView.AccumulationAge,
    locks: DebugView.Locks,
    exposure: DebugView.Exposure,
    'shading-change': DebugView.ShadingChange,
    reactivity: DebugView.Reactivity,
};

/**
 * Exact deterministic browser API consumed by the CDP runner.
 */
class BrowserBenchmarkApi implements UpscalerBenchmarkApi {
    readonly ready = true;
    readonly config: BenchmarkRunConfig;
    readonly metadata: BenchmarkVariantMetadata;

    private readonly _context: BenchmarkApiContext;
    private readonly _clock = new BenchmarkClock();
    private readonly _captures: BenchmarkCaptureResult[] = [];
    private _result: BenchmarkResult;

    constructor(context: BenchmarkApiContext) {
        this._context = context;
        this.config = context.config;
        this.metadata = context.metadata;
        this._result = {
            status: context.scenario.unsupported ? 'unsupported' : 'ready',
            experiment: 'E00',
            manifestDigest: context.manifestDigest,
            config: context.config,
            variant: context.metadata,
            scenario: context.scenario.id,
            unsupported: context.scenario.unsupported,
            environment: context.environment,
            timing: null,
            captures: this._captures,
            validation: context.validation,
        };
    }

    get result(): BenchmarkResult {
        return this._result;
    }

    async step(frame?: number): Promise<number> {
        this._requireSupported();
        const target = frame ?? this._clock.frame;
        if (!Number.isInteger(target) || target < 0)
            throw new Error(`Benchmark frame must be a non-negative integer: ${target}`);
        if (target < this._clock.frame) await this.reset();
        while (this._clock.frame <= target) await this._renderOne(this._clock.frame);
        return target;
    }

    async reset(): Promise<void> {
        const { pipeline, bench, config, scenario, camera } = this._context;
        if (pipeline) await pipeline.drainTiming();
        const canvas = this._context.renderer.domElement;
        const resized =
            canvas.width !== config.dimensions.width || canvas.height !== config.dimensions.height;
        if (resized) this._context.resize(config.dimensions);
        if (resized && pipeline?.usesEffectGraph)
            await pipeline.prepareEffectReadiness(this._context.camera);
        bench.resetDeterministicState();
        const frameZero = scenario.frame(0);
        this._applyFrameState(frameZero);
        pipeline?.reset(bench.scene, camera, 0);
        this._clock.reset();
    }

    async capture(request: BenchmarkCaptureRequest): Promise<BenchmarkCaptureResult> {
        this._requireSupported();
        const pipeline = this._context.pipeline!;
        if (!this._context.scenario.debugViews.includes(request.debugView))
            throw new Error(
                `Debug view ${request.debugView} is not declared for ${this._context.scenario.id}.`,
            );
        pipeline.applySettings({
            sharpness: 0.8,
            rcasDenoise:
                pipeline.resolver.metadata.settings.rcasDenoise === true ||
                ['Q6', 'Q7', 'Q8'].includes(this._context.scenario.id),
            maxAccumulation: 24,
            exposure: 1,
            autoExposure: true,
            lockThinFeatures: true,
            detectShadingChanges: true,
            debugView: DEBUG_VIEWS[request.debugView],
        });
        await this.reset();
        await this.step(request.frame);
        const device = (
            this._context.renderer.backend as unknown as { device?: GPUDevice }
        ).device;
        if (!device) throw new Error('WebGPU device unavailable before capture.');
        await device.queue.onSubmittedWorkDone();

        const capture = {
            scenario: this._context.scenario.id,
            subrun: this.config.subrun,
            ratio: this.config.ratio,
            frame: request.frame,
            debugView: request.debugView,
            width: this._context.renderer.domElement.width,
            height: this._context.renderer.domElement.height,
            jitterPeriod: pipeline.resolver.jitterPhaseCount,
        };
        this._captures.push(capture);
        return capture;
    }

    async run(options: BenchmarkRunOptions = {}): Promise<BenchmarkResult> {
        if (this._context.scenario.unsupported) return this._result;
        const pipeline = this._context.pipeline!;
        const warmupFrames = options.warmupFrames ?? this.config.warmupFrames;
        const sampleFrames = options.sampleFrames ?? this.config.sampleFrames;
        if (!Number.isInteger(warmupFrames) || warmupFrames < 0)
            throw new Error(`Invalid warmup frame count: ${warmupFrames}`);
        if (!Number.isInteger(sampleFrames) || sampleFrames < 1)
            throw new Error(`Invalid sample frame count: ${sampleFrames}`);

        pipeline.resolver.setAuthoritativeTiming(this.config.authoritativeTiming);
        if (this.config.authoritativeTiming && !pipeline.resolver.timestampQuerySupported)
            throw new Error('Performance mode requires timestamp-query support.');

        await this.reset();
        for (let index = 0; index < warmupFrames; index++) await this.step();
        await pipeline.drainTiming();
        pipeline.takeTimingSamples();
        pipeline.resolver.resetTiming();

        const firstMeasuredFrame = this._clock.frame;
        const expectedFrames = Array.from(
            { length: sampleFrames },
            (_, index) => firstMeasuredFrame + index,
        );
        const collector = new BenchmarkCollector(
            expectedFrames,
            this.metadata.pipeline.timingPassLabels,
        );
        for (let index = 0; index < sampleFrames; index++) await this.step();
        await pipeline.drainTiming();
        collector.add(pipeline.takeTimingSamples());
        const timing = collector.summarize();
        this._result = { ...this._result, status: 'complete', timing };

        if (
            this.config.authoritativeTiming &&
            (timing.invalidityCount !== 0 ||
                timing.receivedFrames !== sampleFrames)
        ) {
            this._result = { ...this._result, status: 'failed' };
            throw new Error(
                `Invalid fresh timing set: expected ${sampleFrames}, received ${timing.receivedFrames}, ` +
                    `missing ${timing.missingFrameCount}, invalidities ${timing.invalidityCount}.`,
            );
        }
        return this._result;
    }

    private _requireSupported(): void {
        const unsupported = this._context.scenario.unsupported;
        if (unsupported)
            throw new Error(`${unsupported.code}: ${unsupported.capability}: ${unsupported.reason}`);
        if (!this._context.pipeline) throw new Error('Benchmark resolver is unavailable.');
    }

    private async _renderOne(frame: number): Promise<void> {
        const { pipeline, scenario, camera, bench, config } = this._context;
        if (!pipeline) return;
        const scenarioFrame = scenario.frame(Math.min(frame, scenario.endFrame));
        if (scenarioFrame.resize) this._context.resize(scenarioFrame.resize);
        this._applyFrameState(scenarioFrame);
        if (scenarioFrame.resetHistory) pipeline.reset(bench.scene, camera, frame);

        await pipeline.prepareTiming();
        pipeline.advanceAutomatedFrame(frame);
        pipeline.renderInput(
            bench.scene,
            camera,
            scenarioFrame.particlesVisible ? bench.reactiveScene : undefined,
        );
        pipeline.dispatchResolver(camera, config.timestepSeconds, frame);
        pipeline.present();
        this._clock.seek(frame + 1);
    }

    private _applyFrameState(frame: BenchmarkFrameState): void {
        const { camera, bench } = this._context;
        camera.position.fromArray(frame.cameraPosition);
        camera.up.set(0, 1, 0);
        camera.lookAt(...frame.cameraTarget);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        bench.applyFrame(frame);
        bench.scene.updateMatrixWorld(true);
        bench.roomScene.updateMatrixWorld(true);
        bench.reactiveScene.updateMatrixWorld(true);
    }
}

/**
 * Creates the globally exposed deterministic benchmark API.
 * @param context - Initialized browser benchmark dependencies
 * @returns Exact CDP-facing API
 */
export function createBenchmarkApi(context: BenchmarkApiContext): UpscalerBenchmarkApi {
    return new BrowserBenchmarkApi(context);
}
