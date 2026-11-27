import { UpscalerCore, type DepthMode, type FrameCamera, type UpscalePath } from '@pmndrs/upscaler/core';

import { lookAt, multiply, perspective } from '../../../examples/webgpu/hello/mat4';
import { Scene, SCENE_FAR, SCENE_NEAR } from '../../../examples/webgpu/hello/scene';

/**
 * Linear view-depth input probe (issue #97), driven by
 * `scripts/verify-linear-depth.mjs` over CDP.
 *
 * The raw-WebGPU example's scene (examples/webgpu/hello: orbiting + dollying
 * camera, moving cubes, standard perspective depth32float) renders once per
 * frame. A conversion pass re-expresses its depth as every input the cores
 * should agree on: linear view distance (positive, negative view Z, r16float,
 * a background of 0 / inf / NaN instead of far) and re-encoded hardware
 * depth (reversed perspective, orthographic, reversed orthographic). One core
 * per encoding consumes the same color, motion and jitter; each frame the
 * dilated depth (r32float), the disocclusion guide and the rgba16float output
 * are read back exactly and compared with the positive-linear core.
 *
 * Then a timing phase: a hardware and a linear core alternate order every
 * frame (ABBA) with `gpuTiming` on, and the reconstruct pass's GPU time is
 * averaged per mode.
 */

const DISPLAY = [640, 360] as const;
const RENDER = [320, 180] as const;
const FRAMES = 48;
const TIMING_FRAMES = 400;
const DT = 1 / 30;

const CONVERT_WGSL = /* wgsl */ `
@group(0) @binding(0) var sceneDepth : texture_depth_2d;
// x: mode, y: near, z: far; w: the bits of the invalid background value
@group(0) @binding(1) var<uniform> U : vec4u;

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn near() -> f32 { return bitcast<f32>(U.y); }
fn far() -> f32 { return bitcast<f32>(U.z); }

// The core's standard-perspective linearizeDepth, verbatim.
fn viewDistance(d : f32) -> f32 {
    return (far() * near()) / (far() - d * (far() - near()));
}

// 0 positive, 1 negative view Z, 2 background = bits of U.w (0 / inf / NaN).
@fragment
fn toLinear(@builtin(position) pos : vec4f) -> @location(0) vec4f {
    let d = textureLoad(sceneDepth, vec2i(pos.xy), 0);
    let z = viewDistance(d);
    var value = z;
    if (U.x == 1u) { value = -z; }
    if (U.x == 2u && d >= 1.0) { value = bitcast<f32>(U.w); }
    return vec4f(value, 0.0, 0.0, 1.0);
}

// 0 reversed perspective, 1 orthographic, 2 reversed orthographic.
@fragment
fn toHardware(@builtin(position) pos : vec4f) -> @builtin(frag_depth) f32 {
    let z = viewDistance(textureLoad(sceneDepth, vec2i(pos.xy), 0));
    let n = near();
    let f = far();
    if (U.x == 0u) { return clamp(n * (f - z) / (z * (f - n)), 0.0, 1.0); }
    let t = clamp((z - n) / (f - n), 0.0, 1.0);
    return select(t, 1.0 - t, U.x == 2u);
}
`;

/** One core's per-frame differences against the positive-linear reference, over all frames. */
export interface LinearDepthCase {
    name: string;
    /** Dilated depth texels whose f32 bits differ. */
    depthMismatches: number;
    /** Largest |Δ| of the dilated depth, and the largest |Δ| / depth. */
    depthMaxAbs: number;
    depthMaxRel: number;
    /** Disocclusion texels that differ, and the largest |Δ| (0..1). */
    disocclusionMismatches: number;
    disocclusionMaxAbs: number;
    /** Output texels whose rgba16float bits differ, the largest |Δ| and mean |Δ| per component. */
    outputMismatches: number;
    outputMaxAbs: number;
    outputMeanAbs: number;
}

/** What {@link run} resolves with. */
export interface LinearDepthReport {
    adapter: string;
    frames: number;
    texelsPerFrame: { render: number; display: number };
    cases: LinearDepthCase[];
    /** The reference's own activity, so a blank comparison can't pass. */
    reference: { disoccludedPerFrame: number; nonZeroOutputPerFrame: number };
    timing: { frames: number; hardwareMicros: number; linearMicros: number; samples: number } | null;
    errors: string[];
}

