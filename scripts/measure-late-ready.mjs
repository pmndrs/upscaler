#!/usr/bin/env node
/**
 * Late-readiness meter (NEXT-STEPS §18): drives bench/late-ready.html over CDP.
 * Optional passes (the shading-change detector, every-texel exposure metering)
 * compile asynchronously and switch in on whatever frame they become ready —
 * seconds late on Windows/DXC. The probe holds them inactive until `--release`
 * and compares three runs of one scenario, frame by frame, on the exact
 * rgba16float output (conditioned luma y/(1+y)):
 *
 * - `ref`  the passes active from frame 0
 * - `late` held until the release frame (what a slow compile does)
 * - `old`  `late` plus a history reset on the release frame (the pre-fix core)
 *
 * Per frame around the release: |late − ref| and |old − ref| (mean / max /
 * share of differing pixels), each run's own frame-to-frame churn, the stored
 * exposure, and the shading-change response (mean, share > 0.5). A switch-in
 * without a pop keeps `late`'s churn at the release frame at `ref`'s.
 * `--toggle a,b` turns detectShadingChanges off on frame a and back on at b
 * (runtime re-enable) instead of holding; the release is then b.
 *
 * Usage:
 *   node scripts/measure-late-ready.mjs --scenario Q12 --hold shadingChange --release 60
 *     [--end 75] [--ratio 2] [--runs ref,late,old] [--window 3,12] [--toggle 40,60]
 *     [--settings '{"autoExposure":false}'] [--label late] [--url ...] [--port 9353]
 *
 * Writes bench/results/raw/late-ready/<label>/late-ready.json.
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
const USAGE = `Usage: node scripts/measure-late-ready.mjs [options]
  --scenario <id>        bench scenario (default Q12)
  --hold <list>          shadingChange,everyTexel (default shadingChange)
  --release <frame>      first frame the held passes run (default 60)
  --toggle <a,b>         instead of holding: detectShadingChanges off on frame a, on again at b
  --end <frame>          last frame (default release + 15)
  --ratio <n>            upscale ratio (default 2)
  --runs <list>          ref,late,old (default all)
  --window <before,after> frames reported around the release (default 3,12)
  --settings <json>      RuntimeSettings overrides
  --label <name>         output folder (default late)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9353)
Writes bench/results/raw/late-ready/<label>/.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    ['scenario', 'hold', 'release', 'toggle', 'end', 'ratio', 'runs', 'window', 'settings', 'label', 'url', 'port'],
    USAGE,
);
const scenario = cli.scenario ?? 'Q12';
const toggle = cli.toggle ? cli.toggle.split(',').map(Number) : null;
const release = toggle ? toggle[1] : Number(cli.release ?? 60);
const hold = toggle ? [] : (cli.hold ?? 'shadingChange').split(',').filter(Boolean);
const end = Number(cli.end ?? release + 15);
const ratio = Number(cli.ratio ?? 2);
const runs = (cli.runs ?? 'ref,late,old').split(',').filter(Boolean);
const [before, after] = (cli.window ?? '3,12').split(',').map(Number);
const settings = cli.settings ? JSON.parse(cli.settings) : undefined;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9353;
const outputDirectory = join(ROOT, 'bench/results/raw/late-ready', cli.label ?? 'late');
const width = 1280;
const height = 720;
const keep = [Math.max(0, release - before - 1), Math.min(end, release + after)];

function request(run) {
    const base = { scenario, end, key: run, ratio, width, height, keep, settings };
    if (run === 'ref') return base;
    if (toggle) return { ...base, toggleShading: toggle, release, resetAtRelease: run === 'old' };
    return { ...base, hold, release, resetAtRelease: run === 'old' };
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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-late-ready-'));
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
        await client.send('Page.navigate', { url: `${server.origin}/late-ready.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await client.evaluate('window.__lateReadyProbe?.ready === true')) === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the late-ready probe.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        const evaluate = async (expression) => {
            const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 10 * 60 * 1000);
            if (result.exceptionDetails)
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result.value;
        };

        const frames = {};
        for (const run of runs) {
            const started = Date.now();
            frames[run] = (await evaluate(`window.__lateReadyProbe.run(${JSON.stringify(request(run))})`)).frames;
            console.log(`  ${run.padEnd(5)} ${frames[run].length} frames (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        }

        //* Report
        const what = toggle ? `detectShadingChanges off ${toggle[0]}–${toggle[1] - 1}` : `hold ${hold.join('+')}`;
        console.log(`\n${scenario} ratio ${ratio}, ${what}, release at frame ${release}` + (settings ? `, settings ${JSON.stringify(settings)}` : ''));
        const fmt = (value) => (value === undefined || value === null ? '      -' : value.toExponential(1).padStart(7));
        const header = ['frame', ...runs.filter((r) => r !== 'ref').map((r) => `|${r}−ref| mean/max/share`), ...runs.map((r) => `churn ${r}`), ...runs.map((r) => `exp ${r}`), ...runs.map((r) => `shade ${r}`)];
        console.log(header.join(' | '));
        const rows = [];
        for (let frame = keep[0] + 1; frame <= keep[1]; frame++) {
            const row = { frame, versus: {}, churn: {}, exposure: {}, shading: {} };
            const cells = [String(frame).padStart(5) + (frame === release ? '*' : ' ')];
            for (const run of runs.filter((r) => r !== 'ref')) {
                const value = runs.includes('ref') ? await evaluate(`window.__lateReadyProbe.compare(${JSON.stringify(`${run}:${frame}`)}, ${JSON.stringify(`ref:${frame}`)})`) : null;
                row.versus[run] = value;
                cells.push(value ? `${fmt(value.mean)}/${fmt(value.max)}/${value.share.toFixed(3)}` : '-');
            }
            for (const run of runs) {
                const record = frames[run][frame];
                row.churn[run] = record.churn;
                row.exposure[run] = record.exposure;
                row.shading[run] = { mean: record.shadingMean, firing: record.shadingFiring };
                cells.push(fmt(record.churn));
            }
            for (const run of runs) cells.push(frames[run][frame].exposure.toFixed(4));
            for (const run of runs) cells.push(`${fmt(frames[run][frame].shadingMean)}/${frames[run][frame].shadingFiring.toFixed(4)}`);
            console.log(cells.join(' | '));
            rows.push(row);
        }
        const record = { scenario, ratio, hold, toggle, release, end, settings, runs, rows, frames };
        const records = logs(client);
        record.browserLog = records;
        await writeFile(join(outputDirectory, 'late-ready.json'), `${JSON.stringify(record, null, 2)}\n`);
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

await main();
