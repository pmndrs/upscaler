import { ConstantsBuffer } from '../internal/ConstantsBuffer.js';
import { ComputePass } from '../internal/ComputePass.js';
import { buildAccumulateShader } from '../shaders/accumulate.js';
import { BLIT_SHADER } from '../shaders/blit.js';
import { DEBUG_SHADER } from '../shaders/debug.js';
import { EASU_SHADER } from '../shaders/easu.js';
import { GENERATE_REACTIVE_SHADER } from '../shaders/generateReactive.js';
import { LUMINANCE_PYRAMID_SHADER } from '../shaders/luminancePyramid.js';
import { buildRcasShader, RCAS_SHADER } from '../shaders/rcas.js';
import { buildReconstructShader, DEPTH_CLIP_SHADER } from '../shaders/reconstruct.js';
import { PROVIDED_EXPOSURE_SHADER } from '../shaders/providedExposure.js';
import { SHADING_CHANGE_SHADER } from '../shaders/shadingChange.js';
import { FLAG_AUTO_EXPOSURE, FLAG_EXTERNAL_EXPOSURE, FLAG_INPUT_REINHARD, FLAG_LOCKS, FLAG_PERSPECTIVE, FLAG_RCAS_DENOISE, FLAG_REACTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH, FLAG_SHADING_CHANGE } from '../shaders/common.js';
import { getResourceDescriptors } from './resources.js';
import { DebugView, DEFAULT_SETTINGS, type CoreConfiguration, type CoreResources, type FrameData, type ResourceDescriptor, type ResourceName, type RuntimeSettings, type TextureHistory, type TextureResource } from './types.js';

/** Device and optional host instrumentation for renderer-independent encoding. */
export interface UpscalerCoreOptions {
    /** Initialized device shared with the host renderer. */
    device: GPUDevice;
    /** Optional host profiling. The host resolves and reads its own query sets. */
    timestampWrites?: (pass: string) => GPUComputePassTimestampWrites | undefined;
    /** Shader overrides retained for the upstream benchmark harness. */
    shaders?: Partial<Record<'rcas' | 'spatialRcas' | 'shadingChange' | 'depthClip' | 'reconstruct', string>>;
    /** Bench-only older reconstruction pass with a previous-depth input. */
    crossFrameReconstruct?: boolean;
    cameraCompensated?: boolean;
}

/**
 * Renderer-independent WebGPU pass orchestration with one active split frame.
 * Textures, history swaps and command submission belong to the caller.
 * See docs/webgpu-core.md for resource and frame contracts.
 *
 * @remarks Configure and prepare before encoding; reset after abandoning an encoder.
 */
export class UpscalerCore {
    /**
     * Check minimum limits for the complete temporal path.
     * @param device - Host device whose limits are inspected.
     * @returns Whether the limits support the path without optional GPU features.
     */
    static isSupported(device: GPUDevice): boolean {
        const limits = device.limits;
        return limits.maxBindGroups >= 1 && limits.maxBindingsPerBindGroup >= 13
            && limits.maxSampledTexturesPerShaderStage >= 9 && limits.maxStorageTexturesPerShaderStage >= 3
            && limits.maxStorageBuffersPerShaderStage >= 2 && limits.maxUniformBuffersPerShaderStage >= 1
            && limits.maxSamplersPerShaderStage >= 1 && limits.maxUniformBufferBindingSize >= ConstantsBuffer.SIZE
            && limits.maxComputeWorkgroupSizeX >= 8 && limits.maxComputeWorkgroupSizeY >= 8
            && limits.maxComputeInvocationsPerWorkgroup >= 64 && limits.maxComputeWorkgroupStorageSize >= 1280;
    }
    private readonly device: GPUDevice;
    private readonly options: UpscalerCoreOptions;
    private readonly early: ConstantsBuffer;
    private readonly late: ConstantsBuffer;
    private readonly sampler: GPUSampler;
    /** @internal Pipeline metadata is consumed by the existing benchmark harness. */
    readonly passes = new Map<string, ComputePass>();
    private readonly requests = new Map<string, Promise<void>>();
    private readonly failures = new Map<string, unknown>();
    private configuration: CoreConfiguration = { renderWidth: 1, renderHeight: 1, displayWidth: 1, displayHeight: 1 };
    private configured = false;
    private descriptors = getResourceDescriptors(this.configuration);
    private generation = 0;
    private disposed = false;
    private lost = false;
    private pendingReset = true;
    private pending: { geometry: string; reset: boolean; resources: CoreResources } | null = null;
    private scatter: [GPUBuffer, GPUBuffer] | null = null;
    private scatterIndex = 0;
    private scatterSeed: GPUBuffer | null = null;
    private scatterDirty = false;
    private memorySeed: GPUBuffer | null = null;
    private reprojection: GPUBuffer | null = null;
    private providedExposure: GPUBuffer | null = null;
    private previousResources = new Map<ResourceName, GPUTexture[]>();
    private accumulation = DEFAULT_SETTINGS.maxAccumulation;
    private shadingStale = true;

