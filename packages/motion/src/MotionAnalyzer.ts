import { createDeviceTextureAllocator, type CoreTexture, type TextureAllocator } from '@pmndrs/upscaler-core/textures';

import { CAMERA_MOTION_SHADER, MOTION_CONSTANTS_BYTES } from './shaders/cameraMotion';
import { HISTOGRAM_BINS, LUMA_HISTOGRAM_SHADER } from './shaders/lumaHistogram';
import {
    CANDIDATE_FIELDS,
    MAX_CANDIDATES,
    MOTION_RESIDUAL_SHADER,
    RESIDUAL_CONSTANTS_BYTES,
    RESIDUAL_DEBUG_CLASSIFY,
    RESIDUAL_FIXED_POINT,
    RESIDUAL_FLAG_DEBUG,
    RESIDUAL_FLAG_DEPTH_TEST,
    STATS_STRIDE,
} from './shaders/motionResidual';

/** Residual statistics slots per frame (one per `encodeResidual` call). */
export const RESIDUAL_SLOTS = 8;
/** Histogram slots per frame. */
export const HISTOGRAM_SLOTS = 4;

/**
 * Camera matrices for one frame, column-major (three's `Matrix4.elements`).
 * `inverseViewProjectionJittered` must invert the projection the depth was
 * rasterized with; `viewProjection` must be the unjittered one, so the derived
 * motion is jitter-free like three's `velocity` node.
 */
export interface CameraMatrices {
    viewProjection: ArrayLike<number>;
    inverseViewProjectionJittered: ArrayLike<number>;
    view: ArrayLike<number>;
}

/** One candidate's warp statistics for a residual slot. */
export interface CandidateStats {
    /** Mean conditioned-luma residual over the pixels where it was valid. */
    meanResidual: number;
    /** Share of pixels where the candidate passed the bounds + depth test. */
    valid: number;
    /** Share of pixels where it had the lowest residual of all candidates. */
    best: number;
    /** Share of pixels where its residual exceeded the threshold. */
    unexplained: number;
    /** Share of pixels where it exceeded the threshold but another candidate did not (< half of it). */
    beaten: number;
    /** Share of pixels where it moves more than `MOVING_PIXELS` (analysis pixels), valid or not. */
    moving: number;
}

/** Decoded statistics of one residual slot. */
export interface ResidualStats {
    /** Index 0 is zero motion; 1–3 follow the `motions` order passed in. */
    candidates: CandidateStats[];
    /** Share of pixels no candidate could score (disocclusion / off-screen). */
    noneValid: number;
    pixels: number;
}

/** Statistics read back for one frame. */
export interface MotionFrameStats {
    residuals: (ResidualStats | null)[];
    histograms: (Uint32Array | null)[];
}

/** Arguments of {@link MotionAnalyzer.encodeResidual}. */
export interface ResidualRequest {
    /** Statistics slot, `0 … RESIDUAL_SLOTS − 1`. */
    slot: number;
    /** Current image (any float/unorm color format); sets the analysis size. */
    current: GPUTexture;
    /** Previous image (or a reference image), sampled bilinearly by UV. */
    previous: GPUTexture;
    /** Up to three motion fields (three `velocity` convention), same size. */
    motions?: GPUTexture[];
    /** Score only where the previous depth matches the static expectation. */
    depthTest?: boolean;
    /** Relative depth tolerance for the occlusion test (default 0.05). */
    depthTolerance?: number;
    /** Residual above which a pixel counts as unexplained (default 0.02). */
    threshold?: number;
    /** Write a debug visualization into {@link MotionAnalyzer.debugTexture} for this size. */
    debug?: { mode?: number; candidate?: number };
}

const STATS_WORDS = RESIDUAL_SLOTS * STATS_STRIDE;
const HISTOGRAM_WORDS = HISTOGRAM_SLOTS * HISTOGRAM_BINS;

