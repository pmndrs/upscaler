#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
/**
 * Dark-scene HDR highlight meter (issue #49). Drives bench/exposure-ceiling.html
 * over CDP: emissive squares at 0.25 / 1 / 4 / 16 / 64 linear in three sizes
 * (16 render px, 3 render px, 0.5 render px) on a flat background, temporal
 * path at 512² ratio 2, still camera. The rgba16float output is read back
 * exactly; no 8-bit capture can see these values.
 *
 * Each condition is one conditioning exposure: `auto` (auto-exposure, whatever
 * EXPOSURE_MAX the source has) or a fixed `settings.exposure`. A fixed value
 * is what auto-exposure produces when it pins at a cap of that value, so a
 * sweep emulates candidate caps without editing the shader.
 *
 * Reported per emitter, averaged over the last --average frames (one full
 * jitter cycle at ratio 2 by default):
 * - centre: output value at the emitter centre. For the 16 px squares native
 *   equals the level, so this reads the plateau ceiling + f16 quantization.
 * - energy: window sum above background. For the sub-pixel row native is the
 *   level × one display pixel.
 * - meteredTapMax: the brightest of the luminance pyramid's 32×32 taps on the
 *   render-res input (CPU mirror), i.e. what a highlight-keyed exposure sees.
 *
 * Usage:
 *   node scripts/measure-exposure-ceiling.mjs [--exposures auto,80,32,16,8,4,2,1]
 *     [--background 0] [--sharpness 0.8] [--frames 128] [--average 32]
 *     [--hide large,medium] [--label baseline] [--metering every-texel] [--port 9333]
 *     [--url http://127.0.0.1:5199]
 *
 * Starts the bench dev server on --url's port if nothing answers there.
 * Writes bench/results/raw/exposure-ceiling/<label>/summary.json.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

//* CLI
const USAGE = `Usage: node scripts/measure-exposure-ceiling.mjs [options]
  --exposures <list>     conditioning exposures, 'auto' or fixed values (default auto,80,32,16,8,4,2,1)
  --background <v>       linear background level (default 0)
  --sharpness <v>        RCAS sharpness (default 0.8)
  --frames <n>           frames to run per condition (default 128)
  --average <n>          trailing frames averaged per emitter (default 32)
  --hide <list>          emitter sizes to hide, e.g. large,medium (default none)
  --label <name>         output folder (default baseline)
  --metering <form>      bench-only exposure metering (NEXT-STEPS §17), e.g. every-texel
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); if nothing answers,
                         the bench dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
Writes bench/results/raw/exposure-ceiling/<label>/summary.json.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['exposures', 'background', 'sharpness', 'frames', 'average', 'hide', 'label', 'metering', 'url', 'port'],
    USAGE,
);
const exposures = String(cli.exposures ?? 'auto,80,32,16,8,4,2,1').split(',');
const background = Number(cli.background ?? 0);
const sharpness = Number(cli.sharpness ?? 0.8);
const frames = Number(cli.frames ?? 128);
const average = Number(cli.average ?? 32);
const hide = cli.hide ? String(cli.hide).split(',') : [];
const label = cli.label ?? 'baseline';
const metering = typeof cli.metering === 'string' ? cli.metering : null;
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const outputDirectory = join(ROOT, 'bench/results/raw/exposure-ceiling', label);

const chromeExecutable = () => browserExecutable();

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
    const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

//* Report
const format = (value) =>
    Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(3);

function printCondition(condition, result) {
    console.log(
        `\n${condition}: exposure ${format(result.exposure)}, metered tap max ` +
            `${format(result.meteredTapMax.min)}–${format(result.meteredTapMax.max)}, ` +
            `output max ${format(result.outputMax)}, non-finite ${result.nonFinite}`,
    );
    for (const size of [16, 3, 0.5]) {
        const rows = result.emitters.filter((row) => row.size === size && row.visible);
        if (rows.length === 0) continue;
        const cells = rows.map((row) =>
            size === 0.5
                ? `${row.level}→${format(row.energy)}/${format(row.nativeEnergy)}`
                : `${row.level}→${format(row.centre)}`,
        );
        const what = size === 0.5 ? 'energy out/native' : 'centre';
        console.log(`  ${String(size).padStart(3)} px ${what.padEnd(17)} ${cells.join('  ')}`);
    }
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

        profile = await mkdtemp(join(tmpdir(), 'upscaler-exposure-ceiling-'));
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--window-size=600,600',
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
        const page = new URL('/exposure-ceiling.html', server.origin);
        if (metering) page.searchParams.set('exposureMetering', metering);
        await client.call('Page.navigate', { url: page.href });
        for (let attempt = 0; ; attempt++) {
            if ((await evaluate(client, 'window.__exposureCeiling?.ready === true')) === true) break;
            if (attempt > 300) throw new Error(`Timed out waiting for the probe page.\n${logRecords.join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        const conditions = [];
        for (const condition of exposures) {
            const settings =
                condition === 'auto'
                    ? { sharpness, autoExposure: true }
                    : { sharpness, autoExposure: false, exposure: Number(condition) };
            const request = { background, settings, frames, average, hide };
            const result = await evaluate(client, `window.__exposureCeiling.run(${JSON.stringify(request)})`);
            printCondition(condition, result);
            conditions.push({ condition, request, ...result });
        }

        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
            join(outputDirectory, 'summary.json'),
            `${JSON.stringify({ background, sharpness, frames, average, hide, conditions, logRecords }, null, 2)}\n`,
        );
        if (logRecords.length) console.log(`\nbrowser log:\n${logRecords.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
