#!/usr/bin/env node
/**
 * GI-history-fusion meter (issue #7 research spike): GPU evidence for whether
 * accumulating a noisy GI signal inside the upscaler beats the 06/09 recipe
 * (SSGI static pattern + DenoiseNode + upscaler-owns-temporal). Three modes,
 * all driving the bench's capture API over CDP:
 *
 * - `snapshot` — captures scenario frames × debug views and records a hash of
 *   the decoded pixels per capture. Run once on main and once on a branch with
 *   `--compare <label>` to prove an opt-in feature leaves production output
 *   byte-identical. Scenario specs are `Q14:static` for subruns.
 * - `still` — on a still scenario (Q14), per subrun: consecutive and
 *   same-jitter-phase churn, per-pixel temporal luma std-dev, and mean
 *   `Locks` / `ShadingChange` debug values, on the full frame, every scenario
 *   ROI, and a wire mask (pixels where the `off` control's lock lifetime
 *   averages > 0.3 — "the thin features locks are meant for", as in
 *   bench/docs/NEXT-STEPS.md §7). With `--reference <subrun>` it also builds a
 *   long-accumulated reference and reports each subrun's period-averaged
 *   distance to it (bias + residual spatial grain, which churn cannot see).
 * - `timing` — rough per-pass GPU cost (timestamp queries via the upscaler's
 *   own GpuTimer): per subrun block, the median ms of each pass over
 *   `--count` still frames. List subruns in ABBA order (e.g.
 *   `raw-rotating,fused-rotating,fused-rotating,raw-rotating`) and compare
 *   within the run; block-to-block spread is the noise.
 * - `motion` — on a moving scenario (Q20), per subrun and sample frame f: the
 *   played frame against a held-camera reference (the same scenario with the
 *   camera pinned at f's pose for frames 0..f, i.e. that recipe's own
 *   converged still image). The difference is motion-induced error: ghost
 *   trails, disocclusion noise, lag.
 *
 * Usage:
 *   node scripts/measure-gi-fusion.mjs snapshot --scenarios Q0,Q1,Q14:static
 *     [--frames 0,1,23,119] [--views final,locks] [--label main] [--compare main]
 *   node scripts/measure-gi-fusion.mjs still --scenario Q14
 *     --subruns off,builtin,rotating,fused-rotating [--settle 240] [--count 97]
 *     [--reference raw-rotating] [--reference-settle 1200]
 *     [--reference-settings '{"maxAccumulation":256}']
 *   node scripts/measure-gi-fusion.mjs motion --scenario Q20
 *     --subruns builtin,fused-rotating [--frames 150:238:8] [--keep 200]
 * Common: [--ratio 2] [--width 1280] [--height 720] [--label x] [--port 9333]
 *   [--url http://127.0.0.1:5199] [--settings '{"giFusion":{"maxHistory":48}}']
 *   [--subrun <name>] (alias for a single --subruns entry)
 *
 * --settings is merged into every capture()'s settings (the canonical capture
 * settings plus overrides); the bench routes its `giFusion` key to the
 * dispatch's experimental `giFusion` tuning, not to RuntimeSettings.
 * Starts the bench dev server on --url's port if nothing answers there. Chrome's
 * profile goes under os.tmpdir() (set TMPDIR to relocate it).
 * Writes under bench/results/raw/gi-fusion/<mode>-<label>/ (git-ignored).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Linear lock lifetime above which a pixel of the clean control is "a wire".
const WIRE_LOCK_THRESHOLD = 0.3;
// |Δluma| (0–255) above which a motion-frame pixel counts as a visible error.
const ERROR_THRESHOLD = 8;

//* CLI
function parseArguments(argv) {
    const options = { _: [] };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('--')) {
            options._.push(value);
            continue;
        }
        const key = value.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) options[key] = true;
        else {
            options[key] = next;
            index++;
        }
    }
    return options;
}

const cli = parseArguments(process.argv.slice(2));
const mode = cli._[0];
if (cli.help || cli.h || !['snapshot', 'still', 'motion', 'timing'].includes(mode)) {
    console.log(`Usage: node scripts/measure-gi-fusion.mjs <snapshot|still|motion|timing> [options]
  snapshot: --scenarios Q0,Q1,Q14:static  [--frames 0,1,23,119] [--views final,locks]
            [--compare <label of an earlier snapshot>]
  still:    --scenario Q14 --subruns off,builtin,fused-rotating [--settle 240] [--count 97]
            [--reference <subrun>] [--reference-settle 1200] [--reference-settings <json>]
            [--reference-label <label of an earlier still run whose reference to reuse>]
  motion:   --scenario Q20 --subruns builtin,fused-rotating [--frames 150:238:8] [--keep 200,230]
  timing:   --scenario Q14 --subruns A,B,B,A [--settle 120] [--count 120]
  common:   --ratio 2 --width 1280 --height 720 --label baseline --port 9333
            --url ${DEFAULT_BENCH_URL} --settings '<json>' --subrun <name>
Writes bench/results/raw/gi-fusion/<mode>-<label>/.`);
    process.exit(mode ? 0 : 1);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const port = parsePort(cli.port, '--port') ?? 9333;
const ratio = Number(cli.ratio ?? 2);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const label = cli.label ?? 'baseline';
const captureSettings = typeof cli.settings === 'string' ? JSON.parse(cli.settings) : {};
const listOf = (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : []);
const subruns = listOf(cli.subruns ?? cli.subrun);
const outputDirectory = join(ROOT, 'bench/results/raw/gi-fusion', `${mode}-${label}`);

//* PNG decode (RGB8/RGBA8, non-interlaced), same contract as run-benchmark.mjs
function decodePng(bytes) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
    let offset = 8;
    let pngWidth = 0;
    let pngHeight = 0;
    let bitDepth = 0;
    let colorType = 0;
    const compressed = [];
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            pngWidth = data.readUInt32BE(0);
            pngHeight = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') break;
        offset += length + 12;
    }
    if (bitDepth !== 8 || ![2, 6].includes(colorType))
        throw new Error(`PNG contract requires RGB8/RGBA8; got depth=${bitDepth}, type=${colorType}.`);
    const packed = inflateSync(Buffer.concat(compressed));
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = pngWidth * bytesPerPixel;
    const raw = Buffer.alloc(stride * pngHeight);
    let source = 0;
    for (let y = 0; y < pngHeight; y++) {
        const filter = packed[source++];
        for (let x = 0; x < stride; x++) {
            const value = packed[source++];
            const left = x >= bytesPerPixel ? raw[y * stride + x - bytesPerPixel] : 0;
            const above = y > 0 ? raw[(y - 1) * stride + x] : 0;
            const upperLeft = y > 0 && x >= bytesPerPixel ? raw[(y - 1) * stride + x - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) {
                const p = left + above - upperLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - above);
                const pc = Math.abs(p - upperLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
            } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
            raw[y * stride + x] = (value + predictor) & 0xff;
        }
    }
    // Packed RGB only — alpha is not part of any metric here.
    const rgb = new Uint8Array(pngWidth * pngHeight * 3);
    for (let p = 0; p < pngWidth * pngHeight; p++) {
        rgb[p * 3] = raw[p * bytesPerPixel];
        rgb[p * 3 + 1] = raw[p * bytesPerPixel + 1];
        rgb[p * 3 + 2] = raw[p * bytesPerPixel + 2];
    }
    return { width: pngWidth, height: pngHeight, rgb };
}

const lumaOf = (rgb, p) => 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];
const srgbToLinear = (byte) => {
    const v = byte / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

//* Regions — the full frame, every scenario ROI (normalized x, y, w, h), and
//* an optional pixel mask; each is a list of pixel indices.
function buildRegions(rois, mask) {
    const regions = {};
    for (const [name, [rx, ry, rw, rh]] of Object.entries(rois)) {
        const x0 = Math.floor(rx * width);
        const y0 = Math.floor(ry * height);
        const x1 = Math.min(width, Math.ceil((rx + rw) * width));
        const y1 = Math.min(height, Math.ceil((ry + rh) * height));
        const pixels = [];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.push(y * width + x);
        regions[name] = Uint32Array.from(pixels);
    }
    if (mask) {
        const pixels = [];
        for (let p = 0; p < mask.length; p++) if (mask[p]) pixels.push(p);
        regions.wire_mask = Uint32Array.from(pixels);
    }
    return regions;
}

function meanAbsRgb(a, b, pixels) {
    let sum = 0;
    for (const p of pixels) {
        const i = p * 3;
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return sum / (pixels.length * 3);
}

//* CDP plumbing (subset of run-benchmark.mjs)
function chromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH.');
    return executable;
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.opened = new Promise((resolveOpen, rejectOpen) => {
            this.socket.addEventListener('open', resolveOpen, { once: true });
            this.socket.addEventListener('error', rejectOpen, { once: true });
        });
        this.socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
                return;
            }
            for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        });
    }
    async call(method, params = {}) {
        await this.opened;
        const id = this.nextId++;
        const response = new Promise((resolveCall, rejectCall) => {
            this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
        });
        this.socket.send(JSON.stringify({ id, method, params }));
        return response;
    }
    on(method, listener) {
        const listeners = this.listeners.get(method) ?? [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }
    close() {
        this.socket.close();
    }
}

const PRESENTED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

/** One headless Chrome + bench page session, re-navigated per scenario/subrun. */
class BenchSession {
    constructor(client, logRecords) {
        this.client = client;
        this.logRecords = logRecords;
    }

