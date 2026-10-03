#!/usr/bin/env node
/**
 * Sub-pixel emitter retention meter (issue #51): does an emitter smaller than
 * one render pixel converge to its coverage, or does the temporal resolve drop
 * it on the jitter phases that miss it?
 *
 * Drives bench scenario Q17 (still camera, unlit discs of 0.3–1.5 render-px
 * diameter and 0.5 px lines, over black and over a textured backdrop, each
 * either floating in front of a far background or as a decal just in front of
 * a backdrop plane) and, per frame, reads back:
 * - the upscaler OUTPUT (display res, linear — before any presentation), and
 * - the jittered INPUT color (render res, linear),
 * plus the lock lifetime, disocclusion and shading-change guides.
 *
 * Per emitter window (±5 render px around the projected disc centre; lines use
 * a band over their middle 80 %) it integrates luma energy minus the same
 * window from an emitters-hidden run, so the backdrop cancels. The reference
 * is the input itself: the mean input energy over the measured frames × the
 * display/render pixel-area ratio is what an ideal accumulator converges to
 * (the emitter's true supersampled coverage — "native" with infinite samples).
 *
 * Reported per group (background × depth × shape × radiance):
 * - retention: mean output energy / reference (1 = converged to coverage)
 * - flicker: temporal std-dev of output energy / reference
 * - phaseDrift: mean |E(t) − E(t + period)| / reference (non-periodic churn)
 * - hitRate: share of frames whose input carries the emitter
 * - lock / disocclusion / shadingChange: per-window max, averaged over frames
 *   (disocclusion and shading change as the share of frames > 0.5)
 * - ghostFrames / ghostEnergy: after the measured frames every emitter is
 *   hidden (a light switched off); frames until the output stays under 10 % of
 *   its lit level, and the leftover energy summed over --ghost frames, in
 *   frames of full lit output. The cost side of any miss-phase hold.
 *
 * Usage:
 *   node scripts/measure-emitter-retention.mjs [--ratio 2] [--settle 180]
 *     [--frames 64] [--ghost 48] [--label baseline] [--settings '{"autoExposure":false}']
 *     [--url http://127.0.0.1:5199] [--port 9333]
 *
 * Starts the bench dev server on --url's port if nothing answers there. Writes
 * summary.json under bench/results/raw/emitters/<label>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    console.log(`Usage: node scripts/measure-emitter-retention.mjs [options]
  --ratio <n>          upscale ratio (default 2)
  --settle <frames>    frames to step before measuring (default 180)
  --frames <n>         measured frames (default 64 = two ratio-2 jitter periods)
  --ghost <n>          frames recorded after the emitters switch off (default 48)
  --label <name>       output folder prefix (default baseline)
  --settings <json>    capture-setting overrides, e.g. '{"autoExposure":false}'
  --url <origin>       bench origin (default ${DEFAULT_BENCH_URL}); started if absent
  --port <n>           Chrome DevTools (CDP) port (default 9333)
Writes to bench/results/raw/emitters/<label>-<ratio>x/summary.json.`);
    process.exit(0);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const ratio = Number(cli.ratio ?? 2);
const settle = Number(cli.settle ?? 180);
const frames = Number(cli.frames ?? 64);
const ghost = Number(cli.ghost ?? 48);
const label = cli.label ?? 'baseline';
const port = parsePort(cli.port, '--port') ?? 9333;
const settings = typeof cli.settings === 'string' ? JSON.parse(cli.settings) : {};
const outputDirectory = join(ROOT, 'bench/results/raw/emitters', `${label}-${String(ratio).replace('.', '_')}x`);

//* In-page meter
// Everything heavy (half-float decode, window sums) stays in the page; only
// per-emitter time series cross the protocol.
const PAGE_METER = /* js */ `
(() => {
    const api = window.__UPSCALER_BENCH__;
    const { renderer, camera, bench, pipeline } = api._context;
    const upscaler = pipeline.resolver._upscaler;
    const device = renderer.backend.device;
    const halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1;
        const e = (h >> 10) & 0x1f;
        const f = h & 0x3ff;
        halfTable[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
    }

    // Reads channel 0..3 of any rgba16float / r32float / rgba8unorm / r16float
    // texture into Float32Arrays [r, g, b, a] (missing channels are 0).
    async function read(threeTexture) {
        const texture = renderer.backend.get(threeTexture).texture;
        const w = texture.width;
        const h = texture.height;
        const layout = {
            rgba16float: [8, 4, 'h'], r16float: [2, 1, 'h'], r32float: [4, 1, 'f'],
            rgba32float: [16, 4, 'f'], rgba8unorm: [4, 4, 'u'], r8unorm: [1, 1, 'u'],
        }[texture.format];
        if (!layout) throw new Error('unsupported readback format ' + texture.format);
        const [bpp, channels, kind] = layout;
        const bytesPerRow = Math.ceil((w * bpp) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        const aspect = texture.format.includes('depth') ? 'depth-only' : 'all';
        encoder.copyTextureToBuffer({ texture, aspect }, { buffer, bytesPerRow }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const out = [0, 1, 2, 3].map(() => new Float32Array(w * h));
        const view = kind === 'h' ? new Uint16Array(mapped) : kind === 'f' ? new Float32Array(mapped) : new Uint8Array(mapped);
        const stride = bytesPerRow / (kind === 'h' ? 2 : kind === 'f' ? 4 : 1);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const o = y * stride + x * channels;
                for (let c = 0; c < channels; c++) {
                    const raw = view[o + c];
                    out[c][y * w + x] = kind === 'h' ? halfTable[raw] : kind === 'u' ? raw / 255 : raw;
                }
            }
        buffer.unmap();
        buffer.destroy();
        return { w, h, ch: out };
    }

    const luma = (img, i) => Math.max(0.2126 * img.ch[0][i] + 0.7152 * img.ch[1][i] + 0.0722 * img.ch[2][i], 0);

    // Emitter windows in RENDER pixels, from the scene itself (unjittered
    // camera: the scenario frame is applied by capture()/step()).
    function windows() {
        const rw = upscaler.renderWidth;
        const rh = upscaler.renderHeight;
        const renderPixel = (2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360)) / rh;
        const list = [];
        const v = new camera.position.constructor();
        for (const mesh of bench.emitterScene.children) {
            if (!mesh.isMesh || mesh.geometry.type === 'PlaneGeometry' && mesh.position.z < 0) continue;
            v.copy(mesh.position).project(camera);
            const cx = (v.x * 0.5 + 0.5) * rw;
            const cy = (0.5 - v.y * 0.5) * rh;
            const radiance = mesh.material.color.r;
            const side = (cx < rw / 2 ? 'black' : 'textured') + (cy < rh / 2 ? ' floating' : ' decal');
            if (mesh.geometry.type === 'CircleGeometry') {
                const diameter = Math.round((mesh.scale.x / renderPixel) * 10) / 10;
                list.push({ group: side + ' disc ' + diameter + 'px L' + radiance, x0: Math.floor(cx - 5), x1: Math.floor(cx + 5), y0: Math.floor(cy - 5), y1: Math.floor(cy + 5) });
            } else {
                const half = (mesh.scale.x / renderPixel) * 0.4;
                list.push({ group: side + ' line 0.5px L' + radiance, x0: Math.floor(cx - half), x1: Math.floor(cx + half), y0: Math.floor(cy - 4), y1: Math.floor(cy + 4), line: true });
            }
        }
        return list;
    }

    function windowSum(img, win, scale, fn) {
        let sum = 0;
        let max = 0;
        for (let y = win.y0 * scale; y <= win.y1 * scale + scale - 1; y++)
            for (let x = win.x0 * scale; x <= win.x1 * scale + scale - 1; x++) {
                if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
                const value = fn(img, y * img.w + x);
                sum += value;
                if (value > max) max = value;
            }
        return { sum, max };
    }

    window.__emitterMeter = async ({ settle, frames, ghost, settings }) => {
        await api.capture({ frame: settle, debugView: 'final', settings });
        const wins = windows();
        const scale = Math.round(upscaler.displayWidth / upscaler.renderWidth);
        const area = (upscaler.displayWidth / upscaler.renderWidth) * (upscaler.displayHeight / upscaler.renderHeight);
        const inputTexture = pipeline._renderTarget.textures[0];
        const series = wins.map(() => ({ out: [], inp: [], lock: [], disocc: [], shading: [] }));
        for (let f = 1; f <= frames; f++) {
            await api.step(settle + f);
            const out = await read(upscaler.outputTexture);
            const inp = await read(inputTexture);
            const locks = await read(upscaler.guides.lockStatus);
            const masks = await read(upscaler.guides.disocclusion);
            const shading = upscaler.guides.shadingChange ? await read(upscaler.guides.shadingChange) : null;
            const scScale = shading ? inp.w / shading.w : 1;
            wins.forEach((win, k) => {
                series[k].out.push(windowSum(out, win, scale, luma).sum);
                series[k].inp.push(windowSum(inp, win, 1, luma).sum * area);
                series[k].lock.push(windowSum(locks, win, scale, (img, i) => img.ch[0][i]).max);
                series[k].disocc.push(windowSum(masks, win, 1, (img, i) => img.ch[0][i]).max);
                if (shading) {
                    const sw = { x0: Math.floor(win.x0 / scScale), x1: Math.floor(win.x1 / scScale), y0: Math.floor(win.y0 / scScale), y1: Math.floor(win.y1 / scScale) };
                    series[k].shading.push(windowSum(shading, sw, 1, (img, i) => img.ch[0][i]).max);
                }
            });
        }
        // Switch-off: the emitters vanish (a light turned off) and the output
        // should follow. Whatever history keeps showing is ghosting.
        const hidden = bench.emitterScene.children.filter((m) => m.isMesh && m.position.z === 0);
        hidden.forEach((m) => (m.visible = false));
        const bgOut = wins.map(() => 0);
        const bgIn = wins.map(() => 0);
        try {
            for (let f = 1; f <= ghost; f++) {
                await api.step(settle + frames + f);
                const out = await read(upscaler.outputTexture);
                wins.forEach((win, k) => (series[k].ghost ??= []).push(windowSum(out, win, scale, luma).sum));
            }
            // Background pass: same frames with every emitter hidden, so the
            // backdrop's own (converged) energy cancels out of each window.
            await api.capture({ frame: settle, debugView: 'final', settings });
            for (let f = 1; f <= frames; f++) {
                await api.step(settle + f);
                const out = await read(upscaler.outputTexture);
                const inp = await read(inputTexture);
                wins.forEach((win, k) => {
                    bgOut[k] += windowSum(out, win, scale, luma).sum / frames;
                    bgIn[k] += (windowSum(inp, win, 1, luma).sum * area) / frames;
                });
            }
        } finally {
            hidden.forEach((m) => (m.visible = true));
        }
        return {
            period: upscaler.jitterPhaseCount,
            render: [upscaler.renderWidth, upscaler.renderHeight],
            display: [upscaler.displayWidth, upscaler.displayHeight],
            emitters: wins.map((win, k) => ({ ...win, ...series[k], bgOut: bgOut[k], bgIn: bgIn[k] })),
        };
    };
    return true;
})()
`;

