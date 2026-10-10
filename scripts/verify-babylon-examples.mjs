// Exercises the built site (including Babylon's lazy shader chunks), not Vite dev.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { spawnVite, waitForUrl, stopChild, closeOwnedCdpBrowser, removeTempDirectory } from './local-processes.mjs';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(join(root, 'examples/dist/19-babylon-hello/index.html'), 'utf8');
const base = html.match(/(?:src|href)="([^" ]*)assets\//)?.[1] ?? '/';
const origin = 'http://127.0.0.1:5428';
const profile = mkdtempSync(join(tmpdir(), 'upscaler-babylon-scenes-'));
const server = spawnVite('examples/vite.config.ts', { hostname: '127.0.0.1', port: 5428 }, { windowsHide: true, extra: ['preview'], env: { ...process.env, PAGES_BASE: base } });
const artifacts = join(root, 'output/playwright/babylon-scenes'); mkdirSync(artifacts, { recursive: true });
let chrome, client;
const report = [];
function failures() {
    return client.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' || e.method === 'Network.responseReceived' && e.params.response.status >= 400).map(e => e.method === 'Network.responseReceived' ? `${e.params.response.status} ${e.params.response.url}` : JSON.stringify(e.params));
}
async function waitFrames(target = 20) {
    for (let i = 0; i < 900; i++) {
        assert.deepEqual(failures(), [], 'Browser/HTTP error');
        if (await client.evaluate(`window.__BabylonSceneDemo?.frames >= ${target}`)) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('No rendered frames: ' + await client.evaluate("document.querySelector('#status')?.textContent"));
}
async function settle(count = 24) { await waitFrames(await client.evaluate('window.__BabylonSceneDemo.frames') + count); }
async function probe() {
    const value = await client.evaluate('window.__BabylonSceneDemo.probe()');
    for (const key of ['output', 'depth', 'motion', 'reactive', 'native']) assert.ok(value[key].finite, key + ' must be finite');
    assert.ok(value.output.max > 0.1 && value.output.meanAbs > 0.01, 'Nonempty output');
    assert.ok(value.output.max - value.output.min > 0.1, 'The scene must have RGB contrast');
    assert.ok(value.depth.min > 0 && value.depth.max <= 120, 'Finite positive depth, including background');
    assert.deepEqual(await client.evaluate('window.__BabylonSceneDemo.errors'), []);
    assert.deepEqual(failures(), []);
    return value;
}
try {
    await waitForUrl(origin + base, { child: server });
    const occupied = await fetch('http://127.0.0.1:9548/json/version', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    assert.equal(occupied, false, 'CDP port 9548 is already in use.');
    chrome = spawn(browserExecutable(), ['--headless=new', '--enable-automation', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9548', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    await waitForUrl('http://127.0.0.1:9548/json/version');
    const version = await (await fetch('http://127.0.0.1:9548/json/version')).json();
    const identity = await CDP.connect(version.webSocketDebuggerUrl);
    try {
        const command = await identity.send('Browser.getBrowserCommandLine');
        assert.ok(command.arguments.includes('--user-data-dir=' + profile), 'CDP port 9548 belongs to another browser.');
    } finally { identity.close(); }
    const target = await (await fetch('http://127.0.0.1:9548/json/new?about:blank', { method: 'PUT' })).json();
    client = await CDP.connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable'); await client.send('Network.enable'); await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    const examples = ['19-babylon-hello', '20-babylon-aliasing', '21-babylon-compare', '22-babylon-transparency', '23-babylon-spatial-temporal', '24-babylon-compose', '25-babylon-reactive-mask', '26-babylon-transparent-canvas', '27-babylon-screen-effects', '28-babylon-effect-stack', '29-babylon-temporal-guides', '30-babylon-guides-compose'];
    for (const example of examples) {
        if (process.env.BABYLON_EXAMPLES && !process.env.BABYLON_EXAMPLES.split(',').some(prefix => example.startsWith(prefix))) continue;
        client.events.length = 0;
        await client.send('Page.navigate', { url: origin + base + example + '/' }); await waitFrames();
        const moving = await probe();
        await client.evaluate("document.querySelector('#objects').checked = false"); await settle();
        const stationary = await probe();
        if (example.includes('hello')) assert.ok(stationary.output.cyanY > 0 && stationary.output.cyanY < stationary.output.amberY, 'The higher cyan knot must appear above the lower amber cube (offscreen Y orientation)');
        assert.ok(stationary.motion.meanAbs < 1e-6, 'Static scene motion must exclude jitter: ' + stationary.motion.meanAbs);
        assert.ok(moving.motion.meanAbs > stationary.motion.meanAbs, 'Moving meshes must publish motion');
        await client.evaluate("document.querySelector('#camera').checked = true"); await settle();
        const camera = await probe();
        // A transparent canvas has mostly zero-motion background. Whole-frame
        // averaging dilutes valid foreground motion below the threshold on fast
        // GPUs. Use the existing spatial regions and also reject jitter residue.
        const cameraMotion = Math.max(...camera.motion.regions.map(Math.abs));
        const staticMotion = Math.max(...stationary.motion.regions.map(Math.abs));
        assert.ok(cameraMotion > 1e-6 && cameraMotion > staticMotion * 10, `Camera motion must exceed stationary jitter in a scene region: ${cameraMotion} vs ${staticMotion}`);
        await client.evaluate("document.querySelector('#camera').checked = false"); await settle();
        if (example.includes('transparency') || example.includes('reactive-mask')) {
            assert.ok(camera.reactive.max > 0.1 && camera.reactive.meanAbs > 0.0001, 'Transparent geometry must generate reactivity');
            if (example.includes('reactive-mask')) assert.equal(camera.reactive.max, 1, 'Authored white coverage must reach one');
            await client.evaluate("document.querySelector('#reactive').checked = false"); await settle();
            assert.equal((await probe()).reactive.max, 0, 'Disabled mask must be zero');
            await client.evaluate("document.querySelector('#reactive').checked = true");
            if (example.includes('reactive-mask')) {
                await client.evaluate("document.querySelector('#show-mask').checked = true"); await settle(3);
                writeFileSync(join(artifacts, 'authored-mask.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
                await client.evaluate("document.querySelector('#show-mask').checked = false");
            }
        } else assert.equal(stationary.reactive.max, 0);
        if (example.includes('compare') || example.includes('spatial-temporal')) {
            assert.ok(Math.abs(stationary.native.meanAbs - stationary.output.meanAbs) < 0.05, 'Native and reconstructed images must use the same brightness');
            for (const value of [0, 100, 50]) { await client.evaluate(`document.querySelector('#split').value = ${value}`); await settle(2); }
        }
        if (example === '24-babylon-compose') {
            assert.ok(stationary.presented.meanAbs < stationary.output.meanAbs * 0.98, 'Vignette must change the composed image');
            await client.evaluate("document.querySelector('#composition').checked = false"); await settle(4);
            const identity = await probe(); assert.equal(identity.presented.meanAbs, identity.output.meanAbs, 'Disabled composition must preserve RGB exactly');
            assert.deepEqual(identity.presented.alpha, identity.output.alpha, 'Composition preserves alpha');
            await client.evaluate("document.querySelector('#composition').checked = true");
        }
        if (example.includes('guides')) {
            assert.equal(stationary.guides.length, 3);
            assert.ok(stationary.guides.every(guide => guide.finite), 'Published guides must be finite');
            assert.ok(stationary.guides[0].min > 0 && stationary.guides[0].max <= 120, 'Current dilated depth must be positive');
            assert.ok(stationary.guides[1].meanAbs < 1e-6, 'Static dilated motion must exclude jitter');
            assert.ok(camera.guides[1].meanAbs > 1e-6, 'Published guides must contain current camera motion');
            assert.ok(stationary.guides[2].min >= 0 && stationary.guides[2].max <= 1, 'Disocclusion guide must be normalized');
            if (example.includes('compose')) {
                assert.ok(Math.abs(camera.input.meanAbs - camera.conditioned.meanAbs) > 1e-5, 'Disocclusion tint must affect the input color');
                await client.evaluate("document.querySelector('#guide-tint').checked = false"); await settle(4);
                const neutral = await probe(); assert.equal(neutral.input.meanAbs, neutral.conditioned.meanAbs, 'Disabled guide tint must preserve input RGB');
                assert.deepEqual(neutral.input.alpha, neutral.conditioned.alpha);
                await client.evaluate("document.querySelector('#guide-tint').checked = true");
            }
        }
        if (example.includes('screen-effects') || example.includes('effect-stack')) {
            const stack = example.includes('effect-stack');
            // Remove jitter while comparing individual spatial effects, so their
            // differences cannot come from a different subpixel sample.
            await client.evaluate("document.querySelector('#mode').value = 'bilinear'");
            const select = async effect => {
                await client.evaluate(stack
                    ? `for (const id of ['ao', 'ssr', 'bloom']) document.getElementById(id).checked = id === '${effect}'`
                    : `document.querySelector('#effect').value = '${effect === 'ao' ? 'ssao' : effect}'`);
                await client.evaluate('window.__BabylonSceneDemo.reset()'); await settle(32);
                writeFileSync(join(artifacts, example + '-' + effect + '.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
                return probe();
            };
            const neutral = await select('none'), ao = await select('ao'), ssr = await select('ssr');
            assert.ok(ao.input.meanAbs < neutral.input.meanAbs - 1e-4, 'SSAO must darken contact regions');
            // Reflections redistribute color: a global mean can cancel out even
            // for clearly visible reflections. Compare RGB in spatial regions.
            const reflectedDifference = ssr.input.regions.reduce((sum, value, i) => sum + Math.abs(value - neutral.input.regions[i]), 0) / ssr.input.regions.length;
            assert.ok(reflectedDifference > 0.001, `SSR must change reflected regions: ${reflectedDifference}`);
            if (stack) {
                const bloom = await select('bloom');
                assert.ok(bloom.input.meanAbs > neutral.input.meanAbs + 1e-4, 'HDR bloom must spread bright highlights');
                await client.evaluate("for (const id of ['ao', 'ssr', 'bloom']) document.getElementById(id).checked = true");
            }
            await client.evaluate("document.querySelector('#mode').value = 'temporal'");
        }
        if (example.includes('transparent-canvas')) {
            assert.equal(stationary.output.alpha.min, 0, 'Canvas background must remain transparent');
            assert.equal(stationary.output.alpha.max, 1, 'Opaque meshes keep full coverage');
            assert.ok(stationary.output.alpha.fractional > 0, 'Temporal reconstruction must recover fractional silhouette coverage');
            // Copy immediately after Babylon's RAF callback, before the browser presents
            // the swapchain texture. This checks the actual canvas, not just core output.
            const alpha = await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => {
                const source = document.querySelector('canvas'), copy = document.createElement('canvas');
                copy.width = source.width; copy.height = source.height;
                const context = copy.getContext('2d'); context.drawImage(source, 0, 0);
                const data = context.getImageData(0, 0, copy.width, copy.height).data;
                let min = 255, max = 0, fractional = 0;
                for (let i = 3; i < data.length; i += 4) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); if (data[i] > 0 && data[i] < 255) fractional++; }
                resolve({min, max, fractional});
            }))`);
            assert.equal(alpha.min, 0, 'Presented canvas must have transparent pixels');
            assert.equal(alpha.max, 255, 'Presented canvas must contain the opaque scene');
            assert.ok(alpha.fractional > 0, 'Presented canvas must preserve fractional coverage');
            for (const backdrop of ['light', 'dark', 'grid']) {
                await client.evaluate(`document.querySelector('#backdrop').value = '${backdrop}'; document.querySelector('#backdrop').dispatchEvent(new Event('change'))`); await settle(2);
                if (backdrop !== 'grid') writeFileSync(join(artifacts, 'canvas-' + backdrop + '.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            }
        }
        await client.evaluate("document.querySelector('#mode').value = 'bilinear'"); await settle(); const bilinear = await probe();
        await client.evaluate("document.querySelector('#mode').value = 'temporal'"); await settle(); const reactivated = await probe();
        await client.evaluate('window.__BabylonSceneDemo.reset()'); await settle();
        for (const optimize of [false, true]) {
            await client.evaluate(`window.__BabylonSceneDemo.resize(967, 543, 1.5, ${optimize})`); await settle();
            const resized = await probe(); assert.equal(resized.config.renderWidth, 644); assert.equal(resized.config.displayHeight, 543);
        }
        await client.evaluate('window.__BabylonSceneDemo.resize(961, 539, 1)'); await settle(40);
        const nativeAA = await probe(); assert.equal(nativeAA.config.renderWidth, 961);
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(artifacts, example + '.png'), Buffer.from(shot.data, 'base64'));
        report.push({ example, moving, stationary, camera, bilinear, reactivated, nativeAA });
        console.log(example + ': mesh/camera motion, jitter removal, mask, fallback, odd resize, aliasing and NativeAA passed');
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await settle(30);
    assert.equal(await client.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile controls must fit');
    writeFileSync(join(artifacts, 'mobile.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
} finally {
    await closeOwnedCdpBrowser(client);
    await stopChild(chrome); await stopChild(server); await removeTempDirectory(profile, 'Babylon examples Chrome profile', 20);
}