const halfToFloat = (h: number): number => {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
};

async function run(): Promise<LinearDepthReport> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const timed = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timed ? ['timestamp-query'] : [] });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

    //* Scene + Depth Encodings
    const scene = new Scene(device);
    const targets = scene.createTargets(RENDER[0], RENDER[1]);
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const texture = (format: GPUTextureFormat) => device.createTexture({ size: RENDER, format, usage });
    const module = device.createShaderModule({ label: 'linear-depth-convert', code: CONVERT_WGSL });
    const linearPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    const linearPipeline = (format: GPUTextureFormat) => {
        let pipeline = linearPipelines.get(format);
        if (!pipeline) {
            pipeline = device.createRenderPipeline({
                layout: 'auto', vertex: { module }, fragment: { module, entryPoint: 'toLinear', targets: [{ format }] },
            });
            linearPipelines.set(format, pipeline);
        }
        return pipeline;
    };
    const hardwarePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module },
        fragment: { module, entryPoint: 'toHardware', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const bits = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0];

    interface Encoding { target: GPUTexture; encode(encoder: GPUCommandEncoder): void }
    const conversion = (kind: 'linear' | 'hardware', mode: number, format: GPUTextureFormat, background = 0): Encoding => {
        const target = texture(format);
        const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 0, new Uint32Array([mode, bits(SCENE_NEAR), bits(SCENE_FAR), background]));
        const pipeline = kind === 'linear' ? linearPipeline(format) : hardwarePipeline;
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: targets.depth.createView() },
                { binding: 1, resource: { buffer: uniform } },
            ],
        });
        return {
            target,
            encode(encoder) {
                const pass = encoder.beginRenderPass(kind === 'linear'
                    ? { colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] }
                    : {
                        colorAttachments: [],
                        depthStencilAttachment: {
                            view: target.createView(), depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'store',
                        },
                    });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.draw(3);
                pass.end();
            },
        };
    };

    const perspectiveCamera: FrameCamera = { near: SCENE_NEAR, far: SCENE_FAR, perspective: true };
    interface CaseDefinition {
        name: string;
        depthMode: DepthMode;
        camera: FrameCamera;
        depth: GPUTexture;
        path?: UpscalePath;
        encoding?: Encoding;
    }
    const hardwareCase = (name: string, mode: number, camera: FrameCamera): CaseDefinition => {
        const encoding = conversion('hardware', mode, 'depth32float');
        return { name, depthMode: 'hardware', camera, depth: encoding.target, encoding };
    };
    const linearCase = (name: string, encoding: Encoding, path?: UpscalePath): CaseDefinition =>
        ({ name, depthMode: 'linear', camera: perspectiveCamera, depth: encoding.target, encoding, path });

    // The reference: positive linear view distance, r32float.
    const reference = linearCase('linear +z r32float (reference)', conversion('linear', 0, 'r32float'));
    const definitions: CaseDefinition[] = [
        reference,
        { name: 'hardware standard perspective', depthMode: 'hardware', camera: perspectiveCamera, depth: targets.depth },
        hardwareCase('hardware reversed perspective', 0, { ...perspectiveCamera, reversedDepth: true }),
        hardwareCase('hardware orthographic', 1, { ...perspectiveCamera, perspective: false }),
        hardwareCase('hardware reversed orthographic', 2, { ...perspectiveCamera, perspective: false, reversedDepth: true }),
        linearCase('linear -z (view Z)', conversion('linear', 1, 'r32float')),
        linearCase('linear background 0', conversion('linear', 2, 'r32float', 0)),
        linearCase('linear background +inf', conversion('linear', 2, 'r32float', 0x7f800000)),
        linearCase('linear background NaN', conversion('linear', 2, 'r32float', 0x7fc00000)),
        linearCase('linear +z rgba16float', conversion('linear', 0, 'rgba16float')),
        linearCase('linear +z r16float', conversion('linear', 0, 'r16float')),
        linearCase('linear +z guides path', reference.encoding!, 'guides'),
    ];

    const makeCore = async (depthMode: DepthMode, path: UpscalePath = 'temporal', gpuTiming = false) => {
        const core = new UpscalerCore({ device, gpuTiming });
        core.configure({
            displayWidth: DISPLAY[0], displayHeight: DISPLAY[1], renderWidth: RENDER[0], renderHeight: RENDER[1],
            path, depthMode,
        });
        await core.prepare();
        return core;
    };
    const cores = await Promise.all(definitions.map((d) => makeCore(d.depthMode, d.path)));

    //* Frames
    let time = 0;
    const renderFrame = (encoder: GPUCommandEncoder, jitter: { x: number; y: number }) => {
        // Orbit + dolly, so the depth clip sees surfaces approach and recede.
        const a = time * 0.6;
        const radius = 7 + 2.5 * Math.sin(time * 1.3);
        const view = lookAt([Math.cos(a) * radius, 3.2, Math.sin(a) * radius], [0, 0.4, 0], [0, 1, 0]);
        const proj = perspective((50 * Math.PI) / 180, RENDER[0] / RENDER[1], SCENE_NEAR, SCENE_FAR);
        scene.update(time, multiply(proj, view), jitter, RENDER[0], RENDER[1]);
        scene.encode(encoder, targets);
        const encoded = new Set<Encoding>();
        for (const d of definitions) {
            if (d.encoding && !encoded.has(d.encoding)) {
                d.encoding.encode(encoder);
                encoded.add(d.encoding);
            }
        }
    };

    //* Exact Readback
    const read = async (source: GPUTexture, bytesPerTexel: number): Promise<ArrayBuffer> => {
        const bytesPerRow = Math.ceil((source.width * bytesPerTexel) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * source.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow }, [source.width, source.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        // Drop the row padding so texel indices line up.
        const padded = new Uint8Array(buffer.getMappedRange());
        const rowBytes = source.width * bytesPerTexel;
        const packed = new Uint8Array(rowBytes * source.height);
        for (let row = 0; row < source.height; row++) packed.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes);
        buffer.destroy();
        return packed.buffer;
    };

    const cases: LinearDepthCase[] = definitions.map((d) => ({
        name: d.name, depthMismatches: 0, depthMaxAbs: 0, depthMaxRel: 0,
        disocclusionMismatches: 0, disocclusionMaxAbs: 0, outputMismatches: 0, outputMaxAbs: 0, outputMeanAbs: 0,
    }));
    let disoccluded = 0;
    let nonZero = 0;
    const outputSums = new Array<number>(definitions.length).fill(0);
    for (let frame = 0; frame < FRAMES; frame++) {
        // Every core starts at the same phase and advances once per frame,
        // so one jitter serves all of them.
        let jitter: { x: number; y: number } = { x: 0, y: 0 };
        for (const core of cores) {
            const offset = core.beginFrame();
            if (offset) jitter = { ...offset };
        }
        const encoder = device.createCommandEncoder({ label: 'linear-depth-frame' });
        renderFrame(encoder, jitter);
        device.queue.submit([encoder.finish()]);
        definitions.forEach((d, index) => {
            const inputs = { depth: d.depth, velocity: targets.velocity, deltaTime: DT };
            if (d.path === 'guides') cores[index].dispatchGuides(inputs, d.camera);
            else cores[index].dispatch({ ...inputs, color: targets.color }, d.camera);
        });

        const readbacks = await Promise.all(cores.map(async (core, index) => ({
            depth: new Float32Array(await read(core.guides.dilatedDepth, 4)),
            masks: new Uint8Array(await read(core.guides.disocclusion, 4)),
            output: definitions[index].path === 'guides' ? null : new Uint16Array(await read(core.output, 8)),
        })));
        const ref = readbacks[0];
        for (let t = 0; t < ref.masks.length; t += 4) if (ref.masks[t] > 127) disoccluded++;
        for (const value of ref.output!) if (value !== 0) nonZero++;
        const refDepthBits = new Uint32Array(ref.depth.buffer);
        readbacks.forEach((rb, index) => {
            const c = cases[index];
            const depthBits = new Uint32Array(rb.depth.buffer);
            for (let t = 0; t < rb.depth.length; t++) {
                if (depthBits[t] === refDepthBits[t]) continue;
                c.depthMismatches++;
                const delta = Math.abs(rb.depth[t] - ref.depth[t]);
                c.depthMaxAbs = Math.max(c.depthMaxAbs, delta);
                c.depthMaxRel = Math.max(c.depthMaxRel, delta / Math.max(Math.abs(ref.depth[t]), 1e-6));
            }
            for (let t = 0; t < rb.masks.length; t += 4) {
                if (rb.masks[t] === ref.masks[t]) continue;
                c.disocclusionMismatches++;
                c.disocclusionMaxAbs = Math.max(c.disocclusionMaxAbs, Math.abs(rb.masks[t] - ref.masks[t]) / 255);
            }
            if (!rb.output) return;
            for (let t = 0; t < rb.output.length; t += 4) {
                let differs = false;
                for (let k = 0; k < 4; k++) {
                    if (rb.output[t + k] === ref.output![t + k]) continue;
                    differs = true;
                    const delta = Math.abs(halfToFloat(rb.output[t + k]) - halfToFloat(ref.output![t + k]));
                    c.outputMaxAbs = Math.max(c.outputMaxAbs, delta);
                    outputSums[index] += delta;
                }
                if (differs) c.outputMismatches++;
            }
        });
        time += DT;
    }
    const displayTexels = DISPLAY[0] * DISPLAY[1];
    cases.forEach((c, index) => { c.outputMeanAbs = outputSums[index] / (FRAMES * displayTexels * 4); });
    for (const core of cores) core.dispose();

    //* Timing — reconstruct GPU time per mode, ABBA order per frame
    let timing: LinearDepthReport['timing'] = null;
    if (timed) {
        const hardware = await makeCore('hardware', 'temporal', true);
        const linear = await makeCore('linear', 'temporal', true);
        const sums = { hardware: 0, linear: 0 };
        let samples = 0;
        for (let frame = 0; frame < TIMING_FRAMES; frame++) {
            hardware.beginFrame();
            const jitter = { ...linear.beginFrame()! };
            const encoder = device.createCommandEncoder();
            renderFrame(encoder, jitter);
            device.queue.submit([encoder.finish()]);
            const order = frame % 4 === 0 || frame % 4 === 3 ? [hardware, linear] : [linear, hardware];
            for (const core of order) {
                const isLinear = core === linear;
                core.dispatch({
                    color: targets.color, velocity: targets.velocity, deltaTime: DT,
                    depth: isLinear ? reference.depth : targets.depth,
                }, perspectiveCamera);
            }
            await device.queue.onSubmittedWorkDone();
            await new Promise((resolveWait) => setTimeout(resolveWait, 0));
            const h = hardware.gpuTimings.get('reconstruct');
            const l = linear.gpuTimings.get('reconstruct');
            // Skip warm-up frames and frames whose readback hasn't landed yet.
            if (frame >= 40 && h !== undefined && l !== undefined) {
                sums.hardware += h;
                sums.linear += l;
                samples++;
            }
            time += DT;
        }
        timing = {
            frames: TIMING_FRAMES,
            hardwareMicros: (sums.hardware / Math.max(samples, 1)) * 1000,
            linearMicros: (sums.linear / Math.max(samples, 1)) * 1000,
            samples,
        };
        hardware.dispose();
        linear.dispose();
    }

    await device.queue.onSubmittedWorkDone();
    const { vendor, architecture, description } = adapter.info;
    return {
        adapter: [vendor, architecture, description].filter(Boolean).join(' '),
        frames: FRAMES,
        texelsPerFrame: { render: RENDER[0] * RENDER[1], display: displayTexels },
        cases,
        reference: {
            disoccludedPerFrame: Math.round(disoccluded / FRAMES),
            nonZeroOutputPerFrame: Math.round(nonZero / FRAMES),
        },
        timing,
        errors,
    };
}

declare global {
    interface Window {
        __linearDepthProbe?: { run: typeof run };
    }
}
window.__linearDepthProbe = { run };
