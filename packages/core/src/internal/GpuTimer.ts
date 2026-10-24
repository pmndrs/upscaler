/** One fresh, complete timestamp-query sample. */
export interface GpuTimerFrameSample {
    frameTag: number;
    sequence: number;
    passes: Array<{ label: string; milliseconds: number }>;
}

interface GpuTimerSlot {
    querySet: GPUQuerySet;
    resolveBuffer: GPUBuffer;
    readBuffer: GPUBuffer;
    labels: string[];
    frameTag: number;
    frame: number;
    sequence: number;
    epoch: number;
    state: 'idle' | 'encoding' | 'pending';
    pending: Promise<void> | null;
}

/**
 * Allocation lifecycle. WebGPU reports allocation failures asynchronously and
 * hands back an *invalid* object in the meantime, so the timer cannot attach
 * any timestamp work until its error scopes have resolved clean.
 */
type GpuTimerStatus = 'unsupported' | 'pending' | 'ready' | 'failed';

/**
 * Lightweight multi-slot GPU profiler built on WebGPU timestamp queries.
 *
 * Normal library use remains a graceful no-op without `timestamp-query`, and
 * profiling can never invalidate a frame: the query sets and readback buffers
 * are allocated inside `out-of-memory` + `validation` error scopes, no
 * timestamp work is attached until both resolve clean (the first frame or so
 * goes untimed), and any allocation or readback failure disables the timer
 * for the instance's lifetime with a single warning. Authoritative benchmark
 * mode fails early instead of emitting an invalid performance claim.
 */
export class GpuTimer {
    private static readonly MAX_PASSES = 16;
    private static readonly SLOT_COUNT = 8;

    /**
     * Settles once the allocation error scopes resolve — whether the timer
     * came up healthy or disabled itself. Never rejects.
     */
    readonly ready: Promise<void>;

    private readonly _device: GPUDevice;
    private readonly _slots: GpuTimerSlot[] = [];
    private _status: GpuTimerStatus;
    private _active: GpuTimerSlot | null = null;
    private _results = new Map<string, number>();
    // The frame whose samples are being collected: a split frame's two submits
    // land here one at a time and publish together once the last one reads back.
    private _building: { frame: number; passes: Map<string, number> } | null = null;
    private _samples: GpuTimerFrameSample[] = [];
    private _nextFrameTag: number | null = null;
    private _sequence = 0;
    private _latestCompletedSequence = -1;
    private _epoch = 0;
    private _authoritative = false;
    private _authoritativeError: Error | null = null;
    private _disposed = false;

    constructor(device: GPUDevice) {
        this._device = device;
        if (!device.features.has('timestamp-query')) {
            this._status = 'unsupported';
            this.ready = Promise.resolve();
            return;
        }
        this._status = 'pending';

        //* Scoped Allocation
        // A failed createQuerySet (e.g. OOM on a shared GPU) returns an invalid
        // object; encoding timestampWrites/resolveQuerySet against it would
        // invalidate the caller's whole command buffer — black output. Capture
        // the errors here so they can only ever disable the timer.
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
        let thrown: unknown = null;
        try {
            const count = GpuTimer.MAX_PASSES * 2;
            for (let index = 0; index < GpuTimer.SLOT_COUNT; index++) {
                this._slots.push({
                    querySet: device.createQuerySet({
                        label: `upscale-timer-${index}`,
                        type: 'timestamp',
                        count,
                    }),
                    resolveBuffer: device.createBuffer({
                        label: `upscale-timer-resolve-${index}`,
                        size: count * 8,
                        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                    }),
                    readBuffer: device.createBuffer({
                        label: `upscale-timer-read-${index}`,
                        size: count * 8,
                        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                    }),
                    labels: [],
                    frameTag: -1,
                    frame: -1,
                    sequence: -1,
                    epoch: 0,
                    state: 'idle',
                    pending: null,
                });
            }
        } catch (error) {
            thrown = error;
        }
        // Pop unconditionally (LIFO) so a synchronous throw can't leak scopes
        // onto the device and swallow unrelated errors later.
        const validation = device.popErrorScope();
        const outOfMemory = device.popErrorScope();
        this.ready = Promise.all([validation, outOfMemory]).then(
            ([validationError, oomError]) => {
                const error = thrown ?? validationError ?? oomError;
                if (error) this._fail('allocation failed', error);
                else if (this._status === 'pending') this._status = 'ready';
            },
            (error: unknown) => this._fail('allocation error scope rejected', error),
        );
    }

