#!/usr/bin/env node
/**
 * Exposure metering A/B (bench/docs/NEXT-STEPS.md §16): the frozen
 * single-invocation form (LUMINANCE_PYRAMID_SERIAL_SHADER) against production,
 * where the 64 lanes share the same 1024 taps and a workgroup tree sums them.
 *
 * Part `shader` (examples dev server, a bare WebGPU device per fresh Chrome
 * profile, like measure-exposure-compile.mjs):
 * - compile time of four forms: serial and parallel, each with the shipped
 *   uniform row bound and with it replaced by the constant (the DXC case of
 *   docs/windows-followups.md); the order alternates between runs
 * - readback on synthetic HDR inputs (noise, smooth fields, gradients, sparse
 *   emitters, black, grey, the compile script's 64×64 fixture) under five
 *   flag cases, in the shipped rgba16float and, to see the difference before
 *   f16 rounding hides it, an rgba32float copy of each shader
 * - GPU timestamps, ABBA-interleaved, at two input sizes
 *
 * Part `scenes` (bench dev server): plays bench scenarios frame by frame under
 * `baseline` and `exposure-serial-v1` and reads the published exposure guide
 * (rgba16float: exposure, avg luma, host) back after every frame.
 *
 * Usage:
 *   node scripts/measure-exposure-parallel.mjs [--part all|shader|scenes]
 *     [--runs 3] [--samples 256] [--scenarios Q0,Q1,Q3,Q9,Q10,Q11] [--frames 240]
 *     [--ratio 2] [--chrome path] [--output dir]
 *     [--examples-url http://127.0.0.1:5312] [--bench-url http://127.0.0.1:5313]
 *     [--port 9352] [--power-preference high-performance|low-power]
 *     [--expected-vendor nvidia|intel]
 *
 * Writes results.json under --output (default
 * bench/results/raw/exposure-parallel/<timestamp>/) and prints a summary.
 * Exits non-zero on a WGSL/validation error, or if a constant-bound form reads
 * back differently from its uniform-bound twin (same summation order).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { parseCliOrExit } from './cli-flags.mjs';
import { gpuAuditSource } from './gpu-audit.mjs';
import {
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const USAGE = `Usage: node scripts/measure-exposure-parallel.mjs [options]
  --part all|shader|scenes   which measurements to run (default all)
  --runs <n>                 fresh-profile shader runs (default 3)
  --samples <n>              timestamp samples per input size and run, ABBA (default 256)
  --scenarios <ids>          bench scenarios for the scenes part (default Q0,Q1,Q3,Q9,Q10,Q11)
  --frames <n>               frames played per scenario (default 240)
  --ratio <n>                bench upscale ratio for the scenes part (default 2)
  --examples-url <origin>    examples dev server for the shader part (default http://127.0.0.1:5312)
  --bench-url <origin>       bench dev server for the scenes part (default http://127.0.0.1:5313)
  --port <n>                 CDP port of the Chrome this script launches (default 9352)
  --chrome <path>            browser executable
  --output <dir>             results directory
  --power-preference high-performance|low-power   adapter hint (Windows hybrid GPUs)
  --expected-vendor <name>   fail unless the adapter vendor matches (e.g. nvidia, intel)`;

const cli = parseCliOrExit(
    process.argv.slice(2),
    ['part', 'runs', 'samples', 'scenarios', 'frames', 'ratio', 'examples-url', 'bench-url', 'port',
        'chrome', 'output', 'power-preference', 'expected-vendor'],
    USAGE,
);
const ROOT = resolve(import.meta.dirname, '..');
const part = String(cli.part ?? 'all');
if (!['all', 'shader', 'scenes'].includes(part)) throw new Error(`--part must be all, shader or scenes; got ${part}.`);
const runs = Number(cli.runs ?? 3);
const samples = Number(cli.samples ?? 256);
const scenarios = String(cli.scenarios ?? 'Q0,Q1,Q3,Q9,Q10,Q11').split(',').filter(Boolean);
const frames = Number(cli.frames ?? 240);
const ratio = Number(cli.ratio ?? 2);
const examplesServer = resolveServerUrl(cli['examples-url'], 'http://127.0.0.1:5312');
const benchServer = resolveServerUrl(cli['bench-url'], 'http://127.0.0.1:5313');
const cdpPort = parsePort(cli.port, '--port') ?? 9352;
const auditSource = gpuAuditSource(cli);
const output = resolve(
    String(cli.output ?? join(ROOT, 'bench/results/raw/exposure-parallel', new Date().toISOString().replace(/[:.]/g, '-'))),
);

//* In-page: shader part ======================================================
// Serialized with toString() and evaluated in the page, so it may only use its
// arguments and browser globals.
async function shaderRun({ shaderUrl, order, samples }) {
    const module = await import(shaderUrl);
    const sources = {
        serial: module.LUMINANCE_PYRAMID_SERIAL_SHADER,
        parallel: module.LUMINANCE_PYRAMID_SHADER,
    };
    sources['serial-constant-bound'] = sources.serial.replaceAll('C.exposureTaps', 'EXPOSURE_TAPS');
    sources['parallel-constant-bound'] = sources.parallel.replaceAll('C.exposureTaps', 'EXPOSURE_TAPS');
    // f32 copies publish the raw logSum in .a too.
    const f32Source = (code) => code
        .replace('var exposureOut : texture_storage_2d<rgba16float, write>', 'var exposureOut : texture_storage_2d<rgba32float, write>')
        .replace('vec4f(exposure, avgLum, host, 0.0)', 'vec4f(exposure, avgLum, host, logSum)');
    // Every tap's log2 luma, so the CPU can sum the same 1024 values exactly
    // (f64) and in each form's f32 order.
    const tapSource = sources.serial.slice(0, sources.serial.indexOf('@compute')) + `
@group(0) @binding(7) var taps : texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(gid.xy >= vec2u(EXPOSURE_TAPS))) { return; }
    let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / f32(EXPOSURE_TAPS);
    let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
    textureStore(taps, vec2i(gid.xy), vec4f(log2(max(luma(c), 1.0e-4)), 0.0, 0.0, 0.0));
}`;

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const timestamps = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
    const errors = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

    //* Compile (timed, in the requested order)
    const pipelines = {};
    const compileMs = {};
    for (const name of order) {
        const begin = performance.now();
        const shader = device.createShaderModule({ code: sources[name] });
        pipelines[name] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
        compileMs[name] = performance.now() - begin;
        const info = await shader.getCompilationInfo();
        for (const message of info.messages) if (message.type === 'error') errors.push(`${name}: ${message.message}`);
    }
    const tapPipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: { module: device.createShaderModule({ code: tapSource }), entryPoint: 'main' },
    });
    const f32Pipelines = {};
    for (const name of ['serial', 'parallel']) {
        const shader = device.createShaderModule({ code: f32Source(sources[name]) });
        f32Pipelines[name] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    }

    //* Half-float helpers (round to nearest even)
    const scratch = new DataView(new ArrayBuffer(4));
    function half(value) {
        scratch.setFloat32(0, value);
        const bits = scratch.getUint32(0);
        const sign = (bits >>> 16) & 0x8000;
        const exponent = ((bits >>> 23) & 255) - 127 + 15;
        let mantissa = bits & 0x7fffff;
        if (((bits >>> 23) & 255) === 255 || exponent >= 31) return sign | 0x7c00;
        if (exponent <= 0) {
            if (exponent < -10) return sign;
            mantissa |= 0x800000;
            const shift = 14 - exponent;
            let h = mantissa >>> shift;
            const rest = mantissa & ((1 << shift) - 1), midpoint = 1 << (shift - 1);
            if (rest > midpoint || (rest === midpoint && (h & 1))) h++;
            return sign | h;
        }
        let h = (exponent << 10) | (mantissa >>> 13);
        const rest = mantissa & 0x1fff;
        if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;
        return sign | h;
    }
    function fromHalf(h) {
        const sign = h & 0x8000 ? -1 : 1, exponent = (h >>> 10) & 31, mantissa = h & 1023;
        if (exponent === 0) return sign * mantissa * 2 ** -24;
        if (exponent === 31) return mantissa ? NaN : sign * Infinity;
        return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }

    //* Inputs
    function rng(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const kinds = {
        // Per-channel log-uniform HDR noise, 2^-14 … 2^10.
        noise: (random) => () => [0, 0, 0].map(() => 2 ** (-14 + 24 * random())),
        // A smooth lit field (± 4 stops), textured: what a bench frame looks like to 1024 taps.
        field: (random, w, h) => {
            const [fx, fy, px, py] = [random() * 8 + 1, random() * 8 + 1, random() * 6.3, random() * 6.3];
            const base = -3 + 4 * random();
            return (x, y) => {
                const stops = base + 4 * Math.sin(px + (fx * x) / w * 6.28) * Math.cos(py + (fy * y) / h * 6.28);
                const v = 2 ** (stops + 0.5 * (random() - 0.5));
                return [v, v * (0.6 + 0.4 * random()), v * (0.3 + 0.7 * random())];
            };
        },
        // Mostly black with 0.5 % emitters at 50 (the issue #49 case).
        sparse: (random) => () => (random() < 0.005 ? [50, 50, 50] : [0, 0, 0]),
        gradient: (_, w) => (x) => { const v = 2 ** (-12 + (20 * x) / w); return [v, v, v]; },
        black: () => () => [0, 0, 0],
        grey: () => () => [0.18, 0.18, 0.18],
        // measure-exposure-compile.mjs's fixture.
        periodic: () => (x, y) => { const i = y * 64 + x, v = [0, 0.01, 0.18, 1, 8, 64, 512][i % 7]; return [v, v * 0.5, v * 0.25]; },
    };
    const inputSpecs = [
        ['periodic', 64, 64, 0], ['black', 640, 360, 0], ['grey', 1280, 720, 0],
        ['gradient', 1920, 1080, 0], ['sparse', 960, 540, 1], ['sparse', 1920, 1080, 2],
    ];
    for (let seed = 1; seed <= 8; seed++) inputSpecs.push(['noise', 960, 540, seed], ['field', 960, 540, 100 + seed]);
    for (let seed = 1; seed <= 2; seed++) inputSpecs.push(['noise', 1920, 1080, 200 + seed], ['field', 1920, 1080, 300 + seed]);

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    function makeInput([kind, width, height, seed]) {
        const texture = device.createTexture({ size: [width, height], format: 'rgba16float', usage });
        const random = rng(seed * 7919 + 13);
        const texel = kinds[kind](random, width, height);
        const data = new Uint16Array(width * height * 4);
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const [r, g, b] = texel(x, y);
                data.set([half(r), half(g), half(b), half(1)], (y * width + x) * 4);
            }
        device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 8 }, [width, height]);
        return { name: `${kind}-${width}x${height}${seed ? `-s${seed}` : ''}`, texture, width, height };
    }
    const one = (format = 'rgba16float') => device.createTexture({ size: [1, 1], format, usage });
    const previous = one(), external = one(), host = one();
    const output16 = one(), output32 = one('rgba32float');
    const writeOne = (target, values) =>
        device.queue.writeTexture({ texture: target }, new Uint16Array(values.map(half)), {}, [1, 1]);
    writeOne(previous, [0.3, 0, 1, 0]);
    writeOne(external, [0.75, 0, 0, 0]);
    const uniform = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const constants = new ArrayBuffer(256), f32 = new Float32Array(constants), u32 = new Uint32Array(constants);
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    function writeConstants(input, flags) {
        f32.set([input.width, input.height, input.width, input.height,
            1 / input.width, 1 / input.height, 1 / input.width, 1 / input.height]);
        f32[18] = 2; f32[19] = 1 / 60; u32[20] = flags; u32[23] = 32;
        device.queue.writeBuffer(uniform, 0, constants);
    }
    function bindGroup(pipeline, input, out) {
        return device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ buffer: uniform }, input.texture.createView(), sampler, previous.createView(),
                out.createView(), external.createView(), host.createView()]
                .map((resource, binding) => ({ binding, resource })),
        });
    }
    const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    async function runOnce(pipeline, input, out) {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup(pipeline, input, out));
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyTextureToBuffer({ texture: out }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const range = readback.getMappedRange();
        const value = out.format === 'rgba32float'
            ? [...new Float32Array(range).slice(0, 4)]
            : [...new Uint16Array(range).slice(0, 4)];
        readback.unmap();
        return value;
    }

    const tapTexture = device.createTexture({ size: [32, 32], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const tapBuffer = device.createBuffer({ size: 256 * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    /** logSum three ways from the GPU's own per-tap values: exact, serial f32 order, parallel f32 order. */
    async function tapSums(input) {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(tapPipeline);
        pass.setBindGroup(0, device.createBindGroup({
            layout: tapPipeline.getBindGroupLayout(0),
            entries: [{ binding: 1, resource: input.texture.createView() }, { binding: 2, resource: sampler },
                { binding: 7, resource: tapTexture.createView() }],
        }));
        pass.dispatchWorkgroups(4, 4);
        pass.end();
        encoder.copyTextureToBuffer({ texture: tapTexture }, { buffer: tapBuffer, bytesPerRow: 256 }, [32, 32]);
        device.queue.submit([encoder.finish()]);
        await tapBuffer.mapAsync(GPUMapMode.READ);
        const raw = new Float32Array(tapBuffer.getMappedRange().slice(0));
        tapBuffer.unmap();
        const tap = (x, y) => raw[y * 64 + x];
        let exact = 0, serial = 0;
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { exact += tap(x, y); serial = Math.fround(serial + tap(x, y)); }
        const lanes = new Float32Array(64);
        for (let ly = 0; ly < 8; ly++) for (let lx = 0; lx < 8; lx++) {
            let sum = 0;
            for (let y = ly; y < 32; y += 8) for (let x = lx; x < 32; x += 8) sum = Math.fround(sum + tap(x, y));
            lanes[ly * 8 + lx] = sum;
        }
        for (let stride = 32; stride > 0; stride >>= 1) for (let i = 0; i < stride; i++) lanes[i] = Math.fround(lanes[i] + lanes[i + stride]);
        return { exact, serial, parallel: lanes[0] };
    }

    //* Readback
    const flagCases = [
        { name: 'auto-reset', flags: 65, host: 0 }, { name: 'auto-adapt', flags: 64, host: 0 },
        { name: 'manual', flags: 1, host: 0 }, { name: 'external', flags: 1025, host: 0 },
        { name: 'host-pre-exposure', flags: 65, host: 8 },
    ];
    const cases = [];
    const timingInputs = {};
    for (const spec of inputSpecs) {
        const input = makeInput(spec);
        const sums = await tapSums(input);
        for (const flagCase of flagCases) {
            writeConstants(input, flagCase.flags);
            writeOne(host, [flagCase.host, 0, 0, 0]);
            const h = {};
            for (const name of Object.keys(sources)) h[name] = await runOnce(pipelines[name], input, output16);
            const f = {};
            for (const name of ['serial', 'parallel']) f[name] = await runOnce(f32Pipelines[name], input, output32);
            cases.push({
                input: input.name, case: flagCase.name, sums,
                half: h,
                f32: f,
                boundIdentical:
                    JSON.stringify(h.serial) === JSON.stringify(h['serial-constant-bound']) &&
                    JSON.stringify(h.parallel) === JSON.stringify(h['parallel-constant-bound']),
                halfDecoded: { serial: h.serial.map(fromHalf), parallel: h.parallel.map(fromHalf) },
            });
        }
        if (input.name === 'field-960x540-s101' || input.name === 'field-1920x1080-s301') timingInputs[input.name] = input;
        else input.texture.destroy();
    }

    //* Timing (ABBA per input; auto-reset flags)
    const timings = {};
    if (timestamps) {
        for (const [inputName, input] of Object.entries(timingInputs)) {
            writeConstants(input, 65);
            writeOne(host, [0, 0, 0, 0]);
            const groups = { serial: bindGroup(pipelines.serial, input, output16), parallel: bindGroup(pipelines.parallel, input, output16) };
            const query = device.createQuerySet({ type: 'timestamp', count: samples * 2 });
            const resolved = device.createBuffer({ size: samples * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            const mapped = device.createBuffer({ size: samples * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const sequence = Array.from({ length: samples }, (_, i) => ['serial', 'parallel', 'parallel', 'serial'][i % 4]);
            for (let i = 0; i < samples; i++) {
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass({
                    timestampWrites: { querySet: query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 },
                });
                pass.setPipeline(pipelines[sequence[i]]);
                pass.setBindGroup(0, groups[sequence[i]]);
                pass.dispatchWorkgroups(1);
                pass.end();
                device.queue.submit([encoder.finish()]);
            }
            const encoder = device.createCommandEncoder();
            encoder.resolveQuerySet(query, 0, samples * 2, resolved, 0);
            encoder.copyBufferToBuffer(resolved, 0, mapped, 0, samples * 16);
            device.queue.submit([encoder.finish()]);
            await mapped.mapAsync(GPUMapMode.READ);
            const values = new BigUint64Array(mapped.getMappedRange());
            const ms = { serial: [], parallel: [] };
            for (let i = 0; i < samples; i++) ms[sequence[i]].push(Number(values[i * 2 + 1] - values[i * 2]) / 1e6);
            mapped.unmap();
            timings[inputName] = ms;
        }
    }
    await device.queue.onSubmittedWorkDone();
    const { vendor, architecture, device: deviceName, description } = adapter.info;
    device.destroy();
    return { adapter: { vendor, architecture, device: deviceName, description }, timestamps, compileMs, cases, timings, errors };
}

//* In-page: scenes part =======================================================
async function scenesRun({ frames }) {
    const api = window.__UPSCALER_BENCH__;
    const context = api._context;
    const backend = context.renderer.backend;
    const device = backend.device;
    const errors = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    async function readExposure() {
        const upscaler = context.pipeline.resolver._upscaler;
        const texture = backend.get(upscaler.guides.exposure).texture;
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const value = [...new Uint16Array(buffer.getMappedRange()).slice(0, 4)];
        buffer.unmap();
        return value;
    }
    const values = [];
    await api.capture({ frame: 0, debugView: 'final' });
    values.push(await readExposure());
    for (let frame = 1; frame < frames; frame++) {
        await api.step(frame);
        values.push(await readExposure());
    }
    buffer.destroy();
    return { variant: api.result.variant?.id, values, errors };
}

//* Node side =================================================================
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function fromHalf(h) {
    const sign = h & 0x8000 ? -1 : 1, exponent = (h >>> 10) & 31, mantissa = h & 1023;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
/** Max |a − b| and max |a − b| / |a| over pairs, plus how many differ at all. */
function deltas(pairs) {
    let abs = 0, rel = 0, differing = 0;
    for (const [a, b] of pairs) {
        const d = Math.abs(a - b);
        if (d > 0) differing++;
        abs = Math.max(abs, d);
        if (a !== 0) rel = Math.max(rel, d / Math.abs(a));
    }
    return { maxAbs: abs, maxRel: rel, differing, of: pairs.length };
}

/** Runtime.evaluate without CDP.evaluate's 45 s cap (input generation and frame playback run long). */
async function evaluateLong(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 900000);
    if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
}

async function withBrowser(work) {
    const profile = await mkdtemp(join(tmpdir(), 'upscaler-exposure-parallel-'));
    const browser = spawn(
        browserExecutable(cli.chrome),
        ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
            '--window-size=1960,1280', '--force-device-scale-factor=1', 'about:blank'],
        { windowsHide: true, stdio: 'ignore' },
    );
    let client;
    try {
        await waitForUrl(`http://127.0.0.1:${cdpPort}/json/version`, { child: browser, allowSuccessfulExit: true });
        const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
        client = await CDP.connect(target.webSocketDebuggerUrl);
        await client.send('Page.enable');
        await client.send('Log.enable');
        await client.send('Runtime.enable');
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: auditSource });
        return await work(client);
    } finally {
        if (client) {
            await client.send('Browser.close', {}, 2000).catch(() => {});
            client.close();
        }
        await stopChild(browser);
        if (dirname(resolve(profile)) === resolve(tmpdir())) await removeTempDirectory(profile);
    }
}

