import * as THREE from 'three/webgpu';
import { mrt, output, velocity } from 'three/tsl';

import { Upscaler } from '@pmndrs/upscaler';
import { getGPUTexture } from '@pmndrs/upscaler-three/internal/threeWebGPU';
import { MotionFromDepthPass } from '@pmndrs/motion-vectors/three';

import { createBenchScene } from '../BenchScene';
import { getBenchmarkScenario } from '../benchmark/scenarios';

/**
 * GPU reset-signal probe (issue #102), driven by `scripts/measure-reset-signal.mjs`
 * over CDP. Renders a bench scenario (Q10: a camera cut at frame 60) through
 * the temporal path and reads the output back exactly, per frame, under one
 * reset mode:
 *
 * - `none`: history is never reset (the cut ghosts).
 * - `scripted`: `dispatch({ reset: true })` on the scenario's reset frames.
 * - `gpu`: `dispatch({ resetTexture: cutFlag })` every frame — the flag of
 *   `@pmndrs/motion-vectors`' GPU cut detector, consumed with no readback.
 * - `zero`: `resetTexture` bound to an explicit all-zero 1×1 texture.
 *
 * Every mode runs the same motion-from-depth + cut detector work, so only the
 * upscaler's inputs differ. `gpu` must equal `scripted` byte for byte when the
 * detector fires on exactly the scripted frames, and `zero` must equal `none`.
 */

type ResetMode = 'none' | 'scripted' | 'gpu' | 'zero';

interface ProbeRequest {
    scenario: string;
    end: number;
    mode: ResetMode;
    ratio?: number;
    width?: number;
    height?: number;
    /** Frames whose output luma is kept for {@link compare}. */
    keep?: [number, number];
    /** Name the kept frames are stored under (default: the mode). */
    key?: string;
    /**
     * `temporal` (default): one dispatch(). `split`: dispatchGuides() with the
     * reset inputs, then dispatchUpscale() without them (the late stage must
     * inherit them). `guides`: the guides-only path; the hash is the
     * disocclusion guide's.
     */
    path?: 'temporal' | 'split' | 'guides';
    /** Record per-pass GPU times (ms) per frame. */
    timing?: boolean;
}

interface FrameRecord {
    frame: number;
    /** FNV-1a over the rgba16float output bytes (the disocclusion guide's on the guides path). */
    hash: string;
    /** The scenario asked for a reset this frame. */
    scripted: boolean;
    /** The detector's verdict (read back after the frame, for reporting only). */
    cut: boolean;
    share: number;
    /** Mean of the published disocclusion guide (r) this frame. */
    disocclusion: number;
    /** Per-pass GPU ms of the latest timed frame (with `timing`). */
    timings?: Record<string, number>;
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

// three's velocity node rolls its camera history once per NodeFrame frame,
// which its own requestAnimationFrame loop advances. The probe renders many
// frames per tick, so it stops that loop and advances the frame itself.
const internals = renderer as unknown as {
    _animation?: { start(): void; stop(): void };
    _nodes?: { nodeFrame?: { update(): void; time: number; deltaTime: number } };
};
const nodeFrame = internals._nodes?.nodeFrame;
if (!internals._animation || typeof internals._animation.start !== 'function' || !nodeFrame)
    throw new Error('Pinned renderer._animation / _nodes.nodeFrame shape changed.');
internals._animation.stop();
// r187 restarts the loop from every render()/compute() (three#35278): pin it off.
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
    bench.scene.updateMatrixWorld(true);
    return { scene: bench.scene, resetHistory: state.resetHistory };
}

//* Pipeline
const upscaler = new Upscaler({ renderer });
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);
const depthMotion = new MotionFromDepthPass(renderer);
await depthMotion.init();
const zeroFlag = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
zeroFlag.needsUpdate = true;
// A texture three never sampled has no GPU allocation until initialized.
renderer.initTexture(zeroFlag);
const mrtFull = mrt({ output, velocity });
let target: THREE.RenderTarget | null = null;
let configured = '';
const kept = new Map<string, Float32Array>();

