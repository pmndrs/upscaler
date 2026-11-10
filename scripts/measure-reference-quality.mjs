#!/usr/bin/env node
import { browserExecutable } from './browser-executable.mjs';
import { gpuAuditSource } from './gpu-audit.mjs';
/**
 * Ground-truth image quality: scores upscaler output against a supersampled
 * reference of the same frame, not only for stability.
 *
 * For each measured frame of a bench scenario the page renders the input scene
 * at DISPLAY resolution --samples times, each pass under a different sub-pixel
 * offset (Halton 2,3, recentred to zero mean), with the scene and camera set to
 * that frame's exact scenario state and the clock frozen, and sums the passes
 * in an f32 storage buffer. For a raster scene that box-filtered supersample is
 * the ground truth; no path tracer is needed. --scale s renders each pass at
 * s× display resolution and box-sums s×s texels per display pixel, for effects
 * anchored to the render's own pixel grid (Q12's IGN shadow dither,
 * derivative-based mip selection) that sub-pixel jitter alone cannot average.
 *
 * Every mode then runs the same frames through the bench pipeline (native =
 * ratio 1, plus bilinear / FSR1 spatial / temporal at --ratio) and the
 * rgba16float output is read back exactly. Both sides go through one fixed
 * presentation transform — negatives to 0, three's ACESFilmic (exposure 1), sRGB,
 * exactly what the bench canvas shows (checked against a canvas screenshot
 * every run) — and are scored in Node:
 * - PSNR (dB) over display-encoded RGB in [0, 1], unquantized
 * - SSIM (Gaussian 11-tap σ 1.5, K 0.01/0.03, per RGB channel, mean)
 * - temporal error: mean |Δoutput − Δreference| between consecutive frames
 *   (0–255 scale), with the output's own churn |Δoutput| and the reference's
 *   |Δreference| beside it. Same-phase convergence meters only see churn, so
 *   they cannot tell "stable and right" from "stable and wrong"; PSNR/SSIM
 *   can, and the temporal error charges flicker the true image lacks and lag
 *   behind motion the true image makes.
 * Per window (a run of consecutive frames, e.g. one Q19 motion segment), per
 * scenario ROI. --export-png writes every frame as an 8-bit PNG sequence for
 * offline LPIPS / FovVideoVDP / ColorVideoVDP (recipe:
 * bench/docs/REFERENCE-QUALITY.md). No Python is needed for anything else.
 *
 * Usage:
 *   node scripts/measure-reference-quality.mjs --scenario Q1 [--ratio 2]
 *     [--modes native,bilinear,spatial,temporal] [--frames still=180:211]
 *     [--samples 64] [--scale 1] [--variant production] [--export-png]
 *
 * Starts the bench dev server on --url's port if nothing answers there.
 * Writes summary.json (+ PNGs) under
 * bench/results/raw/reference-quality/<label>-<scenario>-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseCliOrExit } from './cli-flags.mjs';
import {
    HALF_TO_FLOAT,
    SSIM_BORDER,
    decodePng,
    encodePng,
    present,
    psnr,
    referenceOffsets,
    regionMean,
    squaredErrorMap,
    ssimMap,
    temporalMaps,
} from './image-metrics.mjs';
import {
    DEFAULT_BENCH_URL,
    closeOwnedCdpBrowser,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MODES = ['native', 'bilinear', 'spatial', 'temporal'];

/**
 * Default measured windows per scenario. Still scenes take one full jitter
 * cycle at ratio 2 (32 frames) after convergence; motion scenarios take 16
 * frames inside each motion segment, so every window's temporal error is a
 * single motion type.
 */
const DEFAULT_WINDOWS = {
    Q0: 'animated=120:151',
    Q1: 'still=180:211',
    Q2: 'dolly=150:181',
    Q3: 'objects=150:181',
    Q4: 'orbit=88:103,translate=200:215,orbit-2=320:335,hold=440:455',
    Q5: 'particles=150:181',
    Q9: 'steady=20:51',
    Q12: 'still=180:211',
    Q13: 'still=180:211',
    Q15: 'still=60:91,ramp-down=130:161',
    Q16: 'still=180:211',
    Q17: 'still=180:211',
    Q18: 'still=180:211',
    // Mirrors Q19_SEGMENTS in bench/src/benchmark/scenarios.ts: the converged
    // still as a control, then the middle of each kind of motion.
    Q19: 'still=96:111,dolly-back=150:165,orbit-left=390:405,slide=630:645,scene-recede=750:765,dolly-back-fast=962:977',
};
/** Effect graphs (Q6–Q8, Q14) render through a post graph the reference would skip; Q10 resizes; Q11 bakes host exposure into the MRT. */
const UNSUPPORTED = new Set(['Q6', 'Q7', 'Q8', 'Q10', 'Q11', 'Q14']);

