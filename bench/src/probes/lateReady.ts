import * as THREE from 'three/webgpu';
import { mrt, output, velocity } from 'three/tsl';

import { Upscaler } from '@pmndrs/upscaler';
import { getGPUTexture } from '@pmndrs/upscaler-three/internal/threeWebGPU';

import { createBenchScene } from '../BenchScene';
import { getBenchmarkScenario } from '../benchmark/scenarios';

/**
 * Late-readiness probe (NEXT-STEPS §18), driven by `scripts/measure-late-ready.mjs`
 * over CDP. Renders a bench scenario through the temporal path and holds
 * optional passes (the shading-change detector, every-texel metering) inactive
 * until a release frame — what a slow pipeline compile does on Windows/DXC —
 * then reads the exact rgba16float output back every frame.
 *
 * A run is compared against a reference run with the same passes active from
 * frame 0: the per-frame output difference around the release frame, and each
 * run's own frame-to-frame churn there. `resetAtRelease` adds a history reset
 * on the release frame, reproducing the restart the core did before.
 */

type Held = 'shadingChange' | 'everyTexel';

interface ProbeRequest {
    scenario: string;
    end: number;
    key: string;
    ratio?: number;
    width?: number;
    height?: number;
    /** Optional passes kept inactive until {@link release}. */
    hold?: Held[];
    release?: number;
    /** Reset history on the release frame (the pre-fix behaviour). */
    resetAtRelease?: boolean;
    /** Toggle `detectShadingChanges` off on these frames and back on at the next listed one. */
    toggleShading?: [number, number];
    /** RuntimeSettings overrides. */
    settings?: Record<string, unknown>;
    /** Frames whose conditioned luma is kept for {@link compare}. */
    keep?: [number, number];
}

interface FrameRecord {
    frame: number;
    hash: string;
    /** Mean |Δ| conditioned luma vs this run's previous frame. */
    churn: number;
    /** Stored conditioning exposure (exposure guide .r) after this frame. */
    exposure: number;
    /** Mean / max of the published shading-change response. */
    shadingMean: number;
    shadingMax: number;
    /** Fraction of response texels above 0.5. */
    shadingFiring: number;
}

//* Renderer
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.shadowMap.enabled = true;
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
await renderer.init();
const device = (renderer.backend as unknown as { device: GPUDevice }).device;
const gpu = (texture: THREE.Texture) => getGPUTexture(renderer, texture);

// The probe renders many frames per tick, so it advances three's node frame
// itself (the velocity node rolls its camera history once per node frame).
const internals = renderer as unknown as {
    _animation?: { start(): void; stop(): void };
    _nodes?: { nodeFrame?: { update(): void; time: number; deltaTime: number } };
};
const nodeFrame = internals._nodes?.nodeFrame;
if (!internals._animation || typeof internals._animation.start !== 'function' || !nodeFrame)
    throw new Error('Pinned renderer._animation / _nodes.nodeFrame shape changed.');
internals._animation.stop();
internals._animation.start = () => {};

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
camera.layers.enable(1);
const bench = createBenchScene();

function applyFrame(scenario: string, frame: number): { scene: THREE.Scene; resetHistory: boolean } {
    const definition = getBenchmarkScenario(scenario as BenchmarkScenarioId);
    const state = definition.frame(Math.min(frame, definition.endFrame));
    camera.position.fromArray(state.cameraPosition);
    camera.up.set(0, 1, 0);
    camera.lookAt(...state.cameraTarget);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    bench.applyFrame(state);
    const scene = state.scene === 'cornell' ? bench.cornellScene : bench.scene;
    scene.updateMatrixWorld(true);
    return { scene, resetHistory: state.resetHistory };
}

//* Pipeline
let held = new Set<Held>();
const upscaler = new Upscaler({
    renderer,
    _holdOptionalPass: (pass: string) => held.has(pass as Held),
} as ConstructorParameters<typeof Upscaler>[0]);
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);
const mrtFull = mrt({ output, velocity });
let target: THREE.RenderTarget | null = null;
let configured = '';
const kept = new Map<string, Float32Array>();

function configure(ratio: number, width: number, height: number): void {
    const key = `${ratio}:${width}x${height}`;
    if (key === configured) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    upscaler.configure({ displayWidth: width, displayHeight: height, customUpscaleRatio: ratio });
    target?.dispose();
    const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
    depthTexture.type = THREE.FloatType;
    target = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, { count: 2, type: THREE.HalfFloatType, depthTexture });
    target.textures[0].name = 'output';
    target.textures[1].name = 'velocity';
    configured = key;
}

