#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Forced conditioning-exposure step meter (issue #99): how far the temporal
 * output leaves the image when only the CONDITIONING exposure changes. Scene,
 * camera and jitter stay identical, and the exposure is divided back out
 * before display, so an ideal accumulator shows no change at all.
 *
 * Per step `E0>E1` (fixed exposure, auto-exposure off):
 * - reference run: E1 from frame 0;
 * - step run: E0 for --settle frames, then E1 for --frames more.
 * Every frame from the step on, the upscaler OUTPUT (rgba16float, display res,
 * linear, before presentation) is read back exactly and compared with the
 * reference's same frame (same jitter phase):
 * - bias: mean output luma / mean reference luma − 1 (a brightness pop, signed);
 * - relErr: mean |Δluma| / mean reference luma;
 * - pop10: share of pixels whose luma is off by more than 10 %;
 * - hot: pixels above 4× the reference frame's maximum (a correction that
 *   rescales history must not push it into tonemapInvert's cap, issue #118);
 * - settled: the first frame from which |bias| stays under 0.5 %.
 * `floor` is the last pre-step frame against the reference: how much the two
 * conditioning values differ once both are converged.
 *
 * Usage:
 *   node scripts/measure-exposure-step.mjs [--scenario Q12] [--ratio 2]
 *     [--steps '1>4;4>1;1>1.1'] [--settle 180] [--frames 48]
 *     [--variant production] [--label baseline]
 *     [--url http://127.0.0.1:5199] [--port 9333]
 *
 * Starts the bench dev server on --url's port if nothing answers there. Writes
 * summary.json under bench/results/raw/exposure-step/<label>-<scenario>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const USAGE = `Usage: node scripts/measure-exposure-step.mjs [options]
  --scenario <id>      still bench scenario (default Q12)
  --ratio <n>          upscale ratio (default 2)
  --steps <list>       ';'-separated E0>E1 fixed-exposure steps (default 1>4;4>1;1>1.1)
  --settle <n>         frames at E0 before the step (default 180)
  --frames <n>         frames measured after the step (default 48)
  --variant <id>       bench resolver variant (default production)
  --label <name>       output folder prefix (default baseline)
  --url <origin>       bench origin (default ${DEFAULT_BENCH_URL}); started if absent
  --port <n>           Chrome DevTools (CDP) port (default 9333)
Writes bench/results/raw/exposure-step/<label>-<scenario>-<ratio>x/summary.json.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['scenario', 'ratio', 'steps', 'settle', 'frames', 'variant', 'label', 'url', 'port'],
    USAGE,
);
const scenario = String(cli.scenario ?? 'Q12');
const ratio = Number(cli.ratio ?? 2);
const steps = String(cli.steps ?? '1>4;4>1;1>1.1').split(';').map((step) => {
    const [from, to] = step.split('>').map(Number);
    if (!(from > 0 && to > 0)) throw new Error(`Invalid step ${step}`);
    return { step, from, to };
});
const settle = Number(cli.settle ?? 180);
const frames = Number(cli.frames ?? 48);
const variant = typeof cli.variant === 'string' ? cli.variant : null;
const label = cli.label ?? 'baseline';
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const outputDirectory = join(
    ROOT,
    'bench/results/raw/exposure-step',
    `${label}-${scenario}-${String(ratio).replace('.', '_')}x`,
);

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

    // rgba16float only: the output and the exposure guide are.
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
    async function lumaOf(threeTexture) {
        const { w, h, raw, stride } = await read(threeTexture);
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const o = y * stride + x * 4;
                out[y * w + x] = 0.2126 * halfTable[raw[o]] + 0.7152 * halfTable[raw[o + 1]] + 0.0722 * halfTable[raw[o + 2]];
            }
        return out;
    }
    function compare(out, ref) {
        let refMax = 0;
        for (let i = 0; i < ref.length; i++) if (ref[i] > refMax) refMax = ref[i];
        let sumOut = 0, sumRef = 0, sumAbs = 0, pop = 0, hot = 0, nonFinite = 0;
        for (let i = 0; i < ref.length; i++) {
            const o = out[i], r = ref[i];
            if (!Number.isFinite(o)) { nonFinite++; continue; }
            sumOut += o; sumRef += r; sumAbs += Math.abs(o - r);
            if (Math.abs(o - r) > 0.1 * Math.max(r, 1e-3)) pop++;
            if (o > 4 * refMax) hot++;
        }
        return {
            bias: sumOut / Math.max(sumRef, 1e-9) - 1,
            relErr: sumAbs / Math.max(sumRef, 1e-9),
            pop10: pop / ref.length,
            hot,
            nonFinite,
        };
    }

    window.__exposureStep = async ({ from, to, settle, frames }) => {
        // Reference: E1 throughout; only the measured frames are kept.
        const reference = new Map();
        await api.capture({ frame: 0, debugView: 'final', settings: { autoExposure: false, exposure: to } });
        for (let frame = 1; frame <= settle + frames; frame++) {
            await api.step(frame);
            if (frame >= settle) reference.set(frame, await lumaOf(upscaler.outputTexture));
        }
        // Step run: E0, then E1 from frame settle + 1 on.
        await api.capture({ frame: 0, debugView: 'final', settings: { autoExposure: false, exposure: from } });
        const rows = [];
        let floor = null;
        for (let frame = 1; frame <= settle + frames; frame++) {
            if (frame === settle + 1) pipeline.resolver.settings.exposure = to;
            await api.step(frame);
            if (frame < settle) continue;
            const row = { frame: frame - settle, ...compare(await lumaOf(upscaler.outputTexture), reference.get(frame)) };
            if (frame === settle) floor = row;
            else rows.push(row);
        }
        const exposure = await read(upscaler.guides.exposure);
        return { floor, rows, period: upscaler.jitterPhaseCount, exposure: halfTable[exposure.raw[0]] };
    };
    return true;
})()
`;

//* Analysis
const pct = (value) => `${(value * 100).toFixed(2)}%`;

function summarize(step, result) {
    const rows = result.rows;
    let settledAt = 1;
    for (let index = rows.length - 1; index >= 0; index--) {
        if (Math.abs(rows[index].bias) >= 0.005) {
            settledAt = index + 1 < rows.length ? rows[index + 1].frame : null;
            break;
        }
    }
    return {
        step,
        exposure: result.exposure,
        floor: result.floor,
        peakBias: rows.reduce((peak, row) => (Math.abs(row.bias) > Math.abs(peak) ? row.bias : peak), 0),
        peakRelErr: Math.max(...rows.map((row) => row.relErr)),
        meanRelErr: rows.reduce((sum, row) => sum + row.relErr, 0) / rows.length,
        peakPop10: Math.max(...rows.map((row) => row.pop10)),
        hot: rows.reduce((sum, row) => sum + row.hot, 0),
        nonFinite: rows.reduce((sum, row) => sum + row.nonFinite, 0),
        settledAt,
        rows,
    };
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-exposure-step-'));
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
        url.searchParams.set('scenario', scenario);
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
        for (const { step, from, to } of steps) {
            const result = await evaluate(
                client,
                `window.__exposureStep(${JSON.stringify({ from, to, settle, frames })})`,
            );
            const summary = summarize(step, result);
            results.push(summary);
            console.log(
                `${label} ${variant ?? 'production'} ${scenario} ${ratio}x step ${step}: ` +
                    `floor ${pct(summary.floor.relErr)}, peak bias ${pct(summary.peakBias)}, ` +
                    `peak relErr ${pct(summary.peakRelErr)}, mean relErr ${pct(summary.meanRelErr)}, ` +
                    `peak pop>10% ${pct(summary.peakPop10)}, hot ${summary.hot}, nonFinite ${summary.nonFinite}, ` +
                    `|bias| < 0.5% from frame ${summary.settledAt ?? 'never'}`,
            );
            console.log(`  bias by frame: ${summary.rows.slice(0, 12).map((row) => `${row.frame}:${pct(row.bias)}`).join(' ')}`);
        }
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
            join(outputDirectory, 'summary.json'),
            `${JSON.stringify({ label, scenario, ratio, variant, settle, frames, results, logRecords }, null, 2)}\n`,
        );
        if (logRecords.some((record) => /error|exception|validation|warning/i.test(record)))
            console.warn(`\nbrowser log:\n${logRecords.join('\n')}`);
        console.log(`artifacts: ${outputDirectory}`);
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
