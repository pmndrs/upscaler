import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';

import {
    assertCaptureEvidenceBinding,
    authoritativeComparisonPasses,
    closeExternalCdpTarget,
    computeSumNoiseFloorPasses,
    hashWorkingTreeEntries,
    reviewStorageKey,
} from './benchmark-contract.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = join(ROOT, 'bench/results/experiments/e00-harness.json');
const DEFAULT_URL = 'http://127.0.0.1:5199';
const execFileAsync = promisify(execFile);

class UserDecisionRequired extends Error {
    constructor(message) {
        super(message);
        this.name = 'USER_DECISION_REQUIRED';
    }
}

class BlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BLOCKED';
    }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    name.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
    return chunk;
}

function decodePng(bytes) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const compressed = [];
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
        if (crc32(Buffer.concat([Buffer.from(type), data])) !== expectedCrc)
            throw new Error(`PNG ${type} CRC mismatch.`);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') break;
        offset += length + 12;
    }
    if (width < 1 || height < 1 || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0)
        throw new Error(
            `PNG contract requires non-interlaced RGB8/RGBA8; got ${width}x${height}, depth=${bitDepth}, type=${colorType}, interlace=${interlace}.`,
        );

    const packed = inflateSync(Buffer.concat(compressed));
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = width * bytesPerPixel;
    const rawPixels = Buffer.alloc(stride * height);
    let source = 0;
    for (let y = 0; y < height; y++) {
        const filter = packed[source++];
        for (let x = 0; x < stride; x++) {
            const raw = packed[source++];
            const left =
                x >= bytesPerPixel ? rawPixels[y * stride + x - bytesPerPixel] : 0;
            const above = y > 0 ? rawPixels[(y - 1) * stride + x] : 0;
            const upperLeft =
                y > 0 && x >= bytesPerPixel
                    ? rawPixels[(y - 1) * stride + x - bytesPerPixel]
                    : 0;
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
            rawPixels[y * stride + x] = (raw + predictor) & 0xff;
        }
    }
    const rgba = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        rawPixels.copy(
            rgba,
            pixel * 4,
            pixel * bytesPerPixel,
            pixel * bytesPerPixel + bytesPerPixel,
        );
        if (bytesPerPixel === 3) rgba[pixel * 4 + 3] = 255;
    }
    return { width, height, bitDepth, colorType, rgba };
}

function encodePng(width, height, rgba) {
    const scanlines = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        scanlines[row] = 0;
        rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(scanlines)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('--')) continue;
        const [name, inline] = value.slice(2).split('=', 2);
        const next = argv[index + 1];
        if (inline !== undefined) options[name] = inline;
        else if (next !== undefined && !next.startsWith('--')) options[name] = argv[++index];
        else options[name] = true;
    }
    return options;
}

function list(value, fallback) {
    return String(value ?? fallback)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

async function currentWorkingTreeDigest() {
    const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: ROOT, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const inventory = Buffer.from(stdout)
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    const entries = await Promise.all(
        inventory.map(async (path) => {
            try {
                return { path, bytes: await readFile(join(ROOT, path)) };
            } catch (error) {
                if (error?.code === 'ENOENT') return { path, bytes: null };
                throw error;
            }
        }),
    );
    return hashWorkingTreeEntries(entries);
}

function chromeExecutable(explicit) {
    const candidates = [
        explicit,
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error('Chrome was not found. Pass --chrome /path/to/chrome.');
    return executable;
}

async function waitForUrl(url, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The process is still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${url}`);
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
            for (const listener of this.listeners.get(message.method) ?? [])
                listener(message.params);
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

function formatConsoleArgument(argument) {
    if ('value' in argument) return String(argument.value);
    if (argument.description) return argument.description;
    return argument.type;
}

async function createPage(cdpBase) {
    const response = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Unable to create CDP page: ${response.status}`);
    const target = await response.json();
    return {
        client: new CdpClient(target.webSocketDebuggerUrl),
        targetId: target.id,
    };
}

async function waitForApi(client) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const response = await client.call('Runtime.evaluate', {
            expression: 'window.__UPSCALER_BENCH__?.ready === true',
            returnByValue: true,
        });
        if (response.result.value === true) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error('Timed out waiting for window.__UPSCALER_BENCH__.');
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

async function navigate(client, url, logRecords) {
    logRecords.length = 0;
    await client.call('Page.navigate', { url });
    await waitForApi(client);
}

function runUrl(baseUrl, options, variant, ratio, scenario = 'Q1', subrun = null) {
    const url = new URL(baseUrl);
    url.searchParams.set('experiment', options.experiment ?? 'E00');
    url.searchParams.set('benchMode', options.mode);
    url.searchParams.set('variant', variant);
    url.searchParams.set('comparison', options.comparison);
    url.searchParams.set('ratio', String(ratio));
    url.searchParams.set('scenario', scenario);
    url.searchParams.set('width', String(options.width ?? 1920));
    url.searchParams.set('height', String(options.height ?? 1080));
    url.searchParams.set('warmup', String(options.warmup));
    url.searchParams.set('samples', String(options.samples));
    if (subrun) url.searchParams.set('subrun', subrun);
    return url.href;
}

function assertCleanLogs(records) {
    const failures = records.filter(
        (record) =>
            record.channel === 'Runtime.exceptionThrown' ||
            (record.channel === 'Runtime.consoleAPICalled' && record.level === 'error') ||
            /device lost|validation|parsing wgsl|invalid (compute|bind|command)/i.test(record.text),
    );
    if (failures.length > 0)
        throw new Error(`Browser validation failed:\n${failures.map((entry) => entry.text).join('\n')}`);
}

async function captureCanvas(client) {
    await evaluate(
        client,
        `(async () => {
            const device = window.__UPSCALER_BENCH__ && document.querySelector('canvas')
                ? window.__UPSCALER_BENCH__
                : null;
            if (!device) throw new Error('Benchmark API unavailable before screenshot.');
            return true;
        })()`,
    );
    const bounds = await evaluate(
        client,
        `(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) throw new Error('Canvas not found.');
            const rect = canvas.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`,
    );
    const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...bounds, scale: 1 },
    });
    return { bytes: Buffer.from(screenshot.data, 'base64'), clip: bounds };
}

function resolveRoi(roi, width, height) {
    return {
        x: Math.floor(roi[0] * width),
        y: Math.floor(roi[1] * height),
        width: Math.ceil(roi[2] * width),
        height: Math.ceil(roi[3] * height),
    };
}

function validateDecodedCapture(decoded, expected) {
    const errors = [];
    if (decoded.width !== expected.width || decoded.height !== expected.height)
        errors.push(
            `Dimensions ${decoded.width}x${decoded.height} do not match ${expected.width}x${expected.height}.`,
        );
    let nonOpaquePixels = 0;
    for (let offset = 3; offset < decoded.rgba.length; offset += 4)
        if (decoded.rgba[offset] !== 255) nonOpaquePixels++;
    if (nonOpaquePixels > 0) errors.push(`${nonOpaquePixels} pixels have alpha other than 255.`);
    return {
        width: decoded.width,
        height: decoded.height,
        bitDepth: decoded.bitDepth,
        colorType: decoded.colorType,
        nonOpaquePixels,
        errors,
        passes: errors.length === 0,
    };
}

