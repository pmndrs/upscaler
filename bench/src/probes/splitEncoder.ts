import { UpscalerCore, type FrameCamera } from '@pmndrs/upscaler/core';

/**
 * Split-frame encoder probe (issue #96), driven by
 * `scripts/verify-split-encoder.mjs` over CDP.
 *
 * Three cores on one bare `GPUDevice` consume the same procedural inputs (a
 * bright box moving over a striped wall, with its own depth and motion) and
 * differ only in how the frame is submitted:
 * - `mono`: `dispatch()`;
 * - `two`: `dispatchGuides()` then `dispatchUpscale()`, two submits;
 * - `one`: `encodeGuides()` and `encodeUpscale()` into one host encoder, one
 *   submit.
 * Each frame the rgba16float output and the r32float dilated depth are read
 * back exactly and compared texel by texel against `two`.
 *
 * The `isolation` case hands the late stage a different camera `far`. That
 * breaks the "same camera for both stages" contract on purpose: it is the one
 * way to make the two stages' constants differ in a field the guides passes
 * read, so a guides stage reading the late constants shows up in the dilated
 * depth of `one`.
 */

const DISPLAY = [128, 96] as const;
const RENDER = [64, 48] as const;
const FRAMES = 12;
const CAMERA: FrameCamera = { near: 0.1, far: 100, perspective: true };

const INPUT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> U : vec4f; // x: frame

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

