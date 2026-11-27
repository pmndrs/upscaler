#!/usr/bin/env node
/**
 * Exact ground-truth disocclusion meter (issue #102): drives
 * bench/disocclusion-truth.html over CDP and scores the published
 * `disocclusion` guide against a rasterized ground truth (object ids + world
 * positions, rendered at render resolution and 4× under the same jittered
 * projection the upscaler's input used; see bench/src/probes/disocclusionTruth.ts
 * for the construction and its precision).
 *
 * Per scenario × variant, pooled over each window (a Q19 / Q30 segment group,
 * or the whole run) and in #102's format:
 * - recall / precision of the mask over all receivers
 * - wrong-surface missed: share of the truly disoccluded pixels with no texel
 *   of the same object in the 3×3 around the true reprojection that the mask
 *   leaves below the threshold
 * - interior missed / false (‰ of interior positives / negatives)
 * - band recall / precision (the 1–2 px silhouette strip)
 * at mask ≥ 0.5, with > 0, ≥ 0.25 and ≥ 0.75 in summary.json. With
 * `--error`, the upscaled output's conditioned-luma error against a
 * 2×2-supersampled reference, split by the same classes (and by whether the
 * mask flagged the pixel).
 *
 * `--validate` runs the ground truth's own checks first: Q1 (still camera,
 * still scene: no pixel may be disoccluded) and `slide` (one quad sliding
 * 4 render px/frame over a wall: the revealed strip is analytically
 * 4 px × the quad's height per frame).
 *
 * Usage:
 *   node scripts/measure-disocclusion-truth.mjs [--scenarios Q3,Q4,Q19,Q30]
 *     [--variants production,reconstruct-cross-frame-v1] [--ratio 2]
 *     [--width 1920] [--height 1080] [--gt-scale 4] [--error Q3,Q30]
 *     [--validate] [--label truth] [--url http://127.0.0.1:5199] [--port 9335]
 *
 * Writes bench/results/raw/disocclusion-truth/<label>/summary.json and
 * class-colour PNGs (white detected, red missed, magenta missed wrong-surface,
 * cyan false alarm) for a few frames per run.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { parseCliOrExit } from './cli-flags.mjs';
import { encodePng } from './image-metrics.mjs';
import {
    DEFAULT_BENCH_URL,
    closeOwnedCdpBrowser,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = `Usage: node scripts/measure-disocclusion-truth.mjs [options]
  --scenarios <list>     bench scenarios (default Q3,Q4,Q19,Q30; "none" with --validate)
  --variants <list>      production,reconstruct-cross-frame-v1 (default both)
  --ratio <n>            upscale ratio (default 2)
  --width <px> --height <px>   display size (default 1920x1080 → 960×540 render at ratio 2)
  --gt-scale <n>         t−1 visibility supersampling; edge precision 1/n render px (default 4)
  --error <list>         scenarios whose output error is scored per class (production only)
  --validate             run the ground truth's own checks (Q1 still, slide) first
  --label <name>         output folder (default truth)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9335)
Writes bench/results/raw/disocclusion-truth/<label>/.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['scenarios', 'variants', 'ratio', 'width', 'height', 'gt-scale', 'error', 'validate', 'label', 'url', 'port'],
    USAGE,
);
const list = (value, fallback) => (typeof value === 'string' ? value : fallback).split(',').filter(Boolean);
const scenarios = list(cli.scenarios, 'Q3,Q4,Q19,Q30').filter((scenario) => scenario !== 'none');
const variants = list(cli.variants, 'production,reconstruct-cross-frame-v1');
const errorScenarios = new Set(list(cli.error, ''));
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1920);
const height = Number(cli.height ?? 1080);
const gtScale = Number(cli['gt-scale'] ?? 4);
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9335;
const outputDirectory = join(ROOT, 'bench/results/raw/disocclusion-truth', cli.label ?? 'truth');

const { Q19_SEGMENTS, Q30_SEGMENTS, BENCHMARK_SCENARIOS } = await import(
    pathToFileURL(join(ROOT, 'bench/src/benchmark/scenarios.ts')).href
);

/** Thresholds the probe counts at (index into its per-threshold arrays). */
const THRESHOLDS = ['>0', '≥0.25', '≥0.5', '≥0.75'];
const HALF = 2;

/**
 * Scored frames and the windows they pool into. Motion windows only: a still
 * frame has no disocclusion to find, so it would only dilute the false-alarm
 * rate. Q19's camera segments and its object-motion segments pool separately.
 */