function browserErrors(client) {
    return client.events
        .filter((event) =>
            event.method === 'Runtime.exceptionThrown' ||
            (event.method === 'Log.entryAdded' && /error|validation|wgsl/i.test(event.params.entry.text)))
        .map((event) => event.params.entry?.text ?? event.params.exceptionDetails?.exception?.description ?? 'exception')
        .filter((text) => !/favicon/i.test(text));
}

async function ensureServer(config, server) {
    try {
        await waitForUrl(server.origin, { attempts: 1 });
        return null;
    } catch {
        const child = spawnVite(config, server);
        await waitForUrl(server.origin, { child, attempts: 600 });
        return child;
    }
}

async function shaderPart(results) {
    const server = await ensureServer('examples/vite.config.ts', examplesServer);
    const shaderUrl = '/@fs/' + resolve(ROOT, 'packages/core/src/shaders/luminancePyramid.ts').replaceAll('\\', '/');
    const forms = ['serial', 'parallel', 'serial-constant-bound', 'parallel-constant-bound'];
    try {
        for (let run = 0; run < runs; run++) {
            // Rotate the compile order so no form always compiles first (cold driver caches).
            const order = forms.map((_, i) => forms[(i + run) % forms.length]);
            const result = await withBrowser(async (client) => {
                await client.send('Page.navigate', { url: examplesServer.origin + '/' });
                await client.evaluate('new Promise(r=>document.readyState==="complete"?r():window.addEventListener("load",r,{once:true}))');
                const value = await evaluateLong(client, `(${shaderRun.toString()})(${JSON.stringify({ shaderUrl, order, samples })})`);
                const audit = await client.evaluate('window.__gpuAudit');
                return { ...value, gpuAudit: audit, browserErrors: browserErrors(client) };
            });
            results.shader.push({ run, order, ...result });
            const timing = Object.fromEntries(Object.entries(result.timings).map(([input, ms]) =>
                [input, { serial: median(ms.serial), parallel: median(ms.parallel), ratio: median(ms.parallel) / median(ms.serial) }]));
            console.log(JSON.stringify({ run, compileMs: result.compileMs, timing, errors: result.errors.length + result.browserErrors.length }));
            await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
        }
    } finally {
        if (server) await stopChild(server);
    }
}

