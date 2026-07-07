/**
 * Lightweight GPU pass profiler built on WebGPU timestamp queries.
 *
 * Degrades to a no-op when the device lacks `timestamp-query` (three
 * requests every adapter feature at init, so if the hardware supports it,
 * the device has it). Results resolve asynchronously a few frames behind —
 * fine for a bench readout.
 */
export class GpuTimer {
    readonly enabled: boolean;

    private readonly _device: GPUDevice;
    private _querySet: GPUQuerySet | null = null;
    private _resolveBuffer: GPUBuffer | null = null;
    private _readBuffer: GPUBuffer | null = null;
    private _labels: string[] = [];
    private _pending = false;
    private _results = new Map<string, number>();

    private static readonly MAX_PASSES = 16;

    constructor(device: GPUDevice) {
        this._device = device;
        this.enabled = device.features.has('timestamp-query');
        if (!this.enabled) return;

        const count = GpuTimer.MAX_PASSES * 2;
        this._querySet = device.createQuerySet({
            label: 'fsr3-timer',
            type: 'timestamp',
            count,
        });
        this._resolveBuffer = device.createBuffer({
            label: 'fsr3-timer-resolve',
            size: count * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this._readBuffer = device.createBuffer({
            label: 'fsr3-timer-read',
            size: count * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
    }

    /** Starts a new frame of measurements. */
    beginFrame(): void {
        this._labels = [];
    }

    /**
     * Returns `timestampWrites` for a labeled compute pass, or undefined
     * when timing is unavailable or the read-back is still in flight.
     */
    passDescriptor(label: string): GPUComputePassTimestampWrites | undefined {
        if (!this.enabled || !this._querySet || this._pending) return undefined;
        if (this._labels.length >= GpuTimer.MAX_PASSES) return undefined;
        const index = this._labels.length;
        this._labels.push(label);
        return {
            querySet: this._querySet,
            beginningOfPassWriteIndex: index * 2,
            endOfPassWriteIndex: index * 2 + 1,
        };
    }

    /** Encodes query resolution; call after all passes, before submit. */
    resolve(encoder: GPUCommandEncoder): void {
        if (!this.enabled || this._pending || this._labels.length === 0) return;
        if (!this._querySet || !this._resolveBuffer || !this._readBuffer) return;
        const count = this._labels.length * 2;
        encoder.resolveQuerySet(this._querySet, 0, count, this._resolveBuffer, 0);
        encoder.copyBufferToBuffer(this._resolveBuffer, 0, this._readBuffer, 0, count * 8);
    }

    /** Kicks off the async read-back; results appear in {@link timings}. */
    readback(): void {
        if (!this.enabled || this._pending || this._labels.length === 0) return;
        const readBuffer = this._readBuffer;
        if (!readBuffer) return;
        const labels = [...this._labels];
        this._pending = true;
        readBuffer
            .mapAsync(GPUMapMode.READ)
            .then(() => {
                const values = new BigUint64Array(readBuffer.getMappedRange());
                for (let i = 0; i < labels.length; i++) {
                    const ns = Number(values[i * 2 + 1] - values[i * 2]);
                    this._results.set(labels[i], ns / 1e6);
                }
                readBuffer.unmap();
            })
            .catch(() => {
                // Device loss/teardown mid-map — timings just stop updating.
            })
            .finally(() => {
                this._pending = false;
            });
    }

    /** Latest resolved per-pass GPU times in milliseconds. */
    get timings(): ReadonlyMap<string, number> {
        return this._results;
    }

    dispose(): void {
        this._querySet?.destroy();
        this._resolveBuffer?.destroy();
        this._readBuffer?.destroy();
    }
}
