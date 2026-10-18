#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Lighting-drift lag meter: how far the temporal output trails a lighting ramp
 * on a still camera. Written for STILL_CLAMP_RELAX (issue #5): widening the
 * variance box on still, converged pixels trades rectification authority for
 * still-scene convergence, and a ramp too slow for the shading-change detector
 * is where that trade shows up.
 *
 * For every sampled frame f of a scenario (Q9, Q15), two canvases are compared
 * at the same jitter phase:
 * - ramp: the scenario played continuously from frame 0 to f
 * - reference: the same scenario with the directional light frozen at f's
 *   intensity for all frames 0..f, i.e. the converged image the accumulator
 *   would show if it had no lag
 * The difference is the drift error: stale lighting that the history kept.
 * Before the ramp starts both runs are identical (deterministic), so the
 * error is exactly 0 there. After the ramp ends, the error decays back to 0
 * as the history catches up.
 *
 * A third pass replays the ramp with the shading-change debug view, to show
 * whether the detector fired. A ramp that is meant to be "sub-detector" must
 * read black there.
 *
 * Metrics, on the presented canvas (0–255 scale, as measure-convergence.mjs):
 * - meanAbs: mean |ramp - reference| over RGB
 * - signedLuma: mean (ramp - reference) Rec.709 luma. Positive means the
 *   output is brighter than it should be (stale light on a down-ramp).
 * - ghostFraction: share of pixels whose |Δluma| exceeds 4/255
 * - rampLuma / referenceLuma: mean luma of each, so the lag can be read in
 *   frames (how many frames ago the reference had the ramp's brightness)
 * Each is reported for the full frame and for every scenario ROI.
 *
 * The relax value is a WGSL constant, so this script does not change it.
 * Edit STILL_CLAMP_RELAX in packages/core/src/shaders/accumulate.ts, then run once per
 * value. The constant is read back from the source and recorded in the
 * summary.
 *
 * Usage:
 *   node scripts/measure-drift-lag.mjs [--scenario Q15] [--ratio 2]
 *     [--frames 116:379:4] [--width 1280] [--height 720] [--label relax8]
 *     [--settings '{"autoExposure":false}'] [--port 9333]
 *     [--variant shading-memory-range8]
 *     [--url http://127.0.0.1:5199]
 *
 * --settings is passed to every capture() as its settings override (the same
 * plumbing measure-convergence.mjs uses). Auto-exposure is worth isolating: an adapting exposure re-decodes
 * history conditioned under the previous exposure (no conditioning-exposure
 * history correction, NEXT-STEPS "not planned"), which reads as lag of its
 * own, independent of the variance clip.
 *
 * Starts the bench dev server on --url's port if nothing answers there.
 * Writes summary.json (+ ramp/reference/detector PNGs at --keep frames) under
 * bench/results/raw/drift-lag/<label>-<scenario>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { parseCliOrExit } from './cli-flags.mjs';
import {
    DEFAULT_BENCH_URL,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GHOST_THRESHOLD = 4;

//* CLI
const USAGE = `Usage: node scripts/measure-drift-lag.mjs [options]
  --scenario <id>        bench scenario with a lighting ramp (default Q15; Q9 also works)
  --ratio <n>            upscale ratio (default 2)
  --frames <a:b:step>    sampled frames, inclusive (default 116:379:4)
  --keep <list>          frames whose ramp/reference/shading-change PNGs are kept, e.g. 154,206
  --width <px> --height <px>   canvas size (default 1280x720)
  --label <name>         output folder prefix (default baseline)
  --settings <json>      capture-setting overrides, e.g. '{"autoExposure":false}'
  --variant <id>         bench variant identity, e.g. shading-frame-pair-v1 (default: production)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); if nothing answers,
                         the bench dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
Writes to bench/results/raw/drift-lag/<label>-<scenario>-<ratio>x/.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['scenario', 'ratio', 'frames', 'keep', 'width', 'height', 'label', 'settings', 'variant', 'url', 'port'],
    USAGE,
);
const scenario = cli.scenario ?? 'Q15';
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const label = cli.label ?? 'baseline';
const variant = typeof cli.variant === 'string' ? cli.variant : null;
const captureSettings = typeof cli.settings === 'string' ? JSON.parse(cli.settings) : {};
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const [frameStart, frameEnd, frameStep] = (cli.frames ?? '116:379:4').split(':').map(Number);
const sampleFrames = [];
for (let frame = frameStart; frame <= frameEnd; frame += frameStep) sampleFrames.push(frame);
const keepFrames = new Set(String(cli.keep ?? '').split(',').filter(Boolean).map(Number));
const outputDirectory = join(
    ROOT,
    'bench/results/raw/drift-lag',
    `${label}-${scenario}-${String(ratio).replace('.', '_')}x`,
);

//* PNG decode (RGB8/RGBA8, non-interlaced), same contract as run-benchmark.mjs
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
    return { width: pngWidth, height: pngHeight, bytesPerPixel, raw };
}

//* Metrics
function regionBounds(image, roi) {
    const [rx, ry, rw, rh] = roi;
    return {
        x0: Math.floor(rx * image.width),
        y0: Math.floor(ry * image.height),
        x1: Math.min(image.width, Math.ceil((rx + rw) * image.width)),
        y1: Math.min(image.height, Math.ceil((ry + rh) * image.height)),
    };
}

function compare(ramp, reference, roi) {
    const { x0, y0, x1, y1 } = regionBounds(ramp, roi);
    let abs = 0;
    let signed = 0;
    let rampLuma = 0;
    let referenceLuma = 0;
    let ghost = 0;
    let pixels = 0;
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const a = (y * ramp.width + x) * ramp.bytesPerPixel;
            const b = (y * reference.width + x) * reference.bytesPerPixel;
            const dr = ramp.raw[a] - reference.raw[b];
            const dg = ramp.raw[a + 1] - reference.raw[b + 1];
            const db = ramp.raw[a + 2] - reference.raw[b + 2];
            const dl = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
            referenceLuma +=
                0.2126 * reference.raw[b] + 0.7152 * reference.raw[b + 1] + 0.0722 * reference.raw[b + 2];
            rampLuma += 0.2126 * ramp.raw[a] + 0.7152 * ramp.raw[a + 1] + 0.0722 * ramp.raw[a + 2];
            abs += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
            signed += dl;
            if (Math.abs(dl) > GHOST_THRESHOLD) ghost++;
            pixels++;
        }
    return {
        meanAbs: abs / (pixels * 3),
        signedLuma: signed / pixels,
        ghostFraction: ghost / pixels,
        rampLuma: rampLuma / pixels,
        referenceLuma: referenceLuma / pixels,
    };
}

function brightness(image, roi) {
    const { x0, y0, x1, y1 } = regionBounds(image, roi);
    let lit = 0;
    let sum = 0;
    let pixels = 0;
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const value = image.raw[(y * image.width + x) * image.bytesPerPixel];
            if (value > 10) lit++;
            sum += value;
            pixels++;
        }
    return { litFraction: lit / pixels, meanByte: sum / pixels };
}

//* CDP plumbing (subset of run-benchmark.mjs)
const chromeExecutable = () => browserExecutable();

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

const PRESENTED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
const SETTINGS = JSON.stringify(captureSettings);

/** Plays the scenario from frame 0 and captures every sample frame in `view`. */
async function playRamp(client, view, onFrame) {
    const [first, ...rest] = sampleFrames;
    await evaluate(
        client,
        `window.__UPSCALER_BENCH__.capture({ frame: ${first}, debugView: '${view}', settings: ${SETTINGS} }).then(() => ${PRESENTED})`,
    );
    await onFrame(first, await captureCanvas(client));
    for (const frame of rest) {
        await evaluate(client, `window.__UPSCALER_BENCH__.step(${frame}).then(() => ${PRESENTED})`);
        await onFrame(frame, await captureCanvas(client));
    }
}

//* Main
async function main() {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    const accumulateSource = await readFile(join(ROOT, 'packages/core/src/shaders/accumulate.ts'), 'utf8');
    const relax = Number(/const STILL_CLAMP_RELAX : f32 = ([\d.e+-]+);/.exec(accumulateSource)?.[1]);

    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    try {
        try {
            await waitForUrl(server.origin, { attempts: 1 });
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }

        profile = join(tmpdir(), `upscaler-drift-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${width + 40},${height + 200}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', scenario);
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', String(width));
        url.searchParams.set('height', String(height));
        if (variant) url.searchParams.set('variant', variant);
        await client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            const ready = await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true').catch(() => false);
            if (ready === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__UPSCALER_BENCH__.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        // The bench keeps the scenario contract on its (TS-private) context.
        // Holding the light means swapping that frame function for one that
        // pins directionalIntensity, and restoring it afterwards.
        const rois = await evaluate(
            client,
            `(() => {
                const scenario = window.__UPSCALER_BENCH__._context.scenario;
                window.__driftOriginalFrame = scenario.frame;
                return scenario.rois;
            })()`,
        );

        //* Pass 1: the ramp, played continuously
        const ramp = new Map();
        const intensity = new Map();
        await playRamp(client, 'final', async (frame, png) => {
            ramp.set(frame, decodePng(png));
            intensity.set(
                frame,
                await evaluate(client, `window.__driftOriginalFrame(${frame}).directionalIntensity`),
            );
            if (keepFrames.has(frame)) await writeFile(join(outputDirectory, `ramp-f${frame}.png`), png);
        });

        //* Pass 2: held-light references, one fresh run per sample frame
        const rows = [];
        for (const frame of sampleFrames) {
            const held = intensity.get(frame);
            await evaluate(
                client,
                `(() => {
                    const original = window.__driftOriginalFrame;
                    window.__UPSCALER_BENCH__._context.scenario.frame = (n) => ({ ...original(n), directionalIntensity: ${held} });
                })()`,
            );
            await evaluate(
                client,
                `window.__UPSCALER_BENCH__.capture({ frame: ${frame}, debugView: 'final', settings: ${SETTINGS} }).then(() => ${PRESENTED})`,
            );
            const png = await captureCanvas(client);
            if (keepFrames.has(frame)) await writeFile(join(outputDirectory, `reference-f${frame}.png`), png);
            const reference = decodePng(png);
            const regions = {};
            for (const [name, roi] of Object.entries(rois)) regions[name] = compare(ramp.get(frame), reference, roi);
            rows.push({ frame, intensity: held, regions });
            const full = regions.full;
            console.log(
                `f${frame} I=${held.toFixed(3)} meanAbs ${full.meanAbs.toFixed(3)} ` +
                    `signedLuma ${full.signedLuma.toFixed(3)} ghost ${(100 * full.ghostFraction).toFixed(2)}%`,
            );
        }
        await evaluate(client, `window.__UPSCALER_BENCH__._context.scenario.frame = window.__driftOriginalFrame`);
        ramp.clear();

        //* Pass 3: did the shading-change detector fire?
        const detector = [];
        await playRamp(client, 'shading-change', async (frame, png) => {
            if (keepFrames.has(frame)) await writeFile(join(outputDirectory, `shading-change-f${frame}.png`), png);
            detector.push({ frame, ...brightness(decodePng(png), rois.full) });
        });
        // A still scene has a little block speckle of its own (Q1/Q12 read
        // "near-black", not black), so judge the ramp against the first
        // sampled frame, which precedes it.
        const baseline = detector[0];
        const peak = detector.reduce((a, b) => (b.litFraction > a.litFraction ? b : a));
        console.log(
            `shading-change: lit ${(100 * baseline.litFraction).toFixed(3)}% at f${baseline.frame} (baseline), ` +
                `peak ${(100 * peak.litFraction).toFixed(3)}% at f${peak.frame}`,
        );

        const summary = {
            scenario,
            ratio,
            width,
            height,
            stillClampRelax: relax,
            variant,
            settings: captureSettings,
            frames: sampleFrames,
            ghostThreshold: GHOST_THRESHOLD,
            rows,
            detector,
            logRecords,
        };
        await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
        console.log(`artifacts: ${outputDirectory}`);
        if (logRecords.some((record) => /error|exception|validation/i.test(record) && !/favicon|404/.test(record)))
            console.warn(`browser log records:\n${logRecords.join('\n')}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
