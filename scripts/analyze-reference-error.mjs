#!/usr/bin/env node
/**
 * Where does one mode's error against the reference live, relative to another?
 * Reads a scripts/measure-reference-quality.mjs run written with
 * --save-diagnostics (presented reference + per-mode presented output +
 * temporal guides) and splits the squared-error difference between mode A and
 * mode B (default temporal − spatial) into exclusive pixel classes, assigned in
 * this order:
 *
 * - border: within --border display px of the screen edge (content entering view)
 * - disoccluded: temporal's disocclusion mask > 0.5
 * - young: temporal history younger than --young frames (reset, rejected or new)
 * - edge: reference luma gradient above --edge (geometric and texture edges)
 * - interior: everything else
 *
 * Per class: pixel share, each mode's MSE, and `gapDb` — how many dB of A's
 * whole-frame PSNR deficit to B would close if A matched B on that class alone
 * (positive = A is worse there). The classes' gapDb don't sum exactly to the
 * total (dB is logarithmic), but they rank where the deficit lives. The edge
 * class is further split by motion (render px/frame) into slow and fast thirds.
 *
 * Band split: each image is split into a low band (Gaussian, σ 2 display px)
 * and the residual high band, and both modes' MSE is reported per band. Blur
 * (detail lost to resampling) shows as high-band error; lag or ghosting (wrong
 * content, not just soft content) also raises the low band.
 *
 * Also writes diff-<frame>.png for the window's first frame: red where A's
 * squared error exceeds B's, blue where it is lower (sqrt-scaled).
 *
 * Usage:
 *   node scripts/analyze-reference-error.mjs <run-dir> [--a temporal] [--b spatial]
 *     [--border 8] [--young 4] [--edge 0.1]
 *
 * Writes <run-dir>/error-analysis.json.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCliOrExit } from './cli-flags.mjs';
import { encodePng, psnr } from './image-metrics.mjs';

const USAGE = `Usage: node scripts/analyze-reference-error.mjs <run-dir> [options]
  --a <mode>       mode whose deficit is analysed (default temporal; its guides classify pixels)
  --b <mode>       comparison mode (default spatial)
  --border <px>    screen-edge band, display px (default 8)
  --young <n>      history younger than n frames is "young" (default 4)
  --edge <g>       reference luma gradient threshold for "edge", presented units (default 0.1)
The run must come from measure-reference-quality.mjs --save-diagnostics.`;
const argv = process.argv.slice(2);
const runDirectory = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null;
const cli = parseCliOrExit(argv, ['a', 'b', 'border', 'young', 'edge'], USAGE);
if (!runDirectory) {
    console.error(USAGE);
    process.exit(1);
}
const modeA = String(cli.a ?? 'temporal');
const modeB = String(cli.b ?? 'spatial');
const border = Number(cli.border ?? 8);
const youngFrames = Number(cli.young ?? 4);
const edgeThreshold = Number(cli.edge ?? 0.1);
const CLASSES = ['border', 'disoccluded', 'young', 'edge-slow', 'edge-mid', 'edge-fast', 'interior'];

const SIGMA = 2;
const RADIUS = 6;
const KERNEL = (() => {
    const taps = Array.from({ length: 2 * RADIUS + 1 }, (_, i) => Math.exp(-((i - RADIUS) ** 2) / (2 * SIGMA * SIGMA)));
    const total = taps.reduce((x, y) => x + y, 0);
    return taps.map((tap) => tap / total);
})();

/** Gaussian low band of interleaved RGB, clamped edges. */
function lowBand(image, width, height) {
    const scratch = new Float32Array(image.length);
    const out = new Float32Array(image.length);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let k = -RADIUS; k <= RADIUS; k++) {
                    const xx = Math.min(width - 1, Math.max(0, x + k));
                    sum += KERNEL[k + RADIUS] * image[(y * width + xx) * 3 + c];
                }
                scratch[(y * width + x) * 3 + c] = sum;
            }
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let k = -RADIUS; k <= RADIUS; k++) {
                    const yy = Math.min(height - 1, Math.max(0, y + k));
                    sum += KERNEL[k + RADIUS] * scratch[(yy * width + x) * 3 + c];
                }
                out[(y * width + x) * 3 + c] = sum;
            }
    return out;
}

