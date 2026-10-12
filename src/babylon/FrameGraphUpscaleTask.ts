import { Constants } from '@babylonjs/core/Engines/constants.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { FrameGraphTextureCreationOptions } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { UpscalerCore } from '../core/UpscalerCore.js';
import { getResourceDescriptors } from '../core/resources.js';
import { DebugView, DEFAULT_SETTINGS } from '../core/types.js';
import { JitterSequence } from '../math/jitter.js';
import { jitterProjection } from '../core/projection.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { CoreConfiguration, CoreResources, FrameData, ResourceDescriptor, ResourceName, RuntimeSettings } from '../core/types.js';
import { freezeJitteredProjection, getBabylonDevice, getBabylonEncoder, resolveBabylonTexture } from './compatibility.js';

/** Babylon-supported configuration; split guides are enabled on the temporal path via createGuidesTask(). */
export type FrameGraphUpscaleConfiguration = Omit<CoreConfiguration, 'path'> & { path?: 'temporal' | 'spatial' | 'bilinear' };

/** Render-resolution guides owned by Babylon's texture manager, available on the temporal path. */
export interface FrameGraphUpscaleGuides {
    /** Current linear depth. Resolve with getTextureFromHandle(handle, true), as this is history.write. */
    readonly dilatedDepth: number;
    /** Dilated motion in RG, in UV units. */
    readonly dilatedMotion: number;
    /** Disocclusion in R: 1 rejects history, 0 accepts it. */
    readonly disocclusion: number;
}

/** Configuration, frame callback and initial runtime settings for the Frame Graph adapter. */
export interface FrameGraphUpscaleOptions {
    /** Allocation and shader requirements; configure again only between frames. */
    configuration: FrameGraphUpscaleConfiguration;
    /**
     * Must match the conditioning/host exposure baked into the input textures.
     * In split mode this runs for each phase; geometry must stay identical until upscale finishes.
     */
    frame: () => FrameData;
    /** Initial runtime overrides merged with DEFAULT_SETTINGS. */
    settings?: Partial<RuntimeSettings>;
}

/**
 * Convert core texture requirements into native Frame Graph allocation options.
 * @param descriptor - Validated requirement from getResourceDescriptors().
 * @returns Single-sample options preserving dimensions, format, storage and history flags.
 */
export function getBabylonTextureOptions(descriptor: ResourceDescriptor): FrameGraphTextureCreationOptions {
    const integer = descriptor.format === 'rgba32uint';
    const red = descriptor.format === 'r8unorm' || descriptor.format === 'r32float';
    const type = integer ? Constants.TEXTURETYPE_UNSIGNED_INTEGER : descriptor.format.includes('32float') ? Constants.TEXTURETYPE_FLOAT : descriptor.format.includes('16float') ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    return {
        size: { width: descriptor.width, height: descriptor.height }, sizeIsPercentage: false,
        isHistoryTexture: descriptor.history,
        options: { samples: 1, createMipMaps: false, types: [type], formats: [integer ? Constants.TEXTUREFORMAT_RGBA_INTEGER : red ? Constants.TEXTUREFORMAT_RED : Constants.TEXTUREFORMAT_RGBA], creationFlags: [(descriptor.usage & 8) ? Constants.TEXTURE_CREATIONFLAG_STORAGE : 0] },
    };
}

/**
 * Temporal, spatial or bilinear reconstruction on Babylon's current WebGPU encoder.
 * The texture manager owns all allocations and history swaps. See docs/babylon-framegraph.md.
 * @remarks Prepare before execution and wrap jittered scene rendering in beginFrame/endFrame.
 */
export class FrameGraphUpscaleTask extends FrameGraphTask {
    /** Final input color; may be produced between guides and upscale. */
    colorTexture!: number;
    /** Render-resolution depth matching configuration.depthMode; temporal only. */
    depthTexture!: number;
    /** Render-resolution velocity converted through frame().motionScale; temporal only. */
    velocityTexture!: number;
    /** Optional authored reactive mask in R. */
    reactiveTexture?: number;
    /** Optional opaque reference color for automatic reactive-mask generation. */
    reactiveOpaqueColorTexture?: number;
    /** Optional 1x1 conditioning exposure overriding the CPU value. */
    exposureTexture?: number;
    /** Optional 1x1 host pre-exposure baked into input color. */
    preExposureTexture?: number;
    /** Stable display-resolution output handle resolved when the graph is built. */
    readonly outputTexture: number;
    /** Stable temporal guide handles; dilatedDepth resolves to current history.write. */
    readonly guides: FrameGraphUpscaleGuides;
    /** Mutable runtime defaults; frame callback settings can override them. */
    readonly settings: RuntimeSettings;
    private readonly core: UpscalerCore;
    private readonly fallback: UpscalerCore;
    private configuration: FrameGraphUpscaleConfiguration;
    private readonly frame: () => FrameData;
    private readonly handles = new Map<ResourceName, number>();
    private temporalLastFrame = false;
    private initialized = false;
    private preparation?: Promise<void>;
    private guidesTask?: FrameGraphTask;
    private guidesRecorded = false;
    private splitPending = false;
    private sequence = new JitterSequence(1);
    private restoreProjection: (() => void) | null = null;
    private currentJitter = { x: 0, y: 0 };
    private previousJitter = { x: 0, y: 0 };
    /** Use this projection when generating unjittered motion vectors. */
    unjitteredProjectionMatrix: Matrix | null = null;