function expectedCaptureDimensions(scenario, frame) {
    if (scenario === 'Q10' && frame >= 120 && frame <= 179)
        return { width: 1280, height: 720 };
    return { width: 1920, height: 1080 };
}

function differenceLegend() {
    return {
        mapping: 'red = max absolute RGB difference; green=0; blue=0; alpha=1',
        domain: [0, 1],
        exactThreshold: 1 / 255,
        rmseThreshold: 0.25 / 255,
    };
}

function compareRegion(a, b, region) {
    let maxByteDifference = 0;
    let squaredDifference = 0;
    let channels = 0;
    for (let y = region.y; y < Math.min(a.height, region.y + region.height); y++) {
        for (let x = region.x; x < Math.min(a.width, region.x + region.width); x++) {
            const offset = (y * a.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const difference = Math.abs(a.rgba[offset + channel] - b.rgba[offset + channel]);
                maxByteDifference = Math.max(maxByteDifference, difference);
                squaredDifference += (difference / 255) ** 2;
                channels++;
            }
        }
    }
    return {
        ...region,
        maxAbsolute: maxByteDifference / 255,
        rmse: Math.sqrt(squaredDifference / channels),
        passes: maxByteDifference <= 1 && Math.sqrt(squaredDifference / channels) <= 0.25 / 255,
    };
}

function differenceHeatmap(a, b) {
    const rgba = Buffer.alloc(a.rgba.length);
    for (let offset = 0; offset < rgba.length; offset += 4) {
        const difference = Math.max(
            Math.abs(a.rgba[offset] - b.rgba[offset]),
            Math.abs(a.rgba[offset + 1] - b.rgba[offset + 1]),
            Math.abs(a.rgba[offset + 2] - b.rgba[offset + 2]),
        );
        rgba[offset] = Math.min(255, difference * 255);
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 255;
    }
    return encodePng(a.width, a.height, rgba);
}

function unorderedPairs(values) {
    const pairs = [];
    for (let left = 0; left < values.length; left++)
        for (let right = left + 1; right < values.length; right++)
            pairs.push([values[left], values[right]]);
    return pairs;
}

function timingCsv(timing) {
    const rows = ['frame,sequence,label,milliseconds'];
    for (const sample of timing.raw) {
        let sum = 0;
        for (const pass of sample.passes) {
            rows.push(`${sample.frameTag},${sample.sequence},${pass.label},${pass.milliseconds}`);
            sum += pass.milliseconds;
        }
        rows.push(`${sample.frameTag},${sample.sequence},compute-sum,${sum}`);
    }
    return `${rows.join('\n')}\n`;
}

function relativeDelta(a, b) {
    const mean = (a + b) / 2;
    return mean === 0 ? 0 : Math.abs(a - b) / mean;
}

