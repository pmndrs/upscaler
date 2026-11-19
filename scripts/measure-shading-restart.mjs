#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Shading-change memory restart meter (NEXT-STEPS §14). The detector keeps a
 * per-block memory of recent means, which Upscaler zeroes when the detector is
 * re-enabled. This checks that a genuine step a few frames after such an event
 * still fires like one with mature memory.
 *
 * Three runs on a bench scenario with a light step (Q18 or Q16, step at 300).
 * Each reads the shading-change signal texture back exactly (r32float, half
 * render res) from the event frame to step + 3:
 * - mature: detector on throughout;
 * - toggle: detector off for --off frames, re-enabled --lead frames before the step;
 * - configure: Upscaler.configure() (same size, no explicit resetHistory)
 *   --lead frames before the step.
 * Per frame and scenario ROI it reports the firing share (v > 0.1) and mean v.
 *
 * Usage:
 *   node scripts/measure-shading-restart.mjs [--scenario Q18] [--ratio 2]
 *     [--step 300] [--lead 3] [--off 10] [--label after]
 *     [--url http://127.0.0.1:5199] [--port 9333]
 *
 * Starts the bench dev server on --url's port if nothing answers there. Writes
 * bench/results/raw/shading-restart/<label>-<scenario>-r<ratio>-lead<n>.json.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
const cli = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) cli[argv[index].slice(2)] = true;
    else cli[argv[index].slice(2)] = argv[++index];
}
if (cli.help) {
    console.log(`Usage: node scripts/measure-shading-restart.mjs [options]
  --scenario <id>   bench scenario with a light step (default Q18)
  --ratio <n>       upscale ratio (default 2)
  --step <frame>    the step frame (default 300)
  --lead <n>        frames between the re-enable/configure event and the step (default 3)
  --off <n>         frames the detector is off in the toggle run (default 10)
  --label <name>    output name prefix (default restart)
  --url <origin>    bench origin (default ${DEFAULT_BENCH_URL})
  --port <n>        Chrome DevTools (CDP) port (default 9333)`);
    process.exit(0);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9333;
const scenario = cli.scenario ?? 'Q18';
const ratio = Number(cli.ratio ?? 2);
const stepFrame = Number(cli.step ?? 300);
const lead = Number(cli.lead ?? 3);
const offFrames = Number(cli.off ?? 10);
const label = cli.label ?? 'restart';

//* CDP
class Cdp {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.logs = [];
        this.opened = new Promise((resolveOpen, rejectOpen) => {
            this.socket.addEventListener('open', resolveOpen, { once: true });
            this.socket.addEventListener('error', rejectOpen, { once: true });
        });
        this.socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const request = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
            } else if (message.method === 'Log.entryAdded') this.logs.push(`[log] ${message.params.entry.text}`);
            else if (message.method === 'Runtime.exceptionThrown')
                this.logs.push(`[exception] ${message.params.exceptionDetails.exception?.description}`);
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
    async evaluate(expression) {
        const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails)
            throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
        return response.result.value;
    }
}

