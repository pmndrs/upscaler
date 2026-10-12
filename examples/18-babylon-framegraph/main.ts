import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import { FrameGraphUpscaleTask, getBabylonTextureOptions, babylonWebGPU } from '@pmndrs/upscaler/babylon';
import type { ResourceDescriptor, TextureResource } from '@pmndrs/upscaler/core';
import type { FrameGraphUpscaleConfiguration } from '@pmndrs/upscaler/babylon';
import { DemoScene, DemoPresent, readOutput } from '../shared/core-demo';
import type { DemoInputs } from '../shared/core-demo';

// Finish module evaluation before Babylon lazy shader chunks import their engine dependencies.
// Top-level await here can otherwise deadlock the production bundle during graph.buildAsync().
async function main(): Promise<void> {
    const canvas = document.querySelector('canvas')!; canvas.width = 963; canvas.height = 541;
    const engine = new WebGPUEngine(canvas, { antialias: false }); await engine.initAsync(); engine.setSize(963, 541);
    const scene = new Scene(engine); const camera = new FreeCamera('camera', new Vector3(0, 0, -5), scene);
    const graph = new FrameGraph(scene); const device = babylonWebGPU.getBabylonDevice(engine);
    const errors: string[] = []; device.addEventListener('uncapturederror', event => { errors.push(event.error.message); console.error(event.error.message); });
    const generator = new DemoScene(device); const presenter = new DemoPresent(device, navigator.gpu.getPreferredCanvasFormat());
    const context = canvas.getContext('webgpu')!;
    let config: FrameGraphUpscaleConfiguration = { renderWidth: 642, renderHeight: 360, displayWidth: 963, displayHeight: 541, depthMode: 'linear', exposureMode: 'provided', correctConditioningExposure: true, rcasAgeKnee: 0.5 };
    let frames = 0; let paused = false; let time = 0; let previousTime = 0;
    const checked = (id: string) => (document.querySelector(`#${id}`) as HTMLInputElement).checked;
    const upscale = new FrameGraphUpscaleTask('upscale', graph, { configuration: config, frame: () => ({ frameIndex: frames, deltaTime: 1 / 60, motionScale: { x: -1, y: -1 } }) });
    const names = ['color', 'depth', 'velocity', 'reactive', 'exposureTexture', 'preExposureTexture'] as const;
    const inputHandles = {} as Record<typeof names[number], number>;

    class InputsTask extends FrameGraphTask {
        record(): void {
            for (const name of names) {
                const exposure = name.includes('Exposure') || name === 'exposureTexture';
                const descriptor: ResourceDescriptor = { name: 'output', width: exposure ? 1 : config.renderWidth, height: exposure ? 1 : config.renderHeight, format: exposure ? 'rgba32float' : name === 'depth' ? 'r32float' : name === 'reactive' ? 'rgba8unorm' : 'rgba16float', usage: 12, history: false, sampling: 'load', initialization: 'zero' };
                inputHandles[name] = graph.textureManager.createRenderTargetTexture(name, getBabylonTextureOptions(descriptor));
            }
            upscale.colorTexture = inputHandles.color; upscale.depthTexture = inputHandles.depth; upscale.velocityTexture = inputHandles.velocity; upscale.reactiveTexture = inputHandles.reactive;
            upscale.exposureTexture = inputHandles.exposureTexture; upscale.preExposureTexture = inputHandles.preExposureTexture;
            const pass = graph.addRenderPass('analytic-scene'); pass.setRenderTarget(inputHandles.color); pass.addDependencies(Object.values(inputHandles));
            pass.setExecuteFunc(() => {
                const inputs = Object.fromEntries(names.map(name => [name, babylonWebGPU.resolveBabylonTexture(graph.textureManager, inputHandles[name], true)])) as DemoInputs;
                const host = checked('host') ? (Math.floor(frames / 45) % 2 ? 2 : 0.5) : 1;
                const conditioning = checked('conditioning') ? (Math.floor(frames / 60) % 2 ? 1.8 : 0.6) : 1;
                generator.encode(babylonWebGPU.getBabylonEncoder(engine), inputs, time, previousTime, upscale.jitter, host, conditioning);
            });
        }
    }
    class PresentTask extends FrameGraphTask {
        record(): void {
            const pass = graph.addRenderPass('present'); pass.setRenderTarget(0); pass.addDependencies(upscale.outputTexture);
            pass.setExecuteFunc(() => presenter.encode(babylonWebGPU.getBabylonEncoder(engine), babylonWebGPU.resolveBabylonTexture(graph.textureManager, upscale.outputTexture), context.getCurrentTexture().createView()));
        }
    }
    graph.addTask(new InputsTask('inputs', graph)); graph.addTask(upscale); graph.addTask(new PresentTask('present', graph));
    await graph.buildAsync();
    document.querySelector('#reset')!.addEventListener('click', () => upscale.resetHistory());
    async function rebuild(width = 967, height = 543, optimize = true, ratio = 1.5): Promise<void> {
        const before = paused; paused = true;
        try {
            engine.setSize(width, height); config = { ...config, renderWidth: Math.floor(width / ratio), renderHeight: Math.floor(height / ratio), displayWidth: width, displayHeight: height };
            upscale.configure(config); await upscale.prepare(); graph.optimizeTextureAllocation = optimize; await graph.buildAsync();
        } finally { paused = before; }
    }
    engine.runRenderLoop(() => {
        if (paused) return;
        upscale.disabled = !checked('enabled'); previousTime = time; time += 1 / 60;
        upscale.beginFrame(camera);
        try { graph.execute(); frames++; } catch (error) { upscale.resetHistory(); throw error; } finally { upscale.endFrame(); }
        document.querySelector('#status')!.textContent = `${config.renderWidth}×${config.renderHeight} → ${config.displayWidth}×${config.displayHeight} · ${frames} frames`;
    });
    Object.assign(window, { __UpscalerDemo: { errors, probe: () => readOutput(device, babylonWebGPU.resolveBabylonTexture(graph.textureManager, upscale.outputTexture)), get frames() { return frames; }, pause(value: boolean) { paused = value; }, resize: rebuild, reset() { upscale.resetHistory(); }, output: () => babylonWebGPU.resolveBabylonTexture(graph.textureManager, upscale.outputTexture) as TextureResource, history: () => graph.textureManager } });
}

void main().catch(error => {
    console.error(error);
    document.querySelector('#status')!.textContent = 'Initialisation impossible : ' + String(error);
});