//* CLI
const USAGE = `Usage: node scripts/measure-reference-quality.mjs [options]
  --scenario <id>        bench scenario (default Q1); not ${[...UNSUPPORTED].join('/')}
  --ratio <n>            upscale ratio for bilinear/spatial/temporal (default 2)
  --modes <list>         subset of ${MODES.join(',')} (default all); native renders at ratio 1
  --frames <windows>     measured windows, 'name=start:end' comma-separated (a bare
                         'start:end' is named 'window'); default per scenario, e.g.
                         Q1 ${DEFAULT_WINDOWS.Q1}, Q19 the six motion segments
  --samples <n>          reference samples per display pixel (default 64)
  --scale <s>            reference render scale: each pass renders at s× display
                         resolution, s×s texels box-summed per pixel; --samples
                         must be a multiple of s² (default 1)
  --floor-samples <n>    also render the first frame at n spp and score the main
                         reference against it: the reference's own error, i.e.
                         the floor below which mode differences mean nothing
                         (default 0 = off; e.g. 1024)
  --width <px> --height <px>   display size (default 1280x720)
  --variant <id>         bench variant (default production: production RCAS on every
                         path; 'baseline' runs the frozen legacy RCAS on temporal)
  --settings <json>      capture-setting overrides, e.g. '{"autoExposure":false}'
  --label <name>         output folder prefix (default: the variant id)
  --export-png           write every measured frame (reference + each mode) as an
                         8-bit sRGB PNG sequence for offline perceptual metrics
  --keep-raw             keep the linear f32 reference frames (<out>/reference/*.f32)
  --save-diagnostics     keep the presented reference (<out>/reference/*.presented.f32)
                         and write each mode's presented output (<out>/raw/<mode>/*.f32)
                         plus temporal's guides (<out>/raw/temporal/*.guides.f32: history
                         age in frames, disocclusion, motion in render px, at display
                         res) for scripts/analyze-reference-error.mjs
  --reference-offset <k> score output frame N against the reference of frame N + k
                         (default 0): an alignment check, the best score must be at 0
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); if nothing answers,
                         the bench dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
  --chrome <path>        browser executable (Chrome/Edge)
  --power-preference <high-performance|low-power>  request a GPU preference
  --expected-vendor <vendor>  reject measurements on a different GPU
  --without-timestamps   omit timestamp-query from real device requests
Writes bench/results/raw/reference-quality/<label>-<scenario>-<ratio>x/summary.json.
Metric definitions and the baseline table: bench/docs/REFERENCE-QUALITY.md.`;
const cli = parseCliOrExit(
    process.argv.slice(2),
    [
        'scenario', 'ratio', 'modes', 'frames', 'samples', 'scale', 'floor-samples', 'width', 'height', 'variant',
        'settings', 'label', 'export-png', 'keep-raw', 'save-diagnostics', 'reference-offset', 'url', 'port', 'chrome', 'power-preference',
        'expected-vendor', 'without-timestamps',
    ],
    USAGE,
);
const auditSource = gpuAuditSource(cli);
const scenario = String(cli.scenario ?? 'Q1');
const ratio = Number(cli.ratio ?? 2);
const modes = String(cli.modes ?? MODES.join(',')).split(',').filter(Boolean);
const samples = Number(cli.samples ?? 64);
const scale = Number(cli.scale ?? 1);
const floorSamples = Number(cli['floor-samples'] ?? 0);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
// Not the page default: `baseline` keeps the frozen RCAS_LEGACY_SHADER on the
// temporal path for history comparability, so it would not score what ships.
const variant = typeof cli.variant === 'string' ? cli.variant : 'production';
const settings = typeof cli.settings === 'string' ? JSON.parse(cli.settings) : {};
const label = String(cli.label ?? variant);
const exportPng = cli['export-png'] === true;
const keepRaw = cli['keep-raw'] === true;
const saveDiagnostics = cli['save-diagnostics'] === true;
const referenceOffset = Number(cli['reference-offset'] ?? 0);
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);

function fail(message) {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(1);
}
if (UNSUPPORTED.has(scenario)) fail(`Scenario ${scenario} is not supported by the reference capture.`);
for (const mode of modes) if (!MODES.includes(mode)) fail(`Unknown mode ${mode}.`);
if (!Number.isInteger(scale) || scale < 1) fail('--scale must be a positive integer.');
if (!Number.isInteger(samples) || samples < 1 || samples % (scale * scale) !== 0)
    fail(`--samples must be a positive multiple of scale² (${scale * scale}).`);