struct Targets {
    @location(0) color : vec4f,
    @location(1) velocity : vec4f,
    @location(2) reactive : vec4f,
    @builtin(frag_depth) depth : f32,
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> Targets {
    let t = U.x;
    let q = pos.xy + vec2f(t * 1.7, t * 0.6);
    let box = step(abs(q.x - 30.0 - t), 9.0) * step(abs(q.y - 24.0), 9.0);
    let stripes = step(0.5, fract(q.x * 0.31)) * 0.8 + 0.1;
    var out : Targets;
    out.color = vec4f(mix(vec3f(stripes, stripes * 0.6, 0.3), vec3f(6.0, 2.0, 0.5), box), 1.0);
    out.velocity = vec4f(mix(vec2f(0.004, 0.0), vec2f(0.03, 0.0), box), 0.0, 0.0);
    out.reactive = vec4f(step(40.0, pos.x) * 0.7, 0.0, 0.0, 0.0);
    out.depth = mix(0.98, 0.6, box);
    return out;
}
`;

/** One case's texel mismatches, summed over every frame. */
export interface SplitEncoderCase {
    name: string;
    /** `dispatch()` output vs the two-submit split. */
    monoVsTwo: number;
    /** One-encoder split output vs the two-submit split. */
    oneVsTwo: number;
    /** One-encoder split dilated depth vs the two-submit split. */
    guideDepthOneVsTwo: number;
    /** Non-zero output components per frame — guards against comparing blanks. */
    nonZeroPerFrame: number;
}

/** What {@link run} resolves with. */
export interface SplitEncoderReport {
    adapter: string;
    frames: number;
    cases: SplitEncoderCase[];
    errors: string[];
}

async function run(): Promise<SplitEncoderReport> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

    //* Procedural Inputs
    const target = (format: GPUTextureFormat) =>
        device.createTexture({
            size: RENDER,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
    const color = target('rgba16float');
    const velocity = target('rg16float');
    const reactive = target('r8unorm');
    const depth = target('depth32float');
    const module = device.createShaderModule({ code: INPUT_WGSL });
    const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module },
        fragment: { module, targets: [{ format: 'rgba16float' }, { format: 'rg16float' }, { format: 'r8unorm' }] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const frameUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const inputBindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frameUniform } }],
    });
    const renderInputs = (frame: number) => {
        device.queue.writeBuffer(frameUniform, 0, new Float32Array([frame, 0, 0, 0]));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [color, velocity, reactive].map((texture) => ({
                view: texture.createView(),
                loadOp: 'clear' as const,
                storeOp: 'store' as const,
            })),
            depthStencilAttachment: {
                view: depth.createView(),
                depthLoadOp: 'clear',
                depthClearValue: 1,
                depthStoreOp: 'store',
            },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, inputBindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
    };

    //* Exact Readback
    const read = async (texture: GPUTexture, bytesPerTexel: number): Promise<Uint8Array> => {
        const bytesPerRow = Math.ceil((texture.width * bytesPerTexel) / 256) * 256;
        const buffer = device.createBuffer({
            size: bytesPerRow * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texture.width, texture.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        // Row padding is zero-filled on both sides, so whole buffers compare.
        const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        return bytes;
    };
    // Mismatching texels, not bytes.
    const mismatches = (a: Uint8Array, b: Uint8Array, bytesPerTexel: number) => {
        let count = 0;
        for (let texel = 0; texel < a.length; texel += bytesPerTexel) {
            for (let byte = 0; byte < bytesPerTexel; byte++) {
                if (a[texel + byte] !== b[texel + byte]) {
                    count++;
                    break;
                }
            }
        }
        return count;
    };

    const makeCore = async () => {
        const core = new UpscalerCore({ device });
        core.configure({
            displayWidth: DISPLAY[0],
            displayHeight: DISPLAY[1],
            renderWidth: RENDER[0],
            renderHeight: RENDER[1],
        });
        await core.prepare();
        return core;
    };

    //* Cases — `lateOnly` adds inputs only the late stage sees (a reactive
    //* mask, a mid-run reset), so the two stages stage different flags.
    const definitions: Array<{ name: string; lateOnly: boolean; lateCamera: FrameCamera }> = [
        { name: 'same-constants', lateOnly: false, lateCamera: CAMERA },
        { name: 'late-only-inputs', lateOnly: true, lateCamera: CAMERA },
        { name: 'isolation', lateOnly: true, lateCamera: { ...CAMERA, far: 3 } },
    ];
    const cases: SplitEncoderCase[] = [];
    for (const { name, lateOnly, lateCamera } of definitions) {
        const mono = await makeCore();
        const two = await makeCore();
        const one = await makeCore();
        const guides = { depth, velocity, deltaTime: 1 / 60 };
        const late = (frame: number) => ({
            color,
            deltaTime: 1 / 60,
            ...(lateOnly ? { reactive, reset: frame === 5 } : {}),
        });
        const result: SplitEncoderCase = { name, monoVsTwo: 0, oneVsTwo: 0, guideDepthOneVsTwo: 0, nonZeroPerFrame: 0 };
        let nonZero = 0;
        for (let frame = 0; frame < FRAMES; frame++) {
            renderInputs(frame);
            for (const core of [mono, two, one]) core.beginFrame();

            mono.dispatch({ ...late(frame), depth, velocity }, CAMERA);

            two.dispatchGuides(guides, CAMERA);
            two.dispatchUpscale(late(frame), lateCamera);

            const encoder = device.createCommandEncoder({ label: 'host-frame' });
            one.encodeGuides(encoder, guides, CAMERA);
            one.encodeUpscale(encoder, late(frame), lateCamera);
            device.queue.submit([encoder.finish()]);

            const [monoOut, twoOut, oneOut, twoDepth, oneDepth] = await Promise.all([
                read(mono.output, 8),
                read(two.output, 8),
                read(one.output, 8),
                read(two.guides.dilatedDepth, 4),
                read(one.guides.dilatedDepth, 4),
            ]);
            // The isolation case stages a different camera for `two`'s late
            // stage than `mono` ever sees, so only the split pair compares.
            if (name !== 'isolation') result.monoVsTwo += mismatches(monoOut, twoOut, 8);
            result.oneVsTwo += mismatches(oneOut, twoOut, 8);
            result.guideDepthOneVsTwo += mismatches(oneDepth, twoDepth, 4);
            for (const value of new Uint16Array(twoOut.buffer)) if (value !== 0) nonZero++;
        }
        result.nonZeroPerFrame = Math.round(nonZero / FRAMES);
        cases.push(result);
        for (const core of [mono, two, one]) core.dispose();
    }
    await device.queue.onSubmittedWorkDone();
    const { vendor, architecture, description } = adapter.info;
    return { adapter: [vendor, architecture, description].filter(Boolean).join(' '), frames: FRAMES, cases, errors };
}

declare global {
    interface Window {
        __splitEncoderProbe?: { run: typeof run };
    }
}
window.__splitEncoderProbe = { run };
