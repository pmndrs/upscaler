#!/usr/bin/env node
/**
 * Split-frame encoder check (issue #96). A split frame recorded into one host
 * encoder (`encodeGuides` + `encodeUpscale`, one submit) must render exactly
 * what two submits render, and its guides stage must read its own constants.
 *
 * Drives bench/split-encoder.html (bench/src/probes/splitEncoder.ts): three
 * cores on one bare device fed the same procedural inputs for 12 frames, with
 * the rgba16float output and the r32float dilated depth read back and compared
 * texel by texel. Three cases:
 * - same-constants: both stages stage identical constants;
 * - late-only-inputs: a reactive mask and a reset only the late stage sees;
 * - isolation: the late stage is handed a different camera `far`, so a guides
 *   stage that reads the late constants shows up in the dilated depth. On the
 *   single shared constants buffer this case fails on every texel.
 * Passes when every count is 0, the output is not blank and no WebGPU error
 * was reported. Exits 1 otherwise.
 *
 * Usage:
 *   node scripts/verify-split-encoder.mjs [--software]
 *     [--url http://127.0.0.1:5199] [--port 9333] [--chrome <path>]
 *
 * --software adds Chrome's SwiftShader flag, for machines with no GPU. The
 * comparison is exact either way; run without it for evidence on a real GPU.
 * Starts the bench dev server on --url's port if nothing answers there.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import {
    DEFAULT_BENCH_URL,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

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
    console.log(`Usage: node scripts/verify-split-encoder.mjs [options]
  --software        run on Chrome's software adapter (no GPU needed)
  --url <origin>    bench origin (default ${DEFAULT_BENCH_URL})
  --port <n>        Chrome DevTools (CDP) port (default 9333)
  --chrome <path>   browser executable (default: CHROME_PATH, then a system Chrome/Edge)`);
    process.exit(0);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9333;

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
        profile = join(tmpdir(), `upscaler-split-encoder-${process.pid}-${Date.now()}`);
        chrome = spawn(
            browserExecutable(typeof cli.chrome === 'string' ? cli.chrome : undefined),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                ...(cli.software ? ['--enable-unsafe-swiftshader'] : []),
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        await waitForUrl(`http://127.0.0.1:${port}/json/version`);
        const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = await CDP.connect(target.webSocketDebuggerUrl);
        await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);

        await client.send('Page.navigate', { url: new URL('/split-encoder.html', server.origin).href });
        for (let attempt = 0; ; attempt++) {
            const ready = await client.evaluate('typeof window.__splitEncoderProbe?.run === "function"').catch(() => false);
            if (ready === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__splitEncoderProbe.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        const report = await client.evaluate('window.__splitEncoderProbe.run()');

        // WGSL and validation failures surface as browser log entries. Network
        // entries are the page's missing favicon; a missing module never gets
        // this far (the probe would not have loaded).
        const logs = client.events
            .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.source !== 'network')
            .filter((event) => /error|warning/.test(event.params.entry.level))
            .map((event) => event.params.entry.text);
        const problems = [...report.errors, ...logs];

        console.log(`adapter: ${report.adapter || 'unknown'} · ${report.frames} frames`);
        console.log('case               mono≠two  one≠two  guide depth one≠two  non-zero/frame');
        let failed = problems.length > 0;
        for (const row of report.cases) {
            const bad = row.monoVsTwo + row.oneVsTwo + row.guideDepthOneVsTwo > 0 || row.nonZeroPerFrame === 0;
            failed ||= bad;
            console.log(
                `${row.name.padEnd(18)} ${String(row.monoVsTwo).padStart(8)} ${String(row.oneVsTwo).padStart(8)} ` +
                    `${String(row.guideDepthOneVsTwo).padStart(20)} ${String(row.nonZeroPerFrame).padStart(15)}` +
                    (bad ? '  FAIL' : ''),
            );
        }
        if (problems.length) console.error(`WebGPU / browser errors:\n${[...new Set(problems)].join('\n')}`);
        console.log(failed ? 'FAIL' : 'PASS: one encoder renders what two submits render');
        process.exitCode = failed ? 1 : 0;
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
