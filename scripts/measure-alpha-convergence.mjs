#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Still-scene ALPHA convergence meter — the alpha counterpart of
 * measure-convergence.mjs. Drives examples/15-transparent-canvas (sub-texel
 * wires + a torus knot over a zero-alpha background, temporal path) with the
 * animation frozen and the camera still, steps frames itself, and reads the
 * upscaler's rgba16float output texture straight back from the GPU — no canvas
 * capture, so alpha is measured exactly rather than inferred from compositing.
 *
 * After a settle period it records two jitter cycles and reports, for alpha and
 * (as context) display-mapped luma:
 * - consecutive-frame mean |Δ| (0–255 scale)
 * - same-jitter-phase mean |Δ| (frame k vs k + phaseCount — isolates churn that
 *   is not the per-phase pattern; a converged accumulator drives this to ~0)
 * - mean per-pixel temporal std-dev and the count of pixels whose alpha swings
 *   by more than 0.25 within the window
 * each over all pixels and over "coverage" pixels (temporal-mean alpha strictly
 * inside (0.02, 0.98), or any frame-to-frame swing above 0.02).
 *
 * Usage:
 *   node scripts/measure-alpha-convergence.mjs [--ratio 2] [--settle 240]
 *     [--width 960] [--height 540] [--sharpness 0.8] [--path temporal]
 *     [--settings '{"detectShadingChanges":false}'] [--label baseline]
 *     [--port 9333] [--url http://127.0.0.1:5300]
 *
 * --settings is merged into the upscaler's RuntimeSettings, so a run can
 * isolate one mechanism (e.g. the shading-change detector) from the rest.
 *
 * Starts the examples dev server on --url's host + port if nothing answers
 * there. --port is Chrome's DevTools (CDP) port. Run with --help for the list.
 * Writes summary.json plus alpha-mean / alpha-range PNGs under
 * bench/results/raw/alpha-convergence/<label>-<path>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    closeOwnedCdpBrowser,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl as waitForServer,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_EXAMPLES_URL = 'http://127.0.0.1:5300';

//* CLI
function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('--')) continue;
        const key = value.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) options[key] = true;
        else {
            options[key] = next;
            index++;
        }
    }
    return options;
}

const cli = parseArguments(process.argv.slice(2));
if (cli.help || cli.h) {
    console.log(`Usage: node scripts/measure-alpha-convergence.mjs [options]
  --ratio <n>            upscale ratio (default 2)
  --settle <frames>      frames to step before measuring (default 240)
  --width <px> --height <px>   canvas size (default 960x540)
  --sharpness <n>        RCAS sharpness (default 0.8)
  --path <path>          upscale path (default temporal)
  --settings <json>      merged into the upscaler's RuntimeSettings
  --label <name>         output folder prefix (default baseline)
  --url <origin>         examples origin (default ${DEFAULT_EXAMPLES_URL}); if nothing answers,
                         the examples dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
Writes to bench/results/raw/alpha-convergence/<label>-<path>-<ratio>x/.`);
    process.exit(0);
}
const ratio = Number(cli.ratio ?? 2);
const settle = Number(cli.settle ?? 240);
const width = Number(cli.width ?? 960);
const height = Number(cli.height ?? 540);
const sharpness = Number(cli.sharpness ?? 0.8);
const path = cli.path ?? 'temporal';
const label = cli.label ?? 'baseline';
const runtimeSettings = cli.settings ? JSON.parse(cli.settings) : {};
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_EXAMPLES_URL);
const baseUrl = server.origin;
const outputDirectory = join(
    ROOT,
    'bench/results/raw/alpha-convergence',
    `${label}-${path}-${String(ratio).replace('.', '_')}x`,
);

//* CDP plumbing (subset of run-benchmark.mjs)
const chromeExecutable = () => browserExecutable();

