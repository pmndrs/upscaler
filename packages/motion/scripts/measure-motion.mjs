#!/usr/bin/env node
/**
 * Motion lab meter (EXPERIMENTAL): the package's acceptance harness
 * (docs/research/MOTION-VECTORS-PLAN.md §4). Drives lab/index.html over CDP;
 * every number is exact GPU readback.
 *
 * Experiments (--experiments, comma-separated):
 * - oracle: validates the oracle where three is known to be exact (courtyard
 *   track, camera segments): three and the oracle must agree to f16 noise.
 * - deformers: per object, endpoint error of zero motion / three / camera
 *   motion from depth against the oracle (static and animated positionNode
 *   displacement, morph, rigid control, frustum re-entry).
 * - cases: moves then holds (positionNode A→B, morph ramp, rigid control), per segment.
 * - ticks: the track with 1 / 2 / 4 renders per animation-loop tick.
 * - jitter: jitter switched on after warm-up, with one stable unjittered
 *   matrix vs the build-time trap (setProjectionMatrix(null) before).
 * - water: geometric swell (oracle) vs shading motion (glint, ripples: warp audit).
 * - track: per segment, the new bar (Q19's motion types in the lab's scene).
 * - cuts: histogram distances at hard and similar cuts vs fade / flash / fast pan.
 * - probe: one --request (or an array), prints per-object errors.
 *
 * Usage:
 *   node packages/motion/scripts/measure-motion.mjs [--experiments …] [--label motion]
 *     [--width 1280] [--height 720] [--url http://127.0.0.1:5611] [--port 9411]
 *
 * Writes packages/motion/results/<label>/<experiment>.json + PNGs (gitignored).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { browserExecutable } from './lib/browser-executable.mjs';
import { CDP } from './lib/cdp-client.mjs';
import { parseCliOrExit } from './lib/cli-flags.mjs';
import { DEFAULT_BENCH_URL, parsePort, removeTempDirectory, resolveServerUrl, spawnVite, stopChild, waitForUrl } from './lib/local-processes.mjs';

const PACKAGE = resolve(import.meta.dirname, '..');
const ALL = ['oracle', 'deformers', 'cases', 'ticks', 'jitter', 'water', 'track', 'cuts'];
const USAGE = `Usage: node packages/motion/scripts/measure-motion.mjs [options]
  --experiments <list>   ${ALL.join(',')},probe (default: all but probe)
  --width <px> --height <px>   render size (default 1280x720)
  --label <name>         output folder (default motion)
  --url <origin>         lab origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9411)
  --request <json>       with probe: one lab request or an array
  --name <file>          with probe: screenshot name (default probe)
Writes packages/motion/results/<label>/.`;
const cli = parseCliOrExit(process.argv.slice(2), ['experiments', 'width', 'height', 'label', 'url', 'port', 'request', 'name'], USAGE);
const experiments = (cli.experiments ?? ALL.join(',')).split(',').filter(Boolean);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9411;
const outputDirectory = join(PACKAGE, 'results', cli.label ?? 'motion');

/** Oracle comparison candidates, in the lab's order. */
const COMPARE = ['zero', 'three', 'camera'];
/** Warp audit candidates, in the lab's order. */
const AUDIT = ['zero', 'three', 'camera', 'oracle'];

//* Summaries
const fmt = (value, digits = 3, pad = 8) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)).padStart(pad);
const pct = (value, digits = 1, pad = 7) => fmt(value === null ? null : 100 * value, digits, pad);
const isMotion = (segment) => !/^(still|hold)/.test(segment);

/**
 * Pixel-weighted oracle comparison of one object over frames.
 * @returns {{ valid: number, motion: number|null, candidates: { name: string, error: number|null, over025: number|null, over1: number|null }[] } | null}
 */