function plan(scenario) {
    const segmentsWindow = (segments, groups) =>
        Object.fromEntries(
            Object.entries(groups).map(([name, members]) => [
                name,
                segments.filter((segment) => members.includes(segment.name)).map((segment) => [segment.start, segment.end]),
            ]),
        );
    if (scenario === 'Q19')
        return {
            start: 100,
            end: BENCHMARK_SCENARIOS.Q19.endFrame,
            windows: segmentsWindow(Q19_SEGMENTS, {
                'camera (dolly, orbit, slide)': ['dolly-back', 'dolly-forward', 'orbit-left', 'orbit-right', 'slide', 'dolly-back-fast', 'dolly-forward-fast'],
                'scene recede/approach': ['scene-recede', 'scene-approach'],
                holds: ['hold-1', 'hold-2', 'hold-3', 'hold-4', 'hold-5', 'hold-6', 'hold-7', 'hold-8', 'hold-9'],
            }),
            snapshots: [150, 390, 750],
        };
    if (scenario === 'Q30')
        return {
            start: 30,
            end: BENCHMARK_SCENARIOS.Q30.endFrame,
            windows: segmentsWindow(Q30_SEGMENTS, { pan: ['pan'], orbit: ['orbit'], holds: ['hold-1', 'hold-2'] }),
            snapshots: [120, 300],
        };
    if (scenario === 'Q4')
        return { start: 30, end: 359, windows: { 'orbit, dolly, orbit': [[30, 359]] }, snapshots: [100, 300] };
    if (scenario === 'Q3') return { start: 30, end: 239, windows: { 'object motion': [[30, 239]] }, snapshots: [120] };
    if (scenario === 'Q1') return { start: 30, end: 89, windows: { still: [[30, 89]] }, snapshots: [60] };
    if (scenario === 'slide') return { start: 5, end: 40, windows: { slide: [[5, 40]] }, snapshots: [20] };
    const definition = BENCHMARK_SCENARIOS[scenario];
    if (!definition) throw new Error(`Unknown scenario ${scenario}.`);
    return { start: 30, end: definition.endFrame, windows: { all: [[30, definition.endFrame]] }, snapshots: [] };
}

//* Pooling
const sumArrays = (a, b) => a.map((value, index) => value + b[index]);
function pool(frames) {
    const total = {
        frames: frames.length,
        receivers: 0,
        positives: 0,
        offScreen: 0,
        wrongSurface: 0,
        interiorPositive: 0,
        interiorNegative: 0,
        bandPositive: 0,
        bandNegative: 0,
        hit: [0, 0, 0, 0],
        falseAlarm: [0, 0, 0, 0],
        interiorHit: [0, 0, 0, 0],
        interiorFalse: [0, 0, 0, 0],
        bandHit: [0, 0, 0, 0],
        bandFalse: [0, 0, 0, 0],
        wrongSurfaceHit: [0, 0, 0, 0],
        offScreenHit: [0, 0, 0, 0],
        selfCheckMax: 0,
        errors: null,
    };
    for (const frame of frames) {
        for (const key of ['receivers', 'positives', 'offScreen', 'wrongSurface', 'interiorPositive', 'interiorNegative', 'bandPositive', 'bandNegative'])
            total[key] += frame[key];
        for (const key of ['hit', 'falseAlarm', 'interiorHit', 'interiorFalse', 'bandHit', 'bandFalse', 'wrongSurfaceHit', 'offScreenHit'])
            total[key] = sumArrays(total[key], frame[key]);
        total.selfCheckMax = Math.max(total.selfCheckMax, frame.selfCheckMax);
        if (frame.errors) {
            total.errors ??= {};
            for (const [name, entry] of Object.entries(frame.errors)) {
                const pooled = (total.errors[name] ??= { count: 0, sum: 0, over: 0 });
                pooled.count += entry.count;
                pooled.sum += entry.sum;
                pooled.over += entry.over;
            }
        }
    }
    return total;
}

/** #102's table columns at one threshold. */
function metrics(total, t) {
    const ratioOf = (a, b) => (b > 0 ? a / b : null);
    const flagged = total.hit[t] + total.falseAlarm[t];
    return {
        recall: ratioOf(total.hit[t], total.positives),
        precision: ratioOf(total.hit[t], flagged),
        wrongSurfaceMissed: ratioOf(total.wrongSurface - total.wrongSurfaceHit[t], total.wrongSurface),
        offScreenMissed: ratioOf(total.offScreen - total.offScreenHit[t], total.offScreen),
        interiorMissed: ratioOf(total.interiorPositive - total.interiorHit[t], total.interiorPositive),
        interiorFalse: ratioOf(total.interiorFalse[t], total.interiorNegative),
        bandRecall: ratioOf(total.bandHit[t], total.bandPositive),
        bandPrecision: ratioOf(total.bandHit[t], total.bandHit[t] + total.bandFalse[t]),
        flaggedPerMille: ratioOf(flagged * 1000, total.receivers),
    };
}

const pct = (value, digits = 1) => (value === null ? '–' : (100 * value).toFixed(digits));
const permille = (value, digits = 2) => (value === null ? '–' : (1000 * value).toFixed(digits));