async function waitForUrl(url, attempts = 150) {
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

//* In-page meter
// Runs inside the example. Everything heavy (half-float decode, per-pixel
// statistics, the same-phase ring buffer) stays in the page so only the summary
// and two small PNGs cross the protocol.
const PAGE_METER = /* js */ `
(() => {
    const example = window.__transparentCanvasExample;
    const { renderer, pass, settings, scene, camera, knot } = example;
    const device = renderer.backend.device;

    const halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1;
        const e = (h >> 10) & 0x1f;
        const f = h & 0x3ff;
        halfTable[h] = e === 0 ? s * 2 ** -14 * (f / 1024)
            : e === 31 ? (f ? NaN : s * Infinity)
            : s * 2 ** (e - 15) * (1 + f / 1024);
    }

    async function readOutput() {
        const texture = renderer.backend.get(pass.upscaler.outputTexture).texture;
        const w = texture.width;
        const h = texture.height;
        const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
        const buffer = device.createBuffer({
            size: bytesPerRow * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const halves = new Uint16Array(buffer.getMappedRange());
        const alpha = new Float32Array(w * h);
        const luma = new Float32Array(w * h);
        const stride = bytesPerRow / 2;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = y * stride + x * 4;
                const r = halfTable[halves[o]];
                const g = halfTable[halves[o + 1]];
                const b = halfTable[halves[o + 2]];
                const l = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 0);
                alpha[y * w + x] = halfTable[halves[o + 3]];
                // Display-mapped so HDR highlights cannot dominate the mean.
                luma[y * w + x] = l / (1 + l);
            }
        }
        buffer.unmap();
        buffer.destroy();
        return { w, h, alpha, luma };
    }

    // Frames go through three's own animation loop, not a bare for-loop: the
    // loop is what advances the node frame, and the velocity node only rolls
    // its previous-frame matrices forward on a new frame. Rendering N times in
    // one task would leave the camera's last move in the motion vectors for
    // every one of them — history would never settle.
    function step(frames) {
        return new Promise((resolveStep) => {
            let remaining = frames;
            renderer.setAnimationLoop(() => {
                pass.renderScene(scene, camera, 1 / 60);
                if (--remaining > 0) return;
                renderer.setAnimationLoop(null);
                device.queue.onSubmittedWorkDone().then(resolveStep);
            });
        });
    }

    async function png(w, h, values) {
        const canvas = new OffscreenCanvas(w, h);
        const context = canvas.getContext('2d');
        const image = context.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
            const v = Math.round(Math.min(Math.max(values[i], 0), 1) * 255);
            image.data[i * 4] = v;
            image.data[i * 4 + 1] = v;
            image.data[i * 4 + 2] = v;
            image.data[i * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    }

    window.__alphaMeter = {
        async run({ ratio, settle, sharpness, path, runtimeSettings }) {
            renderer.setAnimationLoop(null);
            // A late resize from the headless window settling would re-run the
            // example's configure() mid-measurement and reset all history —
            // swallow resizes for the rest of the run.
            window.addEventListener('resize', (event) => event.stopImmediatePropagation(), true);
            settings.orbit = false;
            settings.ratio = ratio;
            settings.path = path;
            settings.sharpness = sharpness;
            example.configure();
            pass.applySettings({ sharpness, debugView: settings.debugView, ...runtimeSettings });
            // Frozen pose: the knot stops rotating, the camera stops orbiting.
            knot.rotation.set(0.6, 0.9, 0);
            camera.position.set(0.6, 1.6, 9.5);
            camera.lookAt(1.1, 0, 0);
            camera.updateMatrixWorld();

            await step(settle);
            const period = pass.upscaler.jitterPhaseCount ?? 0;
            if (!(period > 0)) throw new Error('jitter phase count unavailable');
            const count = 2 * period + 1;

            let first = await readOutput();
            const { w, h } = first;
            const n = w * h;
            const ringAlpha = new Array(period);
            const ringLuma = new Array(period);
            const aSum = new Float64Array(n), aSq = new Float64Array(n);
            const aMin = new Float32Array(n).fill(Infinity), aMax = new Float32Array(n).fill(-Infinity);
            const lSum = new Float64Array(n), lSq = new Float64Array(n);
            const consecutiveA = new Float64Array(n), consecutiveL = new Float64Array(n);
            const phaseA = new Float64Array(n), phaseL = new Float64Array(n);
            let maxStep = new Float32Array(n);
            let previous = first;
            let consecutivePairs = 0;
            let phasePairs = 0;
            // Per-frame image means: a drifting series (rather than a flat one
            // with per-frame noise) points at an unsettled accumulator.
            const series = [];
            for (let k = 0; k < count; k++) {
                const frame = k === 0 ? first : (await step(1), await readOutput());
                const { alpha, luma } = frame;
                let frameA = 0, frameL = 0;
                for (let i = 0; i < n; i++) { frameA += alpha[i]; frameL += luma[i]; }
                series.push({ alpha: frameA / n, luma: frameL / n });
                for (let i = 0; i < n; i++) {
                    const a = alpha[i];
                    aSum[i] += a; aSq[i] += a * a;
                    if (a < aMin[i]) aMin[i] = a;
                    if (a > aMax[i]) aMax[i] = a;
                    lSum[i] += luma[i]; lSq[i] += luma[i] * luma[i];
                }
                if (k > 0) {
                    consecutivePairs++;
                    for (let i = 0; i < n; i++) {
                        const da = Math.abs(alpha[i] - previous.alpha[i]);
                        consecutiveA[i] += da;
                        if (da > maxStep[i]) maxStep[i] = da;
                        consecutiveL[i] += Math.abs(luma[i] - previous.luma[i]);
                    }
                }
                const slot = k % period;
                if (k >= period) {
                    phasePairs++;
                    const oa = ringAlpha[slot], ol = ringLuma[slot];
                    for (let i = 0; i < n; i++) {
                        phaseA[i] += Math.abs(alpha[i] - oa[i]);
                        phaseL[i] += Math.abs(luma[i] - ol[i]);
                    }
                }
                ringAlpha[slot] = alpha;
                ringLuma[slot] = luma;
                previous = frame;
            }

            const meanA = new Float32Array(n), rangeA = new Float32Array(n);
            // Relative flicker (std / mean) puts alpha and luma on one scale: with
            // a zero-alpha black background the color is effectively
            // premultiplied, so coverage flicker shared by both channels shows
            // up equally in each, while alpha-only churn shows up in alpha alone.
            const acc = (label) => ({ label, pixels: 0, consA: 0, phaseA: 0, stdA: 0, meanA: 0, consL: 0, phaseL: 0, stdL: 0, swingPixels: 0, relPixels: 0, relA: 0, relL: 0 });
            const all = acc('all'), coverage = acc('coverage');
            for (let i = 0; i < n; i++) {
                const ma = aSum[i] / count;
                const sa = Math.sqrt(Math.max(aSq[i] / count - ma * ma, 0));
                const ml = lSum[i] / count;
                const sl = Math.sqrt(Math.max(lSq[i] / count - ml * ml, 0));
                meanA[i] = ma;
                rangeA[i] = aMax[i] - aMin[i];
                const isCoverage = (ma > 0.02 && ma < 0.98) || maxStep[i] > 0.02;
                for (const bucket of isCoverage ? [all, coverage] : [all]) {
                    bucket.pixels++;
                    bucket.consA += consecutiveA[i] / consecutivePairs;
                    bucket.phaseA += phaseA[i] / phasePairs;
                    bucket.stdA += sa;
                    bucket.meanA += ma;
                    bucket.consL += consecutiveL[i] / consecutivePairs;
                    bucket.phaseL += phaseL[i] / phasePairs;
                    bucket.stdL += sl;
                    if (rangeA[i] > 0.25) bucket.swingPixels++;
                    if (ma > 0.05 && ml > 1.0e-3) {
                        bucket.relPixels++;
                        bucket.relA += sa / ma;
                        bucket.relL += sl / ml;
                    }
                }
            }
            const finish = (b) => ({
                pixels: b.pixels,
                alpha: {
                    consecutive255: (255 * b.consA) / b.pixels,
                    samePhase255: (255 * b.phaseA) / b.pixels,
                    temporalStd255: (255 * b.stdA) / b.pixels,
                    mean: b.meanA / b.pixels,
                    swingOver025Pixels: b.swingPixels,
                    relativeStd: b.relA / Math.max(b.relPixels, 1),
                },
                luma: {
                    consecutive255: (255 * b.consL) / b.pixels,
                    samePhase255: (255 * b.phaseL) / b.pixels,
                    temporalStd255: (255 * b.stdL) / b.pixels,
                    relativeStd: b.relL / Math.max(b.relPixels, 1),
                },
            });
            // The worst-swinging pixels, traced over one more jitter cycle (the
            // orbit is periodic once settled, so this cycle is representative).
            const worstIndices = Array.from(rangeA.keys())
                .sort((a, b) => rangeA[b] - rangeA[a])
                .slice(0, 6);
            const worst = worstIndices.map((i) => ({ x: i % w, y: Math.floor(i / w), alpha: [], luma: [] }));
            for (let k = 0; k < period; k++) {
                await step(1);
                const frame = await readOutput();
                worstIndices.forEach((i, j) => {
                    worst[j].alpha.push(Number(frame.alpha[i].toFixed(3)));
                    worst[j].luma.push(Number(frame.luma[i].toFixed(3)));
                });
            }
            return {
                width: w,
                height: h,
                period,
                worst,
                frames: count,
                series,
                all: finish(all),
                coverage: finish(coverage),
                alphaMeanPng: await png(w, h, meanA),
                alphaRangePng: await png(w, h, rangeA),
            };
        },
    };
    return true;
})()
`;

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
            await waitForUrl(baseUrl, 1);
        } catch {
            viteServer = spawnVite('examples/vite.config.ts', server);
            await waitForServer(baseUrl, { child: viteServer });
        }

        profile = join(tmpdir(), `upscaler-alpha-convergence-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-automation',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${width},${height}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        // A busy debugging port may answer from somebody else's browser. Do not
        // create a page or later close it until our unique profile is confirmed.
        const version = await fetch(`${cdpBase}/json/version`).then((r) => r.json());
        const identity = new CdpClient(version.webSocketDebuggerUrl);
        try {
            const command = await identity.call('Browser.getBrowserCommandLine');
            if (!command.arguments.includes(`--user-data-dir=${profile}`))
                throw new Error(`Chrome debugging port ${port} belongs to another browser. Choose another --port.`);
        } finally {
            identity.close();
        }
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log:${entry.level}] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        client.on('Runtime.consoleAPICalled', ({ type, args }) => {
            if (type === 'error' || type === 'warning')
                logRecords.push(`[console:${type}] ${args.map((a) => a.value ?? a.description).join(' ')}`);
        });
        await Promise.all([
            client.call('Page.enable'),
            client.call('Runtime.enable'),
            client.call('Log.enable'),
        ]);
        await client.call('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await client.call('Page.navigate', { url: new URL('/15-transparent-canvas/', baseUrl).href });
        for (let attempt = 0; ; attempt++) {
            const ready = await evaluate(client, 'Boolean(window.__transparentCanvasExample)');
            if (ready === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__transparentCanvasExample.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        // Let the page finish settling (first frames, late resizes) before the
        // meter takes over the loop.
        await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
        await evaluate(client, PAGE_METER);
        const result = await evaluate(
            client,
            `window.__alphaMeter.run(${JSON.stringify({ ratio, settle, sharpness, path, runtimeSettings })})`,
        );
        await writeFile(join(outputDirectory, 'alpha-mean.png'), Buffer.from(result.alphaMeanPng, 'base64'));
        await writeFile(join(outputDirectory, 'alpha-range.png'), Buffer.from(result.alphaRangePng, 'base64'));
        delete result.alphaMeanPng;
        delete result.alphaRangePng;
        const summary = { label, path, ratio, settle, sharpness, runtimeSettings, ...result, logRecords };
        await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));

        const line = (name, bucket) =>
            `${name.padEnd(9)} px ${String(bucket.pixels).padStart(7)} | alpha consec ${bucket.alpha.consecutive255.toFixed(3)}` +
            ` same-phase ${bucket.alpha.samePhase255.toFixed(3)} std ${bucket.alpha.temporalStd255.toFixed(3)}` +
            ` swing>0.25 ${bucket.alpha.swingOver025Pixels} mean ${bucket.alpha.mean.toFixed(3)}` +
            ` rel-std ${bucket.alpha.relativeStd.toFixed(3)}` +
            ` | luma consec ${bucket.luma.consecutive255.toFixed(3)} same-phase ${bucket.luma.samePhase255.toFixed(3)}` +
            ` rel-std ${bucket.luma.relativeStd.toFixed(3)}`;
        console.log(
            `${label} ${path} ${ratio}x  ${result.width}x${result.height}, settle ${settle}, ` +
                `${result.frames} frames (period ${result.period})`,
        );
        console.log(line('all', result.all));
        console.log(line('coverage', result.coverage));
        console.log(`artifacts: ${outputDirectory}`);
        if (logRecords.length) console.warn(`browser log records:\n${logRecords.join('\n')}`);
    } finally {
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