function compareSummary(frames, object) {
    const rows = frames.map((frame) => frame.compare[object]).filter((row) => row && row.valid > 0);
    const pixels = rows.reduce((total, row) => total + row.valid, 0);
    if (!pixels) return null;
    const weighted = (pick) => rows.reduce((total, row) => total + pick(row) * row.valid, 0) / pixels;
    return {
        valid: pixels / frames.length,
        motion: weighted((row) => row.meanMotion),
        candidates: COMPARE.map((name, k) => ({
            name,
            error: weighted((row) => row.candidates[k].meanError),
            over025: weighted((row) => row.candidates[k].over025),
            over1: weighted((row) => row.candidates[k].over1),
        })),
    };
}

/** Frame-averaged warp audit per candidate. */
function auditSummary(frames) {
    const rows = frames.map((frame) => frame.audit).filter(Boolean);
    if (!rows.length) return null;
    const average = (pick) => rows.reduce((total, row) => total + pick(row), 0) / rows.length;
    return AUDIT.map((name, k) => ({
        name,
        residual: average((row) => row.candidates[k].meanResidual),
        unexplained: average((row) => row.candidates[k].unexplained),
        beaten: average((row) => row.candidates[k].beaten),
    }));
}

const COMPARE_HEADER = '  object/segment          px moved   zero err   three err  >0.25px  >1px   camera err  >0.25px';
function printCompare(label, summary) {
    if (!summary) return console.log(`  ${label.padEnd(22)}  (not visible)`);
    const [zero, three, camera] = summary.candidates;
    console.log(
        `  ${label.padEnd(22)} ${fmt(summary.motion)}  ${fmt(zero.error)}   ${fmt(three.error)}  ${pct(three.over025)} ${pct(three.over1, 1, 5)}  ${fmt(camera.error)}  ${pct(camera.over025)}`,
    );
}
function printAudit(label, rows) {
    if (!rows) return;
    console.log(`  ${label}: warp residual / unexplained%  ${rows.map((row) => `${row.name} ${fmt(row.residual, 4, 0)} / ${pct(row.unexplained, 2, 0)}`).join('   ')}`);
}

function bySegment(frames, segments) {
    return segments.map((segment) => ({ ...segment, frames: frames.filter((frame) => frame.frame >= segment.start && frame.frame <= segment.end) }));
}

//* Experiments
async function oracleCheck(run, screenshot) {
    const result = await run({ scene: 'track' });
    const camera = result.frames.filter((frame) => isMotion(frame.segment) && !frame.segment.startsWith('scene'));
    const objectMotion = result.frames.filter((frame) => frame.segment.startsWith('scene'));
    console.log(COMPARE_HEADER);
    const summary = {
        cameraStatic: compareSummary(camera, 'static'),
        cameraProps: compareSummary(camera, 'props'),
        objectProps: compareSummary(objectMotion, 'props'),
    };
    printCompare('camera motion / static', summary.cameraStatic);
    printCompare('camera motion / props', summary.cameraProps);
    printCompare('props moving / props', summary.objectProps);
    await run({ scene: 'track', end: 60, view: 'audit-motion', heatCandidate: 3 });
    await screenshot('oracle-track-f60');
    return summary;
}

async function deformers(run, screenshot) {
    const result = await run({ scene: 'deformers' });
    console.log(COMPARE_HEADER);
    const summary = {};
    for (const name of Object.values(result.objects)) {
        summary[name] = compareSummary(result.frames, name);
        printCompare(name, summary[name]);
    }
    // The re-entry frames: the ball is drawn again after leaving the frustum.
    const reentry = result.frames
        .filter((frame) => frame.compare.reentry?.valid > 0)
        .map((frame) => ({ frame: frame.frame, error: frame.compare.reentry.candidates[1].meanError }))
        .sort((a, b) => b.error - a.error)
        .slice(0, 3);
    console.log(`  reentry: worst three frames ${reentry.map((row) => `${row.frame} (${fmt(row.error, 2, 0)} px)`).join(', ')}`);
    summary.audit = auditSummary(result.frames);
    printAudit('whole frame', summary.audit);
    for (const [view, candidate] of [['output', 1], ['audit-motion', 1], ['audit-motion', 3]]) {
        await run({ scene: 'deformers', end: 140, view, heatCandidate: candidate });
        await screenshot(`deformers-${view}${view === 'output' ? '' : `-${AUDIT[candidate]}`}-f140`);
    }
    return { summary, reentry };
}