/**
 * EXPERIMENTAL engine-free motion analysis on a bare `GPUDevice` (motion lab).
 *
 * Per frame: {@link encodeCameraMotion} once (depth → static-world motion +
 * linear depth), any number of {@link encodeResidual} calls into distinct
 * slots, {@link encodeHistogram} calls, then {@link encodeSnapshot} for every
 * image a later frame warps from, then {@link endFrame}; read the numbers with
 * {@link readStats}. Slots are cleared by {@link beginFrame}.
 */
export class MotionAnalyzer<THandle = GPUTexture> {
    readonly device: GPUDevice;

    private readonly _allocate: TextureAllocator<THandle>;
    private _cameraPipeline: GPUComputePipeline | null = null;
    private _residualPipeline: GPUComputePipeline | null = null;
    private _histogramPipeline: GPUComputePipeline | null = null;
    private readonly _sampler: GPUSampler;
    private readonly _motionConstants: GPUBuffer;
    private readonly _residualConstants: GPUBuffer[];
    private readonly _histogramConstants: GPUBuffer[];
    private readonly _stats: GPUBuffer;
    private readonly _readback: GPUBuffer;
    private _width = 0;
    private _height = 0;
    private _cameraMotion: CoreTexture<THandle> | null = null;
    private _linearDepth: GPUTexture[] = [];
    private _depthIndex = 0;
    private _hasPrevious = false;
    private _prevViewProjection = new Float32Array(16);
    private _prevViewZRow = new Float32Array(4);
    private readonly _snapshots = new Map<string, GPUTexture>();
    private readonly _debug = new Map<string, CoreTexture<THandle>>();
    private readonly _dummy: GPUTexture;
    private readonly _usedResiduals = new Set<number>();
    private readonly _usedHistograms = new Set<number>();