if (!Number.isInteger(referenceOffset)) fail('--reference-offset must be an integer.');
if (!Number.isInteger(floorSamples) || floorSamples < 0 || floorSamples % (scale * scale) !== 0)
    fail(`--floor-samples must be 0 or a multiple of scale² (${scale * scale}).`);
const windowSpec = typeof cli.frames === 'string' ? cli.frames : DEFAULT_WINDOWS[scenario];
if (!windowSpec) fail(`No default windows for ${scenario}; pass --frames.`);

/**
 * Parses 'name=start:end,…' into sorted, non-overlapping windows.
 * @param {string} spec - Window list
 * @returns {Array<{name: string, start: number, end: number}>} Windows
 */
function parseWindows(spec) {
    const windows = spec.split(',').map((entry) => {
        const [name, range] = entry.includes('=') ? entry.split('=') : ['window', entry];
        const [start, end] = range.split(':').map(Number);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
            fail(`Invalid window ${entry}.`);
        return { name, start, end };
    });
    windows.sort((a, b) => a.start - b.start);
    for (let i = 1; i < windows.length; i++)
        if (windows[i].start <= windows[i - 1].end) fail(`Windows ${windows[i - 1].name} and ${windows[i].name} overlap.`);
    return windows;
}
const windows = parseWindows(windowSpec);
const frames = windows.flatMap((window) => Array.from({ length: window.end - window.start + 1 }, (_, i) => window.start + i));
const outputDirectory = join(
    ROOT,
    'bench/results/raw/reference-quality',
    `${label}-${scenario}-${String(ratio).replace('.', '_')}x`,
);
const referenceDirectory = join(outputDirectory, 'reference');
const frameName = (frame) => `f${String(frame).padStart(4, '0')}`;