async function cases(run) {
    const result = await run({ scene: 'cases' });
    const summary = {};
    console.log(COMPARE_HEADER);
    for (const name of Object.values(result.objects).filter((object) => object !== 'static'))
        for (const segment of bySegment(result.frames, result.segments)) {
            const key = `${name} ${segment.name}`;
            summary[key] = compareSummary(segment.frames, name);
            printCompare(key, summary[key]);
        }
    return summary;
}

async function ticks(run) {
    const summary = {};
    console.log(COMPARE_HEADER);
    for (const rendersPerTick of [1, 2, 4]) {
        const result = await run({ scene: 'track', rendersPerTick });
        const camera = result.frames.filter((frame) => isMotion(frame.segment) && !frame.segment.startsWith('scene'));
        summary[rendersPerTick] = compareSummary(camera, 'static');
        printCompare(`${rendersPerTick} render(s)/tick`, summary[rendersPerTick]);
    }
    return summary;
}

async function jitter(run) {
    // Still camera: the correct motion is zero everywhere once jitter is on.
    const summary = {};
    console.log(COMPARE_HEADER);
    for (const velocityProjection of ['stable', 'trap']) {
        const result = await run({ scene: 'track', end: 29, jitter: 10, velocityProjection, fresh: true });
        const after = result.frames.filter((frame) => frame.jittered);
        summary[velocityProjection] = compareSummary(after, 'static');
        printCompare(`jitter on, ${velocityProjection}`, summary[velocityProjection]);
    }
    return summary;
}

async function water(run, screenshot) {
    const result = await run({ scene: 'water' });
    console.log(COMPARE_HEADER);
    const summary = {};
    for (const name of Object.values(result.objects)) {
        summary[name] = compareSummary(result.frames, name);
        printCompare(name, summary[name]);
    }
    summary.audit = auditSummary(result.frames);
    printAudit('whole frame', summary.audit);
    for (const [view, candidate] of [['output', 1], ['audit', 3], ['audit-heat', 3]]) {
        await run({ scene: 'water', end: 120, view, heatCandidate: candidate });
        await screenshot(`water-${view}-f120`);
    }
    return summary;
}

async function track(run, screenshot) {
    const result = await run({ scene: 'track' });
    const rows = bySegment(result.frames, result.segments).map((segment) => ({
        segment: segment.name,
        static: compareSummary(segment.frames, 'static'),
        props: compareSummary(segment.frames, 'props'),
        audit: auditSummary(segment.frames),
    }));
    console.log('  segment              static: moved  three  camera  zero | props: moved  three  camera | warp: three  camera  oracle  zero');
    for (const row of rows) {
        const c = (summary, k) => summary?.candidates[k].error ?? null;
        const a = (k) => row.audit?.[k].residual ?? null;
        console.log(
            `  ${row.segment.padEnd(20)} ${fmt(row.static?.motion, 2, 7)} ${fmt(c(row.static, 1), 3, 6)} ${fmt(c(row.static, 2), 3, 7)} ${fmt(c(row.static, 0), 2, 6)} |` +
                ` ${fmt(row.props?.motion, 2, 6)} ${fmt(c(row.props, 1), 3, 6)} ${fmt(c(row.props, 2), 3, 7)} | ${fmt(a(1), 4, 7)} ${fmt(a(2), 4, 7)} ${fmt(a(3), 4, 7)} ${fmt(a(0), 4, 7)}`,
        );
    }
    for (const frame of [60, 510]) {
        await run({ scene: 'track', end: frame, view: 'output' });
        await screenshot(`track-output-f${frame}`);
    }
    return { segments: rows, maxEMD: Math.max(...result.frames.map((frame) => frame.cutEMD ?? 0)), maxJS: Math.max(...result.frames.map((frame) => frame.cutJS ?? 0)) };
}

