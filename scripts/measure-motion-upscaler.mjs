#!/usr/bin/env node
/**
 * Upscaler motion meter (EXPERIMENTAL): the upscaler's consumer of
 * `@pmndrs/motion-vectors` (npm, a bench-only devDependency). Drives bench/motion-upscaler.html over
 * CDP and reads every number back exactly from the GPU. The motion lab itself
 * (oracle comparisons, its own scenes) lives in pmndrs/motion-vectors.
 *
 * Experiments (--experiments, comma-separated):
 * - audit-q19: how well zero motion, three's `velocity` and camera motion from
 *   depth warp the previous input onto the current one, per Q19 segment.
 * - warp: Q19 through native / bilinear / spatial / temporal (+ temporal fed
 *   the package's node, and camera motion from depth): output warping error
 *   (`WarpingError`, judged through the node) and mean
 *   |output − 2×2 SSAA reference|, per segment.
 * - cut: Q10's camera cut (frame 60): the GPU cut detector's share and the
 *   histogram distances per frame, the false-positive margin over Q19's
 *   motion, and the temporal path through the cut with history reset by the
 *   scenario, never, the GPU detector (`auto`) or the histogram.
 *
 * Usage:
 *   node scripts/measure-motion-upscaler.mjs [--experiments audit-q19,warp,cut]
 *     [--ratio 2] [--width 1280] [--height 720] [--label motion]
 *     [--url http://127.0.0.1:5199] [--port 9334]
 *
 * Writes bench/results/raw/motion/<label>/<experiment>.json + PNGs.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
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
const USAGE = `Usage: node scripts/measure-motion-upscaler.mjs [options]
  --experiments <list>   audit-q19,warp,cut (default: all)
  --ratio <n>            upscale ratio for warp / cut (default 2)
  --width <px> --height <px>   display size (default 1280x720)
  --label <name>         output folder (default motion)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9334)
  --request <json>       with --experiments probe: one lab request; prints per-candidate means
  --name <file>          with probe: screenshot name (default probe)
Writes bench/results/raw/motion/<label>/.`;
const cli = parseCliOrExit(process.argv.slice(2), ['experiments', 'ratio', 'width', 'height', 'label', 'url', 'port', 'request', 'name'], USAGE);
const experiments = (cli.experiments ?? 'audit-q19,warp,cut').split(',').filter(Boolean);
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9334;
const outputDirectory = join(ROOT, 'bench/results/raw/motion', cli.label ?? 'motion');

// Mirrors Q19_SEGMENTS in bench/src/benchmark/scenarios.ts.
const Q19_SEGMENTS = [
    ['still', 0, 119], ['dolly-back', 120, 179], ['hold-1', 180, 239], ['dolly-forward', 240, 299],
    ['hold-2', 300, 359], ['orbit-left', 360, 419], ['hold-3', 420, 479], ['orbit-right', 480, 539],
    ['hold-4', 540, 599], ['slide', 600, 659], ['hold-5', 660, 719], ['scene-recede', 720, 779],
    ['hold-6', 780, 839], ['scene-approach', 840, 899], ['hold-7', 900, 959], ['dolly-back-fast', 960, 979],
    ['hold-8', 980, 1039], ['dolly-forward-fast', 1040, 1059], ['hold-9', 1060, 1119],
].map(([name, start, end]) => ({ name, start, end }));
const MOTION_SEGMENTS = Q19_SEGMENTS.filter((segment) => !/^(still|hold)/.test(segment.name));
const CANDIDATES = ['zero', 'engine', 'camera', 'node'];

//* Helpers
const mean = (values) => {
    const finite = values.filter((value) => value !== null && Number.isFinite(value));
    return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : null;
};
const fmt = (value, digits = 4, pad = 9) => (value === null ? '—' : value.toFixed(digits)).padStart(pad);
const pct = (value, digits = 2, pad = 8) => (value === null ? '—' : (100 * value).toFixed(digits)).padStart(pad);

/** Mean per-candidate stats over frames for the audit residual slot. */
function candidateSummary(frames, key) {
    return CANDIDATES.map((name, index) => {
        const stats = frames.map((frame) => frame[key]?.candidates[index]).filter(Boolean);
        return {
            candidate: name,
            meanResidual: mean(stats.map((s) => (s.valid > 0 ? s.meanResidual : null))),
            valid: mean(stats.map((s) => s.valid)),
            best: mean(stats.map((s) => s.best)),
            unexplained: mean(stats.map((s) => s.unexplained)),
            beaten: mean(stats.map((s) => s.beaten)),
            moving: mean(stats.map((s) => s.moving)),
        };
    });
}

function printCandidates(title, rows) {
    console.log(`  ${title}`);
    console.log('    candidate   residual    valid%    best%  unexpl%  beaten%  moving%');
    for (const row of rows)
        console.log(
            `    ${row.candidate.padEnd(9)} ${fmt(row.meanResidual)} ${pct(row.valid)} ${pct(row.best)} ${pct(row.unexplained)} ${pct(row.beaten)} ${pct(row.moving)}`,
        );
}