    /**
     * Whether this timer can (still) produce timings: `timestamp-query` is
     * supported and nothing has disabled it. Stays true while the allocation
     * is being confirmed — timings simply start once it is.
     */
    get enabled(): boolean {
        return this._status === 'pending' || this._status === 'ready';
    }

    /** Makes the next sample use an explicit deterministic frame tag. */
    setNextFrameTag(frameTag: number): void {
        this._nextFrameTag = frameTag;
    }

    /** Enables benchmark-only hard failures for unavailable or dropped timing. */
    setAuthoritative(authoritative: boolean): void {
        this._authoritative = authoritative;
        if (authoritative && !this.enabled) throw this._unavailableError();
    }

    /**
     * Starts timing one submit without replacing the latest completed
     * interactive result.
     * @param frame - The caller's frame index. Submits that share it (a split
     * frame's early and late stage) are reported together in {@link timings};
     * defaults to a fresh index per submit
     */
    beginFrame(frame?: number): void {
        this._active = null;
        this._throwAuthoritativeError();
        if (!this.enabled) {
            if (this._authoritative) throw this._unavailableError();
            return;
        }
        // Allocation not yet confirmed valid: attach nothing this frame.
        if (this._status !== 'ready') return;

        const slot = this._slots.find((candidate) => candidate.state === 'idle');
        if (!slot) {
            if (this._authoritative)
                throw new Error('No fresh GPU timestamp readback slot is available.');
            return;
        }

        slot.labels = [];
        slot.frameTag = this._nextFrameTag ?? this._sequence;
        slot.frame = frame ?? this._sequence;
        slot.sequence = this._sequence++;
        slot.epoch = this._epoch;
        slot.state = 'encoding';
        this._nextFrameTag = null;
        this._active = slot;
    }

    /**
     * Returns `timestampWrites` for a labeled compute pass.
     * @param label - Stable compute-pass label
     * @returns Timestamp writes for the active frame, when available
     */
    passDescriptor(label: string): GPUComputePassTimestampWrites | undefined {
        const slot = this._active;
        if (!slot) return undefined;
        if (slot.labels.length >= GpuTimer.MAX_PASSES) {
            if (this._authoritative) throw new Error('GPU timer pass capacity exceeded.');
            return undefined;
        }
        const index = slot.labels.length;
        slot.labels.push(label);
        return {
            querySet: slot.querySet,
            beginningOfPassWriteIndex: index * 2,
            endOfPassWriteIndex: index * 2 + 1,
        };
    }