function quantile95(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const position = 0.95 * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function runStatistic(run, label, kind) {
    const summary =
        label === 'compute-sum'
            ? run.result.timing.computeSum
            : run.result.timing.passes.find((pass) => pass.label === label);
    if (!summary || summary[kind] === null)
        throw new Error(`Missing ${kind} statistic for ${label}.`);
    return summary[kind];
}

function analyzeAbba(runs, repetitions) {
    const analyses = [];
    const ratios = [...new Set(runs.map((run) => run.ratio))];
    for (const ratio of ratios) {
        const ratioRuns = runs.filter((run) => run.ratio === ratio);
        // Cross-variant comparisons (production vs candidate) have disjoint pass
        // graphs — only labels present in every run can be compared. compute-sum
        // always qualifies.
        const labels = new Set(['compute-sum']);
        const [firstRun, ...restRuns] = ratioRuns;
        for (const pass of firstRun.result.timing.passes) {
            const everywhere = restRuns.every((run) =>
                run.result.timing.passes.some((other) => other.label === pass.label),
            );
            if (everywhere) labels.add(pass.label);
        }

        for (const label of labels) {
            const statistics = {};
            for (const kind of ['median', 'p95']) {
                const rows = [];
                for (let repetition = 1; repetition <= repetitions; repetition++) {
                    const byPosition = Object.fromEntries(
                        ratioRuns
                            .filter((run) => run.repetition === repetition)
                            .map((run) => [run.position, run]),
                    );
                    const A1 = runStatistic(byPosition.A1, label, kind);
                    const B1 = runStatistic(byPosition.B1, label, kind);
                    const B2 = runStatistic(byPosition.B2, label, kind);
                    const A2 = runStatistic(byPosition.A2, label, kind);
                    const dA = relativeDelta(A1, A2);
                    const dB = relativeDelta(B1, B2);
                    const meanA = (A1 + A2) / 2;
                    const meanB = (B1 + B2) / 2;
                    rows.push({
                        repetition,
                        A1,
                        B1,
                        B2,
                        A2,
                        dA,
                        dB,
                        meanA,
                        meanB,
                        comparisonDelta: relativeDelta(meanA, meanB),
                    });
                }
                const sortedDeltaA = rows.map((row) => row.dA).sort((a, b) => a - b);
                const sortedDeltaB = rows.map((row) => row.dB).sort((a, b) => a - b);
                const q95A = quantile95(sortedDeltaA);
                const q95B = quantile95(sortedDeltaB);
                const noiseFloor = Math.max(q95A, q95B);
                const comparisonLimit = Math.max(kind === 'median' ? 0.03 : 0.05, 2 * noiseFloor);
                const passCount = rows.filter(
                    (row) => row.comparisonDelta <= comparisonLimit,
                ).length;
                statistics[kind] = {
                    rows,
                    sortedDeltaA,
                    sortedDeltaB,
                    q95A,
                    q95B,
                    noiseFloor,
                    comparisonLimit,
                    passCount,
                    passes: passCount >= 3,
                };
            }
            const baselineMedian = statistics.median.rows.reduce(
                (sum, row) => sum + row.meanA,
                0,
            ) / repetitions;
            const timerResolutionLimited = label !== 'compute-sum' && baselineMedian < 0.02;
            const noiseFloorPass =
                timerResolutionLimited ||
                (statistics.median.noiseFloor <= 0.015 &&
                    statistics.p95.noiseFloor <= 0.025);
            analyses.push({
                ratio,
                label,
                baselineMedian,
                timerResolutionLimited,
                individualClaimEligible:
                    label === 'compute-sum' || (!timerResolutionLimited && noiseFloorPass),
                median: statistics.median,
                p95: statistics.p95,
                noiseFloorPass,
            });
        }
    }
    return analyses;
}

function noiseFloorPasses(analysis) {
    return computeSumNoiseFloorPasses(analysis);
}

function comparisonPasses(analysis) {
    return authoritativeComparisonPasses(analysis);
}

async function persistPageEvidence(client, outputDirectory, name, logRecords) {
    let browserResult = null;
    try {
        browserResult = await evaluate(client, 'window.__UPSCALER_BENCH__?.result ?? null');
    } catch {
        // Navigation or device failure can make the API unavailable; CDP logs remain authoritative.
    }
    await writeFile(
        join(outputDirectory, `${name}-logs.json`),
        JSON.stringify({ channels: logRecords, browserValidation: browserResult?.validation ?? [] }, null, 2),
    );
}

async function performanceRun(client, context) {
    const { options, outputDirectory, logRecords } = context;
    const ratios = list(options.ratios, '1,1.5,2,3').map(Number);
    const repetitions = Number(options.blocks ?? 4);
    const sequence = [
        ['A1', options.variant],
        ['B1', options.comparison],
        ['B2', options.comparison],
        ['A2', options.variant],
    ];
    if (!options.smoke && (repetitions !== 4 || options.warmup !== 240 || options.samples !== 600))
        throw new Error('Authoritative E00 timing requires 4 blocks, 240 warmup frames, and 600 samples.');
    if (!options.smoke && ratios.join(',') !== '1,1.5,2,3')
        throw new Error('Authoritative E00 timing requires ratios 1,1.5,2,3.');

    async function runRatio(activeClient, activeLogs, ratio, retry) {
        const ratioResults = [];
        for (let repetition = 0; repetition < repetitions; repetition++) {
            for (const [position, variant] of sequence) {
                const url = runUrl(DEFAULT_URL, options, variant, ratio);
                const name = `${retry ? 'retry-' : ''}ratio-${ratio}-r${repetition + 1}-${position}-${variant}`;
                let result = null;
                try {
                    await navigate(activeClient, url, activeLogs);
                    result = await evaluate(
                        activeClient,
                        `window.__UPSCALER_BENCH__.run({
                            warmupFrames: ${options.warmup},
                            sampleFrames: ${options.samples}
                        })`,
                    );
                    if (result?.variant?.id !== variant)
                        throw new Error(
                            `Run ${name} reported variant ${result?.variant?.id ?? '<missing>'}, expected ${variant}.`,
                        );
                    await writeFile(join(outputDirectory, `${name}.json`), JSON.stringify(result, null, 2));
                    if (result.timing)
                        await writeFile(join(outputDirectory, `${name}.csv`), timingCsv(result.timing));
                } finally {
                    await persistPageEvidence(activeClient, outputDirectory, name, activeLogs);
                }
                assertCleanLogs(activeLogs);
                if (
                    !result?.timing ||
                    result.timing.expectedFrames !== options.samples ||
                    result.timing.receivedFrames !== options.samples ||
                    result.timing.raw.length !== options.samples ||
                    result.timing.invalidityCount !== 0
                )
                    throw new Error(`Run ${name} did not produce an exact fresh timing set.`);
                ratioResults.push({ ratio, repetition: repetition + 1, position, variant, result });
            }
        }
        return ratioResults;
    }

    const allResults = [];
    const analyses = [];
    let activeClient = client;
    let activeLogs = logRecords;
    for (const ratio of ratios) {
        let ratioResults = await runRatio(activeClient, activeLogs, ratio, false);
        let ratioAnalysis = analyzeAbba(ratioResults, repetitions);
        let retryState = 'not-required';
        if (!noiseFloorPasses(ratioAnalysis) && !options.smoke) {
            retryState = 'cold-retry';
            const restarted = await context.restartBrowser();
            activeClient = restarted.client;
            activeLogs = restarted.logRecords;
            ratioResults = await runRatio(activeClient, activeLogs, ratio, true);
            ratioAnalysis = analyzeAbba(ratioResults, repetitions);
            if (!noiseFloorPasses(ratioAnalysis)) {
                retryState = 'blocked-after-retry';
                await writeFile(
                    join(outputDirectory, `ratio-${ratio}-blocked.json`),
                    JSON.stringify(
                        { ratio, status: 'BLOCKED', retryState, analysis: ratioAnalysis },
                        null,
                        2,
                    ),
                );
                throw new BlockedError(
                    `E00 timing noise floor remained too high at ratio ${ratio} after one cold retry.`,
                );
            }
            retryState = 'passed-after-retry';
        }
        if (!comparisonPasses(ratioAnalysis) && !options.smoke) {
            await writeFile(
                join(outputDirectory, `ratio-${ratio}-failed.json`),
                JSON.stringify(
                    { ratio, status: 'FAIL', reason: 'baseline-equivalence', analysis: ratioAnalysis },
                    null,
                    2,
                ),
            );
            throw new Error(`E00 baseline equivalence failed at ratio ${ratio}.`);
        }
        allResults.push(...ratioResults);
        analyses.push(...ratioAnalysis.map((entry) => ({ ...entry, retryState })));
    }
    await writeFile(join(outputDirectory, 'abba-analysis.json'), JSON.stringify(analyses, null, 2));
    return { runs: allResults, analysis: analyses };
}

function scenarioSubruns(scenario) {
    if (scenario.id === 'Q6') return ['gtao', 'ssr', 'ssgi'];
    if (scenario.id === 'Q8') return ['builtin', 'spatial', 'recurrent'];
    return [null];
}

function captureFrames(expressions, period) {
    return [...new Set(expressions.map((expression) => {
        if (/^\d+$/.test(expression)) return Number(expression);
        if (expression === 'P') return period;
        if (expression === 'P-1') return period - 1;
        if (expression === '2*P-1') return 2 * period - 1;
        throw new Error(`Unsupported capture expression: ${expression}`);
    }))];
}

function isHumanReviewTuple(manifest, record) {
    const spec =
        manifest.capture_protocol.harness_acceptance_matrix.human_review_scenarios[record.scenario];
    if (!spec) return false;
    const period =
        manifest.capture_protocol.jitter_period_by_ratio[String(record.ratio)];
    return (
        captureFrames(spec.frames, period).includes(record.frame) &&
        spec.debug_views.includes(record.debugView)
    );
}

function normalizeRubricTemplate(records, manifest, includeAll = false) {
    const groups = new Map();
    for (const record of records) {
        if (!includeAll && !isHumanReviewTuple(manifest, record)) continue;
        const key = [
            record.scenario,
            record.subrun ?? 'default',
            record.ratio,
            record.frame,
            record.debugView,
        ].join('|');
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
    }

    const reviewerCount =
        manifest.capture_protocol.harness_acceptance_matrix.reviewer_count;
    return [...groups.entries()].map(([key, group]) => {
        const full = group.find((record) => record.roi === 'full') ?? group[0];
        return {
            ...full,
            id: `${key}|blinded-A-B|full-and-declared`,
            roi: 'full-and-declared',
            roiBounds: undefined,
            inspectionRois: Object.fromEntries(
                group.map((record) => [record.roi, record.roiBounds]),
            ),
            reviewerGrades: Array(reviewerCount).fill(null),
        };
    });
}

function reviewHtml(records, binding, title = 'E00 blinded capture review') {
    const data = JSON.stringify(records).replaceAll('<', '\\u003c');
    const safeTitle = String(title).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const storageKey = reviewStorageKey(binding, records);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
    :root { color-scheme: dark; font: 14px/1.4 system-ui, sans-serif; background: #111; color: #eee; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header, footer { position: sticky; z-index: 5; display: flex; gap: 12px; align-items: center; padding: 10px 14px; background: #181818; border-color: #444; }
    header { top: 0; border-bottom: 1px solid; }
    footer { bottom: 0; border-top: 1px solid; }
    main { padding: 14px; }
    button, select, textarea { color: inherit; background: #292929; border: 1px solid #555; border-radius: 3px; padding: 6px 9px; }
    button { cursor: pointer; }
    button.active { background: #d0d0d0; color: #111; }
    .spacer { flex: 1; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .panel { min-width: 0; }
    .viewport { overflow: auto; max-height: calc(100vh - 245px); border: 1px solid #444; background: #050505; }
    .stage { position: relative; transform-origin: top left; }
    .stage img { display: block; width: 100%; height: auto; }
    .roi { position: absolute; border: 1px solid #ffdb4d; pointer-events: none; }
    .meta { display: grid; grid-template-columns: repeat(6, max-content); gap: 4px 16px; margin: 0 0 10px; }
    .meta dt { color: #aaa; }
    .meta dd { margin: 0; }
    .review { display: grid; grid-template-columns: max-content 1fr; gap: 10px; align-items: start; margin-top: 12px; }
    .grades { display: flex; gap: 5px; }
    textarea { width: 100%; min-height: 54px; resize: vertical; }
    .hint { color: #aaa; }
    @media (max-width: 900px) { .pair { grid-template-columns: 1fr; } .meta { grid-template-columns: max-content 1fr; } }
</style>
</head>
<body>
<header>
    <strong>${safeTitle}</strong>
    <span id="progress"></span>
    <span class="spacer"></span>
    <label>Zoom <select id="zoom"><option value="1">1x</option><option value="4">4x</option></select></label>
    <button id="export">Export reviewed rubric</button>
</header>
<main>
    <dl class="meta" id="meta"></dl>
    <div class="pair">
        <section class="panel"><h2>Left</h2><div class="viewport"><div class="stage" id="leftStage"><img id="leftImage" alt="Blinded left capture"></div></div></section>
        <section class="panel"><h2>Right</h2><div class="viewport"><div class="stage" id="rightStage"><img id="rightImage" alt="Blinded right capture"></div></div></section>
    </div>
    <p class="hint" id="rois"></p>
    <div class="review">
        <strong>Grade</strong>
        <div class="grades" id="grades"></div>
        <strong>Notes</strong>
        <textarea id="notes" placeholder="Optional artifact or comparison notes"></textarea>
    </div>
</main>
<footer>
    <button id="previous">Previous</button>
    <button id="next">Next</button>
    <span class="hint">Keys: 0–4 grade and advance · ←/→ navigate</span>
</footer>
<script>
const sourceRecords = ${data};
const storageKey = ${JSON.stringify(storageKey)};
const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
const savedMatches = Array.isArray(saved) &&
    saved.length === sourceRecords.length &&
    saved.every((record, recordIndex) => record.id === sourceRecords[recordIndex].id);
const records = savedMatches ? saved : sourceRecords;
let index = Math.max(0, records.findIndex((record) => record.reviewerGrades[0] === null));
if (index < 0) index = records.length - 1;
let zoom = 1;

const byId = (id) => document.getElementById(id);
const save = () => localStorage.setItem(storageKey, JSON.stringify(records));
const completed = () => records.filter((record) => Number.isInteger(record.reviewerGrades[0])).length;

function drawSide(stageId, imageId, source, rois) {
    const stage = byId(stageId);
    stage.style.width = String(zoom * 100) + '%';
    stage.querySelectorAll('.roi').forEach((element) => element.remove());
    byId(imageId).src = source;
    const full = rois.full;
    for (const [name, roi] of Object.entries(rois)) {
        if (name === 'full') continue;
        const overlay = document.createElement('div');
        overlay.className = 'roi';
        overlay.title = name;
        overlay.style.left = String(roi.x / full.width * 100) + '%';
        overlay.style.top = String(roi.y / full.height * 100) + '%';
        overlay.style.width = String(roi.width / full.width * 100) + '%';
        overlay.style.height = String(roi.height / full.height * 100) + '%';
        stage.append(overlay);
    }
}

function render() {
    const record = records[index];
    byId('progress').textContent = String(index + 1) + ' / ' + records.length + ' · ' + completed() + ' graded';
    byId('meta').innerHTML = [
        ['Scenario', record.scenario],
        ['Ratio', record.ratio],
        ['Frame', record.frame],
        ['View', record.debugView],
        ['Subrun', record.subrun || 'default'],
        ['ID', record.id],
    ].map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('');
    drawSide('leftStage', 'leftImage', record.leftImage, record.inspectionRois);
    drawSide('rightStage', 'rightImage', record.rightImage, record.inspectionRois);
    byId('rois').textContent = 'Inspect: ' + Object.keys(record.inspectionRois).join(', ') + '. Yellow boxes mark declared sub-regions.';
    byId('grades').innerHTML = [0, 1, 2, 3, 4].map((grade) =>
        '<button data-grade="' + grade + '" class="' + (record.reviewerGrades[0] === grade ? 'active' : '') + '">' + grade + '</button>'
    ).join('');
    byId('grades').querySelectorAll('button').forEach((button) =>
        button.addEventListener('click', () => grade(Number(button.dataset.grade)))
    );
    byId('notes').value = record.notes || '';
    byId('previous').disabled = index === 0;
    byId('next').disabled = index === records.length - 1;
}

function navigate(direction) {
    index = Math.max(0, Math.min(records.length - 1, index + direction));
    render();
}

function grade(value) {
    records[index].reviewerGrades[0] = value;
    save();
    if (index < records.length - 1) index++;
    render();
}

byId('notes').addEventListener('input', (event) => {
    records[index].notes = event.target.value;
    save();
});
byId('zoom').addEventListener('change', (event) => {
    zoom = Number(event.target.value);
    render();
});
byId('previous').addEventListener('click', () => navigate(-1));
byId('next').addEventListener('click', () => navigate(1));
byId('export').addEventListener('click', () => {
    save();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }));
    link.download = 'rubric-reviewed.json';
    link.click();
    URL.revokeObjectURL(link.href);
});
document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'TEXTAREA') return;
    if (/^[0-4]$/.test(event.key)) grade(Number(event.key));
    if (event.key === 'ArrowLeft') navigate(-1);
    if (event.key === 'ArrowRight') navigate(1);
});
render();
</script>
</body>
</html>`;
}

async function validateReviewerRubric(template, rubricPath, outputDirectory, manifest) {
    const reviewedRubric = JSON.parse(await readFile(resolve(rubricPath), 'utf8'));
    if (!Array.isArray(reviewedRubric) || reviewedRubric.length !== template.length)
        throw new UserDecisionRequired('Reviewer rubric is missing required records.');
    const expectedRecords = new Map(template.map((record) => [record.id, record]));
    if (expectedRecords.size !== template.length)
        throw new Error('Generated reviewer rubric contains duplicate record IDs.');
    const reviewedIds = new Set();
    const reviewerCount =
        manifest.capture_protocol.harness_acceptance_matrix.reviewer_count;
    for (const record of reviewedRubric) {
        const grades = record.reviewerGrades;
        const expected = expectedRecords.get(record.id);
        if (
            !expected ||
            reviewedIds.has(record.id) ||
            record.scenario !== expected.scenario ||
            record.subrun !== expected.subrun ||
            record.ratio !== expected.ratio ||
            record.frame !== expected.frame ||
            record.debugView !== expected.debugView ||
            record.roi !== expected.roi ||
            record.pairKind !== expected.pairKind ||
            JSON.stringify(record.blindPair) !== JSON.stringify(expected.blindPair) ||
            JSON.stringify(record.inspectionRois) !== JSON.stringify(expected.inspectionRois) ||
            !Array.isArray(grades) ||
            grades.length !== reviewerCount ||
            grades.some((grade) => !Number.isInteger(grade) || grade < 0 || grade > 4)
        )
            throw new UserDecisionRequired(
                `Reviewer rubric record ${record.id ?? '<missing-id>'} is incomplete.`,
            );
        reviewedIds.add(record.id);
    }
    if (
        reviewedIds.size !== expectedRecords.size ||
        [...expectedRecords.keys()].some((id) => !reviewedIds.has(id))
    )
        throw new UserDecisionRequired('Reviewer rubric does not cover every required record ID.');

    const grades = reviewedRubric.flatMap((record) => record.reviewerGrades);
    const sorted = grades.toSorted((a, b) => a - b);
    const middle = sorted.length / 2;
    const median =
        sorted.length % 2 === 0
            ? (sorted[middle - 1] + sorted[middle]) / 2
            : sorted[Math.floor(middle)];
    const reviewerPass = grades.every((grade) => grade <= 1) && median === 0;
    await writeFile(
        join(outputDirectory, 'rubric-reviewed.json'),
        JSON.stringify(reviewedRubric, null, 2),
    );
    if (!reviewerPass) throw new Error('One or more blinded reviewer rubric gates failed.');
    return { recordCount: reviewedRubric.length, reviewerCount, median, passes: true };
}

async function captureRun(client, context, manifest) {
    const { options, outputDirectory, logRecords, binding } = context;
    const ratios = list(options.ratios, '1,1.5,2,3').map(Number);
    const acceptanceMatrix = manifest.capture_protocol.harness_acceptance_matrix.scenarios;
    const acceptanceScenarioIds = Object.keys(acceptanceMatrix);
    const requiredScenarioIds = manifest.scenarios.required.map((scenario) => scenario.id);
    const defaultScenarios = options.smoke ? requiredScenarioIds : acceptanceScenarioIds;
    const requested = new Set(list(options.scenarios, defaultScenarios.join(',')));
    const variants = [
        ['A', options.variant],
        ['B', options.comparison],
    ];
    const reloads = Number(options.reloads ?? 5);
    const frameOverride = options.frames ? list(options.frames, '').map(Number) : null;
    const viewOverride = options.views ? list(options.views, '') : null;
    const records = [];
    const capturesByTuple = new Map();
    const authoritativeCoverage =
        reloads === 5 &&
        ratios.join(',') === manifest.scenarios.ratios.join(',') &&
        frameOverride === null &&
        viewOverride === null &&
        requested.size === acceptanceScenarioIds.length &&
        acceptanceScenarioIds.every((id) => requested.has(id));
    if (!options.smoke && !authoritativeCoverage)
        throw new Error(
            `Authoritative capture requires ${acceptanceScenarioIds.join(',')}, all manifest ratios, the frozen E00 acceptance frames/views, and five reloads.`,
        );

    for (const scenario of manifest.scenarios.required.filter((entry) => requested.has(entry.id))) {
        const captureSpec = options.smoke ? scenario.captures : acceptanceMatrix[scenario.id];
        if (!captureSpec)
            throw new Error(`${scenario.id} is not part of the authoritative E00 capture matrix.`);
        for (const subrun of scenarioSubruns(scenario)) {
            for (const ratio of ratios) {
                for (const [blind, variant] of variants) {
                    for (let reload = 1; reload <= reloads; reload++) {
                        const url = runUrl(DEFAULT_URL, options, variant, ratio, scenario.id, subrun);
                        const pageName = [
                            blind,
                            variant,
                            `reload-${reload}`,
                            scenario.id,
                            subrun,
                            `ratio-${ratio}`,
                        ]
                            .filter(Boolean)
                            .join('_');
                        try {
                            await navigate(client, url, logRecords);
                            const initial = await evaluate(client, 'window.__UPSCALER_BENCH__.result');
                            if (initial.status === 'unsupported')
                                throw new Error(`${scenario.id}/${subrun ?? 'default'} is unsupported.`);
                            if (initial.variant?.id !== variant)
                                throw new Error(
                                    `${pageName} reported variant ${initial.variant?.id ?? '<missing>'}, expected ${variant}.`,
                                );
                            const period = manifest.capture_protocol.jitter_period_by_ratio[String(ratio)];
                            for (const frame of frameOverride ?? captureFrames(captureSpec.frames, period)) {
                                for (const debugView of viewOverride ?? captureSpec.debug_views) {
                                    const capture = await evaluate(
                                        client,
                                        `window.__UPSCALER_BENCH__.capture(${JSON.stringify({ frame, debugView })})`,
                                    );
                                    const expectedDimensions = expectedCaptureDimensions(
                                        scenario.id,
                                        frame,
                                    );
                                    const screenshot = await captureCanvas(client);
                                    const png = screenshot.bytes;
                                    const stem = [
                                    blind,
                                    variant,
                                    `reload-${reload}`,
                                    scenario.id,
                                    subrun,
                                    `ratio-${ratio}`,
                                    `frame-${frame}`,
                                    debugView,
                                ]
                                    .filter(Boolean)
                                    .join('_');
                                    const pngPath = join(outputDirectory, `${stem}.png`);
                                    await writeFile(pngPath, png);
                                    let decoded;
                                    try {
                                        decoded = decodePng(png);
                                    } catch (error) {
                                        await writeFile(
                                            join(outputDirectory, `${stem}-validation.json`),
                                            JSON.stringify(
                                                {
                                                    blind,
                                                    variant,
                                                    reload,
                                                    ratio,
                                                    scenario: scenario.id,
                                                    subrun,
                                                    capture,
                                                    expectedDimensions,
                                                    clip: screenshot.clip,
                                                    differenceLegend: differenceLegend(),
                                                    validation: {
                                                        passes: false,
                                                        errors: [
                                                            error instanceof Error
                                                                ? error.message
                                                                : String(error),
                                                        ],
                                                    },
                                                },
                                                null,
                                                2,
                                            ),
                                        );
                                        throw error;
                                    }
                                    const validation = validateDecodedCapture(
                                        decoded,
                                        expectedDimensions,
                                    );
                                    if (
                                        capture.width !== expectedDimensions.width ||
                                        capture.height !== expectedDimensions.height
                                    )
                                        validation.errors.push(
                                            `Browser metadata ${capture.width}x${capture.height} does not match independent expectation ${expectedDimensions.width}x${expectedDimensions.height}.`,
                                        );
                                    if (
                                        screenshot.clip.width !== expectedDimensions.width ||
                                        screenshot.clip.height !== expectedDimensions.height
                                    )
                                        validation.errors.push(
                                            `Canvas clip ${screenshot.clip.width}x${screenshot.clip.height} does not match independent expectation ${expectedDimensions.width}x${expectedDimensions.height}.`,
                                        );
                                    if (capture.jitterPeriod !== period)
                                        validation.errors.push(
                                            `Active resolver jitter period ${capture.jitterPeriod} does not match manifest P=${period}.`,
                                        );
                                    validation.passes = validation.errors.length === 0;
                                    const validationRecord = {
                                        blind,
                                        variant,
                                        reload,
                                        ratio,
                                        scenario: scenario.id,
                                        subrun,
                                        capture,
                                        expectedDimensions,
                                        clip: screenshot.clip,
                                        png: {
                                            width: decoded.width,
                                            height: decoded.height,
                                            bitDepth: decoded.bitDepth,
                                            colorType: decoded.colorType,
                                        },
                                        validation,
                                        differenceLegend: differenceLegend(),
                                    };
                                    await writeFile(
                                        join(outputDirectory, `${stem}-validation.json`),
                                        JSON.stringify(validationRecord, null, 2),
                                    );
                                    records.push(validationRecord);
                                    if (!validation.passes)
                                        throw new Error(`Capture validation failed for ${stem}: ${validation.errors.join(' ')}`);

                                    const tupleKey = [
                                        scenario.id,
                                        subrun ?? 'default',
                                        ratio,
                                        frame,
                                        debugView,
                                    ].join('|');
                                    const tuple = capturesByTuple.get(tupleKey) ?? {
                                        key: tupleKey,
                                        scenario: scenario.id,
                                        subrun,
                                        ratio,
                                        frame,
                                        debugView,
                                        rois: scenario.captures.rois,
                                        A: [],
                                        B: [],
                                    };
                                    tuple[blind].push({ blind, variant, reload, stem, pngPath });
                                    capturesByTuple.set(tupleKey, tuple);
                                }
                            }
                            assertCleanLogs(logRecords);
                        } finally {
                            await persistPageEvidence(client, outputDirectory, pageName, logRecords);
                        }
                    }
                }
            }
        }
    }
    const pairResults = [];
    const rubric = [];
    for (const tuple of capturesByTuple.values()) {
        if (tuple.A.length !== reloads || tuple.B.length !== reloads)
            throw new Error(`Capture tuple ${tuple.key} has incomplete reload sets.`);
        const loadedCaptures = new Map();
        for (const capture of [...tuple.A, ...tuple.B]) {
            const bytes = await readFile(capture.pngPath);
            loadedCaptures.set(capture.pngPath, { bytes, decoded: decodePng(bytes) });
        }
        const pairs = [
            ...unorderedPairs(tuple.A).map((pair) => ['A-A', pair]),
            ...unorderedPairs(tuple.B).map((pair) => ['B-B', pair]),
            ...tuple.A.flatMap((a) => tuple.B.map((b) => ['A-B', [a, b]])),
        ];
        for (const [kind, [left, right]] of pairs) {
            const { bytes: leftBytes, decoded: leftDecoded } = loadedCaptures.get(left.pngPath);
            const { bytes: rightBytes, decoded: rightDecoded } = loadedCaptures.get(right.pngPath);
            const regions = {
                full: { x: 0, y: 0, width: leftDecoded.width, height: leftDecoded.height },
                ...Object.fromEntries(
                    Object.entries(tuple.rois).map(([name, roi]) => [
                        name,
                        resolveRoi(roi, leftDecoded.width, leftDecoded.height),
                    ]),
                ),
            };
            const dimensionsPass =
                leftDecoded.width === rightDecoded.width &&
                leftDecoded.height === rightDecoded.height;
            const exactMatch = dimensionsPass && leftDecoded.rgba.equals(rightDecoded.rgba);
            const metrics = dimensionsPass
                ? Object.fromEntries(
                      Object.entries(regions).map(([name, region]) => [
                          name,
                          exactMatch
                              ? { ...region, maxAbsolute: 0, rmse: 0, passes: true }
                              : compareRegion(leftDecoded, rightDecoded, region),
                      ]),
                  )
                : {};
            const passes = dimensionsPass && Object.values(metrics).every((metric) => metric.passes);
            const pairStem = `${tuple.key.replaceAll('|', '_')}_${kind}_${left.reload}-${right.reload}`;
            const result = {
                tuple: tuple.key,
                kind,
                left: { blind: left.blind, variant: left.variant, reload: left.reload, stem: left.stem },
                right: { blind: right.blind, variant: right.variant, reload: right.reload, stem: right.stem },
                dimensionsPass,
                alphaPass: true,
                metrics,
                thresholds: { maxAbsolute: 1 / 255, rmse: 0.25 / 255 },
                differenceLegend: differenceLegend(),
                passes,
            };
            if (!passes) {
                await writeFile(
                    join(outputDirectory, `${pairStem}-metrics.json`),
                    JSON.stringify(result, null, 2),
                );
            }
            if (!passes && dimensionsPass)
                await writeFile(
                    join(outputDirectory, `${pairStem}-heatmap.png`),
                    differenceHeatmap(leftDecoded, rightDecoded),
                );
            pairResults.push(result);

            if (
                kind === 'A-B' &&
                left.reload === 1 &&
                right.reload === 1 &&
                (options['review-all'] || isHumanReviewTuple(manifest, tuple))
            ) {
                const reviewId = createHash('sha256').update(tuple.key).digest('hex').slice(0, 16);
                const reverse = (createHash('sha256').update(`${tuple.key}|orientation`).digest()[0] & 1) === 1;
                const reviewLeft = reverse ? rightBytes : leftBytes;
                const reviewRight = reverse ? leftBytes : rightBytes;
                const leftImage = `review-${reviewId}-left.png`;
                const rightImage = `review-${reviewId}-right.png`;
                await writeFile(join(outputDirectory, leftImage), reviewLeft);
                await writeFile(join(outputDirectory, rightImage), reviewRight);

                for (const [roi, roiBounds] of Object.entries(regions))
                    rubric.push({
                        id: [
                            tuple.key,
                            'blinded-A-B',
                            roi,
                        ].join('|'),
                        scenario: tuple.scenario,
                        subrun: tuple.subrun,
                        ratio: tuple.ratio,
                        frame: tuple.frame,
                        debugView: tuple.debugView,
                        roi,
                        roiBounds,
                        blindPair: ['left', 'right'],
                        pairKind: 'blinded-A-B',
                        leftReload: left.reload,
                        rightReload: right.reload,
                        leftImage,
                        rightImage,
                        reviewerGrades: [null, null],
                        notes: '',
                    });
            }
        }
    }
    const expectedPairsPerTuple = reloads === 5 ? 45 : reloads * (reloads - 1) + reloads ** 2;
    const selectedScenarios = manifest.scenarios.required.filter((scenario) =>
        requested.has(scenario.id),
    );
    const expectedTupleCount = selectedScenarios.reduce(
        (total, scenario) => {
            const captureSpec = options.smoke ? scenario.captures : acceptanceMatrix[scenario.id];
            return total +
                scenarioSubruns(scenario).length *
                    ratios.reduce(
                        (ratioTotal, ratio) =>
                            ratioTotal +
                            captureFrames(
                                captureSpec.frames,
                                manifest.capture_protocol.jitter_period_by_ratio[String(ratio)],
                            ).length *
                                captureSpec.debug_views.length,
                        0,
                    );
        },
        0,
    );
    const pairKindCounts = Object.fromEntries(
        ['A-A', 'B-B', 'A-B'].map((kind) => [
            kind,
            pairResults.filter((pair) => pair.kind === kind).length,
        ]),
    );
    const analysis = {
        reloads,
        authoritative: !options.smoke,
        nonAuthoritativeReason: options.smoke ? 'smoke-mode' : null,
        completeProtocol:
            authoritativeCoverage && capturesByTuple.size === expectedTupleCount,
        tupleCount: capturesByTuple.size,
        expectedTupleCount,
        pairCount: pairResults.length,
        expectedPairsPerTuple,
        pairKindCounts,
        failedPairCount: pairResults.filter((pair) => !pair.passes).length,
        passes:
            pairResults.every((pair) => pair.passes) &&
            pairResults.length === capturesByTuple.size * expectedPairsPerTuple &&
            (options.smoke ||
                (capturesByTuple.size === expectedTupleCount &&
                    pairKindCounts['A-A'] === expectedTupleCount * 10 &&
                    pairKindCounts['B-B'] === expectedTupleCount * 10 &&
                    pairKindCounts['A-B'] === expectedTupleCount * 25)),
        pairs: pairResults,
    };
    const reviewRubric = normalizeRubricTemplate(rubric, manifest, options['review-all']);
    await writeFile(join(outputDirectory, 'capture-analysis.json'), JSON.stringify(analysis, null, 2));
    await writeFile(
        join(outputDirectory, 'rubric-template.json'),
        JSON.stringify(reviewRubric, null, 2),
    );
    await writeFile(
        join(outputDirectory, 'review.html'),
        reviewHtml(reviewRubric, binding, options['review-title']),
    );
    if (!analysis.passes && !options['allow-differences'])
        throw new Error('One or more capture equivalence pairs failed.');
    if (!options.smoke) {
        if (!options.rubric)
            throw new UserDecisionRequired(
                'Blinded reviewer grades are required; complete rubric-template.json, then run --review-only with --output and --rubric.',
            );
        await validateReviewerRubric(reviewRubric, options.rubric, outputDirectory, manifest);
    }
    return {
        records,
        analysis,
        rubricTemplate: 'rubric-template.json',
        status: options.smoke ? 'non-authoritative-smoke' : 'complete',
    };
}

async function reviewExistingCapture(outputDirectory, rubricPath, manifest, binding) {
    const run = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8'));
    const analysis = JSON.parse(
        await readFile(join(outputDirectory, 'capture-analysis.json'), 'utf8'),
    );
    assertCaptureEvidenceBinding({
        run,
        analysis,
        manifestDigest: binding.manifestDigest,
        workingTreeDigest: binding.workingTreeDigest,
    });
    const templatePath = join(outputDirectory, 'rubric-template.json');
    const existingTemplate = JSON.parse(await readFile(templatePath, 'utf8'));
    if (!Array.isArray(existingTemplate))
        throw new Error('Existing rubric-template.json is not an array.');
    const normalizedTemplate = existingTemplate.every((record) => record.inspectionRois)
        ? existingTemplate
        : normalizeRubricTemplate(existingTemplate, manifest);
    if (normalizedTemplate.length === 0)
        throw new Error('Existing capture artifacts contain no required human-review tuples.');
    await writeFile(templatePath, JSON.stringify(normalizedTemplate, null, 2));
    await writeFile(
        join(outputDirectory, 'review.html'),
        reviewHtml(normalizedTemplate, binding),
    );
    if (!rubricPath)
        return {
            status: 'USER_DECISION_REQUIRED',
            recordCount: normalizedTemplate.length,
            rubricTemplate: 'rubric-template.json',
        };
    const validation = await validateReviewerRubric(
        normalizedTemplate,
        rubricPath,
        outputDirectory,
        manifest,
    );
    return { status: 'complete', rubricTemplate: 'rubric-template.json', validation };
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill('SIGTERM');
    const graceful = await Promise.race([
        exited.then(() => true),
        new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3000)),
    ]);
    if (graceful) return;
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
}

function collectChildOutput(child) {
    const output = { stdout: '', stderr: '' };
    child?.stdout?.on('data', (chunk) => {
        output.stdout += chunk.toString();
    });
    child?.stderr?.on('data', (chunk) => {
        output.stderr += chunk.toString();
    });
    return output;
}

async function persistChildOutput(outputDirectory, name, output) {
    if (!output) return;
    await writeFile(
        join(outputDirectory, `${name}-process.json`),
        JSON.stringify(output, null, 2),
    );
}

function attachLogCollection(client, logRecords) {
    client.on('Log.entryAdded', ({ entry }) => {
        logRecords.push({
            channel: 'Log.entryAdded',
            level: entry.level,
            text: entry.text,
            timestamp: entry.timestamp,
        });
    });
    client.on('Runtime.consoleAPICalled', (event) => {
        logRecords.push({
            channel: 'Runtime.consoleAPICalled',
            level: event.type,
            text: event.args.map(formatConsoleArgument).join(' '),
            timestamp: event.timestamp,
        });
    });
    client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        logRecords.push({
            channel: 'Runtime.exceptionThrown',
            level: 'error',
            text: exceptionDetails.exception?.description ?? exceptionDetails.text,
            timestamp: exceptionDetails.timestamp,
        });
    });
}

async function createBrowserRuntime(cli, cdpBase, port, outputDirectory, name) {
    let chrome = null;
    let profile = null;
    let processOutput = null;
    let page = null;
    try {
        if (!cli.cdp) {
            profile = join(tmpdir(), `upscaler-e00-${process.pid}-${Date.now()}`);
            chrome = spawn(
                chromeExecutable(cli.chrome),
                [
                    '--headless=new',
                    '--enable-unsafe-webgpu',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    `--remote-debugging-port=${port}`,
                    `--user-data-dir=${profile}`,
                    '--window-size=1920,1080',
                    '--force-device-scale-factor=1',
                    'about:blank',
                ],
                { stdio: ['ignore', 'pipe', 'pipe'] },
            );
            processOutput = collectChildOutput(chrome);
            await waitForUrl(`${cdpBase}/json/version`);
        }
        page = await createPage(cdpBase);
        const { client, targetId } = page;
        const logRecords = [];
        attachLogCollection(client, logRecords);
        await Promise.all([
            client.call('Page.enable'),
            client.call('Runtime.enable'),
            client.call('Log.enable'),
        ]);
        return {
            chrome,
            profile,
            client,
            targetId,
            cdpBase,
            userOwnedCdp: Boolean(cli.cdp),
            logRecords,
            processOutput,
            outputDirectory,
            name,
        };
    } catch (error) {
        if (page && cli.cdp) {
            try {
                await closeExternalCdpTarget(cdpBase, page.targetId);
            } catch {
                // Preserve the startup error; cleanup failure is secondary here.
            } finally {
                page.client.close();
            }
        }
        await stopChild(chrome);
        await persistChildOutput(outputDirectory, name, processOutput);
        if (profile) await rm(profile, { recursive: true, force: true });
        throw error;
    }
}

async function closeBrowserRuntime(runtime) {
    if (!runtime) return;
    try {
        if (runtime.userOwnedCdp)
            await closeExternalCdpTarget(runtime.cdpBase, runtime.targetId);
    } finally {
        runtime.client.close();
        await stopChild(runtime.chrome);
        await persistChildOutput(runtime.outputDirectory, runtime.name, runtime.processOutput);
        if (runtime.profile) await rm(runtime.profile, { recursive: true, force: true });
    }
}

async function main() {
    const cli = parseArguments(process.argv.slice(2));
    if (cli.help || cli.h) {
        console.log(`Usage: node scripts/run-benchmark.mjs [options]
  --mode performance|capture   (default performance)
  --smoke                      relax E00 acceptance gates — required for candidate A/B runs
  --variant <id> --comparison <id>   A/B variant ids (see bench/src/benchmark/variants.ts)
  --ratios 1,1.5,2,3  --blocks N  --warmup N  --samples N     timing shape
  --scenarios Q0,..  --frames 0,..  --views final,..  --reloads N  --allow-differences  --review-all   capture shape
  --output <dir>               results directory (default bench/results/raw/E00/<timestamp>)
  --chrome <path> | --cdp <url>   browser selection
Without --smoke this runs the strict E00 baseline acceptance protocol (64 runs, hard noise gates).`);
        return;
    }
    const manifestBytes = await readFile(MANIFEST_PATH);
    const manifest = JSON.parse(manifestBytes);
    const mode = cli.mode ?? 'performance';
    const smoke = cli.smoke === true || cli.smoke === 'true';
    const baselineRoleA = manifest.timing_protocol.variant_mapping.A;
    const baselineRoleB = manifest.timing_protocol.variant_mapping.B;
    const requestedVariant = cli.variant ?? 'baseline';
    const requestedComparison = cli.comparison ?? 'baseline';
    if (!smoke && requestedVariant !== 'baseline' && requestedVariant !== baselineRoleA)
        throw new Error(`Authoritative E00 role A must be ${baselineRoleA}.`);
    if (!smoke && requestedComparison !== 'baseline' && requestedComparison !== baselineRoleB)
        throw new Error(`Authoritative E00 role B must be ${baselineRoleB}.`);
    const options = {
        ...cli,
        mode,
        experiment: cli.experiment ?? 'E00',
        variant: requestedVariant === 'baseline' ? baselineRoleA : requestedVariant,
        comparison:
            requestedComparison === 'baseline' ? baselineRoleB : requestedComparison,
        warmup: Number(cli.warmup ?? 240),
        samples: Number(cli.samples ?? 600),
        smoke,
    };
    if (options.experiment !== 'E00') throw new Error(`Unsupported experiment: ${options.experiment}`);

    const stamp = new Date().toISOString().replaceAll(':', '-');
    const outputDirectory = resolve(cli.output ?? join(ROOT, 'bench/results/raw/E00', stamp));
    const binding = {
        manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
        workingTreeDigest: await currentWorkingTreeDigest(),
    };
    if (cli['prepare-review'] || cli['review-only']) {
        if (!cli.output)
            throw new Error('--prepare-review and --review-only require an existing --output directory.');
        const result = await reviewExistingCapture(
            outputDirectory,
            cli['review-only'] ? cli.rubric : null,
            manifest,
            binding,
        );
        await writeFile(
            join(outputDirectory, 'review-result.json'),
            JSON.stringify(
                {
                    ...result,
                    ...binding,
                    timestamp: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        console.log(outputDirectory);
        return;
    }

    const { stdout: localSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'manifest.json'), manifestBytes);
    await writeFile(
        join(outputDirectory, 'run.json'),
        JSON.stringify(
            {
                options,
                ...binding,
                localSha: localSha.trim(),
                startedAt: new Date().toISOString(),
            },
            null,
            2,
        ),
    );

    const port = Number(cli.port ?? 9333);
    const cdpBase = cli.cdp ?? `http://127.0.0.1:${port}`;
    let server = null;
    let serverOutput = null;
    let runtime = null;
    let browserGeneration = 0;
    try {
        try {
            await waitForUrl(DEFAULT_URL, 1);
        } catch {
            server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
                cwd: ROOT,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            serverOutput = collectChildOutput(server);
            await waitForUrl(DEFAULT_URL);
        }

        runtime = await createBrowserRuntime(
            cli,
            cdpBase,
            port,
            outputDirectory,
            `chrome-${browserGeneration++}`,
        );
        const browserVersion = await fetch(`${cdpBase}/json/version`).then((response) => response.json());
        await writeFile(
            join(outputDirectory, 'browser.json'),
            JSON.stringify(
                {
                    product: browserVersion.Browser,
                    protocolVersion: browserVersion['Protocol-Version'],
                    userAgent: browserVersion['User-Agent'],
                    operatingSystem: `${process.platform} ${process.arch}`,
                },
                null,
                2,
            ),
        );

        const context = {
            options,
            outputDirectory,
            binding,
            logRecords: runtime.logRecords,
            async restartBrowser() {
                if (cli.cdp)
                    throw new Error('Cold-browser retry is unavailable with a user-owned --cdp session.');
                await closeBrowserRuntime(runtime);
                runtime = await createBrowserRuntime(
                    cli,
                    cdpBase,
                    port,
                    outputDirectory,
                    `chrome-${browserGeneration++}`,
                );
                return runtime;
            },
        };
        const results =
            mode === 'capture'
                ? await captureRun(runtime.client, context, manifest)
                : await performanceRun(runtime.client, context);
        await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(results, null, 2));
        console.log(outputDirectory);
    } catch (error) {
        await writeFile(
            join(outputDirectory, 'failure.json'),
            JSON.stringify(
                {
                    status:
                        error instanceof UserDecisionRequired
                            ? 'USER_DECISION_REQUIRED'
                            : error instanceof BlockedError
                              ? 'BLOCKED'
                            : 'FAIL',
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : null,
                    timestamp: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        throw error;
    } finally {
        await closeBrowserRuntime(runtime);
        await stopChild(server);
        await persistChildOutput(outputDirectory, 'vite', serverOutput);
    }
}

await main();