function configure(ratio: number, width: number, height: number, path: 'temporal' | 'guides'): void {
    const key = `${ratio}:${width}x${height}:${path}`;
    if (key === configured) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    upscaler.configure({ displayWidth: width, displayHeight: height, customUpscaleRatio: ratio, path });
    target?.dispose();
    const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
    depthTexture.type = THREE.FloatType;
    // MRT routes by texture name; the attachment count must match the MRT's.
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

// rgba16float → luma per pixel (for mean-abs comparisons between modes).
function luma(bytes: ArrayBuffer): Float32Array {
    const halves = new Uint16Array(bytes);
    const out = new Float32Array(halves.length / 4);
    const half = (h: number) => THREE.DataUtils.fromHalfFloat(h);
    for (let index = 0; index < out.length; index++) {
        const r = half(halves[index * 4]);
        const g = half(halves[index * 4 + 1]);
        const b = half(halves[index * 4 + 2]);
        // The conditioned domain the bench meters use, so HDR peaks don't dominate.
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        out[index] = y / (1 + y);
    }
    return out;
}

async function run(request: ProbeRequest): Promise<{ frames: FrameRecord[] }> {
    const ratio = request.ratio ?? 2;
    const path = request.path ?? 'temporal';
    configure(ratio, request.width ?? 1280, request.height ?? 720, path === 'guides' ? 'guides' : 'temporal');
    Object.assign(upscaler.settings, { sharpness: 0.8, maxAccumulation: 24, autoExposure: true, exposure: 1, debugView: 0 });
    upscaler.gpuTiming = request.timing ?? false;
    await upscaler.prepare();
    upscaler.resetHistory();
    bench.resetDeterministicState();
    depthMotion.reset();

    const frames: FrameRecord[] = [];
    for (let frame = 0; frame <= request.end; frame++) {
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
        // While the camera still holds the jittered projection it rendered with.
        depthMotion.update({
            depth: target!.depthTexture!,
            camera,
            projectionMatrix: upscaler.unjitteredProjectionMatrix,
            motions: [target!.textures[1]],
        });
        upscaler.endFrame(camera);

        const reset = request.mode === 'scripted' && resetHistory;
        const resetTexture = request.mode === 'gpu' ? depthMotion.cutFlag! : request.mode === 'zero' ? zeroFlag : undefined;
        const geometry = { depth: target!.depthTexture!, velocity: target!.textures[1] };
        if (path === 'temporal') {
            upscaler.dispatch({ color: target!.textures[0], ...geometry, reset, resetTexture, deltaTime: 1 / 60 }, camera);
        } else {
            upscaler.dispatchGuides({ ...geometry, reset, resetTexture, deltaTime: 1 / 60 }, camera);
            if (path === 'split') upscaler.dispatchUpscale({ color: target!.textures[0], deltaTime: 1 / 60 }, camera);
        }

        const maskBytes = await readTexture(gpu(upscaler.guides.disocclusion), 4);
        const outputBytes = path === 'guides' ? maskBytes : await readTexture(gpu(upscaler.outputTexture), 8);
        const masks = new Uint8Array(maskBytes);
        let disocclusion = 0;
        for (let index = 0; index < masks.length; index += 4) disocclusion += masks[index];
        const cut = await depthMotion.readCut();
        const [from, to] = request.keep ?? [-1, -1];
        if (path !== 'guides' && frame >= from && frame <= to) kept.set(`${request.key ?? request.mode}:${frame}`, luma(outputBytes));
        frames.push({
            frame,
            hash: fnv(outputBytes),
            scripted: resetHistory,
            cut: cut.hasPrevious && cut.cut,
            share: cut.share,
            disocclusion: disocclusion / (255 * (masks.length / 4)),
            timings: request.timing ? Object.fromEntries(upscaler.gpuTimings) : undefined,
        });
    }
    await device.queue.onSubmittedWorkDone();
    return { frames };
}

/** Mean and max |a − b| of two kept frames' conditioned luma, and the pixels that differ. */
function compare(a: string, b: string): { mean: number; max: number; pixels: number } | null {
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
    return { mean: total / left.length, max, pixels };
}

(window as unknown as { __resetProbe: unknown }).__resetProbe = { ready: true, run, compare };