    /**
     * Register stable output/guide handles and configure core-owned GPU state.
     * @param name - Task label used for graph passes and allocations.
     * @param graph - Host Frame Graph on an initialized Babylon 9.29 WebGPU engine.
     * @param options - Configuration, per-phase frame callback and initial settings.
     */
    constructor(name: string, graph: FrameGraph, options: FrameGraphUpscaleOptions) {
        super(name, graph);
        this.configuration = { ...options.configuration, path: options.configuration.path ?? 'temporal' };
        getResourceDescriptors(this.configuration);
        this.frame = options.frame; this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
        const device = getBabylonDevice(graph.engine);
        this.core = new UpscalerCore({ device }); this.fallback = new UpscalerCore({ device });
        this.configure(this.configuration);
        this.outputTexture = graph.textureManager.createDanglingHandle();
        this.guides = Object.freeze({
            dilatedDepth: graph.textureManager.createDanglingHandle(),
            dilatedMotion: graph.textureManager.createDanglingHandle(),
            disocclusion: graph.textureManager.createDanglingHandle(),
        });
    }

    /**
     * Change requirements between frames, then prepare and rebuild the Frame Graph.
     * @param configuration - Dimensions and shader variants; temporal is the default path.
     * @returns No value; history and preparation readiness are invalidated.
     * @throws If a jitter/split frame is active or a guides task would lose its temporal path.
     */
    configure(configuration: FrameGraphUpscaleConfiguration): void {
        if (this.splitPending) throw new Error('@pmndrs/upscaler: cannot configure during a Babylon split frame; finish upscale or resetHistory() first.');
        if (this.restoreProjection) throw new Error('@pmndrs/upscaler: cannot configure during an active Babylon frame.');
        if (this.guidesTask && (configuration.path ?? 'temporal') !== 'temporal') throw new Error('@pmndrs/upscaler: a guides task requires the temporal path.');
        if (configuration.path && !['temporal', 'spatial', 'bilinear'].includes(configuration.path)) throw new Error('@pmndrs/upscaler: Babylon task supports temporal, spatial or bilinear paths.');
        this.configuration = { ...configuration, path: configuration.path ?? 'temporal' };
        this.core.configure(this.configuration);
        this.fallback.configure({ ...this.configuration, path: 'bilinear' });
        this.temporalLastFrame = false; this.initialized = false; this.preparation = undefined; this.guidesRecorded = false;
        this.sequence.setRatio(configuration.displayWidth / configuration.renderWidth);
    }
    /**
     * Prepare shared temporal/optional passes and the defined bilinear fallback.
     * @returns Shared preparation completion; a failed request can be retried.
     */
    prepare(): Promise<void> {
        // Both tasks share compilation, including optional passes changed by frame callbacks.
        if (this.preparation) return this.preparation;
        const preparation = Promise.all([
            this.core.prepare({ ...this.settings, detectShadingChanges: true, debugView: DebugView.Depth }), this.fallback.prepare({}),
        ]).then(() => {
            if (this.preparation === preparation) this.initialized = true;
        }, error => {
            if (this.preparation === preparation) this.preparation = undefined;
            throw error;
        });
        return this.preparation = preparation;
    }
    /** @returns Pipeline preparation completion requested by Frame Graph initialization. */
    override initAsync(): Promise<void> { return this.prepare(); }
    /** @returns Whether the owner and fallback are prepared on a live device. */
    override isReady(): boolean { return this.initialized && this.core.isReady && this.fallback.isReady; }
    /** Select the defined bilinear fallback; transitions reset history, and activation requires readiness. */
    override get disabled(): boolean { return this._disabled; }
    override set disabled(value: boolean) {
        if (value === this._disabled) return;
        if (!value && !this.isReady()) throw new Error('@pmndrs/upscaler: cannot activate an unprepared Babylon task.');
        this._disabled = value; this.resetHistory();
    }
    /**
     * Cancel any split frame and restart temporal history and jitter sequencing.
     * @returns No value; native texture ownership and history rotation stay with Babylon.
     */
    resetHistory(): void { this.core.resetHistory(); this.splitPending = false; this.temporalLastFrame = false; this.sequence.reset(); }
    /** Current projection offset in render pixels; zero for disabled and non-temporal paths. */
    get jitter(): Readonly<{ x: number; y: number }> { return this.currentJitter; }
    /**
     * Apply jitter while preserving the camera's original projection ownership.
     * @param camera - Camera used to render depth, velocity and color inputs.
     * @returns No value; always call endFrame() in a finally after graph execution.
     * @throws If another jitter frame is active.
     */
    beginFrame(camera: Camera): void {
        if (this.restoreProjection) throw new Error('@pmndrs/upscaler: a Babylon jitter frame is already active.');
        this.sequence.advance(); const [x, y] = this.sequence.current; const [px, py] = this.sequence.previous;
        const jittered = !this.disabled && this.configuration.path === 'temporal';
        this.currentJitter = jittered ? { x, y } : { x: 0, y: 0 }; this.previousJitter = jittered ? { x: px, y: py } : { x: 0, y: 0 };
        this.unjitteredProjectionMatrix = camera.getProjectionMatrix().clone();
        const projection = this.unjitteredProjectionMatrix.clone();
        projection.fromArray(jitterProjection(projection.m, this.currentJitter, this.configuration.renderWidth, this.configuration.renderHeight));
        this.restoreProjection = freezeJitteredProjection(camera, projection);
    }
    /**
     * Restore the camera projection and invalidate any abandoned split frame.
     * @returns No value; safe to call when no camera frame is active.
     */
    endFrame(): void {
        this.restoreProjection?.(); this.restoreProjection = null;
        // A consumer may have thrown before the final task executed.
        if (this.splitPending) this.resetHistory();
    }

