// Image math for scripts/measure-reference-quality.mjs: the fixed presentation
// transform, full-reference metrics (PSNR, SSIM), the reference temporal error,
// reference jitter offsets and RGB8 PNG I/O. Pure functions over typed arrays,
// so the unit tests (image-metrics.test.mjs) stay GPU-free.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

//* Presentation Transform =====================================================
// The bench presents with three's ACESFilmicToneMapping (exposure 1) and an
// sRGB output color space. These mirror three's TSL nodes, not the classic
// GLSL chunk: TSL's RRTAndODTFit multiplies 0.983729 into the whole
// denominator term (`(v + 0.4329510) * 0.983729`), which the GLSL form does
// not. The script checks this transform against the bench's own canvas every
// run (`presentationCheck` in the summary).

/** Rows of three's TSL ACESInputMat (sRGB → AP1 + RRT saturation). */
const ACES_INPUT = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
];
/** Rows of three's TSL ACESOutputMat (ODT saturation → sRGB). */
const ACES_OUTPUT = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
];

const rrtAndOdtFit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * ((v + 0.432951) * 0.983729) + 0.238081);
const srgbEncode = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Applies the bench's presentation (negatives clamped to 0, three
 * ACESFilmic at exposure 1, then the sRGB OETF) to linear RGB. Non-finite input is reported, not hidden: it maps
 * to NaN so a metric over it reads NaN.
 * @param {ArrayLike<number>} linear - Interleaved linear RGB, 3 values per pixel
 * @returns {Float32Array} Interleaved display-encoded RGB in [0, 1]
 */
export function present(linear) {
    const out = new Float32Array(linear.length);
    for (let i = 0; i < linear.length; i += 3) {
        // Negative linear values (e.g. RCAS undershoot) present as black on
        // the bench canvas, but the ACES fit curves back up below zero, so
        // clamp first. Verified against the canvas: without this, Q18's
        // temporal output read up to 29/255 brighter than the screen.
        const r = Math.max(linear[i], 0) / 0.6;
        const g = Math.max(linear[i + 1], 0) / 0.6;
        const b = Math.max(linear[i + 2], 0) / 0.6;
        for (let c = 0; c < 3; c++) {
            const row = ACES_INPUT[c];
            const v = rrtAndOdtFit(row[0] * r + row[1] * g + row[2] * b);
            out[i + c] = v;
        }
        const x = out[i];
        const y = out[i + 1];
        const z = out[i + 2];
        for (let c = 0; c < 3; c++) {
            const row = ACES_OUTPUT[c];
            out[i + c] = srgbEncode(clamp01(row[0] * x + row[1] * y + row[2] * z));
        }
    }
    return out;
}

/** IEEE half → float lookup, for rgba16float readbacks. */
export const HALF_TO_FLOAT = (() => {
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const sign = h & 0x8000 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const fraction = h & 0x3ff;
        table[h] =
            exponent === 0
                ? sign * 2 ** -14 * (fraction / 1024)
                : exponent === 31
                  ? fraction
                      ? NaN
                      : sign * Infinity
                  : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
    }
    return table;
})();

//* Reference Jitter ==========================================================

const radicalInverse = (index, base) => {
    let result = 0;
    let fraction = 1 / base;
    for (let i = index; i > 0; i = Math.floor(i / base)) {
        result += (i % base) * fraction;
        fraction /= base;
    }
    return result;
};

/**
 * Sub-pixel offsets for a box-filtered supersampled reference: Halton (2, 3)
 * points 1…count, recentred so their mean is exactly zero. A biased mean would
 * shift the whole reference against the upscaler output by a fraction of a
 * pixel and read as error on every edge.
 * @param {number} count - Number of samples
 * @returns {Array<[number, number]>} Offsets in pixels, about [-0.5, 0.5)
 */
export function referenceOffsets(count) {
    const points = Array.from({ length: count }, (_, i) => [radicalInverse(i + 1, 2), radicalInverse(i + 1, 3)]);
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / count;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / count;
    return points.map(([x, y]) => [x - meanX, y - meanY]);
}

//* Regions ===================================================================

/**
 * Pixel bounds of a normalized [x, y, w, h] region (the scenario ROI format).
 * @param {readonly number[]} roi - Normalized region
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {{x0: number, y0: number, x1: number, y1: number}} Half-open bounds
 */