//* In-page Helper
// Installed over CDP, so the bench source stays untouched. It reaches the
// bench's TS-private context the way measure-emitter-retention.mjs does.
// Heavy payloads stay in the page until Node pulls them in base64 chunks.
const PAGE_HELPER = /* js */ `
(() => {
    if (window.__referenceQuality) return true;
    const api = window.__UPSCALER_BENCH__;
    const { renderer, camera, pipeline, scenario } = api._context;
    const device = renderer.backend.device;
    const canvas = renderer.domElement;
    // three's constructors, taken from the bench's own objects: importing three
    // again would load a second copy.
    const RenderTarget = pipeline._renderTarget.constructor;
    const halfFloatType = pipeline._renderTarget.texture.type;

    // Box-sums scale×scale texels of one reference pass into a display-res f32
    // accumulator. Measurement code, not a library pass.
    const module = device.createShaderModule({ code: \`
        struct Params { size : vec2u, scale : u32, pad : u32 }
        @group(0) @binding(0) var source : texture_2d<f32>;
        @group(0) @binding(1) var<storage, read_write> accumulator : array<vec4f>;
        @group(0) @binding(2) var<uniform> params : Params;
        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid : vec3u) {
            if (gid.x >= params.size.x || gid.y >= params.size.y) { return; }
            var sum = vec4f(0.0);
            for (var j = 0u; j < params.scale; j++) {
                for (var i = 0u; i < params.scale; i++) {
                    sum += textureLoad(source, vec2u(gid.x * params.scale + i, gid.y * params.scale + j), 0);
                }
            }
            let index = gid.y * params.size.x + gid.x;
            accumulator[index] = accumulator[index] + sum;
        }\` });
    const accumulate = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

    let payload = new Uint8Array(0);
    let reference = null;

    const halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const sign = h & 0x8000 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const fraction = h & 0x3ff;
        halfTable[h] = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024)
            : exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
    }

    // Reads an rgba16float / rgba8unorm three texture into four Float32Array channels.
    async function readTexture(threeTexture) {
        const texture = renderer.backend.get(threeTexture).texture;
        const layout = { rgba16float: [8, 'h'], rgba8unorm: [4, 'u'] }[texture.format];
        if (!layout) throw new Error('Unsupported guide format ' + texture.format);
        const [bytesPerPixel, kind] = layout;
        const w = texture.width;
        const h = texture.height;
        const bytesPerRow = Math.ceil((w * bytesPerPixel) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, mipLevel: 0 }, { buffer, bytesPerRow }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const view = kind === 'h' ? new Uint16Array(mapped) : new Uint8Array(mapped);
        const stride = bytesPerRow / (kind === 'h' ? 2 : 1);
        const ch = [0, 1, 2, 3].map(() => new Float32Array(w * h));
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                for (let c = 0; c < 4; c++) {
                    const raw = view[y * stride + x * 4 + c];
                    ch[c][y * w + x] = kind === 'h' ? halfTable[raw] : raw / 255;
                }
        buffer.unmap();
        buffer.destroy();
        return { w, h, ch };
    }

    function referenceTargets(scale) {
        const w = canvas.width;
        const h = canvas.height;
        if (reference && reference.w === w && reference.h === h && reference.scale === scale) return reference;
        if (reference) {
            reference.target.dispose();
            reference.accumulator.destroy();
            reference.readBuffer.destroy();
            reference.params.destroy();
        }
        const target = new RenderTarget(w * scale, h * scale, { type: halfFloatType, depthBuffer: true });
        target.texture.name = 'output';
        const bytes = w * h * 16;
        const accumulator = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const readBuffer = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(params, 0, new Uint32Array([w, h, scale, 0]));
        reference = { w, h, scale, target, accumulator, readBuffer, params };
        return reference;
    }

    window.__referenceQuality = {
        info() {
            return { rois: scenario.rois, endFrame: scenario.endFrame, display: [canvas.width, canvas.height] };
        },

        // Switches the pipeline to a mode in place (resolver path + render
        // target); the next capture() resets history and velocity seeding.
        configureMode(mode, ratio) {
            const benchMode = { native: 'bilinear', bilinear: 'bilinear', spatial: 'fsr1-spatial', temporal: 'upscale-temporal' }[mode];
            const { width, height } = api.config.dimensions;
            pipeline._configure(width, height, benchMode, pipeline._quality, mode === 'native' ? 1 : ratio,
                pipeline._reactiveTarget !== null, pipeline._opaqueTarget !== null);
            return { render: [pipeline.resolver.renderWidth, pipeline.resolver.renderHeight], period: pipeline.resolver.jitterPhaseCount };
        },

        // Renders frame's input scene once per offset (in render-target pixels)
        // at scale× display resolution and leaves the box-filtered linear RGB
        // (f32, divided by offsets × scale²) as the payload.
        async renderReference(frame, offsets, scale) {
            const targets = referenceTargets(scale);
            const state = scenario.frame(Math.min(frame, scenario.endFrame));
            api._applyFrameState(state);
            // Put three's pinned NodeFrame where the bench has it while
            // rendering this frame: frame-scoped uniforms (light intensities)
            // only refresh when frameId moves, so without this a cold page
            // renders with stale lights. capture() resets it again afterwards.
            pipeline._resetNodeFrame(frame);
            pipeline.advanceAutomatedFrame(frame);
            const scene = api._inputScene(state);
            const fullWidth = targets.w * scale;
            const fullHeight = targets.h * scale;
            const clear = device.createCommandEncoder();
            clear.clearBuffer(targets.accumulator);
            device.queue.submit([clear.finish()]);
            const mrt = renderer.getMRT();
            renderer.setMRT(null);
            try {
                for (const [dx, dy] of offsets) {
                    camera.setViewOffset(fullWidth, fullHeight, dx, dy, fullWidth, fullHeight);
                    renderer.setRenderTarget(targets.target);
                    renderer.render(scene, camera);
                    renderer.setRenderTarget(null);
                    const source = renderer.backend.get(targets.target.texture).texture;
                    const encoder = device.createCommandEncoder();
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(accumulate);
                    pass.setBindGroup(0, device.createBindGroup({
                        layout: accumulate.getBindGroupLayout(0),
                        entries: [
                            { binding: 0, resource: source.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
                            { binding: 1, resource: { buffer: targets.accumulator } },
                            { binding: 2, resource: { buffer: targets.params } },
                        ],
                    }));
                    pass.dispatchWorkgroups(Math.ceil(targets.w / 8), Math.ceil(targets.h / 8));
                    pass.end();
                    device.queue.submit([encoder.finish()]);
                }
            } finally {
                // The bench camera carries no view offset of its own.
                camera.view = null;
                camera.updateProjectionMatrix();
                renderer.setMRT(mrt);
            }
            const copy = device.createCommandEncoder();
            copy.copyBufferToBuffer(targets.accumulator, 0, targets.readBuffer, 0, targets.w * targets.h * 16);
            device.queue.submit([copy.finish()]);
            await targets.readBuffer.mapAsync(GPUMapMode.READ);
            const sums = new Float32Array(targets.readBuffer.getMappedRange());
            const rgb = new Float32Array(targets.w * targets.h * 3);
            const weight = 1 / (offsets.length * scale * scale);
            let nonFinite = 0;
            for (let p = 0; p < targets.w * targets.h; p++)
                for (let c = 0; c < 3; c++) {
                    const value = sums[p * 4 + c] * weight;
                    if (!Number.isFinite(value)) nonFinite++;
                    rgb[p * 3 + c] = value;
                }
            targets.readBuffer.unmap();
            payload = new Uint8Array(rgb.buffer);
            return { width: targets.w, height: targets.h, bytes: payload.length, nonFinite };
        },

        // Reads the resolver's rgba16float output; leaves its RGB halves as the payload.
        async readOutput() {
            const texture = renderer.backend.get(pipeline.resolver.outputTexture).texture;
            if (texture.format !== 'rgba16float') throw new Error('Unexpected output format ' + texture.format);
            const w = texture.width;
            const h = texture.height;
            const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
            const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, mipLevel: 0 }, { buffer, bytesPerRow }, [w, h]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const halves = new Uint16Array(buffer.getMappedRange());
            const rgb = new Uint16Array(w * h * 3);
            const stride = bytesPerRow / 2;
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++)
                    for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = halves[y * stride + x * 4 + c];
            buffer.unmap();
            buffer.destroy();
            payload = new Uint8Array(rgb.buffer);
            return { width: w, height: h, bytes: payload.length };
        },

        // Temporal guides at display res, nearest-sampled from render res:
        // [history age in frames, disocclusion 0..1, |motion| in render px/frame].
        async readGuides() {
            const upscaler = pipeline.resolver._upscaler;
            const guides = upscaler.guides;
            const history = await readTexture(guides.history);
            const disocclusion = await readTexture(guides.disocclusion);
            const motion = await readTexture(guides.dilatedMotion);
            const w = history.w;
            const h = history.h;
            const out = new Float32Array(w * h * 3);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const rx = Math.min(disocclusion.w - 1, Math.floor((x * disocclusion.w) / w));
                    const ry = Math.min(disocclusion.h - 1, Math.floor((y * disocclusion.h) / h));
                    const r = ry * disocclusion.w + rx;
                    const p = y * w + x;
                    // history .a is age / maxAccumulation (0..1), despite the
                    // TemporalGuides doc saying frames; report frames.
                    out[p * 3] = history.ch[3][p] * upscaler.settings.maxAccumulation;
                    out[p * 3 + 1] = disocclusion.ch[0][r];
                    out[p * 3 + 2] = Math.hypot(motion.ch[0][r] * motion.w, motion.ch[1][r] * motion.h);
                }
            payload = new Uint8Array(out.buffer);
            return { width: w, height: h, bytes: payload.length, maxAccumulation: upscaler.settings.maxAccumulation };
        },

        chunk(offset, length) {
            const slice = payload.subarray(offset, offset + length);
            if (typeof slice.toBase64 === 'function') return slice.toBase64();
            let binary = '';
            for (let i = 0; i < slice.length; i += 0x8000)
                binary += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
            return btoa(binary);
        },
    };
    return true;
})()
`;

