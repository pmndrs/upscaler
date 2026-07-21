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
    sequence: number;
    epoch: number;
    state: 'idle' | 'encoding' | 'pending';
    pending: Promise<void> | null;
}

/**
 * Lightweight multi-slot GPU profiler built on WebGPU timestamp queries.
 *
 * Normal library use remains a graceful no-op without `timestamp-query`.
 * Authoritative benchmark mode fails early instead of emitting an invalid
 * performance claim.
 */
export class GpuTimer {
    readonly enabled: boolean;

    private static readonly MAX_PASSES = 16;
    private static readonly SLOT_COUNT = 8;

    private readonly _device: GPUDevice;
    private readonly _slots: GpuTimerSlot[] = [];
    private _active: GpuTimerSlot | null = null;
    private _results = new Map<string, number>();
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
        this.enabled = device.features.has('timestamp-query');
        if (!this.enabled) return;

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
                sequence: -1,
                epoch: 0,
                state: 'idle',
                pending: null,
            });
        }
    }

    /** Makes the next sample use an explicit deterministic frame tag. */
    setNextFrameTag(frameTag: number): void {
        this._nextFrameTag = frameTag;
    }

    /** Enables benchmark-only hard failures for unavailable or dropped timing. */
    setAuthoritative(authoritative: boolean): void {
        this._authoritative = authoritative;
        if (authoritative && !this.enabled)
            throw new Error('Authoritative benchmark timing requires timestamp-query support.');
    }

    /** Starts a new frame without replacing the latest completed interactive result. */
    beginFrame(): void {
        this._active = null;
        this._throwAuthoritativeError();
        if (!this.enabled) {
            if (this._authoritative)
                throw new Error('Authoritative benchmark timing requires timestamp-query support.');
            return;
        }

        const slot = this._slots.find((candidate) => candidate.state === 'idle');
        if (!slot) {
            if (this._authoritative)
                throw new Error('No fresh GPU timestamp readback slot is available.');
            return;
        }

        slot.labels = [];
        slot.frameTag = this._nextFrameTag ?? this._sequence;
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
        if (!slot || slot.labels.length === 0) return;
        const count = slot.labels.length * 2;
        encoder.resolveQuerySet(slot.querySet, 0, count, slot.resolveBuffer, 0);
        encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, count * 8);
    }

    /** Kicks off asynchronous readback into the fresh-sample queue. */
    readback(): void {
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
                this._results = new Map(passes.map((pass) => [pass.label, pass.milliseconds]));
            })
            .catch((error: unknown) => {
                if (authoritative && epoch === this._epoch && !this._disposed)
                    this._authoritativeError =
                        error instanceof Error
                            ? error
                            : new Error(`Authoritative GPU timestamp readback failed: ${String(error)}`);
            })
            .finally(() => {
                slot.pending = null;
                slot.state = 'idle';
            });
    }

    /** Waits until another frame can be timestamped without dropping a sample. */
    async waitForAvailableSlot(): Promise<void> {
        this._throwAuthoritativeError();
        if (!this.enabled) {
            if (this._authoritative)
                throw new Error('Authoritative benchmark timing requires timestamp-query support.');
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
        if (!this.enabled) return;
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
        this._samples = [];
        this._nextFrameTag = null;
        this._latestCompletedSequence = -1;
        this._authoritativeError = null;
        for (const slot of this._slots) {
            if (slot.state === 'encoding') slot.state = 'idle';
            slot.labels = [];
        }
    }

    /** Latest complete resolved frame, retained for the interactive readout. */
    get timings(): ReadonlyMap<string, number> {
        return this._results;
    }

    private _throwAuthoritativeError(): void {
        if (!this._authoritative || !this._authoritativeError) return;
        const cause = this._authoritativeError;
        this._authoritativeError = null;
        throw new Error('Authoritative GPU timestamp readback failed.', { cause });
    }

    dispose(): void {
        this._disposed = true;
        this._epoch++;
        for (const slot of this._slots) {
            slot.querySet.destroy();
            slot.resolveBuffer.destroy();
            slot.readBuffer.destroy();
        }
        this._slots.length = 0;
    }
}
