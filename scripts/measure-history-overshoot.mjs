#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * History-resample overshoot meter (issue #118): isolated output pixels far
 * brighter than anything in the input while the camera moves over a dim HDR
 * frame with auto-exposure on.
 *
 * Drives bench scenario Q20 (a dim textured wall with radiance 11 / 16 hot
 * spots of 1–8 render px; auto-exposure lifts the frame so the spots condition
 * near 1 in the invertible tonemap — under a slow then a fast lateral pan) and
 * reads back, every frame, exactly:
 * - the upscaler OUTPUT (rgba16float, display res, linear — before any
 *   presentation), and the jittered INPUT color (render res, linear);
 * - the accumulated HISTORY (rgb in conditioned tonemap space): texels whose
 *   max channel reaches tonemapInvert's 0.999 cap, i.e. the ones that decode
 *   to ~1000 / exposure.
 *
 * "Hot" = output luma above --hot-factor (4) × the still segment's output max
 * (the issue's definition). Reported per Q20 segment: mean / max hot pixels
 * per frame, max output luma, max input luma, saturated history texels.
 *
 * Each condition is a RuntimeSettings JSON merged over the capture defaults;
 * `auto` and `fixed` are shorthands for {"autoExposure":true} and
 * {"autoExposure":false,"exposure":1}.
 *
 * Usage:
 *   node scripts/measure-history-overshoot.mjs [--conditions 'auto;fixed'] [--ratio 2]
 *     [--variant production] [--label baseline] [--hot-factor 4]
 *     [--url http://127.0.0.1:5199] [--port 9333]
 *
 * Starts the bench dev server on --url's port if nothing answers there. Writes
 * summary.json under bench/results/raw/history-overshoot/<label>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseCliOrExit } from './cli-flags.mjs';
import {
    DEFAULT_BENCH_URL,
    parsePort,
    closeOwnedCdpBrowser,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');

//* CLI
const USAGE = `Usage: node scripts/measure-history-overshoot.mjs [options]
  --conditions <list>  ';'-separated: auto | fixed | a RuntimeSettings JSON (default auto;fixed)
  --ratio <n>          upscale ratio (default 2)
  --variant <id>       bench resolver variant (default production)
  --hot-factor <n>     hot = output luma above n × the still segment's max (default 4)
  --label <name>       output folder prefix (default baseline)
  --url <origin>       bench origin (default ${DEFAULT_BENCH_URL}); started if absent
  --port <n>           Chrome DevTools (CDP) port (default 9333)
Writes bench/results/raw/history-overshoot/<label>-<ratio>x/summary.json.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['conditions', 'ratio', 'variant', 'hot-factor', 'label', 'url', 'port'],
    USAGE,
);
const conditions = String(cli.conditions ?? 'auto;fixed').split(';');
const ratio = Number(cli.ratio ?? 2);
const variant = typeof cli.variant === 'string' ? cli.variant : null;
const hotFactor = Number(cli['hot-factor'] ?? 4);
const label = cli.label ?? 'baseline';
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const outputDirectory = join(
    ROOT,
    'bench/results/raw/history-overshoot',
    `${label}-${String(ratio).replace('.', '_')}x`,
);

const { Q20_SEGMENTS, BENCHMARK_SCENARIOS } = await import(
    pathToFileURL(join(ROOT, 'bench/src/benchmark/scenarios.ts')).href
);
const END_FRAME = BENCHMARK_SCENARIOS.Q20.endFrame;
const STILL = Q20_SEGMENTS.find((segment) => segment.name === 'still');

function settingsFor(condition) {
    if (condition === 'auto') return { autoExposure: true };
    if (condition === 'fixed') return { autoExposure: false, exposure: 1 };
    return JSON.parse(condition);
}

//* In-page meter
// Decoding and reductions stay in the page; only per-frame scalars cross.
const PAGE_METER = /* js */ `
(() => {
    const api = window.__UPSCALER_BENCH__;
    const { renderer, pipeline } = api._context;
    const upscaler = pipeline.resolver._upscaler;
    const device = renderer.backend.device;
    const halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1;
        const e = (h >> 10) & 0x1f;
        const f = h & 0x3ff;
        halfTable[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
    }

    // rgba16float only: every texture read here is one.
    async function read(threeTexture) {
        const texture = renderer.backend.get(threeTexture).texture;
        if (texture.format !== 'rgba16float') throw new Error('unexpected format ' + texture.format);
        const w = texture.width;
        const h = texture.height;
        const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const raw = new Uint16Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        buffer.destroy();
        return { w, h, raw, stride: bytesPerRow / 2 };
    }

    function reduce(img, fn) {
        for (let y = 0; y < img.h; y++)
            for (let x = 0; x < img.w; x++) {
                const o = y * img.stride + x * 4;
                fn(halfTable[img.raw[o]], halfTable[img.raw[o + 1]], halfTable[img.raw[o + 2]], x, y);
            }
    }
    const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

    window.__overshootMeter = async ({ settings, endFrame, stillStart, stillEnd, hotFactor }) => {
        await api.capture({ frame: 0, debugView: 'final', settings });
        const inputTexture = pipeline._renderTarget.textures[0];
        let stillMax = 0;
        const frames = [];
        for (let frame = 1; frame <= endFrame; frame++) {
            await api.step(frame);
            const out = await read(upscaler.outputTexture);
            const inp = await read(inputTexture);
            const hist = await read(upscaler.guides.history);
            const exposure = upscaler.guides.exposure ? await read(upscaler.guides.exposure) : null;
            let outMax = 0;
            let nonFinite = 0;
            const lumas = new Float32Array(out.w * out.h);
            reduce(out, (r, g, b, x, y) => {
                const l = luma(r, g, b);
                if (!Number.isFinite(l)) nonFinite++;
                lumas[y * out.w + x] = l;
                if (l > outMax) outMax = l;
            });
            let inMax = 0;
            reduce(inp, (r, g, b) => { const l = luma(r, g, b); if (l > inMax) inMax = l; });
            // History texels at/over tonemapInvert's cap decode to ~1000 / exposure.
            let saturated = 0;
            let historyMax = 0;
            reduce(hist, (r, g, b) => {
                const m = Math.max(r, g, b);
                if (m > historyMax) historyMax = m;
                if (m >= 0.999) saturated++;
            });
            if (frame >= stillStart && frame <= stillEnd && outMax > stillMax) stillMax = outMax;
            let hot = 0;
            if (frame > stillEnd) {
                const threshold = hotFactor * stillMax;
                for (const l of lumas) if (l > threshold) hot++;
            }
            frames.push({
                frame, outMax, inMax, hot, nonFinite, saturated, historyMax,
                exposure: exposure ? halfTable[exposure.raw[0]] : null,
            });
        }
        return {
            stillMax,
            period: upscaler.jitterPhaseCount,
            render: [upscaler.renderWidth, upscaler.renderHeight],
            display: [upscaler.displayWidth, upscaler.displayHeight],
            frames,
        };
    };
    return true;
})()
`;

//* Analysis
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

function summarize(result) {
    return Q20_SEGMENTS.map((segment) => {
        const rows = result.frames.filter((row) => row.frame >= segment.start && row.frame <= segment.end);
        return {
            segment: segment.name,
            hotMean: mean(rows.map((row) => row.hot)),
            hotMax: Math.max(...rows.map((row) => row.hot)),
            hotFrames: rows.filter((row) => row.hot > 0).length,
            frames: rows.length,
            outMax: Math.max(...rows.map((row) => row.outMax)),
            inMax: Math.max(...rows.map((row) => row.inMax)),
            saturatedMean: mean(rows.map((row) => row.saturated)),
            historyMax: Math.max(...rows.map((row) => row.historyMax)),
            exposure: rows.at(-1)?.exposure ?? null,
            nonFinite: rows.reduce((a, row) => a + row.nonFinite, 0),
        };
    });
}

//* CDP
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
        const response = new Promise((resolveCall, rejectCall) =>
            this.pending.set(id, { resolve: resolveCall, reject: rejectCall }),
        );
        this.socket.send(JSON.stringify({ id, method, params }));
        return response;
    }
    on(method, listener) {
        this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    }
    close() {
        this.socket.close();
    }
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

//* Main
const format = (value) =>
    value === null ? '-' : Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(3);

async function main() {
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-history-overshoot-'));
        chrome = spawn(
            browserExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--window-size=1320,760',
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
        client.on('Log.entryAdded', ({ entry }) => {
            if (!/favicon/.test(entry.url ?? '')) logRecords.push(`[${entry.level}] ${entry.text}`);
        });
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', 'Q20');
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', '1280');
        url.searchParams.set('height', '720');
        if (variant) url.searchParams.set('variant', variant);
        await client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            if ((await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true')) === true) break;
            if (attempt > 300)
                throw new Error(`Timed out waiting for window.__UPSCALER_BENCH__.\n${logRecords.join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        await evaluate(client, PAGE_METER);

        const results = [];
        for (const condition of conditions) {
            const settings = settingsFor(condition);
            const result = await evaluate(
                client,
                `window.__overshootMeter(${JSON.stringify({
                    settings,
                    endFrame: END_FRAME,
                    stillStart: Math.floor(STILL.end / 2),
                    stillEnd: STILL.end,
                    hotFactor,
                })})`,
            );
            const segments = summarize(result);
            results.push({ condition, settings, stillMax: result.stillMax, segments, frames: result.frames });
            console.log(
                `\n${label} ${variant ?? 'production'} Q20 ${ratio}x ${condition}: still output max ` +
                    `${format(result.stillMax)}, hot > ${format(hotFactor * result.stillMax)}`,
            );
            console.log(
                'segment'.padEnd(10) +
                    'hot/frame  hotMax  hotFrames  outMax   inMax   satHist  histMax  exposure  nonFinite',
            );
            for (const row of segments)
                console.log(
                    row.segment.padEnd(10) +
                        format(row.hotMean).padStart(9) +
                        String(row.hotMax).padStart(8) +
                        `${row.hotFrames}/${row.frames}`.padStart(11) +
                        format(row.outMax).padStart(8) +
                        format(row.inMax).padStart(8) +
                        format(row.saturatedMean).padStart(9) +
                        format(row.historyMax).padStart(9) +
                        format(row.exposure).padStart(10) +
                        String(row.nonFinite).padStart(11),
                );
        }
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
            join(outputDirectory, 'summary.json'),
            `${JSON.stringify({ label, ratio, variant, hotFactor, results, logRecords }, null, 2)}\n`,
        );
        if (logRecords.some((record) => /error|exception|validation|warning/i.test(record)))
            console.warn(`\nbrowser log:\n${logRecords.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        // On Windows the browser can outlive its launcher process, so close it over CDP first.
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
