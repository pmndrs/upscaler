import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { spawnVite, waitForUrl, stopChild, removeTempDirectory } from './local-processes.mjs';

const fork = resolve(import.meta.dirname, '..');
const upstream = process.argv[2];
if (!upstream) throw new Error('Usage: node scripts/measure-core-extraction.mjs <clean-upstream-v0.5.0-root>');
const profile = mkdtempSync(join(tmpdir(), 'upscaler-extraction-perf-'));
const upstreamServer = spawn(process.execPath, [join(resolve(upstream), 'node_modules/vite/bin/vite.js'), '--config', 'bench/vite.config.ts', '--host', '127.0.0.1', '--port', '5431', '--strictPort'], { cwd: resolve(upstream), windowsHide: true, stdio: 'ignore' });
const forkServer = spawnVite('bench/vite.config.ts', { hostname: '127.0.0.1', port: 5432 });
let chrome; let client;
const arms = []; const analysis = [];
try {
    await Promise.all([waitForUrl('http://127.0.0.1:5431/timer-overhead.html', { child: upstreamServer }), waitForUrl('http://127.0.0.1:5432/timer-overhead.html', { child: forkServer })]);
    chrome = spawn(browserExecutable(), ['--headless=new', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9550', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    await waitForUrl('http://127.0.0.1:9550/json/version');
    const target = await (await fetch('http://127.0.0.1:9550/json/new?about:blank', { method: 'PUT' })).json();
    client = await CDP.connect(target.webSocketDebuggerUrl); await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Page.bringToFront');
    for (const ratio of [1, 1.5, 2, 3]) {
        for (let block = 0; block < 4; block++) {
            for (const role of ['A1', 'B1', 'B2', 'A2']) {
                const port = role.startsWith('A') ? 5431 : 5432;
                await client.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/timer-overhead.html' });
                for (let i = 0; i < 900; i++) {
                    if (await client.evaluate('window.__timerOverhead?.ready')) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const request = { path: 'temporal', ratio, mode: 'dispatch', width: 1280, height: 720, frames: 600, warmup: 240, blocks: 1, inflight: 3, attachOnly: false };
                const result = await client.send('Runtime.evaluate', { expression: 'window.__timerOverhead.run(' + JSON.stringify(request) + ')', awaitPromise: true, returnByValue: true }, 180000);
                if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
                const value = result.result.value;
                const errors = await client.evaluate('window.__timerOverhead.errors'); if (errors.length) throw new Error(errors.join('\n'));
                // Retain the whole upstream on/off probe, but compare only its disabled legs.
                const disabled = value.blocks[0].filter(leg => !leg.timing);
                if (disabled.some(leg => leg.timedFrames !== 0)) throw new Error('Profiling unexpectedly active.');
                arms.push({ ratio, block, role, disabled, result: value });
                console.log('ratio ' + ratio + ', block ' + (block + 1) + ', ' + role + ': off = ' + disabled.map(leg => leg.msPerFrame.toFixed(3)).join('/') + ' ms');
            }
        }
        const values = arms.filter(arm => arm.ratio === ratio);
        const median = entries => { const ordered = entries.sort((a,b) => a-b); return ordered[Math.floor(ordered.length / 2)]; };
        const upstreamMs = median(values.filter(a => a.role.startsWith('A')).flatMap(a => a.disabled.map(l => l.msPerFrame)));
        const forkMs = median(values.filter(a => a.role.startsWith('B')).flatMap(a => a.disabled.map(l => l.msPerFrame)));
        const noise = median(values.filter(a => a.role === 'A1').map(a => Math.abs(a.disabled[0].msPerFrame - values.find(b => b.block === a.block && b.role === 'A2').disabled[0].msPerFrame)));
        analysis.push({ ratio, upstreamMs, forkMs, relativeChange: forkMs / upstreamMs - 1, noiseMs: noise, regressionAboveObservedNoise: forkMs - upstreamMs > noise });
    }
    const output = join(fork, 'bench/results/windows-local/extraction-performance'); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'report.json'), JSON.stringify({ protocol: 'cross-build ABBA, 4 blocks, 240 warmup, 600 samples per leg; upstream off legs only; wall/CPU timings, not per-pass GPU acceptance', arms, analysis }, null, 2));
    console.log(JSON.stringify(analysis, null, 2));
} finally {
    await client?.send('Browser.close', {}, 3000).catch(() => {}); client?.close();
    await stopChild(chrome); await stopChild(upstreamServer); await stopChild(forkServer); await removeTempDirectory(profile, 'extraction performance Chrome profile');
}