    /**
     * Create core-owned buffers and a sampler on the host device.
     * @param options - Shared device, instrumentation and optional benchmark overrides.
     */
    constructor(options: UpscalerCoreOptions) {
        this.options = options; this.device = options.device;
        this.early = new ConstantsBuffer(this.device); this.late = new ConstantsBuffer(this.device);
        this.sampler = this.device.createSampler({ label: 'upscale-linear-clamp', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        if (options.cameraCompensated) this.reprojection = this.device.createBuffer({ label: 'upscale-reproject', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        void this.device.lost.then(() => { this.lost = true; this.generation++; this.pending = null; });
    }

    /**
     * Validate configuration and invalidate history between frames.
     * @param configuration - Dimensions, path, depth contract and shader variants.
     * @returns Fresh requirements for caller-owned texture allocations.
     * @throws If a split frame is active, the device is lost or configuration is invalid.
     */
    configure(configuration: CoreConfiguration): ResourceDescriptor[] {
        this.assertAlive();
        if (this.pending) throw new Error('UpscalerCore: cannot configure during a split frame.');
        const descriptors = getResourceDescriptors(configuration);
        const oldSources = JSON.stringify(this.shaderSources());
        this.configuration = { ...configuration }; this.descriptors = descriptors.map(d => ({ ...d })); this.configured = true; this.generation++;
        this.requests.clear();
        if (oldSources !== JSON.stringify(this.shaderSources())) { this.failures.clear(); this.passes.clear(); }
        this.scatter?.forEach(b => b.destroy()); this.scatter = null;
        this.scatterSeed?.destroy(); this.scatterSeed = null; this.scatterDirty = false;
        this.memorySeed?.destroy(); this.memorySeed = null;
        this.providedExposure?.destroy(); this.providedExposure = configuration.exposureMode === 'provided'
            ? this.device.createBuffer({ label: 'upscale-provided-exposure', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : null;
        if (['temporal', 'guides'].includes(configuration.path ?? 'temporal') && !this.options.crossFrameReconstruct) {
            const create = (index: number): GPUBuffer => {
                const b = this.device.createBuffer({ label: `upscale-reconstructed-depth-${index}`, size: configuration.renderWidth * configuration.renderHeight * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
                new Uint32Array(b.getMappedRange()).fill(0x7f800000); b.unmap(); return b;
            };
            this.scatter = [create(0), create(1)];
        }
        this.previousResources.clear(); this.resetHistory(); return descriptors;
    }

    private required(): string[] {
        const path = this.configuration.path ?? 'temporal';
        if (path === 'bilinear') return ['blit'];
        if (path === 'spatial') return ['easu', 'spatialRcas', 'blit'];
        const geometry = this.options.crossFrameReconstruct ? ['reconstruct'] : ['reconstruct', 'depthClip'];
        return path === 'guides' ? geometry : [...geometry, 'accumulate', 'exposure', 'generateReactive', 'rcas', 'blit'];
    }
    /** Whether mandatory pipelines are available on a live device; optional passes may need preparation. */
    get isReady(): boolean { return !this.disposed && !this.lost && this.required().every(p => this.passes.has(p)); }

    /**
     * Compile required pipelines and optional passes selected by runtime settings.
     * @param settings - Optional shading-change and debug passes to prepare.
     * @param retry - Retry previously failed pipeline compilations; defaults to true.
     * @returns Completion of this configuration's pipeline preparation.
     * @throws The returned promise rejects on compilation failure, reconfiguration,
     * disposal or device loss.
     */
    prepare(settings: Partial<RuntimeSettings> = DEFAULT_SETTINGS, retry = true): Promise<void> {
        if (this.disposed || this.lost) return Promise.reject(new Error('UpscalerCore: disposal or GPU device loss cancelled preparation.'));
        const names = this.required();
        settings = { ...DEFAULT_SETTINGS, ...settings };
        if ((this.configuration.path ?? 'temporal') === 'temporal') {
            if (settings.detectShadingChanges) names.push('shadingChange');
            if (settings.debugView) names.push('debug');
        }
        const generation = this.generation;
        const request = Promise.all(names.map(name => {
            if (this.passes.has(name)) return Promise.resolve();
            if (this.failures.has(name) && !retry) return Promise.reject(this.failures.get(name));
            if (retry && this.failures.has(name)) { this.requests.delete(name); this.failures.delete(name); }
            if (this.requests.has(name)) return this.requests.get(name)!;
            const shaders = this.shaderSources();
            const [label, code] = shaders[name];
            const pending = ComputePass.create(this.device, label, code).then(pass => {
                if (generation !== this.generation || this.disposed || this.lost) throw new Error('UpscalerCore: preparation cancelled by reconfiguration, disposal or device loss.');
                this.passes.set(name, pass);
            }).catch(error => {
                if (generation === this.generation && !this.failures.has(name)) { this.failures.set(name, error); console.error('@pmndrs/upscaler: failed to prepare ' + label, error); }
                throw error;
            });
            this.requests.set(name, pending); return pending;
        })).then(() => {});
        void request.catch(() => {}); return request;
    }

    private shaderSources(): Record<string, [string, string]> {
        return {
            blit: ['blit', BLIT_SHADER], easu: ['easu', EASU_SHADER], rcas: ['rcas', this.options.shaders?.rcas ?? buildRcasShader(this.configuration.rcasAgeKnee)],
            spatialRcas: ['rcas', this.options.shaders?.spatialRcas ?? this.options.shaders?.rcas ?? RCAS_SHADER],
            reconstruct: ['reconstruct', this.options.shaders?.reconstruct ?? buildReconstructShader(this.configuration.depthMode === 'linear')], depthClip: ['depth-clip', this.options.shaders?.depthClip ?? DEPTH_CLIP_SHADER],
            accumulate: ['accumulate', buildAccumulateShader(this.configuration.correctConditioningExposure)], exposure: ['exposure', this.configuration.exposureMode === 'provided' ? PROVIDED_EXPOSURE_SHADER : LUMINANCE_PYRAMID_SHADER],
            generateReactive: ['gen-reactive', GENERATE_REACTIVE_SHADER], shadingChange: ['shading-change', this.options.shaders?.shadingChange ?? SHADING_CHANGE_SHADER], debug: ['debug', DEBUG_SHADER],
        };
    }

    private assertAlive(): void { if (this.disposed || this.lost) throw new Error('UpscalerCore: disposed or GPU device lost.'); }
    private pass(encoder: GPUCommandEncoder, name: string, entries: GPUBindingResource[], width: number, height: number, timing = name): void {
        const pipeline = this.passes.get(name);
        if (!pipeline) throw new Error(`UpscalerCore: required pipeline '${name}' is unprepared; await prepare().`);
        const group = pipeline.createBindGroup(entries);
        const p = encoder.beginComputePass({ label: `upscale-${pipeline.label}`, timestampWrites: this.options.timestampWrites?.(timing) });
        pipeline.dispatch(p, group, width, height); p.end();
    }
    private single(resources: CoreResources, name: keyof CoreResources): TextureResource {
        const r = resources[name]; if (!r || 'read' in r) throw new Error(`UpscalerCore: missing texture '${name}'.`); return r;
    }
    private pair(resources: CoreResources, name: keyof CoreResources): TextureHistory {
        const r = resources[name]; if (!r || !('read' in r)) throw new Error(`UpscalerCore: missing history '${name}'.`); return r;
    }
    private geometry(frame: FrameData): string {
        return JSON.stringify([frame.frameIndex, frame.jitter, frame.jitterPrevious, frame.motionScale, frame.near, frame.far, frame.perspective, frame.reversedDepth, !!frame.reset, frame.reprojection ? Array.from(frame.reprojection) : null]);
    }
    private settings(frame: FrameData): RuntimeSettings { return { ...DEFAULT_SETTINGS, ...frame.settings }; }
    private assertOptionalPasses(frame: FrameData): void {
        const settings = this.settings(frame);
        for (const name of [settings.detectShadingChanges ? 'shadingChange' : '', settings.debugView ? 'debug' : '']) {
            if (name && !this.passes.has(name)) throw new Error("UpscalerCore: required pipeline '" + name + "' is unprepared; await prepare().");
        }
    }

    private validate(resources: CoreResources, stage: 'full' | 'guides' | 'late'): void {
        const config = this.configuration;
        const check = (r: TextureResource, name: string, width: number, height: number, usage: number, format?: GPUTextureFormat): void => {
            const t = r.texture;
            if (t.sampleCount !== 1) throw new Error(`UpscalerCore: '${name}' must be single-sample.`);
            if (t.width !== width || t.height !== height) throw new Error(`UpscalerCore: '${name}' dimensions ${t.width}x${t.height} do not match configuration ${width}x${height}.`);
            if ((t.usage & usage) !== usage) throw new Error(`UpscalerCore: '${name}' has insufficient texture usage.`);
            if (format && t.format !== format) throw new Error(`UpscalerCore: '${name}' requires ${format}.`);
        };
        const path = config.path ?? 'temporal';
        for (const d of this.descriptors) {
            if (d.history) {
                const p = this.pair(resources, d.name);
                if (p.read.texture === p.write.texture) throw new Error(`UpscalerCore: '${d.name}' read/write alias.`);
                check(p.read, d.name, d.width, d.height, 4, d.format); check(p.write, d.name, d.width, d.height, d.usage, d.format);
            } else check(this.single(resources, d.name), d.name, d.width, d.height, d.usage, d.format);
        }
        if (stage !== 'late' && ['temporal', 'guides'].includes(path)) {
            const depth = this.single(resources, 'depth');
            check(depth, 'depth', config.renderWidth, config.renderHeight, 4, config.depthMode === 'linear' ? 'r32float' : undefined);
            if (config.depthMode !== 'linear' && !depth.texture.format.startsWith('depth')) throw new Error('UpscalerCore: hardware depth input requires a depth texture.');
            check(this.single(resources, 'velocity'), 'velocity', config.renderWidth, config.renderHeight, 4);
        }
        if (stage !== 'guides') {
            check(this.single(resources, 'color'), 'color', config.renderWidth, config.renderHeight, 4);
            for (const name of ['reactive', 'reactiveOpaqueColor'] as const) if (resources[name]) check(resources[name]!, name, config.renderWidth, config.renderHeight, 4);
            for (const name of ['exposureTexture', 'preExposureTexture'] as const) if (resources[name]) check(resources[name]!, name, 1, 1, 4);
            const output = this.single(resources, 'output').texture;
            for (const name of ['color', 'depth', 'velocity', 'reactive', 'reactiveOpaqueColor'] as const) if (resources[name]?.texture === output) throw new Error(`UpscalerCore: output/input '${name}' alias.`);
            if (resources.reactiveOpaqueColor && resources.reactive?.texture === this.single(resources, 'reactiveGenerated').texture) throw new Error('UpscalerCore: reactive input/output alias while generating a reactive mask.');
        }
        const writes = new Set<GPUTexture>(); const reads = new Set<GPUTexture>();
        for (const descriptor of this.descriptors) {
            if (stage === 'guides' && !['dilatedDepth', 'dilatedMotion', 'masks'].includes(descriptor.name)) continue;
            const value = resources[descriptor.name]!; const texture = 'read' in value ? value.write.texture : value.texture;
            if (descriptor.name === 'dummy') { reads.add(texture); continue; }
            if (descriptor.name === 'reactiveGenerated' && !resources.reactiveOpaqueColor) { reads.add(texture); continue; }
            if (writes.has(texture)) throw new Error('UpscalerCore: working textures alias another output.');
            writes.add(texture); if ('read' in value) reads.add(value.read.texture);
        }
        for (const name of ['color', 'depth', 'velocity', 'reactive', 'reactiveOpaqueColor', 'exposureTexture', 'preExposureTexture'] as const) if (resources[name]) reads.add(resources[name]!.texture);
        if ([...writes].some(texture => reads.has(texture))) throw new Error('UpscalerCore: writable resources alias a history or input.');
    }

    private begin(resources: CoreResources, frame: FrameData, stage: 'full' | 'guides'): boolean {
        this.assertAlive(); if (!this.configured) throw new Error('UpscalerCore: configure() before encoding.');
        if (this.pending) throw new Error('UpscalerCore: a split frame is already active.');
        if (!this.isReady) throw new Error('UpscalerCore: required pipelines are unprepared; await prepare().');
        this.validate(resources, stage);
        const settings = this.settings(frame);
        if (!Number.isFinite(settings.maxAccumulation) || settings.maxAccumulation < 1) throw new Error('UpscalerCore: invalid maxAccumulation.');
        // Compare identities per logical resource; a normal ping-pong may exchange its halves.
        let replaced = false;
        for (const descriptor of this.descriptors) {
            const resource = resources[descriptor.name]!;
            const textures = 'read' in resource ? [resource.read.texture, resource.write.texture] : [resource.texture];
            const previous = this.previousResources.get(descriptor.name);
            replaced ||= !previous || textures.some(texture => !previous.includes(texture));
            this.previousResources.set(descriptor.name, textures);
        }
        const reset = this.pendingReset || !!frame.reset || replaced || this.accumulation !== settings.maxAccumulation;
        this.accumulation = settings.maxAccumulation;
        return reset;
    }
    private constants(buffer: ConstantsBuffer, resources: CoreResources, frame: FrameData, reset: boolean): void {
        const c = this.configuration; const s = this.settings(frame);
        buffer.setRenderSize(c.renderWidth, c.renderHeight); buffer.setDisplaySize(c.displayWidth, c.displayHeight);
        buffer.setJitter(frame.jitter?.x ?? 0, frame.jitter?.y ?? 0, frame.jitterPrevious?.x ?? 0, frame.jitterPrevious?.y ?? 0);
        buffer.setMotionScale(frame.motionScale?.x ?? 0.5, frame.motionScale?.y ?? -0.5);
        buffer.setDepthNearFar(frame.near ?? 0.1, frame.far ?? 1000); buffer.setSharpness(Math.min(1, Math.max(0, s.sharpness)));
        buffer.setMaxAccumulation(s.maxAccumulation); buffer.setExposure(s.exposure); buffer.setDeltaTime(frame.deltaTime ?? 1 / 60);
        buffer.setFrameIndex(frame.frameIndex); buffer.setDebugMode(s.debugView);
        let flags = reset ? FLAG_RESET : 0;
        if (frame.perspective) flags |= FLAG_PERSPECTIVE;
        if (frame.reversedDepth && c.depthMode !== 'linear') flags |= FLAG_REVERSED_DEPTH;
        if ((c.path ?? 'temporal') === 'temporal') flags |= FLAG_INPUT_REINHARD;
        if (s.lockThinFeatures) flags |= FLAG_LOCKS;
        if (s.autoExposure) flags |= FLAG_AUTO_EXPOSURE;
        if (s.detectShadingChanges) flags |= FLAG_SHADING_CHANGE;
        if (s.rcasDenoise) flags |= FLAG_RCAS_DENOISE;
        if (resources.reactive || resources.reactiveOpaqueColor) flags |= FLAG_REACTIVE;
        if (resources.exposureTexture) flags |= FLAG_EXTERNAL_EXPOSURE;
        buffer.setFlags(flags); buffer.upload();
    }

    /**
     * Encode the configured path, composing guides and upscale for temporal frames.
     * @param encoder - Host encoder; this method neither finishes nor submits it.
     * @param resources - Resolved inputs and allocations matching configure().
     * @param frame - Current geometry, exposures and runtime settings.
     * @returns No value; passes are appended to the host encoder.
     * @throws If preparation, resource validation or frame ordering fails.
     */
    encode(encoder: GPUCommandEncoder, resources: CoreResources, frame: FrameData): void {
        const path = this.configuration.path ?? 'temporal';
        if (path === 'guides') throw new Error('UpscalerCore: guides path requires encodeGuides().');
        if (path === 'temporal') {
            this.assertAlive(); if (this.pending) throw new Error('UpscalerCore: a split frame is already active.');
            this.validate(resources, 'full');
            this.assertOptionalPasses(frame);
            this.encodeGuides(encoder, resources, frame); this.encodeUpscale(encoder, resources, frame); return;
        }
        const reset = this.begin(resources, frame, 'full'); this.constants(this.late, resources, frame, reset);
        const color = this.single(resources, 'color').view; const exposure = this.pair(resources, 'exposure').read.view;
        if (path === 'spatial') {
            const easu = this.single(resources, 'easuOutput').view;
            this.pass(encoder, 'easu', [{ buffer: this.late.buffer }, color, easu], this.configuration.displayWidth, this.configuration.displayHeight);
            this.output(encoder, resources, frame, easu, exposure, easu, true);
        } else this.output(encoder, resources, frame, color, exposure, color, false);
        this.pendingReset = false;
    }
    /**
     * Publish geometry guides before the final color input is available.
     * @param encoder - Host encoder shared with intervening consumers and the late phase.
     * @param resources - Geometry inputs and the complete configured working set.
     * @param frame - Geometry and reset state to freeze until encodeUpscale().
     * @returns No value; the temporal path opens a split frame, while guides-only completes here.
     * @throws If the path, preparation, resources or active-frame state are invalid.
     */
    encodeGuides(encoder: GPUCommandEncoder, resources: CoreResources, frame: FrameData): void {
        if (!['temporal', 'guides'].includes(this.configuration.path ?? 'temporal')) throw new Error('UpscalerCore: encodeGuides requires temporal or guides path.');
        const reset = this.begin(resources, frame, 'guides'); this.constants(this.early, resources, frame, reset);
        const c = this.configuration; const depth = this.pair(resources, 'dilatedDepth');
        const entries: GPUBindingResource[] = [{ buffer: this.early.buffer }, this.single(resources, 'depth').view, this.single(resources, 'velocity').view];
        if (this.options.crossFrameReconstruct) {
            entries.push(depth.read.view, depth.write.view, this.single(resources, 'dilatedMotion').view, this.single(resources, 'masks').view);
            if (this.reprojection) { if (!frame.reprojection) throw new Error('UpscalerCore: missing reprojection constants.'); this.device.queue.writeBuffer(this.reprojection, 0, frame.reprojection as Float32Array<ArrayBuffer>); entries.push({ buffer: this.reprojection }); }
        } else {
            if (reset && this.scatterDirty) {
                const size = c.renderWidth * c.renderHeight * 4;
                if (!this.scatterSeed) {
                    this.scatterSeed = this.device.createBuffer({ label: 'upscale-scatter-seed', size, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
                    new Uint32Array(this.scatterSeed.getMappedRange()).fill(0x7f800000); this.scatterSeed.unmap();
                }
                for (const b of this.scatter!) encoder.copyBufferToBuffer(this.scatterSeed, 0, b, 0, size);
            }
            this.scatterDirty = true;
            this.scatterIndex = 1 - this.scatterIndex;
            entries.push(depth.write.view, this.single(resources, 'dilatedMotion').view, { buffer: this.scatter![this.scatterIndex] });
        }
        this.pass(encoder, 'reconstruct', entries, c.renderWidth, c.renderHeight);
        if (!this.options.crossFrameReconstruct) this.pass(encoder, 'depthClip', [{ buffer: this.early.buffer }, depth.write.view, this.single(resources, 'dilatedMotion').view, { buffer: this.scatter![this.scatterIndex] }, this.single(resources, 'masks').view, { buffer: this.scatter![1 - this.scatterIndex] }], c.renderWidth, c.renderHeight);
        if ((c.path ?? 'temporal') === 'temporal') {
            const snapshot = Object.fromEntries(Object.entries(resources).map(([name, value]) => [name, value && ('read' in value ? { read: { ...value.read }, write: { ...value.write } } : { ...value })])) as CoreResources;
            this.pending = { geometry: this.geometry(frame), reset, resources: snapshot };
        }
        else this.pendingReset = false;
    }
    /**
     * Complete a temporal split frame using its previously encoded guides.
     * @param encoder - Host encoder containing the early phase and any guide consumers.
     * @param resources - Same geometry and working textures, with final color/exposure inputs.
     * @param frame - Unchanged geometry and maxAccumulation, plus current runtime settings.
     * @returns No value; completion consumes the active split frame without swapping textures.
     * @throws If guides are missing or the frozen frame/resource contract changes.
     */
    encodeUpscale(encoder: GPUCommandEncoder, resources: CoreResources, frame: FrameData): void {
        this.assertAlive(); if (!this.pending) throw new Error('UpscalerCore: encode guides first with encodeGuides before encodeUpscale.');
        if (this.pending.geometry !== this.geometry(frame)) throw new Error('UpscalerCore: geometry changed during a split frame.');
        for (const name of ['depth', 'velocity', ...this.descriptors.map(descriptor => descriptor.name)] as const) if (resources[name] !== this.pending.resources[name]) {
            // Different wrappers are permitted; geometry and working texture identities stay fixed.
            const a = resources[name]; const b = this.pending.resources[name];
            if (!a || !b || ('read' in a ? !('read' in b) || a.write.texture !== b.write.texture || a.read.texture !== b.read.texture : 'read' in b || a.texture !== b.texture)) throw new Error('UpscalerCore: geometry resources changed during a split frame.');
        }
        this.validate(resources, 'late');
        const settings = this.settings(frame);
        if (settings.maxAccumulation !== this.accumulation) throw new Error('UpscalerCore: maxAccumulation changed during a split frame.');
        this.assertOptionalPasses(frame);
        const reset = this.pending.reset || !!frame.reset;
        this.constants(this.late, resources, frame, reset);
        const c = this.configuration; const u = { buffer: this.late.buffer };
        const dummy = this.single(resources, 'dummy').view; const color = this.single(resources, 'color').view;
        let reactive = resources.reactive?.view ?? dummy;
        if (resources.reactiveOpaqueColor) {
            reactive = this.single(resources, 'reactiveGenerated').view;
            this.pass(encoder, 'generateReactive', [u, resources.reactiveOpaqueColor.view, color, reactive, resources.reactive?.view ?? dummy], c.renderWidth, c.renderHeight, 'genReactive');
        }
        const exposure = this.pair(resources, 'exposure');
        if (this.providedExposure) {
            const host = frame.hostPreExposure ?? 1;
            if (!Number.isFinite(host) || host <= 0 || !Number.isFinite(settings.exposure) || settings.exposure <= 0) throw new Error('UpscalerCore: provided CPU exposures must be finite and positive.');
            const data = new ArrayBuffer(16); const f = new Float32Array(data); const flags = new Uint32Array(data);
            f[0] = settings.exposure; f[1] = host; flags[2] = resources.exposureTexture ? 1 : 0; flags[3] = resources.preExposureTexture ? 1 : 0;
            this.device.queue.writeBuffer(this.providedExposure, 0, data);
            this.pass(encoder, 'exposure', [{ buffer: this.providedExposure }, resources.exposureTexture?.view ?? dummy, resources.preExposureTexture?.view ?? dummy, exposure.write.view], 8, 8);
        } else this.pass(encoder, 'exposure', [u, color, this.sampler, exposure.read.view, exposure.write.view, resources.exposureTexture?.view ?? dummy, resources.preExposureTexture?.view ?? dummy], 8, 8);
        let shading = dummy;
        if (settings.detectShadingChanges) {
            const memory = this.pair(resources, 'shadingBlockMemory');
            if (reset || this.shadingStale) {
                const { width, height } = memory.write.texture;
                const bytesPerRow = Math.ceil(width * 16 / 256) * 256;
                if (!this.memorySeed) {
                    this.memorySeed = this.device.createBuffer({ label: 'upscale-memory-seed', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_SRC });
                }
                for (const r of [memory.read, memory.write]) encoder.copyBufferToTexture({ buffer: this.memorySeed, bytesPerRow }, { texture: r.texture }, { width, height });
            }
            this.shadingStale = false;
            const luma = this.pair(resources, 'shadingLumaHistory'); shading = this.single(resources, 'shadingSignal').view;
            this.pass(encoder, 'shadingChange', [u, color, luma.read.view, this.single(resources, 'dilatedMotion').view, exposure.write.view, exposure.read.view, luma.write.view, shading, this.single(resources, 'masks').view, memory.read.view, memory.write.view], Math.ceil(c.renderWidth / 2), Math.ceil(c.renderHeight / 2));
        } else this.shadingStale = true;
        const history = this.pair(resources, 'history'); const locks = this.pair(resources, 'locks');
        this.pass(encoder, 'accumulate', [u, color, this.single(resources, 'dilatedMotion').view, this.single(resources, 'masks').view, history.read.view, this.sampler, history.write.view, locks.read.view, locks.write.view, exposure.write.view, reactive, exposure.read.view, shading], c.displayWidth, c.displayHeight);
        if (settings.debugView !== DebugView.None) this.pass(encoder, 'debug', [u, this.single(resources, 'dilatedMotion').view, this.single(resources, 'masks').view, this.pair(resources, 'dilatedDepth').write.view, history.write.view, locks.write.view, exposure.write.view, color, reactive, this.single(resources, 'output').view], c.displayWidth, c.displayHeight, 'output');
        else this.output(encoder, resources, frame, history.write.view, exposure.write.view, locks.write.view, true);
        this.pending = null; this.pendingReset = false;
    }
    private output(encoder: GPUCommandEncoder, resources: CoreResources, frame: FrameData, input: GPUTextureView, exposure: GPUTextureView, alpha: GPUTextureView, sharpen: boolean): void {
        const rcas = sharpen && this.settings(frame).sharpness > 0; const name = rcas ? (this.configuration.path === 'spatial' ? 'spatialRcas' : 'rcas') : 'blit';
        const entries: GPUBindingResource[] = [{ buffer: this.late.buffer }, input];
        if (!rcas) entries.push(this.sampler);
        entries.push(exposure, this.single(resources, 'output').view, alpha);
        this.pass(encoder, name, entries, this.configuration.displayWidth, this.configuration.displayHeight, rcas ? 'rcas' : 'blit');
    }
    /**
     * Abandon a split frame and schedule history/scatter invalidation on the next encode.
     * @returns No value; caller-owned textures are not immediately cleared or swapped.
     */
    resetHistory(): void { this.pending = null; this.pendingReset = true; this.shadingStale = true; this.scatterIndex = 0; }
    /**
     * Cancel preparation and destroy core-owned buffers without destroying host textures.
     * @returns No value; subsequent encoding requires a new core instance.
     */
    dispose(): void {
        if (this.disposed) return; this.disposed = true; this.generation++; this.pending = null;
        this.scatter?.forEach(b => b.destroy()); this.scatter = null; this.reprojection?.destroy();
        this.scatterSeed?.destroy(); this.memorySeed?.destroy(); this.providedExposure?.destroy();
        this.early.dispose(); this.late.dispose(); this.passes.clear(); this.requests.clear(); this.failures.clear();
    }
}