    async evaluate(expression) {
        const response = await this.client.call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails)
            throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
        return response.result.value;
    }

    async open(scenario, subrun) {
        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', scenario);
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', String(width));
        url.searchParams.set('height', String(height));
        if (subrun) url.searchParams.set('subrun', subrun);
        await this.client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            const ready = await this.evaluate('window.__UPSCALER_BENCH__?.ready === true').catch(() => false);
            if (ready === true) break;
            if (attempt > 600) throw new Error(`Timed out waiting for ${scenario}${subrun ? `:${subrun}` : ''}.`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        return this.evaluate(
            `(() => { const s = window.__UPSCALER_BENCH__._context.scenario;
                return { rois: s.rois, debugViews: s.debugViews, endFrame: s.endFrame }; })()`,
        );
    }

    /** Resets and replays to `frame` in `view` (canonical settings + overrides). */
    async capture(frame, view = 'final', settings = captureSettings) {
        const info = await this.evaluate(
            `window.__UPSCALER_BENCH__.capture({ frame: ${frame}, debugView: '${view}', settings: ${JSON.stringify(settings)} }).then((c) => ${PRESENTED}.then(() => c))`,
        );
        return info;
    }

    /** Steps the running replay forward to `frame`. */
    async step(frame) {
        await this.evaluate(`window.__UPSCALER_BENCH__.step(${frame}).then(() => ${PRESENTED})`);
    }

    /**
     * Switches the debug view mid-replay without a reset — the view only
     * selects the output pass, so history and locks keep evolving untouched.
     */
    async setView(view) {
        const index = { final: 0, locks: 5, 'shading-change': 7, 'accumulation-age': 4 }[view];
        // Set directly (not via applySettings, which would also reset the
        // capture's other overrides): the resolver reads it at dispatch, the
        // pipeline at present (untone-mapped debug output).
        await this.evaluate(
            `(() => { const p = window.__UPSCALER_BENCH__._context.pipeline;
                p.resolver.settings.debugView = ${index}; p._debugView = ${index}; })()`,
        );
    }

    async screenshot() {
        const bounds = await this.evaluate(
            `(() => { const r = document.querySelector('canvas').getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
        );
        const shot = await this.client.call('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { ...bounds, scale: 1 },
        });
        const png = Buffer.from(shot.data, 'base64');
        const decoded = decodePng(png);
        if (decoded.width !== width || decoded.height !== height)
            throw new Error(`Canvas is ${decoded.width}x${decoded.height}; expected ${width}x${height}.`);
        return { png, decoded };
    }
}

async function withSession(body) {
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
        profile = join(tmpdir(), `upscaler-gi-fusion-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${width + 40},${height + 200}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);
        await body(new BenchSession(client, logRecords));
        const problems = logRecords.filter(
            (record) => /error|exception|validation|invalid/i.test(record) && !/favicon|404/.test(record),
        );
        if (problems.length) console.warn(`browser log records:\n${problems.join('\n')}`);
        return logRecords;
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

//* Snapshot — per-capture pixel hashes for byte-identity checks
async function snapshot() {
    const specs = listOf(cli.scenarios);
    if (!specs.length) throw new Error('snapshot needs --scenarios.');
    const frameOverride = listOf(cli.frames).map(Number);
    const viewOverride = listOf(cli.views);
    const hashes = {};
    await withSession(async (session) => {
        for (const spec of specs) {
            const [scenario, subrun = null] = spec.split(':');
            const info = await session.open(scenario, subrun);
            const frames = (frameOverride.length ? frameOverride : [0, 1, 23, 31, 32, 63, 119])
                .filter((frame) => frame <= info.endFrame)
                .sort((a, b) => a - b);
            const views = viewOverride.length
                ? viewOverride.filter((view) => info.debugViews.includes(view))
                : info.debugViews;
            for (const view of views) {
                // One replay per view, stepping through the frames in order.
                await session.capture(frames[0], view);
                for (const [index, frame] of frames.entries()) {
                    if (index > 0) await session.step(frame);
                    const { png, decoded } = await session.screenshot();
                    const key = `${spec}|${view}|f${frame}`;
                    hashes[key] = createHash('sha256').update(decoded.rgb).digest('hex');
                    await writeFile(join(outputDirectory, `${spec.replace(':', '-')}-${view}-f${frame}.png`), png);
                }
                console.log(`${spec} ${view}: ${frames.length} captures`);
            }
        }
    });
    await writeFile(join(outputDirectory, 'hashes.json'), JSON.stringify(hashes, null, 2));
    if (typeof cli.compare === 'string') {
        const other = JSON.parse(
            await readFile(join(ROOT, 'bench/results/raw/gi-fusion', `snapshot-${cli.compare}`, 'hashes.json'), 'utf8'),
        );
        const keys = Object.keys(hashes).filter((key) => key in other);
        const differing = keys.filter((key) => hashes[key] !== other[key]);
        console.log(
            `compare vs ${cli.compare}: ${keys.length} shared captures, ${differing.length} differ` +
                (differing.length ? `:\n  ${differing.join('\n  ')}` : ' (byte-identical)'),
        );
        if (differing.length) process.exitCode = 1;
    }
}

//* Still — churn, temporal std-dev, locks, and distance to a reference
async function playStill(session, info, settle, count, period, settings) {
    await session.capture(settle, 'final', settings);
    const pixels = width * height;
    const sum = new Float64Array(pixels * 3);
    const lumaSum = new Float64Array(pixels);
    const lumaSq = new Float64Array(pixels);
    const ring = [];
    const consecutive = [];
    const samePhase = [];
    const periodSum = new Float64Array(pixels * 3);
    const periodFrames = Math.min(count, Math.floor(count / period) * period || count);
    // lcm(jitter period, SSGI's 12-frame rotation): frames this far apart
    // repeat every input cycle, so their diff is pure non-periodic churn.
    const cycle = period % 12 === 0 ? period : (period * 12) / gcd(period, 12);
    const firstFrames = [];
    const cycleLocked = [];
    let previous = null;
    for (let index = 0; index < count; index++) {
        if (index > 0) await session.step(settle + index);
        const { decoded } = await session.screenshot();
        const rgb = decoded.rgb;
        for (let p = 0; p < pixels; p++) {
            const l = lumaOf(rgb, p);
            lumaSum[p] += l;
            lumaSq[p] += l * l;
        }
        if (index < periodFrames) for (let i = 0; i < pixels * 3; i++) periodSum[i] += rgb[i];
        for (let i = 0; i < pixels * 3; i++) sum[i] += rgb[i];
        if (previous) consecutive.push([previous, rgb]);
        if (ring.length === period) samePhase.push([ring.shift(), rgb]);
        if (index < count - cycle) firstFrames.push(rgb);
        if (index >= cycle) cycleLocked.push([firstFrames[index - cycle], rgb]);
        ring.push(rgb);
        previous = rgb;
    }
    // Debug-view averages over one jitter period, continuing the same replay.
    const debugMeans = {};
    let frame = settle + count - 1;
    for (const view of ['locks', 'shading-change']) {
        if (!info.debugViews.includes(view)) continue;
        await session.setView(view);
        const acc = new Float64Array(pixels);
        for (let index = 0; index < period; index++) {
            await session.step(++frame);
            const { decoded } = await session.screenshot();
            for (let p = 0; p < pixels; p++) acc[p] += srgbToLinear(decoded.rgb[p * 3]);
        }
        for (let p = 0; p < pixels; p++) acc[p] /= period;
        debugMeans[view] = acc;
    }
    await session.setView('final');
    await session.step(++frame);
    const finalPng = (await session.screenshot()).png;
    const periodMean = new Float32Array(pixels * 3);
    for (let i = 0; i < pixels * 3; i++) periodMean[i] = periodSum[i] / periodFrames;
    return { info, lumaSum, lumaSq, consecutive, samePhase, cycleLocked, debugMeans, periodMean, count, finalPng };
}

function stillMetrics(run, regions, reference) {
    const metrics = {};
    for (const [name, pixels] of Object.entries(regions)) {
        const mean = (list) => list.reduce((total, [a, b]) => total + meanAbsRgb(a, b, pixels), 0) / list.length;
        let std = 0;
        for (const p of pixels) {
            const m = run.lumaSum[p] / run.count;
            std += Math.sqrt(Math.max(run.lumaSq[p] / run.count - m * m, 0));
        }
        const row = {
            cons: mean(run.consecutive),
            phase: run.samePhase.length ? mean(run.samePhase) : null,
            cycle: run.cycleLocked.length ? mean(run.cycleLocked) : null,
            std: std / pixels.length,
        };
        for (const [view, values] of Object.entries(run.debugMeans)) {
            let total = 0;
            for (const p of pixels) total += values[p];
            row[view === 'locks' ? 'locks' : 'sc'] = total / pixels.length;
        }
        if (reference) {
            let total = 0;
            for (const p of pixels)
                for (let c = 0; c < 3; c++) total += Math.abs(run.periodMean[p * 3 + c] - reference[p * 3 + c]);
            row.refDist = total / (pixels.length * 3);
        }
        metrics[name] = row;
    }
    return metrics;
}

async function still() {
    const scenario = cli.scenario ?? 'Q14';
    const settle = Number(cli.settle ?? 240);
    const count = Number(cli.count ?? 97);
    if (!subruns.length) throw new Error('still needs --subruns (put the `off` control first for the wire mask).');
    const results = {};
    let reference = null;
    if (typeof cli['reference-label'] === 'string') {
        const file = join(ROOT, 'bench/results/raw/gi-fusion', `still-${cli['reference-label']}`, 'reference.f32');
        reference = new Float32Array((await readFile(file)).buffer.slice(0));
    }
    let mask = null;
    if (typeof cli.mask === 'string') mask = new Uint8Array(await readFile(cli.mask));
    await withSession(async (session) => {
        let period = 32;
        //* Reference: one long-settled replay, averaged over a whole period
        if (!reference && typeof cli.reference === 'string') {
            const settings = {
                ...captureSettings,
                ...(typeof cli['reference-settings'] === 'string' ? JSON.parse(cli['reference-settings']) : {}),
            };
            const refSettle = Number(cli['reference-settle'] ?? 1200);
            const info = await session.open(scenario, cli.reference);
            period = (await session.capture(0, 'final', settings)).jitterPeriod;
            // lcm(jitter period, SSGI's 12-frame rotation) — both cycles close.
            const frames = period % 12 === 0 ? period : (period * 12) / gcd(period, 12);
            const run = await playStill(session, info, refSettle, frames, frames, settings);
            reference = run.periodMean;
            await writeFile(join(outputDirectory, 'reference.f32'), Buffer.from(reference.buffer));
            console.log(`reference ${cli.reference}: settle ${refSettle}, averaged over ${frames} frames`);
        }
        for (const subrun of subruns) {
            const info = await session.open(scenario, subrun);
            period = (await session.capture(0, 'final')).jitterPeriod;
            const run = await playStill(session, info, settle, count, period, captureSettings);
            if (!mask && subrun === 'off' && run.debugMeans.locks) {
                mask = new Uint8Array(width * height);
                for (let p = 0; p < mask.length; p++) mask[p] = run.debugMeans.locks[p] > WIRE_LOCK_THRESHOLD ? 1 : 0;
                await writeFile(join(outputDirectory, 'wire-mask.u8'), mask);
            }
            const regions = buildRegions(info.rois, mask);
            results[subrun] = stillMetrics(run, regions, reference);
            await writeFile(join(outputDirectory, `${subrun}-final.png`), run.finalPng);
            // Period-averaged canvas (float RGB, 0–255) for offline diffs.
            await writeFile(join(outputDirectory, `${subrun}-mean.f32`), Buffer.from(run.periodMean.buffer));
            const row = (name) => {
                const m = results[subrun][name];
                if (!m) return '';
                const f = (v) => (v === null || v === undefined ? '—' : v.toFixed(3));
                return `${name}: cons ${f(m.cons)} phase ${f(m.phase)} cycle ${f(m.cycle)} std ${f(m.std)} locks ${f(m.locks)} sc ${f(m.sc)} ref ${f(m.refDist)}`;
            };
            console.log(`${subrun}\n  ${row('full')}\n  ${row('wire_mask')}`);
        }
    });
    const summary = { scenario, ratio, width, height, settle, count, settings: captureSettings, results };
    if (mask) summary.wireMaskPixels = mask.reduce((total, v) => total + v, 0);
    await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`artifacts: ${outputDirectory}`);
}

function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
}