async function main() {
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-motion-'));
        chrome = spawn(
            browserExecutable(),
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
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
        client = await CDP.connect(created.webSocketDebuggerUrl);
        await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
        // Pin the viewport to the canvas, or headless chrome clips its bottom rows.
        await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await client.send('Page.navigate', { url: `${server.origin}/motion-upscaler.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await client.evaluate('window.__motionLab?.ready === true')) === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the upscaler motion probe.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        const run = async (request) => {
            const result = await client.send(
                'Runtime.evaluate',
                { expression: `window.__motionLab.run(${JSON.stringify({ width, height, ...request })})`, awaitPromise: true, returnByValue: true },
                30 * 60 * 1000,
            );
            if (result.exceptionDetails)
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result.value;
        };
        const screenshot = async (name) => {
            const shot = await client.send('Page.captureScreenshot', {
                format: 'png',
                clip: { x: 0, y: 0, width, height, scale: 1 },
            });
            await writeFile(join(outputDirectory, `${name}.png`), Buffer.from(shot.data, 'base64'));
        };

        for (const experiment of experiments) {
            const started = Date.now();
            console.log(`\n== ${experiment}`);
            let record;
            if (experiment === 'audit-q19') record = await auditQ19(run, screenshot);
            else if (experiment === 'warp') record = await warp(run, screenshot);
            else if (experiment === 'cut') record = await cut(run, screenshot);
            else if (experiment === 'probe') record = await probe(run, screenshot);
            else throw new Error(`Unknown experiment ${experiment}`);
            await writeFile(join(outputDirectory, `${experiment}.json`), `${JSON.stringify(record, null, 2)}\n`);
            console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        }
        const records = logs(client);
        await writeFile(join(outputDirectory, 'browser-log.txt'), `${records.join('\n')}\n`);
        if (records.some((line) => /error|exception|validation|invalid/i.test(line)))
            console.warn(`\nbrowser log:\n${records.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

function logs(client) {
    return client.events
        .filter((event) => event.method === 'Log.entryAdded' || event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled')
        .map((event) => {
            if (event.method === 'Log.entryAdded') return `[${event.params.entry.level}] ${event.params.entry.text}`;
            if (event.method === 'Runtime.exceptionThrown')
                return `[exception] ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`;
            return `[console.${event.params.type}] ${event.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`;
        });
}

//* Experiments
async function probe(run, screenshot) {
    // One request, or an array run back to back in the same page.
    const parsed = JSON.parse(cli.request ?? '{}');
    const results = [];
    for (const request of Array.isArray(parsed) ? parsed : [parsed]) {
        const result = await run(request);
        console.log(`  ${JSON.stringify(request)}`);
        printCandidates('audit', candidateSummary(result.frames, 'audit'));
        const warped = result.frames.filter((f) => f.warp);
        console.log(`  warp: mean error ${fmt(mean(warped.map((f) => f.warp.meanError)))}, scored ${pct(mean(warped.map((f) => f.warp.scored)))}%`);
        results.push(result);
    }
    await screenshot(cli.name ?? 'probe');
    return Array.isArray(parsed) ? results : results[0];
}

async function auditQ19(run, screenshot) {
    const { frames } = await run({ scenario: 'Q19', path: 'native', start: 100, end: 1119 });
    const segments = Q19_SEGMENTS.map((segment) => ({
        segment: segment.name,
        candidates: candidateSummary(frames.filter((f) => f.frame >= segment.start && f.frame <= segment.end), 'audit'),
    }));
    console.log('  segment              engine res   node res   camera res   zero res  | engine valid%  node valid%  camera valid% | camera beaten%');
    for (const row of segments) {
        const [zero, engine, cam, node] = row.candidates;
        console.log(
            `  ${row.segment.padEnd(20)} ${fmt(engine.meanResidual)}  ${fmt(node.meanResidual)}    ${fmt(cam.meanResidual)}  ${fmt(zero.meanResidual)}  | ${pct(engine.valid)}    ${pct(node.valid)}      ${pct(cam.valid)}     | ${pct(cam.beaten)}`,
        );
    }
    for (const frame of [150, 750]) {
        await run({ scenario: 'Q19', path: 'native', end: frame, view: 'audit' });
        await screenshot(`q19-audit-f${frame}`);
    }
    return { segments, frames };
}

async function warp(run, screenshot) {
    const conditions = [
        { name: 'native', path: 'native' },
        { name: 'bilinear', path: 'bilinear' },
        { name: 'spatial', path: 'spatial' },
        { name: 'temporal', path: 'temporal' },
        { name: 'temporal-node-mv', path: 'temporal', velocity: 'node' },
        { name: 'temporal-camera-mv', path: 'temporal', velocity: 'camera' },
    ];
    const result = {};
    for (const condition of conditions) {
        const { frames } = await run({ scenario: 'Q19', path: condition.path, ratio, velocity: condition.velocity, start: 100, end: 1119, reference: true });
        const segments = Q19_SEGMENTS.map((segment) => {
            const slice = frames.filter((f) => f.frame >= segment.start && f.frame <= segment.end);
            return {
                segment: segment.name,
                warp: mean(slice.map((f) => f.warp?.meanError ?? null)),
                warpScored: mean(slice.map((f) => f.warp?.scored ?? null)),
                reference: mean(slice.map((f) => f.reference)),
            };
        });
        result[condition.name] = { segments };
        const motion = segments.filter((s) => MOTION_SEGMENTS.some((m) => m.name === s.segment));
        const holds = segments.filter((s) => /^(still|hold)/.test(s.segment));
        console.log(
            `  ${condition.name.padEnd(20)} warp motion ${fmt(mean(motion.map((s) => s.warp)))}  warp still ${fmt(mean(holds.map((s) => s.warp)))}` +
                `  |out−SSAA| motion ${fmt(mean(motion.map((s) => s.reference)))}  still ${fmt(mean(holds.map((s) => s.reference)))}`,
        );
    }
    console.log('\n  per motion segment: warp error (judged through the node) / |out − SSAA|, and the share warp scored');
    console.log(`  ${'segment'.padEnd(20)}${conditions.map((c) => c.name.padStart(22)).join('')}`);
    for (const segment of MOTION_SEGMENTS) {
        const cells = conditions.map((c) => {
            const row = result[c.name].segments.find((s) => s.segment === segment.name);
            return `${fmt(row.warp, 4, 7)} / ${fmt(row.reference, 4, 7)}`.padStart(22);
        });
        const scored = result.temporal.segments.find((s) => s.segment === segment.name).warpScored;
        console.log(`  ${segment.name.padEnd(20)}${cells.join('')}   ${pct(scored, 1, 6)}%`);
    }
    for (const path of ['temporal', 'native']) {
        await run({ scenario: 'Q19', path, ratio, end: 400, view: 'warp' });
        await screenshot(`q19-warp-${path}-f400`);
    }
    return result;
}

async function cut(run, screenshot) {
    const q10 = await run({ scenario: 'Q10', path: 'native', start: 1, end: 119 });
    const series = q10.frames.map((f) => ({ frame: f.frame, js: f.cutJS, emd: f.cutEMD, depth: f.cut?.share ?? null, depthCut: f.cut?.cut ?? null }));
    const atCut = series.find((s) => s.frame === 60);
    const otherQ10 = series.filter((s) => s.frame !== 60);
    const q19 = await run({ scenario: 'Q19', path: 'native', start: 1, end: 1119 });
    const most = (rows, key) => Math.max(...rows.map((row) => row[key] ?? 0));
    const q19Series = q19.frames.map((f) => ({ frame: f.frame, js: f.cutJS, emd: f.cutEMD, depth: f.cut?.share ?? null, depthCut: f.cut?.cut ?? null }));
    const q19Max = { js: most(q19Series, 'js'), emd: most(q19Series, 'emd'), depth: most(q19Series, 'depth') };
    const falseCuts = [...otherQ10, ...q19Series].filter((s) => s.depthCut).length;
    console.log('                         JS        EMD     depth share (GPU detector, cut > 0.2)');
    console.log(`  Q10 cut frame 60:   ${fmt(atCut?.js)} ${fmt(atCut?.emd)} ${fmt(atCut?.depth)}  ${atCut?.depthCut ? 'cut' : 'NO CUT'}`);
    console.log(`  Q10 other frames:   ${fmt(most(otherQ10, 'js'))} ${fmt(most(otherQ10, 'emd'))} ${fmt(most(otherQ10, 'depth'))}  (max)`);
    console.log(`  Q19 motion:         ${fmt(q19Max.js)} ${fmt(q19Max.emd)} ${fmt(q19Max.depth)}  (max)`);
    console.log(`  GPU detector false positives: ${falseCuts} of ${otherQ10.length + q19Series.length} frames`);

    const resets = {};
    for (const reset of ['scenario', 'none', 'auto', 'auto-histogram']) {
        const { frames } = await run({ scenario: 'Q10', path: 'temporal', ratio, reset, start: 50, end: 119, reference: true });
        resets[reset] = frames.map((f) => ({ frame: f.frame, reference: f.reference, warp: f.warp?.meanError ?? null, reset: f.reset }));
        const after = (from, to) => mean(frames.filter((f) => f.frame >= from && f.frame <= to).map((f) => f.reference));
        const resetFrames = frames.filter((f) => f.reset).map((f) => f.frame);
        console.log(
            `  temporal reset=${reset.padEnd(14)} |out−SSAA| f60–63 ${fmt(after(60, 63))}  f64–79 ${fmt(after(64, 79))}  f80–119 ${fmt(after(80, 119))}  resets at [${resetFrames.join(', ')}]`,
        );
        if (reset !== 'scenario') {
            await run({ scenario: 'Q10', path: 'temporal', ratio, reset, end: 62 });
            await screenshot(`q10-reset-${reset}-f62`);
        }
    }
    return { q10: series, q19: q19Series, q19Max, falseCuts, resets };
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