export function roiBounds([rx, ry, rw, rh], width, height) {
    return {
        x0: Math.floor(rx * width),
        y0: Math.floor(ry * height),
        x1: Math.min(width, Math.ceil((rx + rw) * width)),
        y1: Math.min(height, Math.ceil((ry + rh) * height)),
    };
}

/**
 * Mean of a per-pixel map over a region, skipping `border` pixels at the image
 * edge (SSIM's window is clamped there).
 * @param {Float32Array} map - One value per pixel
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {readonly number[]} roi - Normalized region
 * @param {number} [border] - Edge pixels to exclude
 * @returns {number} Region mean
 */
export function regionMean(map, width, height, roi, border = 0) {
    const { x0, y0, x1, y1 } = roiBounds(roi, width, height);
    let sum = 0;
    let count = 0;
    for (let y = Math.max(y0, border); y < Math.min(y1, height - border); y++)
        for (let x = Math.max(x0, border); x < Math.min(x1, width - border); x++) {
            sum += map[y * width + x];
            count++;
        }
    return sum / Math.max(count, 1);
}

//* Full-Reference Metrics ====================================================

/**
 * Per-pixel squared error, averaged over RGB, of two interleaved images.
 * @param {Float32Array} a - Interleaved RGB
 * @param {Float32Array} b - Interleaved RGB, same size
 * @returns {Float32Array} One value per pixel
 */
export function squaredErrorMap(a, b) {
    const map = new Float32Array(a.length / 3);
    for (let p = 0, i = 0; p < map.length; p++, i += 3) {
        const dr = a[i] - b[i];
        const dg = a[i + 1] - b[i + 1];
        const db = a[i + 2] - b[i + 2];
        map[p] = (dr * dr + dg * dg + db * db) / 3;
    }
    return map;
}

/**
 * PSNR in dB for a mean squared error over [0, 1] data. Identical images
 * read Infinity.
 * @param {number} mse - Mean squared error
 * @returns {number} Peak signal-to-noise ratio
 */
export const psnr = (mse) => (mse > 0 ? 10 * Math.log10(1 / mse) : Infinity);

const SSIM_RADIUS = 5;
const SSIM_KERNEL = (() => {
    const sigma = 1.5;
    const taps = Array.from({ length: 2 * SSIM_RADIUS + 1 }, (_, i) => Math.exp(-((i - SSIM_RADIUS) ** 2) / (2 * sigma * sigma)));
    const total = taps.reduce((a, b) => a + b, 0);
    return Float32Array.from(taps, (tap) => tap / total);
})();
/** Edge pixels whose SSIM window is clamped; excluded from SSIM means. */
export const SSIM_BORDER = SSIM_RADIUS;

/** Separable 11-tap Gaussian (σ 1.5) with clamped edges, in place via `scratch`. */
function blur(source, width, height, scratch, out) {
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
                const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
                sum += SSIM_KERNEL[k + SSIM_RADIUS] * source[row + xx];
            }
            scratch[row + x] = sum;
        }
    }
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
                const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
                sum += SSIM_KERNEL[k + SSIM_RADIUS] * scratch[yy * width + x];
            }
            out[y * width + x] = sum;
        }
}

/**
 * SSIM map (Wang et al. 2004: 11-tap Gaussian window σ 1.5, K1 0.01, K2 0.03,
 * data range 1), computed per RGB channel and averaged. Average it with
 * {@link regionMean} and `border` {@link SSIM_BORDER}.
 * @param {Float32Array} a - Interleaved RGB in [0, 1]
 * @param {Float32Array} b - Interleaved RGB in [0, 1], same size
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Float32Array} One SSIM value per pixel
 */