// Page side: the bench's resolver wraps the production Upscaler (TS-private
// fields, as measure-drift-lag.mjs reads the scenario). The signal texture is
// copied to a buffer and thresholded per ROI.
const PAGE_HELPERS = `
window.__shadingRestart = {
  upscaler() { return window.__UPSCALER_BENCH__._context.pipeline.resolver._upscaler; },
  async read(rois) {
    // The GPU state lives on the engine-free core since the monorepo split.
    const up = this.upscaler()._core; const device = up._device; const texture = up._shadingSignal;
    const w = texture.width, h = texture.height, bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: w, height: h });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(buffer.getMappedRange().slice(0)); buffer.unmap(); buffer.destroy();
    const stride = bytesPerRow / 4; const out = {};
    for (const [name, [rx, ry, rw, rh]] of Object.entries(rois)) {
      const x0 = Math.floor(rx * w), y0 = Math.floor(ry * h);
      const x1 = Math.min(w, Math.ceil((rx + rw) * w)), y1 = Math.min(h, Math.ceil((ry + rh) * h));
      let n = 0, firing = 0, sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = values[y * stride + x]; n++; sum += v; if (v > 0.1) firing++; }
      out[name] = { firing: firing / n, mean: sum / n };
    }
    return out;
  },
};
true`;

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
        const executable = browserExecutable();
        profile = join(tmpdir(), `upscaler-shading-restart-${process.pid}-${Date.now()}`);
        chrome = spawn(
            executable,
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--window-size=1320,760',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        await waitForUrl(`http://127.0.0.1:${port}/json/version`);
        const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = new Cdp(target.webSocketDebuggerUrl);
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

        const eventFrame = stepFrame - lead;
        const results = {};
        for (const mode of ['mature', 'toggle', 'configure']) {
            const url = new URL(server.origin);
            url.searchParams.set('benchMode', 'capture');
            url.searchParams.set('scenario', scenario);
            url.searchParams.set('ratio', String(ratio));
            url.searchParams.set('width', '1280');
            url.searchParams.set('height', '720');
            await client.call('Page.navigate', { url: url.href });
            for (let attempt = 0; ; attempt++) {
                const ready = await client.evaluate('window.__UPSCALER_BENCH__?.ready === true').catch(() => false);
                if (ready === true) break;
                if (attempt > 300) throw new Error('Timed out waiting for window.__UPSCALER_BENCH__.');
                await new Promise((resolveWait) => setTimeout(resolveWait, 100));
            }
            await client.evaluate(PAGE_HELPERS);
            const rois = await client.evaluate('window.__UPSCALER_BENCH__._context.scenario.rois');
            const start = mode === 'toggle' ? eventFrame - offFrames - 1 : eventFrame - 1;
            // Canonical capture settings + deterministic reset, stepped to `start`.
            await client.evaluate(`window.__UPSCALER_BENCH__.capture({ frame: ${start}, debugView: 'final' })`);
            const rows = [];
            for (let frame = start + 1; frame <= stepFrame + 3; frame++) {
                if (mode === 'toggle' && frame === start + 1)
                    await client.evaluate('__shadingRestart.upscaler().settings.detectShadingChanges = false');
                if (mode === 'toggle' && frame === eventFrame)
                    await client.evaluate('__shadingRestart.upscaler().settings.detectShadingChanges = true');
                if (mode === 'configure' && frame === eventFrame)
                    await client.evaluate(`(() => {
                        const up = __shadingRestart.upscaler();
                        up.configure({ displayWidth: up.displayWidth, displayHeight: up.displayHeight, customUpscaleRatio: ${ratio}, path: 'temporal' });
                        return true;
                    })()`);
                await client.evaluate(`window.__UPSCALER_BENCH__.step(${frame})`);
                if (frame >= eventFrame)
                    rows.push({ frame, regions: await client.evaluate(`__shadingRestart.read(${JSON.stringify(rois)})`) });
            }
            results[mode] = rows;
            console.log(`\n${label} ${scenario} ${ratio}x ${mode} (event f${eventFrame}, step f${stepFrame})`);
            for (const { frame, regions } of rows)
                console.log(
                    `  f${frame}: ` +
                        Object.entries(regions)
                            .map(([name, value]) => `${name} ${(100 * value.firing).toFixed(2)}%/${value.mean.toFixed(3)}`)
                            .join('  '),
                );
        }
        const outputDirectory = join(ROOT, 'bench/results/raw/shading-restart');
        await mkdir(outputDirectory, { recursive: true });
        const output = join(outputDirectory, `${label}-${scenario}-r${ratio}-lead${lead}.json`);
        await writeFile(
            output,
            JSON.stringify({ scenario, ratio, stepFrame, lead, offFrames, results, logRecords: client.logs }, null, 2),
        );
        console.log(`\nartifacts: ${output}`);
        const problems = client.logs.filter((record) => /error|exception|validation|WGSL/i.test(record));
        if (problems.length) console.warn(`browser log records:\n${problems.join('\n')}`);
    } finally {
        client?.socket.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