//* Main
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-disocclusion-truth-'));
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
        client = await CDP.connect(created.webSocketDebuggerUrl);
        await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
        await client.send('Page.navigate', { url: `${server.origin}/disocclusion-truth.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await client.evaluate('window.__disocclusionTruth?.ready === true')) === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the probe.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        const evaluate = async (expression) => {
            const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 15 * 60 * 1000);
            if (result.exceptionDetails)
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result.value;
        };

        const runs = [];
        const queue = [];
        if (cli.validate) {
            queue.push({ scenario: 'Q1', variant: 'production', error: false });
            queue.push({ scenario: 'slide', variant: 'production', error: false });
        }
        for (const scenario of scenarios)
            for (const variant of variants)
                queue.push({ scenario, variant, error: errorScenarios.has(scenario) && variant === 'production' });

        for (const job of queue) {
            const started = Date.now();
            const { start, end, windows, snapshots } = plan(job.scenario);
            const request = {
                scenario: job.scenario,
                start,
                end,
                variant: job.variant,
                ratio,
                width,
                height,
                gtScale,
                error: job.error,
                snapshots,
                slideSpeed: 4,
            };
            const result = await evaluate(`window.__disocclusionTruth.run(${JSON.stringify(request)})`);
            const pooled = Object.fromEntries(
                Object.entries(windows).map(([name, ranges]) => [
                    name,
                    pool(result.frames.filter((frame) => ranges.some(([from, to]) => frame.frame >= from && frame.frame <= to))),
                ]),
            );
            const run = { ...job, request, renderWidth: result.renderWidth, renderHeight: result.renderHeight, validation: result.validation, pooled, frames: result.frames };
            runs.push(run);

            // Class-colour snapshots.
            const count = await evaluate('window.__disocclusionTruth.snapshotCount');
            for (let index = 0; index < count; index++) {
                let encoded = '';
                let meta = null;
                for (let offset = 0; meta === null || offset < meta.total; offset += 1 << 20) {
                    meta = await evaluate(`window.__disocclusionTruth.takeSnapshot(${index}, ${offset})`);
                    encoded += meta.rgb;
                }
                const bytes = Buffer.from(encoded, 'base64');
                const rgb = Float32Array.from(bytes, (byte) => byte / 255);
                await writeFile(join(outputDirectory, `${job.scenario}-${job.variant}-f${meta.frame}.png`), encodePng(rgb, meta.width, meta.height));
            }

            console.log(`\n${job.scenario} ${job.variant} (${result.renderWidth}×${result.renderHeight} render, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
            if (result.validation) console.log(`  validation: ${JSON.stringify(result.validation)}`);
            console.log(
                '  window                         frames  positives/f  recall%  precision%  WS missed% (n/f)  offscr missed% (n/f)  int missed‰  int false‰  band recall%  band prec%  self-check px',
            );
            for (const [name, total] of Object.entries(pooled)) {
                const m = metrics(total, HALF);
                const perFrame = (value) => (total.frames ? (value / total.frames).toFixed(1) : '–');
                console.log(
                    `  ${name.padEnd(30)} ${String(total.frames).padStart(6)}  ${perFrame(total.positives).padStart(11)}  ${pct(m.recall).padStart(7)}  ${pct(m.precision).padStart(10)}` +
                        `  ${`${pct(m.wrongSurfaceMissed)} (${perFrame(total.wrongSurface)})`.padStart(16)}  ${`${pct(m.offScreenMissed)} (${perFrame(total.offScreen)})`.padStart(20)}  ${permille(m.interiorMissed).padStart(11)}` +
                        `  ${permille(m.interiorFalse).padStart(10)}  ${pct(m.bandRecall).padStart(12)}  ${pct(m.bandPrecision).padStart(10)}  ${total.selfCheckMax.toFixed(3).padStart(13)}`,
                );
                if (total.errors) {
                    const rows = Object.entries(total.errors)
                        .filter(([, entry]) => entry.count > 0)
                        .map(([cls, entry]) => `${cls} ${(entry.sum / entry.count).toFixed(4)} (${pct(entry.over / entry.count)}% >0.05, n ${entry.count})`);
                    console.log(`    output |Δ c-luma| by class: ${rows.join('; ')}`);
                }
            }
        }

        //* Report
        const summary = {
            ratio,
            width,
            height,
            gtScale,
            thresholds: THRESHOLDS,
            runs: runs.map(({ frames, ...run }) => ({
                ...run,
                metrics: Object.fromEntries(
                    Object.entries(run.pooled).map(([name, total]) => [name, THRESHOLDS.map((threshold, t) => ({ threshold, ...metrics(total, t) }))]),
                ),
                frames,
            })),
            browserLog: logs(client),
        };
        await writeFile(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        const records = summary.browserLog;
        if (records.some((line) => /error|exception|validation|invalid/i.test(line))) console.warn(`\nbrowser log:\n${records.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        await closeOwnedCdpBrowser(client);
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

await main();
