#!/usr/bin/env node
/**
 * Debug-view screenshots of one bench scenario per velocity source: the bench
 * in capture mode with `?velocity=three|motion-vectors`, one capture per
 * (source, frame, view), a canvas screenshot each, plus a side-by-side grid
 * per frame (top row three's `velocity`, bottom row @pmndrs/motion-vectors'
 * node). Built for Q21 (bench/docs/NEXT-STEPS.md §22); views must be declared
 * by the scenario.
 *
 * Usage:
 *   node scripts/capture-velocity-views.mjs [--scenario Q21] [--ratio 2]
 *     [--frames 110,180,300,410] [--views final,motion-vectors,disocclusion,accumulation-age]
 *     [--url http://127.0.0.1:5199] [--port 9336]
 *
 * Writes bench/results/raw/velocity-views/<scenario>-<ratio>x/<source>-f<frame>-<view>.png
 * and grid-f<frame>.png (rows: three, motion-vectors; columns: views).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { parseCliOrExit } from './cli-flags.mjs';
import { decodePng, encodePng } from './image-metrics.mjs';
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
const SOURCES = ['three', 'motion-vectors'];
const USAGE = `Usage: node scripts/capture-velocity-views.mjs [options]
  --scenario <id>   bench scenario (default Q21)
  --ratio <n>       upscale ratio (default 2)
  --frames <list>   captured frames (default 110,180,300,410)
  --views <list>    debug views (default final,motion-vectors,disocclusion,accumulation-age)
  --url <origin>    bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>        Chrome DevTools port (default 9336)`;
const cli = parseCliOrExit(process.argv.slice(2), ['scenario', 'ratio', 'frames', 'views', 'url', 'port'], USAGE);
const scenario = String(cli.scenario ?? 'Q21');
const ratio = String(cli.ratio ?? 2);
const frames = String(cli.frames ?? '110,180,300,410').split(',').map(Number);
const views = String(cli.views ?? 'final,motion-vectors,disocclusion,accumulation-age').split(',');
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9336;
const out = join(ROOT, 'bench/results/raw/velocity-views', `${scenario}-${ratio}x`);
const WIDTH = 1280;
const HEIGHT = 720;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Tiles same-size decoded screenshots into rows × columns at half resolution.
 * @param {{ width: number, height: number, bytesPerPixel: number, raw: Buffer }[][]} rows - decodePng results per row
 * @returns {Buffer} The grid as a PNG
 */
function grid(rows) {
    const w = rows[0][0].width >> 1;
    const h = rows[0][0].height >> 1;
    const columns = rows[0].length;
    const width = w * columns;
    const rgb = new Float32Array(width * h * rows.length * 3);
    rows.forEach((row, r) =>
        row.forEach((image, c) => {
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const src = (2 * y * image.width + 2 * x) * image.bytesPerPixel;
                    const dst = ((r * h + y) * width + c * w + x) * 3;
                    for (let k = 0; k < 3; k++) rgb[dst + k] = image.raw[src + k] / 255;
                }
        }),
    );
    return encodePng(rgb, width, h * rows.length);
}

async function main() {
    await mkdir(out, { recursive: true });
    let viteServer = null;
    let chrome = null;
    let profile = null;
    const problems = [];
    try {
        try {
            await waitForUrl(server.origin, { attempts: 1 });
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }
        profile = await mkdtemp(join(tmpdir(), 'upscaler-velocity-views-'));
        chrome = spawn(
            browserExecutable(),
            ['--headless=new', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${WIDTH + 40},${HEIGHT + 40}`,
                '--force-device-scale-factor=1', 'about:blank'],
            { stdio: 'ignore' },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const shots = {};
        for (const source of SOURCES) {
            const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
            const client = await CDP.connect(created.webSocketDebuggerUrl);
            await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
            await client.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
            const url = new URL(server.origin);
            const query = { benchMode: 'capture', scenario, ratio, width: WIDTH, height: HEIGHT, variant: 'production', velocity: source };
            for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
            await client.send('Page.navigate', { url: url.href });
            for (let attempt = 0; ; attempt++) {
                const ready = await client
                    .send('Runtime.evaluate', { expression: 'window.__UPSCALER_BENCH__?.ready === true', returnByValue: true }, 5000)
                    .then((response) => response.result?.value === true)
                    .catch(() => false);
                if (ready) break;
                if (attempt > 600) throw new Error(`Timed out waiting for the bench (${source}).`);
                await wait(100);
            }
            for (const frame of frames)
                for (const view of views) {
                    await client.evaluate(`window.__UPSCALER_BENCH__.capture({ frame: ${frame}, debugView: '${view}' }).then(() => 0)`);
                    const shot = Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
                    await writeFile(join(out, `${source}-f${frame}-${view}.png`), shot);
                    shots[`${source}-${frame}-${view}`] = decodePng(shot);
                    console.log(`${source} f${frame} ${view}`);
                }
            for (const event of client.events) {
                const text =
                    event.method === 'Log.entryAdded' && event.params.entry.level !== 'verbose' ? event.params.entry.text
                        : event.method === 'Runtime.exceptionThrown' ? event.params.exceptionDetails.exception?.description
                            : null;
                // The bench page has no favicon; everything else is a finding.
                if (text && !/favicon|status of 404/.test(text)) problems.push(`${source}: ${text}`);
            }
            client.close();
        }
        for (const frame of frames)
            await writeFile(
                join(out, `grid-f${frame}.png`),
                grid(SOURCES.map((source) => views.map((view) => shots[`${source}-${frame}-${view}`]))),
            );
        if (problems.length) {
            console.warn(`browser log:\n${problems.join('\n')}`);
            process.exitCode = 1;
        }
        console.log(`artifacts: ${out}`);
    } finally {
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
