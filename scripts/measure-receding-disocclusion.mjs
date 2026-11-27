#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Receding-camera disocclusion meter (issue #67) — steps the Q19 scenario
 * (converge, then dolly back / forward, orbit left / right, slide, and the
 * scene receding / approaching under a still camera, each followed by a hold)
 * through the disocclusion and accumulation-age debug views, per bench
 * variant, and reports per-segment coverage.
 *
 * A correct depth clip disoccludes only geometry that was genuinely hidden:
 * slivers beside silhouettes, plus the border strip a dolly-out brings into
 * view (that strip fails the off-screen test, which is correct). Large
 * fractions on dolly-back / orbit / scene-recede segments are the #67 bug.
 *
 * Usage:
 *   node scripts/measure-receding-disocclusion.mjs
 *     [--variants baseline,reconstruct-cross-frame-v1,reconstruct-camera-v1]
 *     [--ratio 2] [--width 1280] [--height 720] [--stride 1]
 *     [--label q19] [--url http://127.0.0.1:5199] [--port 9333]
 *
 * Per variant: per-frame mean disocclusion v (whole frame and an interior
 * crop that excludes the border strips), share with v > 0.5, frame-to-frame
 * interior flicker (mean |Δv|, --stride 1 only), mean
 * accumulation age and the share of pixels younger than 0.25, summarized per
 * segment; debug-view and final PNGs at each motion segment's first and middle
 * frame. Writes bench/results/raw/receding/<label>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { parseCliOrExit } from './cli-flags.mjs';
import {
    DEFAULT_BENCH_URL,
    parsePort,
    closeOwnedCdpBrowser,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl as waitForServer,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** sRGB byte → linear value: undoes the output encoding a debug present keeps. */
const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

// Mirrors Q19_SEGMENTS in bench/src/benchmark/scenarios.ts.
const SEGMENTS = [
    { name: 'still', start: 0, end: 119 },
    { name: 'dolly-back', start: 120, end: 179 },
    { name: 'hold-1', start: 180, end: 239 },
    { name: 'dolly-forward', start: 240, end: 299 },
    { name: 'hold-2', start: 300, end: 359 },
    { name: 'orbit-left', start: 360, end: 419 },
    { name: 'hold-3', start: 420, end: 479 },
    { name: 'orbit-right', start: 480, end: 539 },
    { name: 'hold-4', start: 540, end: 599 },
    { name: 'slide', start: 600, end: 659 },
    { name: 'hold-5', start: 660, end: 719 },
    { name: 'scene-recede', start: 720, end: 779 },
    { name: 'hold-6', start: 780, end: 839 },
    { name: 'scene-approach', start: 840, end: 899 },
    { name: 'hold-7', start: 900, end: 959 },
    { name: 'dolly-back-fast', start: 960, end: 979 },
    { name: 'hold-8', start: 980, end: 1039 },
    { name: 'dolly-forward-fast', start: 1040, end: 1059 },
    { name: 'hold-9', start: 1060, end: 1119 },
];
const END_FRAME = 1119;
// Frames measured: everything from the end of the convergence window on.
const FIRST_MEASURED = 100;
const SNAPSHOT_FRAMES = SEGMENTS.filter((segment) => !/^(still|hold)/.test(segment.name)).flatMap(
    (segment) => [segment.start + 1, Math.floor((segment.start + segment.end) / 2)],
);

//* CLI
const USAGE = `Usage: node scripts/measure-receding-disocclusion.mjs [options]
  --variants <list>      bench variants (default baseline,reconstruct-cross-frame-v1,reconstruct-camera-v1)
  --ratio <n>            upscale ratio (default 2)
  --width <px> --height <px>   canvas size (default 1280x720)
  --stride <n>           measure every n-th frame (default 1)
  --label <name>         output folder prefix (default q19)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); if nothing answers,
                         the bench dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
Writes to bench/results/raw/receding/<label>-<ratio>x/.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['variants', 'ratio', 'width', 'height', 'stride', 'label', 'url', 'port'],
    USAGE,
);
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const variants = (cli.variants ?? 'baseline,reconstruct-cross-frame-v1,reconstruct-camera-v1')
    .split(',')
    .filter(Boolean);
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const stride = Math.max(1, Number(cli.stride ?? 1));
const label = cli.label ?? 'q19';
const port = parsePort(cli.port, '--port') ?? 9333;
const outputDirectory = join(
    ROOT,
    'bench/results/raw/receding',
    `${label}-${String(ratio).replace('.', '_')}x`,
);

//* PNG decode (RGB8/RGBA8, non-interlaced) — same contract as run-benchmark.mjs
function decodePng(bytes) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
    let offset = 8;
    let pngWidth = 0;
    let pngHeight = 0;
    let bitDepth = 0;
    let colorType = 0;
    const compressed = [];
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            pngWidth = data.readUInt32BE(0);
            pngHeight = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') break;
        offset += length + 12;
    }
    if (bitDepth !== 8 || ![2, 6].includes(colorType))
        throw new Error(`PNG contract requires RGB8/RGBA8; got depth=${bitDepth}, type=${colorType}.`);
    const packed = inflateSync(Buffer.concat(compressed));
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = pngWidth * bytesPerPixel;
    const raw = Buffer.alloc(stride * pngHeight);
    let source = 0;
    for (let y = 0; y < pngHeight; y++) {
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
    return { width: pngWidth, height: pngHeight, bytesPerPixel, stride, raw };
}

//* CDP plumbing (subset of run-benchmark.mjs)
const chromeExecutable = () => browserExecutable();

async function waitForUrl(url, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // Still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.opened = new Promise((resolveOpen, rejectOpen) => {
            this.socket.addEventListener('open', resolveOpen, { once: true });
            this.socket.addEventListener('error', rejectOpen, { once: true });
        });
        this.socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
                return;
            }
            for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        });
    }
    async call(method, params = {}) {
        await this.opened;
        const id = this.nextId++;
        const response = new Promise((resolveCall, rejectCall) => {
            this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
        });
        this.socket.send(JSON.stringify({ id, method, params }));
        return response;
    }
    on(method, listener) {
        const listeners = this.listeners.get(method) ?? [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }
    close() {
        this.socket.close();
    }
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

async function captureCanvas(client) {
    const bounds = await evaluate(
        client,
        `(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) throw new Error('Canvas not found.');
            const rect = canvas.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`,
    );
    const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...bounds, scale: 1 },
    });
    return Buffer.from(screenshot.data, 'base64');
}

//* Measurement
// Interior = everything but an 8 % margin: dolly-out and orbit bring a border
// strip into view that fails the off-screen test (correctly), and that strip
// would otherwise dominate the comparison between depth-clip forms.
const MARGIN = 0.08;

/** Interior mean |Δv| between two consecutive disocclusion captures. */
function disocclusionFlicker(previous, image) {
    const x0 = Math.floor(image.width * MARGIN);
    const x1 = image.width - x0;
    const y0 = Math.floor(image.height * MARGIN);
    const y1 = image.height - y0;
    let sum = 0;
    let pixels = 0;
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const index = (y * image.width + x) * image.bytesPerPixel;
            sum += Math.abs(SRGB_TO_LINEAR[image.raw[index]] - SRGB_TO_LINEAR[previous.raw[index]]);
            pixels++;
        }
    return sum / pixels;
}

function disocclusionStats(image) {
    let disoccluded = 0;
    let sum = 0;
    let interiorSum = 0;
    let interiorPixels = 0;
    const x0 = Math.floor(image.width * MARGIN);
    const x1 = image.width - x0;
    const y0 = Math.floor(image.height * MARGIN);
    const y1 = image.height - y0;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const value = SRGB_TO_LINEAR[image.raw[(y * image.width + x) * image.bytesPerPixel]];
            if (value > 0.5) disoccluded++;
            sum += value;
            if (x >= x0 && x < x1 && y >= y0 && y < y1) {
                interiorSum += value;
                interiorPixels++;
            }
        }
    }
    const pixels = image.width * image.height;
    return { disoccluded: disoccluded / pixels, mean: sum / pixels, interior: interiorSum / interiorPixels };
}

function ageStats(image) {
    let young = 0;
    let sum = 0;
    const pixels = image.width * image.height;
    for (let p = 0; p < pixels; p++) {
        const value = SRGB_TO_LINEAR[image.raw[p * image.bytesPerPixel]];
        if (value < 0.25) young++;
        sum += value;
    }
    return { young: young / pixels, mean: sum / pixels };
}

async function stepTo(client, frame) {
    await evaluate(
        client,
        `window.__UPSCALER_BENCH__.step(${frame}).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
    );
}

