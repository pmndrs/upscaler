#!/usr/bin/env node
/**
 * Motion-stability meter: temporal instability under motion, reference-free.
 * The still-scene meters (measure-convergence, measure-alpha-convergence)
 * diff consecutive frames of a still camera; under motion consecutive frames
 * differ by the motion itself, so they can't see flicker there. This one
 * warps the previous *output* onto the current one with
 * `@pmndrs/motion-vectors`' `WarpingError` and averages the conditioned-luma
 * difference over the pixels its depth mask keeps (disocclusions left out).
 * A path that flickers, crawls, smears or ghosts under motion reads higher; a
 * stable one approaches the scene's own shading change.
 *
 * Every mode is judged through the same motion: the package's `MotionVectors`
 * node, which fills `.w` (previous linear depth) so moving objects are masked
 * correctly. Never judge with camera-only motion (its mask can't see objects
 * moving along the view axis and it rewards the path fed that motion), nor
 * with the motion one of the compared outputs was built from
 * (pmndrs/motion-vectors docs/MOTION.md §10).
 *
 * Two caveats (bench/docs/NEXT-STEPS.md §20): the warp resamples bilinearly,
 * so a sharper output reads higher (`--warp error` warps the error against the
 * 2×2 reference instead), and the default judge is the input render's, which
 * is jittered on the temporal path (`--judge display` renders it unjittered at
 * display resolution for every mode).
 *
 * Drives bench/motion-upscaler.html (bench/src/probes/motionUpscaler.ts) with
 * `metrics: 'warp'`; the upscaler is a bench variant built through the
 * bench's own registry, so `--variant A --comparison B` is a one-command A/B.
 *
 * Usage:
 *   node scripts/measure-motion-stability.mjs [--scenario Q19] [--ratio 2]
 *     [--modes temporal] [--variant production] [--comparison <id>]
 *     [--settings '{"lockThinFeatures":false}'] [--heat [frames]]
 *     [--end <frame>] [--judge input|display] [--warp output|error]
 *     [--label stability] [--url http://127.0.0.1:5199] [--port 9335]
 *
 * Writes bench/results/raw/motion-stability/<label>-<scenario>-<ratio>x/:
 * summary.json (per condition: segment rows + aggregates), per-frame JSON per
 * condition, heat-map PNGs (error ×8 grey, blue = masked) and the browser log.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
import {
    MODES,
    aggregate,
    defaultHeatFrames,
    expandConditions,
    heatToPng,
    relativeDelta,
    scenarioPlan,
    summarizeSegments,
} from './motion-stability.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = `Usage: node scripts/measure-motion-stability.mjs [options]
  --scenario <id>        Q19 (default; segmented camera + object motion), Q21 (deformed
                         geometry, still then orbiting camera), Q4 (camera
                         orbit/truck/hold) or Q3 (object motion, still camera)
  --ratio <n>            upscale ratio (default 2; native always renders at 1)
  --modes <list>         ${MODES.join(',')} (default temporal; reference =
                         the 2×2-supersampled render, no upscaler)
  --variant <id>         bench variant for the upscaled modes (default production)
  --comparison <id>      a second variant: every upscaled mode runs both, with deltas
  --settings <json>      RuntimeSettings merged over the probe's defaults
  --velocity <source>    what the upscaler is fed: three (default, three's velocity),
                         motion-vectors (@pmndrs/motion-vectors' node) or camera
                         (motion from depth). The judge is always the node, and its
                         position-stage patch also reaches three's velocity in the
                         probe, so three vs motion-vectors is NOT an A/B on deformers
                         (Q21; NEXT-STEPS §22) — use measure-reference-quality.mjs there.
  --heat [frames]        save heat maps (comma-separated frames; bare = the middle
                         of each motion segment)
  --end <frame>          stop early (smoke runs); default the scenario's end
  --judge <input|display>  motion the warp judges with: the input render's (default;
                         render-res, jittered on the temporal path) or an unjittered
                         display-res render of the same node, identical for every mode
  --warp <output|error>  what is warped: the output (default; sharper reads higher) or
                         its conditioned-luma error against the 2×2 reference, so shared
                         content cancels and only the error's change along motion counts
  --width <px> --height <px>   display size (default 1280x720)
  --label <name>         output folder prefix (default stability)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9335)
Writes bench/results/raw/motion-stability/<label>-<scenario>-<ratio>x/.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['scenario', 'ratio', 'modes', 'variant', 'comparison', 'settings', 'velocity', 'heat', 'end', 'judge', 'warp', 'width', 'height', 'label', 'url', 'port'],
    USAGE,
);

function fail(message) {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(1);
}

/** --velocity names → the probe's `velocity` request field. */
const PROBE_VELOCITY = { three: 'engine', 'motion-vectors': 'node', camera: 'camera' };
const registry = await import(pathToFileURL(join(ROOT, 'bench/src/benchmark/scenarios.ts')).href);
let plan;
let conditions;
let settings;
try {
    plan = scenarioPlan(cli.scenario ?? 'Q19', registry);
    const variants = [cli.variant ?? 'production', ...(cli.comparison ? [cli.comparison] : [])];
    conditions = expandConditions((cli.modes ?? 'temporal').split(',').filter(Boolean), variants);
    settings = cli.settings ? JSON.parse(cli.settings) : undefined;
    if (cli.velocity !== undefined && !(cli.velocity in PROBE_VELOCITY))
        throw new Error(`Unknown --velocity ${cli.velocity} (${Object.keys(PROBE_VELOCITY).join(', ')}).`);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
const end = cli.end ? Math.min(Number(cli.end), plan.end) : plan.end;
if (!Number.isInteger(end) || end <= plan.start) fail(`--end must be an integer above ${plan.start}.`);
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const heatFrames =
    cli.heat === undefined
        ? []
        : (cli.heat === true ? defaultHeatFrames(plan.segments, plan.start) : cli.heat.split(',').map(Number)).filter(
              (frame) => frame >= plan.start && frame <= end,
          );
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9335;
const outputDirectory = join(
    ROOT,
    'bench/results/raw/motion-stability',
    `${cli.label ?? 'stability'}-${plan.id}-${String(ratio).replace('.', '_')}x`,
);

//* Formatting
const fmt = (value, digits = 5, pad = 9) => (value === null ? '—' : value.toFixed(digits)).padStart(pad);
const pct = (value, digits = 1, pad = 7) => (value === null ? '—' : (100 * value).toFixed(digits)).padStart(pad);
const delta = (value) => (value === null ? '—' : `${value >= 0 ? '+' : ''}${(100 * value).toFixed(1)}%`).padStart(9);

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

function printCondition(name, rows, totals) {
    console.log(`\n${name}`);
    console.log('  segment                 frames   warp err   max err   scored%  occluded%   over%');
    for (const row of rows)
        console.log(
            `  ${row.segment.padEnd(22)} ${String(row.frames).padStart(6)} ${fmt(row.meanError)} ${fmt(row.maxError)}  ${pct(row.scored)}    ${pct(row.occluded)}  ${pct(row.over, 2)}`,
        );
    console.log(`  motion ${fmt(totals.motion)}   holds ${fmt(totals.holds)}   worst motion frame ${fmt(totals.motionMax)}`);
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-motion-stability-'));
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
        await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await client.send('Page.navigate', { url: `${server.origin}/motion-upscaler.html` });
        for (let attempt = 0; ; attempt++) {
            // A cold dev server re-optimizes deps and reloads the page under a
            // pending evaluate, which then never answers: poll with a short timeout.
            const ready = await client
                .send('Runtime.evaluate', { expression: 'window.__motionLab?.ready === true', returnByValue: true }, 5000)
                .then((response) => response.result?.value === true)
                .catch(() => false);
            if (ready) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the motion probe.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        const results = {};
        for (const condition of conditions) {
            const started = Date.now();
            const request = {
                scenario: plan.id,
                path: condition.path,
                ratio,
                width,
                height,
                start: plan.start,
                end,
                metrics: 'warp',
                heatFrames,
                ...(cli.judge ? { judge: cli.judge } : {}),
                ...(cli.warp ? { warpTarget: cli.warp } : {}),
                ...(condition.variant ? { variant: condition.variant } : {}),
                ...(settings ? { settings } : {}),
                ...(cli.velocity ? { velocity: PROBE_VELOCITY[cli.velocity] } : {}),
            };
            const response = await client.send(
                'Runtime.evaluate',
                { expression: `window.__motionLab.run(${JSON.stringify(request)})`, awaitPromise: true, returnByValue: true },
                10 * 60 * 1000,
            );
            if (response.exceptionDetails)
                throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
            const frames = response.result.value.frames.map((f) => ({ frame: f.frame, warp: f.warp, reset: f.reset }));
            const rows = summarizeSegments(frames, plan.segments.filter((segment) => segment.start <= end), plan.start);
            const totals = aggregate(rows);
            results[condition.name] = { ...condition, rows, totals };
            await writeFile(join(outputDirectory, `${condition.name}.frames.json`), `${JSON.stringify(frames)}\n`);
            const heatCount = await client.evaluate('window.__motionLab.heatCount');
            for (let index = 0; index < heatCount; index++) {
                // In 1 MB pieces: CDP stalls on a single multi-megabyte value.
                const snapshot = await client.evaluate(`window.__motionLab.takeHeat(${index})`);
                while (snapshot.rgba.length < snapshot.total)
                    snapshot.rgba += (await client.evaluate(`window.__motionLab.takeHeat(${index}, ${snapshot.rgba.length})`)).rgba;
                await writeFile(join(outputDirectory, `${condition.name}-heat-f${snapshot.frame}.png`), heatToPng(snapshot));
            }
            printCondition(`${condition.name} (${((Date.now() - started) / 1000).toFixed(0)} s)`, rows, totals);
        }

        //* A/B
        const comparisons = [];
        if (cli.comparison)
            for (const mode of new Set(conditions.filter((c) => c.variant).map((c) => c.path))) {
                const a = results[`${mode}@${cli.variant ?? 'production'}`];
                const b = results[`${mode}@${cli.comparison}`];
                const rows = a.rows.map((row, index) => ({
                    segment: row.segment,
                    a: row.meanError,
                    b: b.rows[index].meanError,
                    delta: relativeDelta(row.meanError, b.rows[index].meanError),
                }));
                comparisons.push({ mode, a: a.variant, b: b.variant, rows, motion: relativeDelta(a.totals.motion, b.totals.motion) });
                console.log(`\n${mode}: ${b.variant} vs ${a.variant} (warp error; lower is steadier)`);
                for (const row of rows)
                    console.log(`  ${row.segment.padEnd(22)} ${fmt(row.a)} ${fmt(row.b)} ${delta(row.delta)}`);
                console.log(`  ${'motion'.padEnd(22)} ${fmt(a.totals.motion)} ${fmt(b.totals.motion)} ${delta(relativeDelta(a.totals.motion, b.totals.motion))}`);
            }

        if (conditions.length > 1) {
            console.log('\nwarp error under motion / on holds');
            for (const [name, result] of Object.entries(results))
                console.log(`  ${name.padEnd(36)} ${fmt(result.totals.motion)} ${fmt(result.totals.holds)}`);
        }

        const records = logs(client);
        await writeFile(join(outputDirectory, 'browser-log.txt'), `${records.join('\n')}\n`);
        await writeFile(
            join(outputDirectory, 'summary.json'),
            `${JSON.stringify({ scenario: plan.id, ratio, width, height, start: plan.start, end, velocity: cli.velocity ?? 'three', judge: cli.judge ?? 'input', warp: cli.warp ?? 'output', settings: settings ?? null, heatFrames, results, comparisons }, null, 2)}\n`,
        );
        if (records.some((line) => /error|exception|validation|invalid/i.test(line))) {
            console.warn(`\nbrowser log:\n${records.join('\n')}`);
            process.exitCode = 1;
        }
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