    /** Encodes query resolution; call after all passes, before submit. */
    resolve(encoder: GPUCommandEncoder): void {
        const slot = this._active;
        if (!slot || slot.labels.length === 0 || this._status !== 'ready') return;
        const count = slot.labels.length * 2;
        encoder.resolveQuerySet(slot.querySet, 0, count, slot.resolveBuffer, 0);
        encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, count * 8);
    }

    /**
     * Kicks off asynchronous readback into the fresh-sample queue.
     * @param completesFrame - `false` for the early submit of a split frame:
     * its timings are held until the frame's last submit reads back, so
     * {@link timings} never shows half a frame
     */
    readback(completesFrame = true): void {
        const slot = this._active;
        this._active = null;
        if (!slot) return;
        if (slot.labels.length === 0) {
            slot.state = 'idle';
            if (this._authoritative) throw new Error('Authoritative GPU frame contained no timed passes.');
            return;
        }

        const labels = [...slot.labels];
        const frameTag = slot.frameTag;
        const frame = slot.frame;
        const sequence = slot.sequence;
        const epoch = slot.epoch;
        const authoritative = this._authoritative;
        const byteLength = labels.length * 2 * 8;
        slot.state = 'pending';
        slot.pending = slot.readBuffer
            .mapAsync(GPUMapMode.READ, 0, byteLength)
            .then(() => {
                const values = new BigUint64Array(slot.readBuffer.getMappedRange(0, byteLength));
                const passes = labels.map((label, index) => ({
                    label,
                    milliseconds: Number(values[index * 2 + 1] - values[index * 2]) / 1e6,
                }));
                slot.readBuffer.unmap();
                if (epoch !== this._epoch || this._disposed) return;

                this._samples.push({ frameTag, sequence, passes });
                if (sequence <= this._latestCompletedSequence) return;
                this._latestCompletedSequence = sequence;
                this._collect(frame, passes, completesFrame);
            })
            .catch((error: unknown) => {
                // dispose() destroys the buffers mid-map: an expected abort.
                if (this._disposed) return;
                if (authoritative && epoch === this._epoch)
                    this._authoritativeError =
                        error instanceof Error
                            ? error
                            : new Error(`Authoritative GPU timestamp readback failed: ${String(error)}`);
                // A readback that fails once (lost/invalid buffer) will keep
                // failing — stop attaching timestamp work rather than retry.
                this._fail('readback failed', error);
            })
            .finally(() => {
                slot.pending = null;
                slot.state = 'idle';
            });
    }

    /** Waits until another frame can be timestamped without dropping a sample. */
    async waitForAvailableSlot(): Promise<void> {
        await this.ready;
        this._throwAuthoritativeError();
        if (!this.enabled) {
            if (this._authoritative) throw this._unavailableError();
            return;
        }
        while (!this._slots.some((slot) => slot.state === 'idle')) {
            const pending = this._slots.flatMap((slot) => (slot.pending ? [slot.pending] : []));
            if (pending.length === 0) throw new Error('GPU timer slots are unavailable without readbacks.');
            await Promise.race(pending);
            this._throwAuthoritativeError();
        }
    }

    /** Waits for the queue and all timestamp readbacks to settle. */
    async drain(): Promise<void> {
        await this.ready;
        if (!this.enabled) {
            this._throwAuthoritativeError();
            return;
        }
        await this._device.queue.onSubmittedWorkDone();
        while (this._slots.some((slot) => slot.pending)) {
            const pending = this._slots.flatMap((slot) => (slot.pending ? [slot.pending] : []));
            await Promise.all(pending);
        }
        this._throwAuthoritativeError();
    }

    /** Returns and clears all fresh samples, ordered by submission sequence. */
    takeSamples(): GpuTimerFrameSample[] {
        const samples = this._samples.sort((a, b) => a.sequence - b.sequence);
        this._samples = [];
        return samples;
    }

    /** Clears labels/results and invalidates pending samples from an old graph. */
    reset(): void {
        this._epoch++;
        this._active = null;
        this._results = new Map();
        this._building = null;
        this._samples = [];
        this._nextFrameTag = null;
        this._latestCompletedSequence = -1;
        this._authoritativeError = null;
        for (const slot of this._slots) {
            if (slot.state === 'encoding') slot.state = 'idle';
            slot.labels = [];
        }
    }

    /**
     * Latest complete resolved frame, retained for the interactive readout.
     * Holds exactly the passes that frame encoded: one that stops running
     * drops out with the next frame.
     */
    get timings(): ReadonlyMap<string, number> {
        return this._results;
    }

    private _collect(
        frame: number,
        passes: GpuTimerFrameSample['passes'],
        completesFrame: boolean,
    ): void {
        // Merge only within one frame. A split frame's submits have disjoint
        // pass sets, so replacing per submit would drop the early stage; but
        // merging across frames kept a pass's last value forever once it
        // stopped running (path change, a toggled-off pass) — issue #69.
        if (!this._building || this._building.frame !== frame)
            this._building = { frame, passes: new Map() };
        for (const pass of passes) this._building.passes.set(pass.label, pass.milliseconds);
        if (completesFrame) this._results = new Map(this._building.passes);
    }

    private _throwAuthoritativeError(): void {
        if (!this._authoritative || !this._authoritativeError) return;
        const cause = this._authoritativeError;
        this._authoritativeError = null;
        throw new Error('Authoritative GPU timestamp readback failed.', { cause });
    }

    private _unavailableError(): Error {
        return new Error(
            this._status === 'failed'
                ? 'Authoritative benchmark timing is unavailable: GPU timer resources failed.'
                : 'Authoritative benchmark timing requires timestamp-query support.',
        );
    }

    /**
     * Disables the timer for the rest of its lifetime: warns once, attaches
     * no further timestamp work, and frees the (possibly invalid) resources.
     */
    private _fail(reason: string, error: unknown): void {
        if (this._status === 'failed' || this._disposed) return;
        this._status = 'failed';
        this._active = null;
        const detail =
            error && typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message.trim()
                : String(error);
        console.warn(
            `@pmndrs/upscaler: GPU timing disabled — timestamp ${reason} (${detail}). ` +
                'Rendering is unaffected; gpuTimings will no longer update.',
        );
        if (this._authoritative && !this._authoritativeError)
            this._authoritativeError = new Error(`GPU timer ${reason}: ${detail}`);
        this._destroySlots();
    }

    private _destroySlots(): void {
        // Safe with in-flight work: WebGPU keeps resources referenced by
        // already-submitted command buffers alive until those complete.
        for (const slot of this._slots) {
            slot.querySet.destroy();
            slot.resolveBuffer.destroy();
            slot.readBuffer.destroy();
        }
        this._slots.length = 0;
    }

    dispose(): void {
        this._disposed = true;
        this._epoch++;
        this._active = null;
        this._destroySlots();
    }
}