export function ssimMap(a, b, width, height) {
    const n = width * height;
    const c1 = 0.01 ** 2;
    const c2 = 0.03 ** 2;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const product = new Float32Array(n);
    const scratch = new Float32Array(n);
    const muX = new Float32Array(n);
    const muY = new Float32Array(n);
    const xx = new Float32Array(n);
    const yy = new Float32Array(n);
    const xy = new Float32Array(n);
    const map = new Float32Array(n);
    for (let channel = 0; channel < 3; channel++) {
        for (let p = 0; p < n; p++) {
            x[p] = a[p * 3 + channel];
            y[p] = b[p * 3 + channel];
        }
        blur(x, width, height, scratch, muX);
        blur(y, width, height, scratch, muY);
        for (let p = 0; p < n; p++) product[p] = x[p] * x[p];
        blur(product, width, height, scratch, xx);
        for (let p = 0; p < n; p++) product[p] = y[p] * y[p];
        blur(product, width, height, scratch, yy);
        for (let p = 0; p < n; p++) product[p] = x[p] * y[p];
        blur(product, width, height, scratch, xy);
        for (let p = 0; p < n; p++) {
            const mx = muX[p];
            const my = muY[p];
            const vx = xx[p] - mx * mx;
            const vy = yy[p] - my * my;
            const cov = xy[p] - mx * my;
            map[p] += ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2)) / 3;
        }
    }
    return map;
}

//* Temporal Error ============================================================

/**
 * Per-pixel temporal maps between consecutive frames, averaged over RGB:
 * `error` = |Δoutput − Δreference| (the output's frame-to-frame change that the
 * true image does not make, and the true change it misses), `churn` = |Δoutput|
 * and `referenceChurn` = |Δreference|. A still, converged output that is wrong
 * reads churn ≈ 0 and error ≈ 0 — temporal error separates stability from
 * correctness only together with a full-reference metric — while flicker the
 * reference does not have, and lag behind real motion, both read as error.
 * @param {Float32Array} output - This frame's output, interleaved RGB
 * @param {Float32Array} previousOutput - Last frame's output
 * @param {Float32Array} reference - This frame's reference
 * @param {Float32Array} previousReference - Last frame's reference
 * @returns {{error: Float32Array, churn: Float32Array, referenceChurn: Float32Array}} Maps
 */
export function temporalMaps(output, previousOutput, reference, previousReference) {
    const n = output.length / 3;
    const error = new Float32Array(n);
    const churn = new Float32Array(n);
    const referenceChurn = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 3) {
        let e = 0;
        let c = 0;
        let r = 0;
        for (let k = 0; k < 3; k++) {
            const dOut = output[i + k] - previousOutput[i + k];
            const dRef = reference[i + k] - previousReference[i + k];
            e += Math.abs(dOut - dRef);
            c += Math.abs(dOut);
            r += Math.abs(dRef);
        }
        error[p] = e / 3;
        churn[p] = c / 3;
        referenceChurn[p] = r / 3;
    }
    return { error, churn, referenceChurn };
}

//* PNG I/O ===================================================================

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/**
 * Encodes display-encoded RGB in [0, 1] as an 8-bit RGB PNG (rounded,
 * clamped) — the frame a viewer sees, for offline perceptual metrics.
 * @param {Float32Array} rgb - Interleaved RGB in [0, 1]
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Buffer} PNG file bytes
 */
export function encodePng(rgb, width, height) {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = Math.round(clamp01(rgb[y * stride + x]) * 255);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Decodes a non-interlaced RGB8/RGBA8 PNG (CDP screenshots).
 * @param {Buffer} bytes - PNG file bytes
 * @returns {{width: number, height: number, bytesPerPixel: number, raw: Buffer}} Unfiltered pixels
 */
export function decodePng(bytes) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const compressed = [];
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') break;
        offset += length + 12;
    }
    if (bitDepth !== 8 || ![2, 6].includes(colorType))
        throw new Error(`PNG decode requires RGB8/RGBA8; got depth=${bitDepth}, type=${colorType}.`);
    const packed = inflateSync(Buffer.concat(compressed));
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = width * bytesPerPixel;
    const raw = Buffer.alloc(stride * height);
    let source = 0;
    for (let y = 0; y < height; y++) {
        const filter = packed[source++];
        for (let x = 0; x < stride; x++) {
            const value = packed[source++];
            const left = x >= bytesPerPixel ? raw[y * stride + x - bytesPerPixel] : 0;
            const above = y > 0 ? raw[(y - 1) * stride + x] : 0;
            const upperLeft = y > 0 && x >= bytesPerPixel ? raw[(y - 1) * stride + x - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) {
                const p = left + above - upperLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - above);
                const pc = Math.abs(p - upperLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
            } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
            raw[y * stride + x] = (value + predictor) & 0xff;
        }
    }
    return { width, height, bytesPerPixel, raw };
}
