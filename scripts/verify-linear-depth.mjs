#!/usr/bin/env node
/**
 * Linear view-depth input check (issue #97). The same scene fed as hardware
 * depth and as linear view depth (`depthMode: 'linear'`) must produce the same
 * guides and output, within the precision of the encoding.
 *
 * Drives bench/linear-depth.html (bench/src/probes/linearDepth.ts): the
 * raw-WebGPU example's scene over 48 moving frames (orbit + dolly + moving
 * cubes), its depth re-expressed as every encoding, one core per encoding,
 * with the r32float dilated depth, the disocclusion guide and the rgba16float
 * output read back and compared texel by texel against positive linear depth
 * (r32float). Then reconstruct's GPU time per mode (ABBA, `gpuTiming`).
 *
 * Passes when:
 * - negative view Z and the guides path are bit-identical to the reference;
 * - every 32-bit encoding (hardware standard / reversed / orthographic, linear
 *   with a 0 / inf / NaN background) keeps the dilated depth within 1e-4
 *   relative of it (16-bit encodings are reported, not gated);
 * - the reference is not blank and no WebGPU error was reported.
 * Exits 1 otherwise.
 *
 * Usage:
 *   node scripts/verify-linear-depth.mjs [--software]
 *     [--url http://127.0.0.1:5199] [--port 9333] [--chrome <path>]
 *
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
    closeOwnedCdpBrowser,
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
    console.log(`Usage: node scripts/verify-linear-depth.mjs [options]
  --software        run on Chrome's software adapter (no GPU needed)
  --url <origin>    bench origin (default ${DEFAULT_BENCH_URL})
  --port <n>        Chrome DevTools (CDP) port (default 9333)
  --chrome <path>   browser executable (default: CHROME_PATH, then a system Chrome/Edge)`);
    process.exit(0);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9333;

const EXACT = new Set(['linear -z (view Z)', 'linear +z guides path']);
const MAX_RELATIVE_DEPTH = 1e-4;

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
        profile = join(tmpdir(), `upscaler-linear-depth-${process.pid}-${Date.now()}`);
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

        await client.send('Page.navigate', { url: new URL('/linear-depth.html', server.origin).href });
        for (let attempt = 0; ; attempt++) {
            const ready = await client.evaluate('typeof window.__linearDepthProbe?.run === "function"').catch(() => false);
            if (ready === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__linearDepthProbe.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        const report = await client.evaluate('window.__linearDepthProbe.run()');

        // WGSL and validation failures surface as browser log entries.
        const logs = client.events
            .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.source !== 'network')
            .filter((event) => /error|warning/.test(event.params.entry.level))
            .map((event) => event.params.entry.text);
        const problems = [...report.errors, ...logs];

        const { render, display } = report.texelsPerFrame;
        console.log(`adapter: ${report.adapter || 'unknown'} · ${report.frames} frames · ` +
            `render ${render} texels, display ${display} texels per frame`);
        console.log(`reference: ${report.reference.disoccludedPerFrame} disoccluded texels/frame, ` +
            `${report.reference.nonZeroOutputPerFrame} non-zero output components/frame`);
        console.log('vs linear +z r32float (all frames)   depth≠  max|Δ|    max rel   disocc≠ max|Δ|  output≠  max|Δ|    mean|Δ|');
        let failed = problems.length > 0 || report.reference.disoccludedPerFrame === 0 ||
            report.reference.nonZeroOutputPerFrame === 0;
        const exp = (value) => value.toExponential(1).padStart(8);
        for (const row of report.cases.slice(1)) {
            const sixteenBit = /16float/.test(row.name);
            const bad = EXACT.has(row.name)
                ? row.depthMismatches + row.disocclusionMismatches + row.outputMismatches > 0
                : !sixteenBit && row.depthMaxRel > MAX_RELATIVE_DEPTH;
            failed ||= bad;
            console.log(
                `${row.name.padEnd(36)} ${String(row.depthMismatches).padStart(6)} ${exp(row.depthMaxAbs)} ${exp(row.depthMaxRel)} ` +
                    `${String(row.disocclusionMismatches).padStart(8)} ${row.disocclusionMaxAbs.toFixed(3)} ` +
                    `${String(row.outputMismatches).padStart(8)} ${exp(row.outputMaxAbs)} ${exp(row.outputMeanAbs)}` +
                    (bad ? '  FAIL' : sixteenBit ? '  (not gated)' : ''),
            );
        }
        if (report.timing) {
            const { hardwareMicros, linearMicros, samples } = report.timing;
            console.log(`reconstruct GPU time (${samples} ABBA frame pairs): hardware ${hardwareMicros.toFixed(1)} µs, ` +
                `linear ${linearMicros.toFixed(1)} µs (${(linearMicros - hardwareMicros >= 0 ? '+' : '')}` +
                `${(linearMicros - hardwareMicros).toFixed(1)} µs, ` +
                `${(((linearMicros / hardwareMicros) - 1) * 100).toFixed(1)}% of hardware)`);
        } else {
            console.log('reconstruct GPU time: timestamp-query unavailable');
        }
        if (problems.length) console.error(`WebGPU / browser errors:\n${[...new Set(problems)].join('\n')}`);
        console.log(failed ? 'FAIL' : 'PASS: linear view depth matches hardware depth');
        process.exitCode = failed ? 1 : 0;
    } finally {
        // On Windows the browser can outlive its launcher process, so close it over CDP first.
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