    /**
     * Opt into guides -> host consumer(s) -> upscale. Add the returned task to the same
     * graph before consumers and this task. It shares allocations and compilation with
     * its owner and produces guides even when the owner selects its disabled bilinear pass.
     * @param name - Optional early-task label; defaults to the owner name plus "-guides".
     * @returns The same early task on repeated calls; add it once before consumers and owner.
     * @throws If the owner uses a non-temporal path.
     */
    createGuidesTask(name = `${this.name}-guides`): FrameGraphTask {
        if (this.configuration.path !== 'temporal') throw new Error('@pmndrs/upscaler: a guides task requires the temporal path.');
        if (this.guidesTask) return this.guidesTask;
        this.guidesTask = new class extends FrameGraphTask {
            constructor(name: string, graph: FrameGraph, private readonly owner: FrameGraphUpscaleTask) { super(name, graph); }
            override initAsync(): Promise<void> { return this.owner.prepare(); }
            override isReady(): boolean { return this.owner.isReady(); }
            record(): void { this.owner.recordGuides(); }
        }(name, this._frameGraph, this);
        return this.guidesTask;
    }

    private assertGuidesOrder(): void {
        const tasks = this._frameGraph.tasks;
        const early = tasks.indexOf(this.guidesTask!); const late = tasks.indexOf(this);
        if (early < 0 || late < 0 || early >= late) throw new Error('@pmndrs/upscaler: add the guides task before its upscale task in the same Frame Graph.');
    }