    /**
     * @param device - The device the engine renders with
     * @param allocate - Allocator for textures an engine samples (camera motion, debug views)
     */
    constructor(device: GPUDevice, allocate?: TextureAllocator<THandle>) {
        this.device = device;
        this._allocate = allocate ?? (createDeviceTextureAllocator(device) as unknown as TextureAllocator<THandle>);
        this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this._motionConstants = device.createBuffer({
            label: 'motion-camera-constants',
            size: MOTION_CONSTANTS_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // One uniform buffer per slot: queue writes land before the whole
        // submit, so slots sharing a buffer would all see the last write.
        this._residualConstants = Array.from({ length: RESIDUAL_SLOTS }, (_, slot) =>
            device.createBuffer({
                label: `motion-residual-constants-${slot}`,
                size: RESIDUAL_CONSTANTS_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
        );
        this._histogramConstants = Array.from({ length: HISTOGRAM_SLOTS }, (_, slot) =>
            device.createBuffer({
                label: `motion-histogram-constants-${slot}`,
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
        );
        const bytes = (STATS_WORDS + HISTOGRAM_WORDS) * 4;
        this._stats = device.createBuffer({
            label: 'motion-stats',
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this._readback = device.createBuffer({
            label: 'motion-stats-readback',
            size: bytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this._dummy = device.createTexture({
            label: 'motion-dummy',
            size: { width: 1, height: 1 },
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING,
        });
    }

    /** Compiles the three pipelines. */
    async init(): Promise<void> {
        const compile = (label: string, code: string) =>
            this.device.createComputePipelineAsync({
                label,
                layout: 'auto',
                compute: { module: this.device.createShaderModule({ label, code }), entryPoint: 'main' },
            });
        [this._cameraPipeline, this._residualPipeline, this._histogramPipeline] = await Promise.all([
            compile('motion-camera', CAMERA_MOTION_SHADER),
            compile('motion-residual', MOTION_RESIDUAL_SHADER),
            compile('motion-histogram', LUMA_HISTOGRAM_SHADER),
        ]);
    }

    /** Camera motion at render resolution (rgba16float; see `cameraMotion.ts`). */
    get cameraMotion(): CoreTexture<THandle> {
        if (!this._cameraMotion) throw new Error('MotionAnalyzer: configure() first.');
        return this._cameraMotion;
    }

    /** This frame's linear depth (r32float, render resolution). */
    get linearDepth(): GPUTexture {
        return this._linearDepth[this._depthIndex];
    }

    /**
     * (Re)allocates the render-resolution products and forgets all history.
     * @param width - Render width
     * @param height - Render height
     */
    configure(width: number, height: number): void {
        if (width === this._width && height === this._height && this._cameraMotion) return;
        this._width = width;
        this._height = height;
        this._cameraMotion?.destroy();
        for (const texture of this._linearDepth) texture.destroy();
        this._cameraMotion = this._allocate({ label: 'motion-camera', width, height, format: 'rgba16float' });
        this._linearDepth = [0, 1].map((index) =>
            this.device.createTexture({
                label: `motion-linear-depth-${index}`,
                size: { width, height },
                format: 'r32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
            }),
        );
        this.reset();
    }

    /** Forgets previous frames (camera matrices, depth, snapshots). */
    reset(): void {
        this._hasPrevious = false;
        for (const texture of this._snapshots.values()) texture.destroy();
        this._snapshots.clear();
    }

    /**
     * Debug view texture for an analysis size (rgba8unorm), allocated on first use.
     * @param width - Analysis width
     * @param height - Analysis height
     * @returns The engine handle + raw texture
     */
    debugTexture(width: number, height: number): CoreTexture<THandle> {
        const key = `${width}x${height}`;
        let texture = this._debug.get(key);
        if (!texture) {
            texture = this._allocate({ label: `motion-debug-${key}`, width, height, format: 'rgba8unorm' });
            this._debug.set(key, texture);
        }
        return texture;
    }

    /** True once a previous frame's depth and matrices exist. */
    get hasPrevious(): boolean {
        return this._hasPrevious;
    }

    /**
     * The snapshot taken under `key` last frame, or null on the first frame.
     * @param key - Snapshot name
     * @returns The previous image
     */
    previous(key: string): GPUTexture | null {
        return this._snapshots.get(key) ?? null;
    }

    /**
     * Clears this frame's statistics slots.
     * @param encoder - Command encoder
     */
    beginFrame(encoder: GPUCommandEncoder): void {
        encoder.clearBuffer(this._stats);
        this._usedResiduals.clear();
        this._usedHistograms.clear();
    }

    /**
     * Depth → camera motion + linear depth. Call once per frame, first.
     * @param encoder - Command encoder
     * @param depth - Render-res depth (any depth format)
     * @param matrices - This frame's camera matrices
     */
    encodeCameraMotion(encoder: GPUCommandEncoder, depth: GPUTexture, matrices: CameraMatrices): void {
        const pipeline = this._ready(this._cameraPipeline);
        const data = new Float32Array(MOTION_CONSTANTS_BYTES / 4);
        const viewZRow = [matrices.view[2], matrices.view[6], matrices.view[10], matrices.view[14]];
        data.set(Array.from(matrices.inverseViewProjectionJittered), 0);
        data.set(Array.from(matrices.viewProjection), 16);
        // First frame: previous = current, so the motion is zero, not garbage.
        data.set(this._hasPrevious ? this._prevViewProjection : Array.from(matrices.viewProjection), 32);
        data.set(viewZRow, 48);
        data.set(this._hasPrevious ? this._prevViewZRow : viewZRow, 52);
        data.set([this._width, this._height, 1 / this._width, 1 / this._height], 56);
        this.device.queue.writeBuffer(this._motionConstants, 0, data);
        this._prevViewProjection.set(Array.from(matrices.viewProjection));
        this._prevViewZRow.set(viewZRow);

        const depthView = depth.createView({
            aspect: depth.format.includes('stencil') ? 'depth-only' : 'all',
            baseMipLevel: 0,
            mipLevelCount: 1,
        });
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._motionConstants } },
                { binding: 1, resource: depthView },
                { binding: 2, resource: this.cameraMotion.gpu.createView() },
                { binding: 3, resource: this.linearDepth.createView() },
            ],
        });
        const pass = encoder.beginComputePass({ label: 'motion-camera' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._width / 8), Math.ceil(this._height / 8));
        pass.end();
    }

    /**
     * Warp residuals of up to three motion candidates (plus zero motion).
     * @param encoder - Command encoder
     * @param request - Images, candidates and options
     */
    encodeResidual(encoder: GPUCommandEncoder, request: ResidualRequest): void {
        const pipeline = this._ready(this._residualPipeline);
        if (request.slot < 0 || request.slot >= RESIDUAL_SLOTS) throw new Error(`Residual slot out of range: ${request.slot}`);
        const motions = request.motions ?? [];
        if (motions.length > MAX_CANDIDATES - 1) throw new Error('At most three motion candidates.');
        const depthTest = request.depthTest ?? true;
        if (depthTest && !this._hasPrevious) return;
        const { width, height } = request.current;
        const motionSize = motions[0] ? [motions[0].width, motions[0].height] : [width, height];
        for (const motion of motions)
            if (motion.width !== motionSize[0] || motion.height !== motionSize[1])
                throw new Error('Motion candidates must share one size.');

        const buffer = new ArrayBuffer(RESIDUAL_CONSTANTS_BYTES);
        const f32 = new Float32Array(buffer);
        const u32 = new Uint32Array(buffer);
        f32.set([width, height, 1 / width, 1 / height, motionSize[0], motionSize[1], this._width, this._height]);
        f32[8] = request.depthTolerance ?? 0.05;
        f32[9] = request.threshold ?? 0.02;
        u32[10] = motions.length;
        u32[11] = (depthTest ? RESIDUAL_FLAG_DEPTH_TEST : 0) | (request.debug ? RESIDUAL_FLAG_DEBUG : 0);
        u32[12] = request.debug?.mode ?? RESIDUAL_DEBUG_CLASSIFY;
        u32[13] = request.debug?.candidate ?? 1;
        u32[14] = request.slot;
        this.device.queue.writeBuffer(this._residualConstants[request.slot], 0, buffer);
        this._usedResiduals.add(request.slot);

        const view = (texture: GPUTexture | undefined) =>
            (texture ?? this._dummy).createView({ baseMipLevel: 0, mipLevelCount: 1 });
        const debug = this.debugTexture(width, height);
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._residualConstants[request.slot] } },
                { binding: 1, resource: view(request.current) },
                { binding: 2, resource: view(request.previous) },
                { binding: 3, resource: this._sampler },
                { binding: 4, resource: view(motions[0]) },
                { binding: 5, resource: view(motions[1]) },
                { binding: 6, resource: view(motions[2]) },
                { binding: 7, resource: this.cameraMotion.gpu.createView() },
                { binding: 8, resource: this._linearDepth[1 - this._depthIndex].createView() },
                { binding: 9, resource: debug.gpu.createView() },
                { binding: 10, resource: { buffer: this._stats } },
            ],
        });
        const pass = encoder.beginComputePass({ label: `motion-residual-${request.slot}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
    }

    /**
     * 64-bin conditioned-luma histogram of a color texture.
     * @param encoder - Command encoder
     * @param slot - Histogram slot, `0 … HISTOGRAM_SLOTS − 1`
     * @param color - Image to bin
     */
    encodeHistogram(encoder: GPUCommandEncoder, slot: number, color: GPUTexture): void {
        const pipeline = this._ready(this._histogramPipeline);
        if (slot < 0 || slot >= HISTOGRAM_SLOTS) throw new Error(`Histogram slot out of range: ${slot}`);
        const buffer = new ArrayBuffer(16);
        new Float32Array(buffer).set([color.width, color.height]);
        new Uint32Array(buffer)[2] = slot;
        this.device.queue.writeBuffer(this._histogramConstants[slot], 0, buffer);
        this._usedHistograms.add(slot);
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._histogramConstants[slot] } },
                { binding: 1, resource: color.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
                { binding: 2, resource: { buffer: this._stats, offset: STATS_WORDS * 4 } },
            ],
        });
        const pass = encoder.beginComputePass({ label: `motion-histogram-${slot}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(color.width / 8), Math.ceil(color.height / 8));
        pass.end();
    }

    /**
     * Copies `source` so next frame's {@link previous}(key) returns it. Encode
     * after every pass that reads this frame's previous image.
     * @param encoder - Command encoder
     * @param key - Snapshot name
     * @param source - Image to keep (needs COPY_SRC)
     */
    encodeSnapshot(encoder: GPUCommandEncoder, key: string, source: GPUTexture): void {
        let target = this._snapshots.get(key);
        if (!target || target.width !== source.width || target.height !== source.height || target.format !== source.format) {
            target?.destroy();
            target = this.device.createTexture({
                label: `motion-snapshot-${key}`,
                size: { width: source.width, height: source.height },
                format: source.format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this._snapshots.set(key, target);
        }
        encoder.copyTextureToTexture({ texture: source }, { texture: target }, [source.width, source.height]);
    }

    /** Flips the depth history; call after the frame's last encode. */
    endFrame(): void {
        this._depthIndex = 1 - this._depthIndex;
        this._hasPrevious = true;
    }

    /**
     * Reads back this frame's statistics (submit the frame's work first).
     * @returns Decoded residual + histogram slots (null where unused)
     */
    async readStats(): Promise<MotionFrameStats> {
        const encoder = this.device.createCommandEncoder({ label: 'motion-stats-readback' });
        encoder.copyBufferToBuffer(this._stats, 0, this._readback, 0, this._stats.size);
        this.device.queue.submit([encoder.finish()]);
        await this._readback.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(this._readback.getMappedRange().slice(0));
        this._readback.unmap();
        return decodeStats(words, this._usedResiduals, this._usedHistograms);
    }

    /** Releases every GPU resource. */
    dispose(): void {
        this._cameraMotion?.destroy();
        for (const texture of this._linearDepth) texture.destroy();
        for (const texture of this._snapshots.values()) texture.destroy();
        for (const texture of this._debug.values()) texture.destroy();
        this._dummy.destroy();
        this._stats.destroy();
        this._readback.destroy();
        this._motionConstants.destroy();
        for (const buffer of [...this._residualConstants, ...this._histogramConstants]) buffer.destroy();
    }

    private _ready(pipeline: GPUComputePipeline | null): GPUComputePipeline {
        if (!pipeline) throw new Error('MotionAnalyzer: await init() first.');
        if (!this._cameraMotion) throw new Error('MotionAnalyzer: configure() first.');
        return pipeline;
    }
}

/**
 * Decodes the raw statistics words (exported for tests).
 * @param words - Residual slots followed by histogram slots
 * @param residualSlots - Slots written this frame
 * @param histogramSlots - Histogram slots written this frame
 * @returns Decoded statistics
 */
export function decodeStats(
    words: Uint32Array,
    residualSlots: ReadonlySet<number>,
    histogramSlots: ReadonlySet<number>,
): MotionFrameStats {
    const residuals: (ResidualStats | null)[] = [];
    for (let slot = 0; slot < RESIDUAL_SLOTS; slot++) {
        if (!residualSlots.has(slot)) {
            residuals.push(null);
            continue;
        }
        const base = slot * STATS_STRIDE;
        const pixels = words[base + MAX_CANDIDATES * CANDIDATE_FIELDS + 1];
        const share = (value: number) => (pixels ? value / pixels : 0);
        const candidates: CandidateStats[] = [];
        for (let k = 0; k < MAX_CANDIDATES; k++) {
            const offset = base + k * CANDIDATE_FIELDS;
            const valid = words[offset + 1];
            candidates.push({
                meanResidual: valid ? words[offset] / RESIDUAL_FIXED_POINT / valid : 0,
                valid: share(valid),
                best: share(words[offset + 2]),
                unexplained: share(words[offset + 3]),
                beaten: share(words[offset + 4]),
                moving: share(words[offset + 5]),
            });
        }
        residuals.push({ candidates, noneValid: share(words[base + MAX_CANDIDATES * CANDIDATE_FIELDS]), pixels });
    }
    const histograms: (Uint32Array | null)[] = [];
    for (let slot = 0; slot < HISTOGRAM_SLOTS; slot++) {
        const start = STATS_WORDS + slot * HISTOGRAM_BINS;
        histograms.push(histogramSlots.has(slot) ? words.slice(start, start + HISTOGRAM_BINS) : null);
    }
    return { residuals, histograms };
}