/** Replays Q19 through one debug view, measuring every stride-th frame. */
async function replay(client, view, variantDirectory, measure) {
    await evaluate(client, `window.__UPSCALER_BENCH__.capture({ frame: ${FIRST_MEASURED}, debugView: '${view}' })`);
    const perFrame = [];
    let previousImage = null;
    let previousFrame = -1;
    for (let frame = FIRST_MEASURED; frame <= END_FRAME; frame++) {
        const snapshot = SNAPSHOT_FRAMES.includes(frame);
        if (frame > FIRST_MEASURED) await stepTo(client, frame);
        if (!snapshot && !measure) continue;
        if (!snapshot && (frame - FIRST_MEASURED) % stride !== 0) continue;
        const png = await captureCanvas(client);
        if (snapshot) await writeFile(join(variantDirectory, `${view}-f${frame}.png`), png);
        if (measure && (frame - FIRST_MEASURED) % stride === 0) {
            const image = decodePng(png);
            const entry = { frame, ...measure(image) };
            // Frame-to-frame flicker needs consecutive captures (--stride 1).
            if (view === 'disocclusion' && previousImage && previousFrame === frame - 1)
                entry.flicker = disocclusionFlicker(previousImage, image);
            previousImage = image;
            previousFrame = frame;
            perFrame.push(entry);
        }
    }
    return perFrame;
}