//* Analysis
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
const std = (values) => {
    const m = mean(values);
    return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};

function analyse(result) {
    const groups = new Map();
    for (const emitter of result.emitters) {
        const out = emitter.out.map((v) => v - emitter.bgOut);
        const inp = emitter.inp.map((v) => v - emitter.bgIn);
        const reference = mean(inp);
        if (!(reference > 1e-4)) continue;
        // Ghost: output left after the switch-off, relative to the lit output.
        const lit = mean(out);
        const ghost = (emitter.ghost ?? []).map((v) => (v - emitter.bgOut) / Math.max(lit, 1e-6));
        const settled = ghost.findIndex((v, t) => ghost.slice(t).every((w) => w < 0.1));
        const drift = [];
        for (let t = 0; t + result.period < out.length; t++) drift.push(Math.abs(out[t] - out[t + result.period]));
        const peak = Math.max(...inp);
        const row = {
            retention: mean(out) / reference,
            flicker: std(out) / reference,
            phaseDrift: drift.length ? mean(drift) / reference : null,
            hitRate: mean(inp.map((v) => (v > 0.1 * peak ? 1 : 0))),
            lock: mean(emitter.lock),
            disocclusion: mean(emitter.disocc.map((v) => (v > 0.5 ? 1 : 0))),
            shadingChange: emitter.shading.length ? mean(emitter.shading.map((v) => (v > 0.5 ? 1 : 0))) : null,
            // Frames until the output stays under 10 % of its lit level, and the
            // ghost's integral in frames of full lit output.
            ghostFrames: ghost.length ? (settled < 0 ? ghost.length : settled) : null,
            ghostEnergy: ghost.length ? ghost.reduce((a, b) => a + Math.max(b, 0), 0) : null,
        };
        if (!groups.has(emitter.group)) groups.set(emitter.group, []);
        groups.get(emitter.group).push(row);
    }
    const summary = {};
    for (const [group, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
        summary[group] = { count: rows.length };
        for (const key of Object.keys(rows[0]))
            summary[group][key] = rows[0][key] === null ? null : mean(rows.map((row) => row[key]));
    }
    return summary;
}

//* CDP plumbing (subset of run-benchmark.mjs)
function chromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH.');
    return executable;
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
        const response = new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolve: resolveCall, reject: rejectCall }));
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
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
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
        profile = join(tmpdir(), `upscaler-emitters-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
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
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', 'Q17');
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', '1280');
        url.searchParams.set('height', '720');
        await client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            if ((await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true')) === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__UPSCALER_BENCH__.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        await evaluate(client, PAGE_METER);
        const result = await evaluate(
            client,
            `window.__emitterMeter(${JSON.stringify({ settle, frames, ghost, settings })})`,
        );
        const groups = analyse(result);
        // One raw (background-subtracted) series per group, for inspection.
        const samples = {};
        for (const emitter of result.emitters)
            samples[emitter.group] ??= {
                output: emitter.out.map((v) => +(v - emitter.bgOut).toFixed(4)),
                input: emitter.inp.map((v) => +(v - emitter.bgIn).toFixed(4)),
                lock: emitter.lock.map((v) => +v.toFixed(3)),
            };
        await writeFile(join(outputDirectory, 'series.json'), JSON.stringify(samples));
        await writeFile(
            join(outputDirectory, 'summary.json'),
            JSON.stringify({ label, ratio, settle, frames, ghost, settings, period: result.period, groups, logRecords }, null, 2),
        );
        console.log(`${label} Q17 ${ratio}x (period ${result.period}, ${frames} frames after ${settle}):`);
        console.log('group'.padEnd(30) + 'n   retain  flicker drift   hit    lock   disocc shading ghostF ghostE');
        const f = (v) => (v === null ? '   -  ' : v.toFixed(3).padStart(6));
        for (const [group, row] of Object.entries(groups))
            console.log(
                group.padEnd(30) + String(row.count).padEnd(4) +
                    [row.retention, row.flicker, row.phaseDrift, row.hitRate, row.lock, row.disocclusion, row.shadingChange].map(f).join(' ') +
                    ` ${String(row.ghostFrames).padStart(6)} ${row.ghostEnergy === null ? '' : row.ghostEnergy.toFixed(2).padStart(6)}`,
            );
        console.log(`artifacts: ${outputDirectory}`);
        if (logRecords.some((record) => /error|exception|validation/i.test(record)))
            console.warn(`browser log records:\n${logRecords.join('\n')}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
