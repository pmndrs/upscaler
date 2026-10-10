import type { TextureResource } from '@pmndrs/upscaler/core';

/** Diagnostic readback only, never used in the render loop. */
export async function readTexture(device: GPUDevice, { texture }: TextureResource, channelCount?: 1 | 2 | 3): Promise<{ finite: boolean; min: number; max: number; meanAbs: number; regions: number[]; cyanY: number; amberY: number; alpha: { min: number; max: number; fractional: number } }> {
    const single = texture.format === 'r32float', byte = texture.format === 'rgba8unorm';
    // Alpha=1 must not make a black color texture pass the nonempty-image checks.
    const channels = single ? 1 : channelCount ?? 3, pixelBytes = single || byte ? 4 : 8;
    const bytesPerRow = Math.ceil(texture.width * pixelBytes / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: texture.width, height: texture.height }); device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const data = new DataView(buffer.getMappedRange());
        let min = Infinity, max = -Infinity, sum = 0, finite = true;
        const regions = new Array<number>(8 * 8 * channels).fill(0), counts = new Array<number>(64).fill(0);
        let cyanY = 0, cyanCount = 0, amberY = 0, amberCount = 0;
        let alphaMin = 1, alphaMax = 0, fractional = 0;
        const half = (bits: number) => {
            const exp = (bits >> 10) & 31, mantissa = bits & 1023;
            return (bits & 32768 ? -1 : 1) * (exp === 0 ? mantissa * 2 ** -24 : exp === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exp - 15));
        };
        for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
            const rgb = [];
            const region = Math.floor(y * 8 / texture.height) * 8 + Math.floor(x * 8 / texture.width); counts[region]++;
            for (let c = 0; c < channels; c++) {
                const offset = y * bytesPerRow + x * pixelBytes + c * (byte ? 1 : single ? 4 : 2);
                let value: number;
                if (single) value = data.getFloat32(offset, true);
                else if (byte) value = data.getUint8(offset) / 255;
                else {
                    value = half(data.getUint16(offset, true));
                }
                finite &&= Number.isFinite(value); min = Math.min(min, value); max = Math.max(max, value); sum += Math.abs(value); rgb.push(value);
                regions[region * channels + c] += value;
            }
            if (!single) {
                const offset = y * bytesPerRow + x * pixelBytes;
                const alpha = byte ? data.getUint8(offset + 3) / 255 : half(data.getUint16(offset + 6, true));
                finite &&= Number.isFinite(alpha); alphaMin = Math.min(alphaMin, alpha); alphaMax = Math.max(alphaMax, alpha);
                if (alpha > 0.001 && alpha < 0.999) fractional++;
                if (rgb[0] < rgb[1] * 0.55 && rgb[1] > 0.15 && rgb[2] > 0.1) { cyanY += y; cyanCount++; }
                if (rgb[0] > 0.15 && rgb[1] > 0.08 && rgb[2] < rgb[1] * 0.6) { amberY += y; amberCount++; }
            }
        }
        return { finite, min, max, meanAbs: sum / (texture.width * texture.height * channels), regions: regions.map((value, index) => value / Math.max(1, counts[Math.floor(index / channels)])), cyanY: cyanCount ? cyanY / cyanCount / texture.height : -1, amberY: amberCount ? amberY / amberCount / texture.height : -1, alpha: { min: alphaMin, max: single ? 1 : alphaMax, fractional } };
    } finally { buffer.destroy(); }
}
