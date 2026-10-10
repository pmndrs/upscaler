import { UpscalerCore, getResourceDescriptors, JitterSequence } from '@pmndrs/upscaler/core';
import type { CoreConfiguration, CoreResources, TextureResource, TextureHistory } from '@pmndrs/upscaler/core';
import { DemoScene, DemoPresent, readOutput } from '../shared/core-demo';
import type { DemoInputs } from '../shared/core-demo';

const canvas = document.querySelector('canvas')!;
const device = await (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))!.requestDevice();
const errors: string[] = []; device.addEventListener('uncapturederror', event => { errors.push(event.error.message); console.error(event.error.message); });
const context = canvas.getContext('webgpu')!; const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: 'opaque' });
const core = new UpscalerCore({ device }); const scene = new DemoScene(device); const present = new DemoPresent(device, format);
let config: CoreConfiguration; let resources: CoreResources; let inputs: DemoInputs; let sequence = new JitterSequence(1.5);
let frameIndex = 0; let time = 0; let previousTime = 0; let paused = false; let preparing = false;
const histories: TextureHistory[] = []; const owned: GPUTexture[] = [];
function allocate(width: number, height: number, textureFormat: GPUTextureFormat, usage: GPUTextureUsageFlags): TextureResource {
    const texture = device.createTexture({ size: [width, height], format: textureFormat, usage: usage | GPUTextureUsage.COPY_SRC }); owned.push(texture);
    return { texture, view: texture.createView() };
}
async function resize(width = 963, height = 541, ratio = 1.5): Promise<void> {
    preparing = true; owned.splice(0).forEach(texture => texture.destroy()); histories.length = 0;
    canvas.width = width; canvas.height = height;
    config = { renderWidth: Math.floor(width / ratio), renderHeight: Math.floor(height / ratio), displayWidth: width, displayHeight: height, depthMode: 'linear', exposureMode: 'provided', correctConditioningExposure: true, rcasAgeKnee: 0.5 };
    resources = {};
    for (const d of core.configure(config)) {
        const create = () => allocate(d.width, d.height, d.format, d.usage);
        if (d.history) { const pair = { read: create(), write: create() }; histories.push(pair); resources[d.name] = pair; }
        else resources[d.name] = create();
    }
    inputs = {
        color: allocate(config.renderWidth, config.renderHeight, 'rgba16float', 12), depth: allocate(config.renderWidth, config.renderHeight, 'r32float', 12), velocity: allocate(config.renderWidth, config.renderHeight, 'rgba16float', 12), reactive: allocate(config.renderWidth, config.renderHeight, 'rgba8unorm', 12), exposureTexture: allocate(1, 1, 'rgba32float', 12), preExposureTexture: allocate(1, 1, 'rgba32float', 12),
    };
    Object.assign(resources, inputs); sequence = new JitterSequence(width / config.renderWidth);
    document.querySelector('#status')!.textContent = 'Compilation des pipelines…';
    await core.prepare(); preparing = false;
}
await resize();
document.querySelector('#reset')!.addEventListener('click', () => core.resetHistory());
const checked = (id: string) => (document.querySelector(`#${id}`) as HTMLInputElement).checked;
function render(): void {
    if (!paused && !preparing) {
        previousTime = time; if (checked('motion')) time += 1 / 60;
        sequence.advance(); const [x, y] = sequence.current; const [px, py] = sequence.previous;
        const encoder = device.createCommandEncoder();
        const host = checked('host') ? (Math.floor(frameIndex / 45) % 2 ? 2 : 0.5) : 1;
        const conditioning = checked('conditioning') ? (Math.floor(frameIndex / 60) % 2 ? 1.8 : 0.6) : 1;
        scene.encode(encoder, inputs, time, previousTime, { x, y }, host, conditioning);
        core.encode(encoder, resources, { frameIndex, jitter: { x, y }, jitterPrevious: { x: px, y: py }, deltaTime: 1 / 60, motionScale: { x: -1, y: -1 } });
        present.encode(encoder, resources.output as TextureResource, context.getCurrentTexture().createView());
        device.queue.submit([encoder.finish()]);
        for (const history of histories) [history.read, history.write] = [history.write, history.read];
        frameIndex++; document.querySelector('#status')!.textContent = `${config.renderWidth}×${config.renderHeight} → ${config.displayWidth}×${config.displayHeight} · ${frameIndex} frames`;
    }
    requestAnimationFrame(render);
}
async function exercisePaths(): Promise<string[]> {
    const before = paused; paused = true; const completed: string[] = [];
    try {
        for (const path of ['bilinear', 'spatial', 'guides', 'temporal'] as const) {
            const test = new UpscalerCore({ device }); test.configure({ ...config, path }); await test.prepare();
            const borrowed = { ...resources, easuOutput: allocate(config.displayWidth, config.displayHeight, 'rgba16float', 12) };
            const frame = { frameIndex, jitter: { x: 0, y: 0 }, motionScale: { x: -1, y: -1 } };
            if (path === 'temporal') { test.encodeGuides(device.createCommandEncoder(), borrowed, frame); test.resetHistory(); }
            const encoder = device.createCommandEncoder();
            if (path === 'guides') test.encodeGuides(encoder, borrowed, frame); else test.encode(encoder, borrowed, frame);
            device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); test.dispose(); completed.push(path);
        }
    } finally { core.resetHistory(); paused = before; }
    return completed;
}
Object.assign(window, { __UpscalerDemo: { errors, exercisePaths, probe: () => readOutput(device, resources.output as TextureResource), get frames() { return frameIndex; }, pause(value: boolean) { paused = value; }, resize, reset() { core.resetHistory(); }, descriptors: () => getResourceDescriptors(config), output: () => resources.output } });
render();