async function scenesPart(results) {
    const server = await ensureServer('bench/vite.config.ts', benchServer);
    try {
        await withBrowser(async (client) => {
            for (const scenario of scenarios) {
                const byVariant = {};
                for (const variant of ['baseline', 'exposure-serial-v1']) {
                    const url = new URL(benchServer.origin);
                    url.searchParams.set('benchMode', 'capture');
                    url.searchParams.set('scenario', scenario);
                    url.searchParams.set('ratio', String(ratio));
                    url.searchParams.set('width', '1920');
                    url.searchParams.set('height', '1080');
                    url.searchParams.set('variant', variant);
                    client.events.length = 0;
                    await client.send('Page.navigate', { url: url.href });
                    for (let attempt = 0; ; attempt++) {
                        const ready = await client.evaluate('window.__UPSCALER_BENCH__?.ready === true').catch(() => false);
                        if (ready === true) break;
                        if (attempt > 600) throw new Error(`Timed out waiting for the bench (${scenario}, ${variant}).`);
                        await new Promise((r) => setTimeout(r, 100));
                    }
                    const value = await evaluateLong(client, `(${scenesRun.toString()})(${JSON.stringify({ frames })})`);
                    if (value.variant !== variant) throw new Error(`Bench reported ${value.variant}, expected ${variant}.`);
                    byVariant[variant] = { ...value, browserErrors: browserErrors(client) };
                }
                const a = byVariant['exposure-serial-v1'].values, b = byVariant.baseline.values;
                const summary = {
                    scenario,
                    frames: a.length,
                    framesDiffering: a.filter((v, i) => JSON.stringify(v) !== JSON.stringify(b[i])).length,
                    exposure: deltas(a.map((v, i) => [fromHalf(v[0]), fromHalf(b[i][0])])),
                    avgLuma: deltas(a.map((v, i) => [fromHalf(v[1]), fromHalf(b[i][1])])),
                    maxUlps: Math.max(...a.flatMap((v, i) => v.map((h, c) => Math.abs(h - b[i][c])))),
                    errors: [...byVariant.baseline.errors, ...byVariant['exposure-serial-v1'].errors,
                        ...byVariant.baseline.browserErrors, ...byVariant['exposure-serial-v1'].browserErrors],
                };
                results.scenes.push({ ...summary, values: { serial: a, parallel: b } });
                console.log(JSON.stringify(summary));
                await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
            }
        });
    } finally {
        if (server) await stopChild(server);
    }
}