//* Motion — each played frame against its held-camera reference
async function motion() {
    const scenario = cli.scenario ?? 'Q20';
    const [start, end, stepSize] = String(cli.frames ?? '150:238:8').split(':').map(Number);
    const frames = [];
    for (let frame = start; frame <= end; frame += stepSize || 1) frames.push(frame);
    const keep = new Set(listOf(cli.keep).map(Number));
    if (!subruns.length) throw new Error('motion needs --subruns.');
    const results = {};
    await withSession(async (session) => {
        for (const subrun of subruns) {
            const info = await session.open(scenario, subrun);
            const regions = buildRegions(info.rois, null);
            await session.evaluate(
                `(() => { window.__giOriginalFrame = window.__UPSCALER_BENCH__._context.scenario.frame; })()`,
            );
            //* Pass 1: the motion, played continuously
            const played = new Map();
            await session.capture(frames[0]);
            for (const [index, frame] of frames.entries()) {
                if (index > 0) await session.step(frame);
                const { png, decoded } = await session.screenshot();
                played.set(frame, decoded.rgb);
                if (keep.has(frame)) await writeFile(join(outputDirectory, `${subrun}-played-f${frame}.png`), png);
            }
            //* Pass 2: held-state references, one fresh replay per sample frame
            const rows = [];
            for (const frame of frames) {
                await session.evaluate(
                    // Everything held at f's state (pose, lights) except the clock.
                    `(() => { const original = window.__giOriginalFrame; const held = original(${frame});
                        window.__UPSCALER_BENCH__._context.scenario.frame = (n) => ({ ...held,
                            frame: n, time: n / 60, sceneTime: n / 60, resetHistory: false, resize: null }); })()`,
                );
                await session.capture(frame);
                const { png, decoded } = await session.screenshot();
                if (keep.has(frame)) await writeFile(join(outputDirectory, `${subrun}-held-f${frame}.png`), png);
                const row = { frame };
                for (const [name, pixels] of Object.entries(regions)) {
                    let over = 0;
                    const a = played.get(frame);
                    for (const p of pixels) if (Math.abs(lumaOf(a, p) - lumaOf(decoded.rgb, p)) > ERROR_THRESHOLD) over++;
                    row[name] = { meanAbs: meanAbsRgb(a, decoded.rgb, pixels), errorFraction: over / pixels.length };
                }
                rows.push(row);
            }
            await session.evaluate(
                `window.__UPSCALER_BENCH__._context.scenario.frame = window.__giOriginalFrame`,
            );
            const average = (name, key) => rows.reduce((total, row) => total + row[name][key], 0) / rows.length;
            const aggregate = {};
            for (const name of Object.keys(regions))
                aggregate[name] = { meanAbs: average(name, 'meanAbs'), errorFraction: average(name, 'errorFraction') };
            results[subrun] = { rows, aggregate };
            console.log(
                `${subrun}: ` +
                    Object.entries(aggregate)
                        .map(([name, m]) => `${name} ${m.meanAbs.toFixed(3)} (${(100 * m.errorFraction).toFixed(2)}% > ${ERROR_THRESHOLD})`)
                        .join(' | '),
            );
        }
    });
    await writeFile(
        join(outputDirectory, 'summary.json'),
        JSON.stringify({ scenario, ratio, width, height, frames, settings: captureSettings, errorThreshold: ERROR_THRESHOLD, results }, null, 2),
    );
    console.log(`artifacts: ${outputDirectory}`);
}