function summarize(perFrame, keys) {
    return SEGMENTS.filter((segment) => segment.end >= FIRST_MEASURED).map((segment) => {
        const frames = perFrame.filter((entry) => entry.frame >= segment.start && entry.frame <= segment.end);
        const result = { segment: segment.name, frames: frames.length };
        for (const key of keys) {
            const values = frames.map((entry) => entry[key]).filter((value) => value !== null && value !== undefined);
            result[key] = values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
            result[`${key}Max`] = values.length ? Math.max(...values) : null;
        }
        return result;
    });
}

//* Main
async function main() {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    try {
        try {
            await waitForUrl(server.origin, 1);
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForServer(server.origin, { child: viteServer });
        }

        profile = join(tmpdir(), `upscaler-receding-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${width + 40},${height + 40}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([
            client.call('Page.enable'),
            client.call('Runtime.enable'),
            client.call('Log.enable'),
        ]);

        const results = {};
        for (const variant of variants) {
            const variantDirectory = join(outputDirectory, variant);
            await mkdir(variantDirectory, { recursive: true });
            const url = new URL(server.origin);
            url.searchParams.set('benchMode', 'capture');
            url.searchParams.set('scenario', 'Q19');
            url.searchParams.set('variant', variant);
            url.searchParams.set('ratio', String(ratio));
            url.searchParams.set('width', String(width));
            url.searchParams.set('height', String(height));
            await client.call('Page.navigate', { url: url.href });
            for (let attempt = 0; ; attempt++) {
                const ready = await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true');
                if (ready === true) break;
                if (attempt > 300) throw new Error(`Timed out waiting for the bench (${variant}).`);
                await new Promise((resolveWait) => setTimeout(resolveWait, 100));
            }

            const started = Date.now();
            const disocclusion = await replay(client, 'disocclusion', variantDirectory, disocclusionStats);
            const age = await replay(client, 'accumulation-age', variantDirectory, ageStats);
            await replay(client, 'final', variantDirectory, null);
            const perFrame = disocclusion.map((entry, index) => ({
                frame: entry.frame,
                disoccluded: entry.disoccluded,
                disocclusionMean: entry.mean,
                disocclusionInterior: entry.interior,
                flicker: entry.flicker ?? null,
                ageMean: age[index].mean,
                young: age[index].young,
            }));
            const segments = summarize(perFrame, [
                'disocclusionMean',
                'disocclusionInterior',
                'flicker',
                'disoccluded',
                'ageMean',
                'young',
            ]);
            results[variant] = { perFrame, segments };
            await writeFile(join(variantDirectory, 'per-frame.json'), JSON.stringify(perFrame, null, 2));
            console.log(`\n${variant} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
            console.log('segment              mean v%  interior v%  v>0.5 %   flicker%   age mean   young%');
            // Segments a coarse --stride skips entirely have no values.
            const pct = (value, digits, width) => (value === null ? '—' : (100 * value).toFixed(digits)).padStart(width);
            for (const row of segments)
                console.log(
                    `${row.segment.padEnd(20)} ${pct(row.disocclusionMean, 3, 7)}  ${pct(row.disocclusionInterior, 3, 11)}` +
                        `  ${pct(row.disoccluded, 3, 7)}   ${pct(row.flicker, 4, 8)}` +
                        `   ${(row.ageMean === null ? '—' : row.ageMean.toFixed(3)).padStart(8)}   ${pct(row.young, 2, 6)}`,
                );
        }

        const summary = { ratio, width, height, stride, variants, segments: SEGMENTS, results, logRecords };
        await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
        console.log(`\nartifacts: ${outputDirectory}`);
        if (logRecords.some((record) => /error|exception|validation/i.test(record)))
            console.warn(`browser log records:\n${logRecords.join('\n')}`);
    } finally {
        // On Windows the browser can outlive its launcher process, so close it over CDP first.
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
