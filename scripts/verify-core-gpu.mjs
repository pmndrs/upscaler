import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { spawnVite, waitForUrl, stopChild, closeOwnedCdpBrowser, removeTempDirectory } from './local-processes.mjs';
import { npmInvocation } from './npm-command.mjs';
import { parsePackJson } from './npm-pack-json.mjs';

const root = resolve(import.meta.dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'upscaler-core-gpu-'));
const packed = process.argv.includes('--packed');
const consumer = packed ? mkdtempSync(join(tmpdir(), 'upscaler-core-consumer-')) : undefined;
let packageEntry;
if (consumer) {
    const result = spawnSync(...npmInvocation(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer]), { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    const [artifact] = parsePackJson(result.stdout);
    const unpack = spawnSync('tar', ['-xzf', join(consumer, artifact.filename), '-C', consumer], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(unpack.stderr);
    symlinkSync(join(root, 'node_modules'), join(consumer, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    packageEntry = join(consumer, 'package/dist/index.js');
}
const server = spawnVite('examples/vite.config.ts', { hostname: '127.0.0.1', port: 5424 }, {
    windowsHide: true, extra: packed ? ['--mode', 'package-consumer'] : [],
    env: { ...process.env, ...(packageEntry ? { UPSCALER_PACKAGE_ENTRY: packageEntry } : {}) },
});
let chrome; let client;
const report = [];
const failureEvents = c => c.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').map(e => JSON.stringify(e.params));
async function waitFrames(minimum = 12) {
    for (let i = 0; i < 1800; i++) {
        if (await client.evaluate('window.__UpscalerDemo?.frames >= ' + minimum)) return;
        const failures = failureEvents(client); if (failures.length) throw new Error(failures.join('\n'));
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Demo did not render: ' + JSON.stringify(await client.evaluate('({status:document.querySelector("#status")?.textContent,frames:window.__UpscalerDemo?.frames})')) + failureEvents(client).join('\n'));
}
try {
    await waitForUrl('http://127.0.0.1:5424/17-core-webgpu/index.html', { child: server });
    const occupied = await fetch('http://127.0.0.1:9545/json/version', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (occupied) throw new Error('CDP port 9545 is already in use.');
    chrome = spawn(browserExecutable(), ['--headless=new', '--enable-automation', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9545', '--user-data-dir=' + profile, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    await waitForUrl('http://127.0.0.1:9545/json/version');
    const version = await (await fetch('http://127.0.0.1:9545/json/version')).json();
    const identity = await CDP.connect(version.webSocketDebuggerUrl);
    try {
        const command = await identity.send('Browser.getBrowserCommandLine');
        if (!command.arguments.includes('--user-data-dir=' + profile)) throw new Error('CDP port 9545 belongs to another browser.');
    } finally { identity.close(); }
    const target = await (await fetch('http://127.0.0.1:9545/json/new?about:blank', { method: 'PUT' })).json();
    client = await CDP.connect(target.webSocketDebuggerUrl); await client.send('Runtime.enable'); await client.send('Page.enable'); await client.send('Page.bringToFront');
    for (const example of ['17-core-webgpu', '18-babylon-framegraph']) {
        client.events.length = 0;
        await client.send('Page.navigate', { url: 'http://127.0.0.1:5424/' + example + '/index.html' });
        await waitFrames();
        for (const [host, conditioning] of [[false, false], [true, false], [false, true], [true, true]]) {
            await client.evaluate("document.querySelector('#host').checked=" + host + ";document.querySelector('#conditioning').checked=" + conditioning + ";window.__UpscalerDemo.reset();");
            const start = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(start + 70);
            const probe = await client.evaluate('window.__UpscalerDemo.probe()');
            if (!probe.finite || probe.max <= 0 || probe.alphaMin >= 1) throw new Error('Invalid output: ' + JSON.stringify(probe));
            report.push({ example, host, conditioning, probe });
        }
        if (example.startsWith('18')) {
            for (const optimize of [false, true]) {
                await client.evaluate('window.__UpscalerDemo.resize(967,543,' + optimize + ')');
                let start = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(start + 12);
                await client.evaluate("document.querySelector('#enabled').checked=false"); start = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(start + 8);
                const fallback = await client.evaluate('window.__UpscalerDemo.probe()');
                await client.evaluate("document.querySelector('#enabled').checked=true"); start = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(start + 16);
                const reactivated = await client.evaluate('window.__UpscalerDemo.probe()');
                if (!fallback.finite || !reactivated.finite || fallback.max <= 0 || reactivated.max <= 0) throw new Error('Undefined disabled/reactivated output.');
                report.push({ example, optimize, fallback, reactivated });
            }
        } else {
            report.push({ example, paths: await client.evaluate('window.__UpscalerDemo.exercisePaths()') });
            await client.evaluate('window.__UpscalerDemo.resize(967,543)'); const start = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(start + 12);
            report.push({ example, resized: await client.evaluate('window.__UpscalerDemo.probe()') });
        }
        await client.evaluate(example.startsWith('18') ? 'window.__UpscalerDemo.resize(961,539,true,1)' : 'window.__UpscalerDemo.resize(961,539,1)');
        const nativeStart = await client.evaluate('window.__UpscalerDemo.frames'); await waitFrames(nativeStart + 16);
        const nativeAA = await client.evaluate('window.__UpscalerDemo.probe()');
        if (!nativeAA.finite || nativeAA.max <= 0) throw new Error('Invalid NativeAA output.');
        report.push({ example, nativeAA, packed });
        const errors = await client.evaluate('window.__UpscalerDemo.errors');
        if (errors.length || failureEvents(client).length) throw new Error([...errors, ...failureEvents(client)].join('\n'));
        console.log(example + ': ' + (packed ? 'packed artifact, ' : '') + 'GPU exposures, finite HDR/alpha, odd resize, NativeAA' + (example.startsWith('18') ? ', alias optimization and disabled/reactivated history' : '') + ' pass.');
    }
    mkdirSync(join(root, 'bench/results/windows-local/core-gpu'), { recursive: true });
    writeFileSync(join(root, 'bench/results/windows-local/core-gpu/report.json'), JSON.stringify(report, null, 2));
} finally {
    await closeOwnedCdpBrowser(client);
    await stopChild(chrome); await stopChild(server); await removeTempDirectory(profile, 'core GPU Chrome profile');
    await removeTempDirectory(consumer, 'core GPU package consumer');
}