//* Timing — median per-pass GPU ms per subrun block (ABBA by argument order)
async function timing() {
    const scenario = cli.scenario ?? 'Q14';
    const settle = Number(cli.settle ?? 120);
    const count = Number(cli.count ?? 120);
    const blocks = [];
    await withSession(async (session) => {
        for (const subrun of subruns) {
            await session.open(scenario, subrun);
            await session.capture(settle);
            const samples = {};
            for (let index = 1; index <= count; index++) {
                await session.step(settle + index);
                const timings = await session.evaluate(
                    `Object.fromEntries(window.__UPSCALER_BENCH__._context.pipeline.resolver._upscaler.gpuTimings)`,
                );
                for (const [pass, ms] of Object.entries(timings)) (samples[pass] ??= []).push(ms);
            }
            const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const row = { subrun, passes: {} };
            for (const [pass, values] of Object.entries(samples)) row.passes[pass] = median(values);
            row.total = Object.values(row.passes).reduce((total, ms) => total + ms, 0);
            blocks.push(row);
            console.log(
                `${subrun}: total ${row.total.toFixed(3)} ms | ` +
                    Object.entries(row.passes).map(([pass, ms]) => `${pass} ${ms.toFixed(3)}`).join(' '),
            );
        }
    });
    await writeFile(
        join(outputDirectory, 'summary.json'),
        JSON.stringify({ scenario, ratio, width, height, settle, count, settings: captureSettings, blocks }, null, 2),
    );
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
if (mode === 'snapshot') await snapshot();
else if (mode === 'still') await still();
else if (mode === 'timing') await timing();
else await motion();
