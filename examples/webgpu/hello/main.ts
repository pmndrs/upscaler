import { DebugView, QualityMode, UpscalerCore, type FrameCamera, type UpscalePath } from '@pmndrs/upscaler/core';

import { lookAt, multiply, perspective } from './mat4';
import { Scene, SCENE_FAR, SCENE_NEAR, type SceneTargets } from './scene';

/**
 * The upscaler with no engine: `@pmndrs/upscaler/core` on a bare GPUDevice.
 * The app renders color + depth + motion itself, applies the core's jitter to
 * its own projection, and encodes the upscale into its own command encoder —
 * scene, upscale and present go out in one submit. The contract this follows
 * is docs/engine-contract.md.
 */

type Mode = 'temporal' | 'spatial' | 'bilinear' | 'native';

const PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<uniform> P : vec4f; // x: 1 = tonemap (0 for debug views)

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn aces(x : vec3f) -> vec3f {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn srgb(c : vec3f) -> vec3f {
    return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
    // The output is display-sized: one texel per canvas pixel.
    let c = textureLoad(src, vec2i(pos.xy), 0).rgb;
    let mapped = select(clamp(c, vec3f(0.0), vec3f(1.0)), aces(c), P.x > 0.5);
    return vec4f(srgb(mapped), 1.0);
}
`;

const badge = document.getElementById('badge')!;

if (!navigator.gpu) {
    badge.textContent = 'WebGPU is not available in this browser — try Chrome/Edge 113+.';
    throw new Error('WebGPU unavailable');
}
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('No WebGPU adapter');
// Optional: the core times its passes when the device can.
const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
});
device.addEventListener('uncapturederror', (e) => console.error('[webgpu-hello]', (e as GPUUncapturedErrorEvent).error.message));
if (!UpscalerCore.isSupported(device)) throw new Error('Device limits are below the upscaler baseline');

const canvas = document.querySelector('canvas')!;
const context = canvas.getContext('webgpu')!;
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

//* The Upscaler
// Default allocator: `core.output` is a plain GPUTexture.
const core = new UpscalerCore({ device });
const scene = new Scene(device);

const presentModule = device.createShaderModule({ label: 'hello-present', code: PRESENT_WGSL });
const presentPipeline = device.createRenderPipeline({
    label: 'hello-present',
    layout: 'auto',
    vertex: { module: presentModule, entryPoint: 'vs' },
    fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
});
const presentParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

const state = {
    mode: 'temporal' as Mode,
    paused: false,
    debugView: DebugView.None,
    frame: 0,
};
let targets: SceneTargets | null = null;
let renderSize = { width: 1, height: 1 };
let presentBindGroup: GPUBindGroup | null = null;
let configuring: Promise<void> | null = null;
const camera: FrameCamera = { near: SCENE_NEAR, far: SCENE_FAR, perspective: true };

/** Resizes the canvas and (re)configures the core and the scene targets for the mode. */
async function configure(): Promise<void> {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.floor(window.innerWidth * dpr));
    const height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.width = width;
    canvas.height = height;

    if (targets) for (const t of Object.values(targets)) t.destroy();
    let presented: GPUTexture;
    if (state.mode === 'native') {
        renderSize = { width, height };
        targets = scene.createTargets(width, height);
        presented = targets.color;
    } else {
        const path: UpscalePath = state.mode;
        // Performance = 2× per axis: a quarter of the pixels.
        core.configure({ displayWidth: width, displayHeight: height, qualityMode: QualityMode.Performance, path });
        renderSize = { width: core.renderWidth, height: core.renderHeight };
        targets = scene.createTargets(renderSize.width, renderSize.height);
        presented = core.output; // reallocated by configure(): re-read it
        await core.prepare();
    }
    presentBindGroup = device.createBindGroup({
        layout: presentPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: presented.createView() },
            { binding: 1, resource: { buffer: presentParams } },
        ],
    });
}

function reconfigure(): void {
    presentBindGroup = null;
    configuring = configure().finally(() => { configuring = null; });
}

//* Frame Loop
let last = performance.now();
let time = 0;

function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (configuring || !presentBindGroup || !targets) return;
    if (state.mode !== 'native' && !core.isReady) return;
    if (!state.paused) time += dt;

    // 1. Jitter: advance the core's sequence and offset this frame's projection.
    //    `null` off the temporal path — render unjittered.
    const temporal = state.mode === 'temporal';
    const jitter = temporal ? core.beginFrame() : null;

    const a = time * 0.15;
    const view = lookAt([Math.cos(a) * 7, 3.2, Math.sin(a) * 7], [0, 0.4, 0], [0, 1, 0]);
    const proj = perspective((50 * Math.PI) / 180, canvas.width / canvas.height, SCENE_NEAR, SCENE_FAR);
    scene.update(time, multiply(proj, view), jitter ?? { x: 0, y: 0 }, renderSize.width, renderSize.height);

    // 2. One encoder for everything: scene → upscale → present, one submit.
    const encoder = device.createCommandEncoder({ label: 'hello-frame' });
    scene.encode(encoder, targets);
    if (state.mode !== 'native') {
        core.settings.debugView = state.debugView;
        core.encode(encoder, {
            color: targets.color,
            depth: targets.depth,
            velocity: targets.velocity,
            deltaTime: dt,
        }, camera);
    }
    device.queue.writeBuffer(presentParams, 0, new Float32Array([core.activeDebugView === DebugView.None ? 1 : 0, 0, 0, 0]));
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(presentPipeline);
    pass.setBindGroup(0, presentBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    state.frame++;
    badge.innerHTML =
        `<b>raw WebGPU · @pmndrs/upscaler/core</b>\n` +
        `mode     ${state.mode}\n` +
        `render   ${renderSize.width}×${renderSize.height}\n` +
        `display  ${canvas.width}×${canvas.height}\n` +
        (temporal ? `jitter   phase ${core.jitterPhase}/${core.jitterPhaseCount}\n` : '') +
        (state.debugView !== DebugView.None ? `debug    ${DebugView[state.debugView]}\n` : '') +
        `\n[1] temporal [2] spatial [3] bilinear [4] native\n[d] debug view  [space] pause`;
}

//* Controls
const MODES: Record<string, Mode> = { '1': 'temporal', '2': 'spatial', '3': 'bilinear', '4': 'native' };
const DEBUG_VIEWS = Object.values(DebugView).filter((v): v is DebugView => typeof v === 'number');
window.addEventListener('keydown', (e) => {
    const mode = MODES[e.key];
    if (mode && mode !== state.mode) {
        state.mode = mode;
        reconfigure();
    } else if (e.key === 'd') {
        state.debugView = DEBUG_VIEWS[(DEBUG_VIEWS.indexOf(state.debugView) + 1) % DEBUG_VIEWS.length];
    } else if (e.key === ' ') {
        state.paused = !state.paused;
    }
});
window.addEventListener('resize', reconfigure);

// Headless verification handle (CDP harness).
Object.assign(window, { __webgpuHello: { core, state, setMode(m: Mode) { state.mode = m; reconfigure(); } } });

reconfigure();
requestAnimationFrame(frame);
