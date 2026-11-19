#!/usr/bin/env node
/**
 * GPU reset-signal meter (issue #102): drives bench/reset-signal.html over CDP
 * through Q10's camera cut (frame 60) under four reset modes and compares the
 * exact rgba16float output, frame by frame:
 *
 * - `none`      never reset (what a consumer without a cut signal gets)
 * - `scripted`  dispatch({ reset: true }) on the scenario's reset frames
 * - `gpu`       dispatch({ resetTexture }) fed @pmndrs/motion-vectors'
 *               CutDetector flag every frame — no readback
 * - `zero`      resetTexture bound to an explicit all-zero texture
 *
 * Pass criteria: `gpu` hashes equal `scripted` on every frame (the detector
 * fires exactly on the cut, never elsewhere); `zero` equals `none` (a bound
 * but unset signal changes nothing); the disocclusion guide reads 1 on a reset
 * frame. `--reference <file>` compares the hashes against an earlier run's
 * JSON (e.g. one made on main) and reports any frame that differs.
 *
 * Usage:
 *   node scripts/measure-reset-signal.mjs [--end 119] [--ratio 2]
 *     [--modes none,scripted,gpu,zero] [--label reset] [--reference <json>]
 *     [--url http://127.0.0.1:5199] [--port 9334]
 *
 * Writes bench/results/raw/reset/<label>/reset.json.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const USAGE = `Usage: node scripts/measure-reset-signal.mjs [options]
  --end <frame>          last Q10 frame (default 119: the cut at 60, no resizes)
  --ratio <n>            upscale ratio (default 2)
  --modes <list>         none,scripted,gpu,zero (default: all); mode@split, mode@guides
                         drive the split frame / guides path, mode#n repeats a mode
  --label <name>         output folder (default reset)
  --reference <file>     earlier reset.json to compare hashes against
  --timing 1             record per-pass GPU ms per frame (median per pass printed)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); started if nothing answers
  --port <n>             Chrome DevTools port (default 9334)
Writes bench/results/raw/reset/<label>/.`;
const cli = parseCliOrExit(process.argv.slice(2), ['end', 'ratio', 'modes', 'label', 'reference', 'url', 'port', 'timing'], USAGE);
const end = Number(cli.end ?? 119);
const ratio = Number(cli.ratio ?? 2);
const modes = (cli.modes ?? 'none,scripted,gpu,zero').split(',').filter(Boolean);
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9334;
const outputDirectory = join(ROOT, 'bench/results/raw/reset', cli.label ?? 'reset');
const KEEP = [59, 66];
const width = 1280;
const height = 720;

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
        profile = await mkdtemp(join(tmpdir(), 'upscaler-reset-'));
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
        await client.send('Page.navigate', { url: `${server.origin}/reset-signal.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await client.evaluate('window.__resetProbe?.ready === true')) === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for the reset probe.\n${logs(client).join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        const evaluate = async (expression) => {
            const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 10 * 60 * 1000);
            if (result.exceptionDetails)
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result.value;
        };

        const runs = {};
        for (const mode of modes) {
            const started = Date.now();
            // `mode#n` repeats a mode under its own key (run-to-run determinism);
            // `mode@split` / `mode@guides` drive the split frame / guides path.
            const [name, path] = mode.split('#')[0].split('@');
            const request = { scenario: 'Q10', end, mode: name, path, key: mode, ratio, width, height, keep: KEEP, timing: cli.timing === '1' };
            runs[mode] = (await evaluate(`window.__resetProbe.run(${JSON.stringify(request)})`)).frames;
            console.log(`  ${mode.padEnd(9)} ${runs[mode].length} frames (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        }

        //* Report
        const record = { end, ratio, modes, runs, comparisons: {} };
        const differing = (a, b) => runs[a] && runs[b] ? runs[a].filter((frame, index) => frame.hash !== runs[b][index].hash).map((frame) => frame.frame) : null;
        // Repeats and split frames compare against their base mode; the guides
        // path hashes the disocclusion guide, so it compares within itself.
        const repeats = modes
            .filter((mode) => /[#@]/.test(mode) && !mode.includes('@guides'))
            .map((mode) => [mode, mode.split('#')[0].split('@')[0]]);
        if (modes.includes('gpu@guides') && modes.includes('scripted@guides')) repeats.push(['gpu@guides', 'scripted@guides']);
        for (const [a, b] of [['gpu', 'scripted'], ['zero', 'none'], ['gpu', 'none'], ['scripted', 'none'], ...repeats]) {
            const frames = differing(a, b);
            if (frames === null) continue;
            record.comparisons[`${a}~${b}`] = frames;
            console.log(`  ${`${a} vs ${b}`.padEnd(20)} frames differing: ${frames.length ? `${frames.length} (${frames[0]}..${frames.at(-1)})` : 'none (byte-identical)'}`);
        }
        const meanAbs = {};
        for (const [a, b] of [['gpu', 'scripted'], ['none', 'scripted'], ['zero', 'none'], ...repeats]) {
            if (!runs[a] || !runs[b] || a.includes('@guides')) continue;
            const values = [];
            for (let frame = KEEP[0]; frame <= Math.min(KEEP[1], end); frame++)
                values.push(await evaluate(`window.__resetProbe.compare(${JSON.stringify(`${a}:${frame}`)}, ${JSON.stringify(`${b}:${frame}`)})`));
            meanAbs[`${a}~${b}`] = values;
            console.log(`  |${a} − ${b}| frames ${KEEP[0]}–${KEEP[1]} (mean / max / px): ${values.map((v) => `${v.mean.toExponential(1)}/${v.max.toExponential(1)}/${v.pixels}`).join('  ')}`);
        }
        record.meanAbs = meanAbs;
        const detector = runs.gpu ?? runs.none ?? Object.values(runs)[0];
        const fired = detector.filter((frame) => frame.cut).map((frame) => frame.frame);
        const quiet = detector.filter((frame) => !frame.cut && frame.frame > 0);
        console.log(`  detector fired on ${JSON.stringify(fired)}; max share elsewhere ${Math.max(...quiet.map((f) => f.share)).toFixed(4)}; cut-frame share ${detector.find((f) => f.frame === 60)?.share.toFixed(4)}`);
        for (const mode of modes) {
            const at = (frame) => runs[mode].find((f) => f.frame === frame)?.disocclusion.toFixed(4);
            console.log(`  ${mode.padEnd(9)} disocclusion mean: f59 ${at(59)}  f60 ${at(60)}  f61 ${at(61)}`);
        }
        if (cli.timing === '1') {
            const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
            for (const mode of modes) {
                const timed = runs[mode].slice(10).map((frame) => frame.timings).filter((t) => t && Object.keys(t).length);
                const passes = [...new Set(timed.flatMap((t) => Object.keys(t)))];
                const row = passes.map((pass) => `${pass} ${(1000 * median(timed.map((t) => t[pass] ?? 0))).toFixed(1)}`);
                console.log(`  ${mode.padEnd(9)} median µs: ${row.join('  ')}`);
            }
        }
        if (cli.reference) {
            const reference = JSON.parse(await readFile(cli.reference, 'utf8'));
            for (const mode of modes) {
                const other = reference.runs?.[mode];
                if (!other) continue;
                const frames = runs[mode].filter((frame, index) => other[index] && frame.hash !== other[index].hash).map((f) => f.frame);
                record.comparisons[`${mode}~reference`] = frames;
                console.log(`  ${mode.padEnd(9)} vs reference: ${frames.length ? `${frames.length} frames differ (${frames.join(',')})` : 'byte-identical'}`);
            }
        }
        const records = logs(client);
        record.browserLog = records;
        await writeFile(join(outputDirectory, 'reset.json'), `${JSON.stringify(record, null, 2)}\n`);
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