function summarize(results) {
    const summary = {};
    if (results.shader.length) {
        const forms = Object.keys(results.shader[0].compileMs);
        summary.compileMedianMs = Object.fromEntries(forms.map((f) => [f, median(results.shader.map((r) => r.compileMs[f]))]));
        summary.gpuMedianMs = {};
        for (const input of Object.keys(results.shader[0].timings)) {
            const serial = median(results.shader.flatMap((r) => r.timings[input].serial));
            const parallel = median(results.shader.flatMap((r) => r.timings[input].parallel));
            summary.gpuMedianMs[input] = { serial, parallel, ratio: parallel / serial };
        }
        const cases = results.shader[0].cases;
        const auto = cases.filter((c) => c.case !== 'manual' && c.case !== 'external');
        summary.readback = {
            inputs: new Set(cases.map((c) => c.input)).size,
            cases: cases.length,
            boundIdentical: results.shader.every((r) => r.cases.every((c) => c.boundIdentical)),
            halfIdentical: cases.filter((c) => JSON.stringify(c.half.serial) === JSON.stringify(c.half.parallel)).length,
            halfExposure: deltas(cases.map((c) => [c.halfDecoded.serial[0], c.halfDecoded.parallel[0]])),
            halfAvgLuma: deltas(cases.map((c) => [c.halfDecoded.serial[1], c.halfDecoded.parallel[1]])),
            f32Exposure: deltas(auto.map((c) => [c.f32.serial[0], c.f32.parallel[0]])),
            f32AvgLuma: deltas(cases.map((c) => [c.f32.serial[1], c.f32.parallel[1]])),
            // logSum against the exact (f64) sum of the GPU's own taps: the
            // serial order's rounding error vs the parallel order's.
            logSumError: {
                serial: Math.max(...cases.map((c) => Math.abs(c.f32.serial[3] - c.sums.exact))),
                parallel: Math.max(...cases.map((c) => Math.abs(c.f32.parallel[3] - c.sums.exact))),
                cpuOrderReproduced: cases.filter((c) => c.f32.serial[3] === c.sums.serial && c.f32.parallel[3] === c.sums.parallel).length,
            },
            maxHalfUlps: Math.max(...cases.flatMap((c) => c.half.serial.map((h, i) => Math.abs(h - c.half.parallel[i])))),
        };
        summary.errors = results.shader.flatMap((r) => [...r.errors, ...r.browserErrors]);
        summary.adapter = results.shader[0].adapter;
    }
    if (results.scenes.length)
        summary.scenes = results.scenes.map(({ values: _values, ...rest }) => rest);
    return summary;
}

await mkdir(output, { recursive: true });
const results = { argv: process.argv.slice(2), shader: [], scenes: [] };
if (part !== 'scenes') await shaderPart(results);
if (part !== 'shader') await scenesPart(results);
results.summary = summarize(results);
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.summary, null, 2));
console.log(`Wrote ${join(output, 'results.json')}`);
const failures = [
    ...(results.summary.errors ?? []),
    ...(results.summary.scenes ?? []).flatMap((s) => s.errors),
];
if (failures.length) throw new Error(`Browser/WGSL errors:\n${failures.join('\n')}`);
if (results.summary.readback && !results.summary.readback.boundIdentical)
    throw new Error('A constant-bound form read back differently from its uniform-bound twin.');