//* CDP
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
        // A dropped socket (e.g. an oversized message) must fail the run, not hang it.
        this.socket.addEventListener('close', (event) => {
            for (const request of this.pending.values())
                request.reject(new Error(`CDP socket closed (${event.code}) with a request pending.`));
            this.pending.clear();
        });
    }
    async call(method, params = {}) {
        await this.opened;
        const id = this.nextId++;
        const response = new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolve: resolveCall, reject: rejectCall }));
        this.socket.send(JSON.stringify({ id, method, params }));
        return response;
    }
    on(method, listener) {
        this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    }
    close() {
        this.socket.close();
    }
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

// Node's WebSocket caps one decompressed message at 4 MiB: a larger base64
// chunk drops the socket. 2 MiB of payload is ~2.8 MB of base64.
const CHUNK_BYTES = 2 * 1024 * 1024;

/** Pulls the page helper's current payload across CDP. */
async function fetchPayload(client, bytes) {
    const parts = [];
    for (let offset = 0; offset < bytes; offset += CHUNK_BYTES)
        parts.push(Buffer.from(await evaluate(client, `window.__referenceQuality.chunk(${offset}, ${CHUNK_BYTES})`), 'base64'));
    const buffer = Buffer.concat(parts);
    if (buffer.length !== bytes) throw new Error(`Payload size ${buffer.length}, expected ${bytes}.`);
    // Copy into a fresh ArrayBuffer: Buffer.concat may hand back an unaligned view.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
}