const loadF32 = async (path) => {
    const bytes = await readFile(path);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
};

const summary = JSON.parse(await readFile(join(runDirectory, 'summary.json'), 'utf8'));
const [width, height] = summary.display;
const offset = summary.referenceOffset ?? 0;
const guideFiles = (await readdir(join(runDirectory, 'raw', 'temporal'))).filter((name) => name.endsWith('.guides.f32'));
if (guideFiles.length === 0) throw new Error('No temporal guides: re-run with --modes including temporal and --save-diagnostics.');

const results = {};
for (const window of summary.windows) {
    const totals = Object.fromEntries(CLASSES.map((name) => [name, { pixels: 0, a: 0, b: 0 }]));
    let frameCount = 0;
    // Motion thresholds for the edge split: thirds of this window's edge motion.
    const motionSamples = [];
    const frames = [];
    for (let frame = window.start; frame <= window.end; frame++) {
        const name = `f${String(frame).padStart(4, '0')}`;
        const reference = await loadF32(join(runDirectory, 'reference', `f${String(frame + offset).padStart(4, '0')}.presented.f32`));
        const a = await loadF32(join(runDirectory, 'raw', modeA, `${name}.f32`));
        const b = await loadF32(join(runDirectory, 'raw', modeB, `${name}.f32`));
        const guides = await loadF32(join(runDirectory, 'raw', 'temporal', `${name}.guides.f32`));
        frames.push({ frame, reference, a, b, guides });
    }
    const luma = (image, p) => 0.2126 * image[p * 3] + 0.7152 * image[p * 3 + 1] + 0.0722 * image[p * 3 + 2];
    const classify = ({ reference, guides }) => {
        const labels = new Uint8Array(width * height);
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                let label = 6;
                if (x < border || y < border || x >= width - border || y >= height - border) label = 0;
                else if (guides[p * 3 + 1] > 0.5) label = 1;
                else if (guides[p * 3] < youngFrames) label = 2;
                else {
                    const gx = luma(reference, p + 1) - luma(reference, p - 1);
                    const gy = luma(reference, p + width) - luma(reference, p - width);
                    if (Math.hypot(gx, gy) > edgeThreshold) label = 3;
                }
                labels[p] = label;
            }
        return labels;
    };
    const labelled = frames.map((entry) => ({ ...entry, labels: classify(entry) }));
    for (const { labels, guides } of labelled)
        for (let p = 0; p < labels.length; p += 7) if (labels[p] === 3) motionSamples.push(guides[p * 3 + 2]);
    motionSamples.sort((x, y) => x - y);
    const lowCut = motionSamples[Math.floor(motionSamples.length / 3)] ?? 0;
    const highCut = motionSamples[Math.floor((2 * motionSamples.length) / 3)] ?? 0;

    let sumA = 0;
    let sumB = 0;
    const band = { lowA: 0, lowB: 0, highA: 0, highB: 0 };
    for (const { frame, reference, a, b, guides, labels } of labelled) {
        frameCount++;
        const [lr, la, lb] = [reference, a, b].map((image) => lowBand(image, width, height));
        for (let i = 0; i < reference.length; i++) {
            band.lowA += (la[i] - lr[i]) ** 2;
            band.lowB += (lb[i] - lr[i]) ** 2;
            band.highA += (a[i] - la[i] - (reference[i] - lr[i])) ** 2;
            band.highB += (b[i] - lb[i] - (reference[i] - lr[i])) ** 2;
        }
        const diff = window.start === frame ? new Float32Array(width * height * 3) : null;
        for (let p = 0; p < width * height; p++) {
            let ea = 0;
            let eb = 0;
            for (let c = 0; c < 3; c++) {
                ea += (a[p * 3 + c] - reference[p * 3 + c]) ** 2;
                eb += (b[p * 3 + c] - reference[p * 3 + c]) ** 2;
            }
            ea /= 3;
            eb /= 3;
            let label = labels[p];
            const name =
                label === 3
                    ? guides[p * 3 + 2] <= lowCut
                        ? 'edge-slow'
                        : guides[p * 3 + 2] <= highCut
                          ? 'edge-mid'
                          : 'edge-fast'
                    : CLASSES[label === 6 ? 6 : label];
            totals[name].pixels++;
            totals[name].a += ea;
            totals[name].b += eb;
            sumA += ea;
            sumB += eb;
            if (diff) {
                const d = Math.sqrt(Math.abs(ea - eb)) * 4;
                diff[p * 3] = ea > eb ? d : 0;
                diff[p * 3 + 2] = ea > eb ? 0 : d;
            }
        }
        if (diff)
            await writeFile(join(runDirectory, `diff-${modeA}-${modeB}-f${String(frame).padStart(4, '0')}.png`), encodePng(diff, width, height));
    }
    const pixels = width * height * frameCount;
    const mseA = sumA / pixels;
    const mseB = sumB / pixels;
    const classes = {};
    for (const name of CLASSES) {
        const t = totals[name];
        // A's whole-frame MSE if it matched B on this class only.
        const matched = mseA - (t.a - t.b) / pixels;
        classes[name] = {
            share: t.pixels / pixels,
            mseA: t.pixels ? t.a / t.pixels : null,
            mseB: t.pixels ? t.b / t.pixels : null,
            psnrA: t.pixels ? psnr(t.a / t.pixels) : null,
            psnrB: t.pixels ? psnr(t.b / t.pixels) : null,
            gapDb: 10 * Math.log10(mseA / matched),
        };
    }
    const values = pixels * 3;
    const bands = {
        low: { psnrA: psnr(band.lowA / values), psnrB: psnr(band.lowB / values) },
        high: { psnrA: psnr(band.highA / values), psnrB: psnr(band.highB / values) },
    };
    results[window.name] = {
        frames: frameCount,
        bands,
        psnrA: psnr(mseA),
        psnrB: psnr(mseB),
        gapDb: 10 * Math.log10(mseA / mseB),
        edgeMotionCutsPx: [lowCut, highCut],
        classes,
    };
    console.log(
        `\n${summary.scenario} ${window.name}: ${modeA} ${psnr(mseA).toFixed(2)} dB vs ${modeB} ${psnr(mseB).toFixed(2)} dB ` +
            `(pooled MSE; deficit ${(10 * Math.log10(mseA / mseB)).toFixed(2)} dB). Edge motion thirds at ` +
            `${lowCut.toFixed(2)} / ${highCut.toFixed(2)} render px/frame.`,
    );
    console.log(
        `bands (σ ${SIGMA} px): low ${bands.low.psnrA.toFixed(2)} vs ${bands.low.psnrB.toFixed(2)} dB, ` +
            `high ${bands.high.psnrA.toFixed(2)} vs ${bands.high.psnrB.toFixed(2)} dB`,
    );
    console.log('class          share    PSNR A   PSNR B   dB of deficit closed if A matched B here');
    for (const [name, c] of Object.entries(classes))
        console.log(
            `${name.padEnd(12)} ${(100 * c.share).toFixed(1).padStart(6)}%  ${c.psnrA === null ? '   —  ' : c.psnrA.toFixed(2).padStart(6)}   ` +
                `${c.psnrB === null ? '   —  ' : c.psnrB.toFixed(2).padStart(6)}   ${c.gapDb.toFixed(3).padStart(7)}`,
        );
}
await writeFile(
    join(runDirectory, 'error-analysis.json'),
    `${JSON.stringify({ modeA, modeB, border, youngFrames, edgeThreshold, results }, null, 2)}\n`,
);