    private allocateResources(): void {
        const manager = this._frameGraph.textureManager;
        this.handles.clear();
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = manager.createRenderTargetTexture(`${this.name}-${descriptor.name}`, getBabylonTextureOptions(descriptor));
            this.handles.set(descriptor.name, handle);
        }
        manager.resolveDanglingHandle(this.outputTexture, this.handles.get('output'));
        if (this.configuration.path === 'temporal') {
            manager.resolveDanglingHandle(this.guides.dilatedDepth, this.handles.get('dilatedDepth'));
            manager.resolveDanglingHandle(this.guides.dilatedMotion, this.handles.get('dilatedMotion'));
            manager.resolveDanglingHandle(this.guides.disocclusion, this.handles.get('masks'));
        }
        this.resetHistory();
    }

    private recordGuides(): void {
        this.assertGuidesOrder();
        if (this.depthTexture === undefined || this.velocityTexture === undefined) throw new Error('@pmndrs/upscaler: guides require Babylon depth and velocity handles.');
        this.allocateResources();
        const pass = this._frameGraph.addRenderPass(this.guidesTask!.name);
        pass.setRenderTarget([this.guides.dilatedDepth, this.guides.dilatedMotion, this.guides.disocclusion]);
        // Include every working allocation: the core snapshots their identities early.
        // Final color and other late inputs can be produced by intervening consumers.
        pass.addDependencies([this.depthTexture, this.velocityTexture, ...this.handles.values()]);
        pass.setExecuteFunc(() => this.executeGuides());
        this.guidesRecorded = true;
    }

    /**
     * Register passes and declare input/working-set dependencies for lifetime analysis.
     * @param skipCreationOfDisabledPasses - Omit the bilinear disabled pass when true.
     * @returns No value; Frame Graph resolves allocations when building the graph.
     * @throws If required inputs or split-task ordering are missing.
     */
    record(skipCreationOfDisabledPasses = false): void {
        const required = this.configuration.path === 'temporal' ? [['color', this.colorTexture], ['depth', this.depthTexture], ['velocity', this.velocityTexture]] : [['color', this.colorTexture]];
        for (const [name, value] of required) if (value === undefined) throw new Error(`@pmndrs/upscaler: missing Babylon ${name} handle.`);
        if (this.guidesTask) {
            this.assertGuidesOrder();
            if (!this.guidesRecorded) throw new Error('@pmndrs/upscaler: record the guides task before its upscale task.');
            this.guidesRecorded = false;
        } else this.allocateResources();
        const inputHandles = [this.colorTexture, this.depthTexture, this.velocityTexture, this.reactiveTexture, this.reactiveOpaqueColorTexture, this.exposureTexture, this.preExposureTexture].filter((h): h is number => h !== undefined);
        // Render passes are required: Babylon's lifetime analysis collects their dependencies.
        const add = (disabled: boolean): void => {
            const pass = this._frameGraph.addRenderPass(`${this.name}-${disabled ? 'bilinear' : this.configuration.path}`, disabled);
            pass.setRenderTarget(this.outputTexture);
            pass.addDependencies([...inputHandles, ...this.handles.values()]);
            pass.setExecuteFunc(() => this.executeUpscale(disabled));
        };
        add(false); if (!skipCreationOfDisabledPasses) add(true);
    }

    private resources(guidesOnly = false): CoreResources {
        const manager = this._frameGraph.textureManager; const result: CoreResources = {};
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = this.handles.get(descriptor.name)!;
            result[descriptor.name] = descriptor.history
                ? { read: resolveBabylonTexture(manager, handle), write: resolveBabylonTexture(manager, handle, true) }
                : resolveBabylonTexture(manager, handle);
        }
        const inputs = guidesOnly ? { depth: this.depthTexture, velocity: this.velocityTexture } : { color: this.colorTexture, depth: this.depthTexture, velocity: this.velocityTexture, reactive: this.reactiveTexture, reactiveOpaqueColor: this.reactiveOpaqueColorTexture, exposureTexture: this.exposureTexture, preExposureTexture: this.preExposureTexture };
        for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
            const handle = inputs[name]; if (handle !== undefined) result[name] = resolveBabylonTexture(manager, handle, true);
        }
        return result;
    }
    private frameData(): FrameData {
        const supplied = this.frame();
        return { ...supplied,
            jitter: this.disabled ? { x: 0, y: 0 } : this.restoreProjection ? this.currentJitter : supplied.jitter,
            jitterPrevious: this.disabled ? { x: 0, y: 0 } : this.restoreProjection ? this.previousJitter : supplied.jitterPrevious,
            settings: { ...this.settings, ...supplied.settings },
        };
    }
    private executeGuides(): void {
        if (!this.isReady()) throw new Error('@pmndrs/upscaler: Babylon task is unprepared; await prepare() or graph.whenReadyAsync().');
        if (this.splitPending) throw new Error('@pmndrs/upscaler: a Babylon split frame is already active; finish upscale or resetHistory() first.');
        if (!this.temporalLastFrame) this.core.resetHistory();
        this.core.encodeGuides(getBabylonEncoder(this._frameGraph.engine), this.resources(true), this.frameData());
        this.splitPending = true;
    }
    private executeUpscale(disabled: boolean): void {
        if (!this.isReady()) throw new Error('@pmndrs/upscaler: Babylon task is unprepared; await prepare() or graph.whenReadyAsync().');
        if (this.guidesTask && !this.splitPending) throw new Error('@pmndrs/upscaler: execute the guides task before the final upscale task.');
        const resources = this.resources(); const frame = this.frameData();
        const encoder = getBabylonEncoder(this._frameGraph.engine);
        if (disabled) {
            this.core.resetHistory(); this.splitPending = false; this.temporalLastFrame = false;
            this.fallback.encode(encoder, resources, { ...frame, settings: { ...frame.settings, sharpness: 0 } });
        } else {
            if (this.guidesTask) {
                this.core.encodeUpscale(encoder, resources, frame); this.splitPending = false;
            } else {
                if (!this.temporalLastFrame) this.core.resetHistory();
                this.core.encode(encoder, resources, frame);
            }
            this.temporalLastFrame = true;
        }
    }
    /**
     * Restore camera state and release owned cores; the texture manager owns textures.
     * @returns No value; create a new task for subsequent rendering.
     */
    override dispose(): void { this.endFrame(); this.core.dispose(); this.fallback.dispose(); super.dispose(); }
}
