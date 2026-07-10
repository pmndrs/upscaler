/**
 * CPU-side writer for the `FsrConstants` uniform block.
 *
 * The layout here must match `WGSL_CONSTANTS` in `shaders/common.ts` —
 * offsets are documented there. A single 256-byte buffer is shared by every
 * pass (bound at `@group(0) @binding(0)`), written once per frame.
 */
export class ConstantsBuffer {
    /** Uniform block size. 96 bytes of payload, padded to a round 256. */
    static readonly SIZE = 256;

    readonly buffer: GPUBuffer;

    private readonly _data = new ArrayBuffer(ConstantsBuffer.SIZE);
    private readonly _f32 = new Float32Array(this._data);
    private readonly _u32 = new Uint32Array(this._data);
    private readonly _device: GPUDevice;

    constructor(device: GPUDevice) {
        this._device = device;
        this.buffer = device.createBuffer({
            label: 'upscale-constants',
            size: ConstantsBuffer.SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    //* Field Setters (f32 indices match WGSL byte offsets / 4)

    setRenderSize(w: number, h: number): void {
        this._f32[0] = w;
        this._f32[1] = h;
        this._f32[4] = 1 / w;
        this._f32[5] = 1 / h;
    }

    setDisplaySize(w: number, h: number): void {
        this._f32[2] = w;
        this._f32[3] = h;
        this._f32[6] = 1 / w;
        this._f32[7] = 1 / h;
    }

    setJitter(x: number, y: number, prevX: number, prevY: number): void {
        this._f32[8] = x;
        this._f32[9] = y;
        this._f32[10] = prevX;
        this._f32[11] = prevY;
    }

    setMotionScale(x: number, y: number): void {
        this._f32[12] = x;
        this._f32[13] = y;
    }

    setDepthNearFar(near: number, far: number): void {
        this._f32[14] = near;
        this._f32[15] = far;
    }

    setSharpness(value: number): void {
        this._f32[16] = value;
    }

    setMaxAccumulation(value: number): void {
        this._f32[17] = value;
    }

    setExposure(value: number): void {
        this._f32[18] = value;
    }

    setDeltaTime(value: number): void {
        this._f32[19] = value;
    }

    setFlags(flags: number): void {
        this._u32[20] = flags;
    }

    setFrameIndex(value: number): void {
        this._u32[21] = value;
    }

    setDebugMode(value: number): void {
        this._u32[22] = value;
    }

    /** Uploads the staged values to the GPU. Call once per frame before dispatch. */
    upload(): void {
        this._device.queue.writeBuffer(this.buffer, 0, this._data);
    }

    dispose(): void {
        this.buffer.destroy();
    }
}