async function captureCanvas(client) {
    const bounds = await evaluate(
        client,
        `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...bounds, scale: 1 },
    });
    return decodePng(Buffer.from(screenshot.data, 'base64'));
}

//* Statistics
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

/**
 * Compares the Node presentation of the last output against the canvas the
 * bench presented for it, so a drift between this script's transform and
 * three's would show up here and not as a silent metric bias.
 */
function presentationCheck(presented, linear, canvas, w, h) {
    if (canvas.width !== w || canvas.height !== h) return { skipped: `canvas ${canvas.width}x${canvas.height}` };
    let sum = 0;
    let max = 0;
    let over1 = 0;
    let worst = null;
    for (let p = 0; p < w * h; p++)
        for (let c = 0; c < 3; c++) {
            const diff = Math.abs(Math.round(presented[p * 3 + c] * 255) - canvas.raw[p * canvas.bytesPerPixel + c]);
            sum += diff;
            if (diff > 1) over1++;
            if (diff > max) {
                max = diff;
                const at = p * canvas.bytesPerPixel;
                worst = {
                    x: p % w,
                    y: Math.floor(p / w),
                    linear: Array.from(linear.subarray(p * 3, p * 3 + 3)),
                    node: Array.from(presented.subarray(p * 3, p * 3 + 3), (v) => Math.round(v * 255)),
                    canvas: [canvas.raw[at], canvas.raw[at + 1], canvas.raw[at + 2]],
                };
            }
        }
    return { meanAbs255: sum / (w * h * 3), max255: max, shareOver1: over1 / (w * h * 3), worst };
}

function summarizeWindow(rows, roiNames) {
    const temporal = rows.filter((row) => row.temporal);
    const summary = {
        frames: rows.length,
        psnr: mean(rows.map((row) => row.psnr)),
        ssim: mean(rows.map((row) => row.ssim)),
        temporalError: temporal.length ? mean(temporal.map((row) => row.temporal.error)) : null,
        churn: temporal.length ? mean(temporal.map((row) => row.temporal.churn)) : null,
        referenceChurn: temporal.length ? mean(temporal.map((row) => row.temporal.referenceChurn)) : null,
        // Temporal only: young = history age under 4 frames, disoccluded = mask > 0.5.
        guides: rows[0].guides
            ? {
                  youngShare: mean(rows.map((row) => row.guides.youngShare)),
                  meanAge: mean(rows.map((row) => row.guides.meanAge)),
                  disoccludedShare: mean(rows.map((row) => row.guides.disoccludedShare)),
                  meanMotionPx: mean(rows.map((row) => row.guides.meanMotionPx)),
              }
            : null,
        rois: {},
    };
    for (const name of roiNames)
        summary.rois[name] = {
            psnr: mean(rows.map((row) => row.rois[name].psnr)),
            ssim: mean(rows.map((row) => row.rois[name].ssim)),
            temporalError: temporal.length ? mean(temporal.map((row) => row.rois[name].temporalError)) : null,
        };
    return summary;
}

//* Main
async function main() {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(referenceDirectory, { recursive: true });
    if (exportPng) for (const name of ['reference', ...modes]) await mkdir(join(outputDirectory, 'png', name), { recursive: true });

    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    const started = Date.now();
    try {
        try {
            await waitForUrl(server.origin, { attempts: 1 });
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }

        profile = join(tmpdir(), `upscaler-reference-quality-${process.pid}-${Date.now()}`);
        chrome = spawn(
            browserExecutable(cli.chrome),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                // Room below the canvas, so the presentation check's screenshot
                // clip never reaches past the headless viewport.
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
        client.on('Log.entryAdded', ({ entry }) => {
            if (!/favicon/.test(entry.url ?? '')) logRecords.push(`[${entry.level}] ${entry.text}`);
        });
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', scenario);
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', String(width));
        url.searchParams.set('height', String(height));
        url.searchParams.set('variant', variant);
        await client.call('Page.addScriptToEvaluateOnNewDocument', { source: auditSource });
        await client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            if ((await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true')) === true) break;
            if (attempt > 300) throw new Error(`Timed out waiting for window.__UPSCALER_BENCH__.\n${logRecords.join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        await evaluate(client, PAGE_HELPER);
        const info = await evaluate(client, 'window.__referenceQuality.info()');
        const rois = { full: [0, 0, 1, 1], ...(info.rois ?? {}) };
        const roiNames = Object.keys(rois);
        const [displayWidth, displayHeight] = info.display;
        if (frames.at(-1) > info.endFrame)
            console.warn(`note: frames past ${scenario}'s endFrame ${info.endFrame} hold its last state.`);

        //* Reference Capture
        // Once per frame, shared by every mode. Presented frames are cached on
        // disk (f32) until the modes have been scored.
        const offsets = referenceOffsets(samples / (scale * scale)).map(([x, y]) => [x, y]);
        const referenceStarted = Date.now();
        const referenceNonFinite = {};
        for (const outputFrame of frames) {
            const frame = outputFrame + referenceOffset;
            const result = await evaluate(
                client,
                `window.__referenceQuality.renderReference(${frame}, ${JSON.stringify(offsets)}, ${scale})`,
            );
            if (result.nonFinite) referenceNonFinite[frame] = result.nonFinite;
            const linear = new Float32Array(await fetchPayload(client, result.bytes));
            if (keepRaw) await writeFile(join(referenceDirectory, `${frameName(frame)}.f32`), Buffer.from(linear.buffer));
            const presented = present(linear);
            await writeFile(join(referenceDirectory, `${frameName(frame)}.presented.f32`), Buffer.from(presented.buffer));
            if (exportPng || windows.some((window) => window.start === outputFrame))
                await writeFile(
                    join(outputDirectory, exportPng ? 'png/reference' : '', `${exportPng ? '' : 'reference-'}${frameName(frame)}.png`),
                    encodePng(presented, displayWidth, displayHeight),
                );
            process.stdout.write(`\rreference ${frame} (${samples} spp, scale ${scale})   `);
        }
        const referenceSeconds = (Date.now() - referenceStarted) / 1000;
        console.log(`\nreference: ${frames.length} frames in ${referenceSeconds.toFixed(1)} s`);

        const loadReference = async (frame) => {
            const bytes = await readFile(join(referenceDirectory, `${frameName(frame)}.presented.f32`));
            return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        };

        //* Reference Floor
        // The --samples reference against a denser one of the first frame: its
        // PSNR/SSIM bound how finely the mode scores can be read.
        let floor = null;
        if (floorSamples > 0) {
            const denseOffsets = referenceOffsets(floorSamples / (scale * scale));
            const result = await evaluate(
                client,
                `window.__referenceQuality.renderReference(${frames[0] + referenceOffset}, ${JSON.stringify(denseOffsets)}, ${scale})`,
            );
            const dense = present(new Float32Array(await fetchPayload(client, result.bytes)));
            const reference = await loadReference(frames[0] + referenceOffset);
            floor = {
                frame: frames[0],
                samples: floorSamples,
                psnr: psnr(regionMean(squaredErrorMap(reference, dense), displayWidth, displayHeight, [0, 0, 1, 1])),
                ssim: regionMean(ssimMap(reference, dense, displayWidth, displayHeight), displayWidth, displayHeight, [0, 0, 1, 1], SSIM_BORDER),
            };
            console.log(`reference floor: ${samples} spp vs ${floorSamples} spp at f${frames[0]}: PSNR ${floor.psnr.toFixed(2)} dB, SSIM ${floor.ssim.toFixed(4)}`);
        }

        //* Modes
        const results = {};
        for (const mode of modes) {
            const configured = await evaluate(client, `window.__referenceQuality.configureMode('${mode}', ${ratio})`);
            const perWindow = {};
            let previous = null;
            let lastPresented = null;
            let nonFinite = 0;
            for (const [windowIndex, window] of windows.entries()) {
                const rows = [];
                for (let frame = window.start; frame <= window.end; frame++) {
                    if (windowIndex === 0 && frame === window.start)
                        await evaluate(
                            client,
                            `window.__UPSCALER_BENCH__.capture({ frame: ${frame}, debugView: 'final', settings: ${JSON.stringify(settings)} })`,
                        );
                    else await evaluate(client, `window.__UPSCALER_BENCH__.step(${frame})`);
                    const result = await evaluate(client, 'window.__referenceQuality.readOutput()');
                    if (result.width !== displayWidth || result.height !== displayHeight)
                        throw new Error(`${mode} output ${result.width}x${result.height}, display ${displayWidth}x${displayHeight}.`);
                    const halves = new Uint16Array(await fetchPayload(client, result.bytes));
                    const linear = new Float32Array(halves.length);
                    for (let i = 0; i < halves.length; i++) {
                        linear[i] = HALF_TO_FLOAT[halves[i]];
                        if (!Number.isFinite(linear[i])) nonFinite++;
                    }
                    const output = present(linear);
                    const reference = await loadReference(frame + referenceOffset);
                    if (saveDiagnostics) {
                        await mkdir(join(outputDirectory, 'raw', mode), { recursive: true });
                        await writeFile(join(outputDirectory, 'raw', mode, `${frameName(frame)}.f32`), Buffer.from(output.buffer));
                    }
                    let guideStats = null;
                    if (mode === 'temporal') {
                        const guideInfo = await evaluate(client, 'window.__referenceQuality.readGuides()');
                        const guides = new Float32Array(await fetchPayload(client, guideInfo.bytes));
                        if (saveDiagnostics)
                            await writeFile(join(outputDirectory, 'raw', mode, `${frameName(frame)}.guides.f32`), Buffer.from(guides.buffer));
                        let young = 0;
                        let age = 0;
                        let disoccluded = 0;
                        let motion = 0;
                        const pixels = guides.length / 3;
                        for (let p = 0; p < pixels; p++) {
                            if (guides[p * 3] < 4) young++;
                            age += guides[p * 3];
                            if (guides[p * 3 + 1] > 0.5) disoccluded++;
                            motion += guides[p * 3 + 2];
                        }
                        guideStats = {
                            youngShare: young / pixels,
                            meanAge: age / pixels,
                            disoccludedShare: disoccluded / pixels,
                            meanMotionPx: motion / pixels,
                        };
                    }
                    if (exportPng)
                        await writeFile(join(outputDirectory, 'png', mode, `${frameName(frame)}.png`), encodePng(output, displayWidth, displayHeight));
                    else if (frame === window.start)
                        await writeFile(join(outputDirectory, `${mode}-${frameName(frame)}.png`), encodePng(output, displayWidth, displayHeight));

                    const squared = squaredErrorMap(output, reference);
                    const ssim = ssimMap(output, reference, displayWidth, displayHeight);
                    const row = {
                        frame,
                        psnr: psnr(regionMean(squared, displayWidth, displayHeight, rois.full)),
                        ssim: regionMean(ssim, displayWidth, displayHeight, rois.full, SSIM_BORDER),
                        temporal: null,
                        guides: guideStats,
                        rois: {},
                    };
                    let maps = null;
                    if (previous && previous.frame === frame - 1) {
                        maps = temporalMaps(output, previous.output, reference, previous.reference);
                        const full = (map) => 255 * regionMean(map, displayWidth, displayHeight, rois.full);
                        row.temporal = { error: full(maps.error), churn: full(maps.churn), referenceChurn: full(maps.referenceChurn) };
                    }
                    for (const [name, roi] of Object.entries(rois))
                        row.rois[name] = {
                            psnr: psnr(regionMean(squared, displayWidth, displayHeight, roi)),
                            ssim: regionMean(ssim, displayWidth, displayHeight, roi, SSIM_BORDER),
                            temporalError: maps ? 255 * regionMean(maps.error, displayWidth, displayHeight, roi) : null,
                        };
                    rows.push(row);
                    previous = { frame, output, reference };
                    lastPresented = { output, linear };
                    process.stdout.write(
                        `\r${mode.padEnd(8)} ${window.name} f${frame}: PSNR ${row.psnr.toFixed(2)} dB, SSIM ${row.ssim.toFixed(4)}` +
                            (row.temporal ? `, tErr ${row.temporal.error.toFixed(3)}` : '') + '        ',
                    );
                }
                perWindow[window.name] = { ...window, summary: summarizeWindow(rows, roiNames), perFrame: rows };
            }
            await evaluate(client, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
            const check = presentationCheck(lastPresented.output, lastPresented.linear, await captureCanvas(client), displayWidth, displayHeight);
            if (check.meanAbs255 > 0.5)
                console.warn(`\nwarning: ${mode} presentation differs from the canvas by ${check.meanAbs255.toFixed(3)}/255 on average.`);
            results[mode] = { ...configured, ratio: mode === 'native' ? 1 : ratio, nonFinite, presentationCheck: check, windows: perWindow };
            process.stdout.write('\n');
        }

        //* Report
        const pad = (value, digits, size) => (value === null ? '—' : value.toFixed(digits)).padStart(size);
        for (const window of windows) {
            console.log(`\n${scenario} ${window.name} (frames ${window.start}–${window.end}), ratio ${ratio}, ${samples} spp at scale ${scale}`);
            console.log('mode        PSNR dB    SSIM    tErr/255  churn/255  ref churn/255');
            for (const mode of modes) {
                const s = results[mode].windows[window.name].summary;
                console.log(
                    `${mode.padEnd(10)} ${pad(s.psnr, 2, 8)} ${pad(s.ssim, 4, 8)} ${pad(s.temporalError, 3, 10)} ${pad(s.churn, 3, 10)} ${pad(s.referenceChurn, 3, 13)}`,
                );
            }
        }

        const summary = {
            command: `node scripts/measure-reference-quality.mjs ${process.argv.slice(2).join(' ')}`,
            gpuAudit: await evaluate(client, 'window.__gpuAudit'),
            scenario,
            variant,
            ratio,
            settings,
            display: [displayWidth, displayHeight],
            referenceOffset,
            reference: { samples, scale, passes: offsets.length, offsets, nonFinite: referenceNonFinite, seconds: referenceSeconds, floor },
            presentation: 'max(0) + three ACESFilmicToneMapping (exposure 1) + sRGB OETF; metrics on unquantized [0, 1] RGB',
            windows,
            rois,
            results,
            seconds: (Date.now() - started) / 1000,
            logRecords,
        };
        await writeFile(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        if (logRecords.some((record) => /error|exception|validation/i.test(record)))
            console.warn(`browser log records:\n${logRecords.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
        // The presented-reference cache only feeds the scoring above.
        if (!keepRaw && !saveDiagnostics) await rm(referenceDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