async function readTexture(texture: GPUTexture, bytesPerTexel: number): Promise<ArrayBuffer> {
    const bytesPerRow = Math.ceil((texture.width * bytesPerTexel) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: texture.width, height: texture.height });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const rowBytes = texture.width * bytesPerTexel;
    const packed = new Uint8Array(rowBytes * texture.height);
    const mapped = new Uint8Array(buffer.getMappedRange());
    for (let y = 0; y < texture.height; y++) packed.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
    buffer.unmap();
    buffer.destroy();
    return packed.buffer;
}

function fnv(bytes: ArrayBuffer): string {
    const words = new Uint32Array(bytes);
    let hash = 0x811c9dc5;
    for (let index = 0; index < words.length; index++) {
        hash ^= words[index];
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

const half = (h: number) => THREE.DataUtils.fromHalfFloat(h);

// rgba16float → conditioned luma y/(1+y) per pixel (HDR peaks don't dominate).
function luma(bytes: ArrayBuffer): Float32Array {
    const halves = new Uint16Array(bytes);
    const out = new Float32Array(halves.length / 4);
    for (let index = 0; index < out.length; index++) {
        const y = 0.2126 * half(halves[index * 4]) + 0.7152 * half(halves[index * 4 + 1]) + 0.0722 * half(halves[index * 4 + 2]);
        out[index] = y / (1 + y);
    }
    return out;
}

function meanAbs(a: Float32Array, b: Float32Array): number {
    let total = 0;
    for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
    return total / a.length;
}

async function run(request: ProbeRequest): Promise<{ frames: FrameRecord[] }> {
    configure(request.ratio ?? 2, request.width ?? 1280, request.height ?? 720);
    Object.assign(upscaler.settings, {
        sharpness: 0.8, maxAccumulation: 24, autoExposure: true, exposure: 1, debugView: 0,
        detectShadingChanges: true, lockThinFeatures: true, ...request.settings,
    });
    held = new Set();
    await upscaler.prepare();
    upscaler.resetHistory();
    bench.resetDeterministicState();

    const release = request.release ?? 0;
    const frames: FrameRecord[] = [];
    let previous: Float32Array | null = null;
    for (let frame = 0; frame <= request.end; frame++) {
        held = new Set(frame < release ? request.hold ?? [] : []);
        if (request.toggleShading) {
            const [off, on] = request.toggleShading;
            upscaler.settings.detectShadingChanges = !(frame >= off && frame < on);
        }
        const { scene, resetHistory } = applyFrame(request.scenario, frame);
        nodeFrame!.update();
        nodeFrame!.time = (frame + 1) / 60;
        nodeFrame!.deltaTime = 1 / 60;

        upscaler.beginFrame(camera);
        renderer.setMRT(mrtFull);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
        upscaler.endFrame(camera);

        const reset = resetHistory || (request.resetAtRelease === true && frame === release);
        upscaler.dispatch({
            color: target!.textures[0], depth: target!.depthTexture!, velocity: target!.textures[1], reset, deltaTime: 1 / 60,
        }, camera);

        const outputBytes = await readTexture(gpu(upscaler.outputTexture), 8);
        const current = luma(outputBytes);
        const exposureTexture = gpu(upscaler.guides.exposure!);
        const exposure = half(new Uint16Array(await readTexture(exposureTexture, 8))[0]);
        const shading = new Float32Array(await readTexture(gpu(upscaler.guides.shadingChange!), 4));
        let shadingSum = 0;
        let shadingMax = 0;
        let firing = 0;
        for (const value of shading) {
            shadingSum += value;
            shadingMax = Math.max(shadingMax, value);
            if (value > 0.5) firing++;
        }
        const [from, to] = request.keep ?? [-1, -1];
        if (frame >= from && frame <= to) kept.set(`${request.key}:${frame}`, current);
        frames.push({
            frame,
            hash: fnv(outputBytes),
            churn: previous ? meanAbs(current, previous) : 0,
            exposure,
            shadingMean: shadingSum / shading.length,
            shadingMax,
            shadingFiring: firing / shading.length,
        });
        previous = current;
    }
    held = new Set();
    await device.queue.onSubmittedWorkDone();
    return { frames };
}

/** Mean and max |a − b| of two kept frames' conditioned luma, and the share of pixels that differ. */
function compare(a: string, b: string): { mean: number; max: number; share: number } | null {
    const left = kept.get(a);
    const right = kept.get(b);
    if (!left || !right) return null;
    let total = 0;
    let max = 0;
    let pixels = 0;
    for (let index = 0; index < left.length; index++) {
        const difference = Math.abs(left[index] - right[index]);
        total += difference;
        max = Math.max(max, difference);
        if (difference > 0) pixels++;
    }
    return { mean: total / left.length, max, share: pixels / left.length };
}

(window as unknown as { __lateReadyProbe: unknown }).__lateReadyProbe = { ready: true, run, compare };