async function cuts(run, screenshot) {
    const result = await run({ scene: 'cuts' });
    const series = result.frames.map((frame) => ({ frame: frame.frame, segment: frame.segment, cut: frame.cut, js: frame.cutJS, emd: frame.cutEMD }));
    const atCuts = series.filter((row) => row.cut);
    const events = bySegment(series.map((row) => ({ ...row })), result.segments)
        .filter((segment) => !segment.name.startsWith('cut-'))
        .map((segment) => ({
            segment: segment.name,
            maxEMD: Math.max(...segment.frames.map((row) => row.emd ?? 0)),
            maxJS: Math.max(...segment.frames.map((row) => row.js ?? 0)),
        }));
    // Cut segments without their cut frame (the holds after a cut).
    const afterCuts = series.filter((row) => row.segment.startsWith('cut-') && !row.cut);
    for (const row of atCuts) console.log(`  ${row.segment.padEnd(14)} frame ${String(row.frame).padStart(3)}   EMD ${fmt(row.emd)}   JS ${fmt(row.js)}`);
    for (const row of events) console.log(`  ${row.segment.padEnd(14)} max         EMD ${fmt(row.maxEMD)}   JS ${fmt(row.maxJS)}`);
    console.log(`  ${'after cuts'.padEnd(14)} max         EMD ${fmt(Math.max(...afterCuts.map((row) => row.emd ?? 0)))}   JS ${fmt(Math.max(...afterCuts.map((row) => row.js ?? 0)))}`);
    for (const frame of [29, 30, 60, 90]) {
        await run({ scene: 'cuts', end: frame, view: 'output' });
        await screenshot(`cuts-f${frame}`);
    }
    return { atCuts, events, series };
}

async function probe(run, screenshot) {
    const parsed = JSON.parse(cli.request ?? '{"scene":"deformers"}');
    const results = [];
    for (const request of Array.isArray(parsed) ? parsed : [parsed]) {
        const result = await run(request);
        console.log(`  ${JSON.stringify(request)}`);
        console.log(COMPARE_HEADER);
        for (const name of Object.values(result.objects)) printCompare(name, compareSummary(result.frames, name));
        printAudit('whole frame', auditSummary(result.frames));
        results.push(result);
    }
    await screenshot(cli.name ?? 'probe');
    return Array.isArray(parsed) ? results : results[0];
}

const EXPERIMENTS = { oracle: oracleCheck, deformers, cases, ticks, jitter, water, track, cuts, probe };

//* Harness
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
            viteServer = spawnVite('lab/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }
        profile = await mkdtemp(join(tmpdir(), 'motion-lab-'));
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
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json());
        client = await CDP.connect(created.webSocketDebuggerUrl);
        await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
        // Pin the viewport to the canvas, or headless Chrome clips its bottom rows.
        await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await client.send('Page.navigate', { url: `${server.origin}/index.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await client.evaluate('window.__motionLab?.ready === true')) === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the motion lab.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        const run = async (request) => {
            const result = await client.send(
                'Runtime.evaluate',
                { expression: `window.__motionLab.run(${JSON.stringify({ width, height, ...request })})`, awaitPromise: true, returnByValue: true },
                30 * 60 * 1000,
            );
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result.value;
        };
        const screenshot = async (name) => {
            const shot = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
            await writeFile(join(outputDirectory, `${name}.png`), Buffer.from(shot.data, 'base64'));
        };

        for (const experiment of experiments) {
            const measure = EXPERIMENTS[experiment];
            if (!measure) throw new Error(`Unknown experiment ${experiment}`);
            const started = Date.now();
            console.log(`\n== ${experiment}`);
            const record = await measure(run, screenshot);
            await writeFile(join(outputDirectory, `${experiment}.json`), `${JSON.stringify(record, null, 2)}\n`);
            console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        }
        const records = logs(client);
        await writeFile(join(outputDirectory, 'browser-log.txt'), `${records.join('\n')}\n`);
        if (records.some((line) => /error|exception|validation|invalid/i.test(line))) console.warn(`\nbrowser log:\n${records.join('\n')}`);
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

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
