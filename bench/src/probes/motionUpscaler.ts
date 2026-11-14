import * as THREE from 'three/webgpu';
import { mrt, output, texture, velocity } from 'three/tsl';

import { Upscaler, type RuntimeSettings } from '@pmndrs/upscaler';
import { createThreeTextureAllocator } from '@pmndrs/upscaler-three/internal/textureAllocator';
import { getGPUTexture } from '@pmndrs/upscaler-three/internal/threeWebGPU';
import {
    earthMovers,
    jensenShannon,
    MotionAnalyzer,
    RESIDUAL_DEBUG_CLASSIFY,
    RESIDUAL_DEBUG_HEAT,
    RESIDUAL_DEBUG_MOTION,
    type ResidualStats,
} from '@pmndrs/upscaler-motion';

import { createBenchScene } from '../BenchScene';
import { getBenchmarkScenario } from '../benchmark/scenarios';

/**
 * Upscaler motion probe (EXPERIMENTAL), driven by `scripts/measure-motion-upscaler.mjs`
 * over CDP: the upscaler's consumer of the motion package. The motion lab
 * itself (oracle comparisons, its own scenes) lives in `packages/motion/lab`
 * and moves with the package to pmndrs/motion-vectors.
 *
 * Renders a bench scenario through one upscale path and measures, per frame,
 * with exact GPU readback:
 *
 * - **audit** (render res): how well zero motion, three's `velocity` and
 *   camera-motion-from-depth each warp the previous *input* onto the current
 *   one. Meaningful without jitter — run it on the `native` path.
 * - **warp** (display res): the same on the upscaled *output* — temporal
 *   stability under motion ("warping error"), candidates three's velocity and
 *   camera motion.
 * - **reference**: mean |output − reference| (conditioned luma), the reference
 *   a 2×2-supersampled render: drawn at twice the display size and read with
 *   one bilinear tap at each display pixel center, which averages exactly its
 *   four samples. (A plain native render is aliased, so it would reward the
 *   paths that anti-alias least.)
 * - **cut**: Jensen–Shannon / earth mover's distance between consecutive
 *   input luma histograms; optionally resets history on the latter (`reset: 'auto'`).
 *
 * `velocity: 'camera'` feeds the upscaler camera motion derived from depth
 * instead of three's velocity buffer.
 */

type LabPath = 'native' | 'bilinear' | 'spatial' | 'temporal';
type LabView = 'output' | 'audit' | 'warp' | 'audit-heat' | 'warp-heat' | 'audit-motion' | 'warp-motion';

interface LabRequest {
    scenario: string;
    /** Last frame simulated; frames from `start` on are measured. */
    end: number;
    start?: number;
    path?: LabPath;
    ratio?: number;
    width?: number;
    height?: number;
    velocity?: 'engine' | 'camera';
    reset?: 'scenario' | 'none' | 'auto';
    /** Earth mover's distance (bins) above which `reset: 'auto'` resets history. */
    autoResetThreshold?: number;
    view?: LabView;
    /** Candidate shown by the heat / motion views (0 zero, 1 engine, 2 camera). */
    heatCandidate?: number;
    reference?: boolean;
    settings?: Partial<RuntimeSettings>;
}

interface FrameRecord {
    frame: number;
    audit: ResidualStats | null;
    warp: ResidualStats | null;
    reference: number | null;
    cutJS: number | null;
    cutEMD: number | null;
    reset: boolean;
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

// three's velocity node rolls its *camera* history once per NodeFrame frame,
// which its own requestAnimationFrame loop advances — not once per render.
// The lab renders many frames per RAF tick, so (like the bench's
// advanceAutomatedFrame) it stops that loop and advances the frame itself.
// Object history is per draw and needs none of this.
const internals = renderer as unknown as {
    _animation?: { stop(): void };
    _nodes?: { nodeFrame?: { update(): void; time: number; deltaTime: number } };
};
const nodeFrame = internals._nodes?.nodeFrame;
if (!internals._animation || typeof internals._animation.stop !== 'function' || !nodeFrame || typeof nodeFrame.update !== 'function')
    throw new Error('Pinned renderer._animation / _nodes.nodeFrame shape changed.');
internals._animation.stop();
function advanceNodeFrame(frame: number): void {
    nodeFrame!.update();
    nodeFrame!.time = (frame + 1) / 60;
    nodeFrame!.deltaTime = 1 / 60;
}

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
camera.layers.enable(1);
const bench = createBenchScene();

//* Scene State
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
    const scene =
        state.scene === 'cornell'
            ? bench.cornellScene
            : state.scene === 'sparse-wires'
              ? bench.sparseWireScene
              : state.scene === 'emitters'
                ? bench.emitterScene
                : state.scene === 'chart'
                  ? bench.chartScene
                  : bench.scene;
    scene.updateMatrixWorld(true);
    return { scene, resetHistory: state.resetHistory };
}

//* Pipeline
const analyzer = new MotionAnalyzer(device, createThreeTextureAllocator(renderer));
await analyzer.init();
const upscaler = new Upscaler({ renderer });
const mrtFull = mrt({ output, velocity });
// One stable matrix for the whole session. setProjectionMatrix() is read when
// a material's shader builds (null = the camera's own, *jittered*, projection),
// so switching it between runs leaves earlier-built materials on the old
// choice: after a native run, temporal velocity carried the jitter.
const velocityProjection = new THREE.Matrix4();
velocity.setProjectionMatrix(velocityProjection);
const quad = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false }));
const quadMaterial = quad.material as THREE.MeshBasicNodeMaterial;

let inputTarget: THREE.RenderTarget | null = null;
let referenceTarget: THREE.RenderTarget | null = null;
let configured = '';

function configure(path: LabPath, ratio: number, width: number, height: number): { renderWidth: number; renderHeight: number } {
    const key = `${path}:${ratio}:${width}x${height}`;
    if (renderer.domElement.width !== width || renderer.domElement.height !== height) renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    let renderWidth = width;
    let renderHeight = height;
    if (path !== 'native') {
        if (key !== configured)
            upscaler.configure({ displayWidth: width, displayHeight: height, customUpscaleRatio: ratio, path });
        renderWidth = upscaler.renderWidth;
        renderHeight = upscaler.renderHeight;
    }
    if (key !== configured) {
        inputTarget?.dispose();
        referenceTarget?.dispose();
        const depthTexture = new THREE.DepthTexture(renderWidth, renderHeight);
        depthTexture.type = THREE.FloatType;
        inputTarget = new THREE.RenderTarget(renderWidth, renderHeight, { count: 2, type: THREE.HalfFloatType, depthTexture });
        inputTarget.textures[0].name = 'output';
        inputTarget.textures[1].name = 'velocity';
        referenceTarget = new THREE.RenderTarget(width * 2, height * 2, { type: THREE.HalfFloatType });
        analyzer.configure(renderWidth, renderHeight);
        configured = key;
    }
    return { renderWidth, renderHeight };
}

function present(view: LabView, outputTexture: THREE.Texture, width: number, height: number, renderWidth: number, renderHeight: number): void {
    const audit = view.startsWith('audit');
    const source =
        view === 'output' ? outputTexture : analyzer.debugTexture(audit ? renderWidth : width, audit ? renderHeight : height).handle;
    quadMaterial.colorNode = texture(source);
    quadMaterial.needsUpdate = true;
    renderer.toneMapping = view === 'output' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.setRenderTarget(null);
    quad.render(renderer);
}

async function run(request: LabRequest): Promise<{ frames: FrameRecord[]; renderWidth: number; renderHeight: number }> {
    const path = request.path ?? 'temporal';
    const ratio = path === 'native' ? 1 : (request.ratio ?? 2);
    const width = request.width ?? 1280;
    const height = request.height ?? 720;
    const start = request.start ?? 0;
    const view = request.view ?? 'output';
    const resetMode = request.reset ?? 'scenario';
    const { renderWidth, renderHeight } = configure(path, ratio, width, height);
    if (path !== 'native') {
        Object.assign(upscaler.settings, { sharpness: 0.8, maxAccumulation: 24, autoExposure: true, exposure: 1, debugView: 0, ...request.settings });
        await upscaler.prepare();
        upscaler.resetHistory();
    }
    bench.resetDeterministicState();
    analyzer.reset();

    const frames: FrameRecord[] = [];
    let previousHistogram: Uint32Array | null = null;
    for (let frame = 0; frame <= request.end; frame++) {
        const { scene, resetHistory } = applyFrame(request.scenario, frame);
        advanceNodeFrame(frame);
        const measured = frame >= start;
        const temporal = path === 'temporal';
        if (temporal) upscaler.beginFrame(camera);
        const jittered = camera.projectionMatrix.clone();
        const unjittered = temporal ? upscaler.unjitteredProjectionMatrix.clone() : jittered;
        velocityProjection.copy(unjittered);
        renderer.setMRT(mrtFull);
        renderer.setRenderTarget(inputTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
        if (temporal) upscaler.endFrame(camera);

        const color = inputTarget!.textures[0];
        const engineVelocity = inputTarget!.textures[1];
        const view4 = camera.matrixWorldInverse;
        const early = device.createCommandEncoder({ label: 'motion-upscaler-early' });
        analyzer.beginFrame(early);
        analyzer.encodeCameraMotion(early, gpu(inputTarget!.depthTexture!), {
            viewProjection: new THREE.Matrix4().multiplyMatrices(unjittered, view4).elements,
            inverseViewProjectionJittered: new THREE.Matrix4().multiplyMatrices(jittered, view4).invert().elements,
            view: view4.elements,
        });
        analyzer.encodeHistogram(early, 0, gpu(color));
        device.queue.submit([early.finish()]);

        //* Cut Detection
        let cutJS: number | null = null;
        let cutEMD: number | null = null;
        let reset = resetMode === 'scenario' && resetHistory;
        if (measured || resetMode === 'auto') {
            const histogram = (await analyzer.readStats()).histograms[0]!;
            if (previousHistogram) {
                cutJS = jensenShannon(previousHistogram, histogram);
                cutEMD = earthMovers(previousHistogram, histogram);
                if (resetMode === 'auto' && cutEMD > (request.autoResetThreshold ?? 0.5)) reset = true;
            }
            previousHistogram = histogram;
        }
        if (reset && path !== 'native') upscaler.resetHistory();

        //* Upscale
        let outputTexture: THREE.Texture = color;
        if (path !== 'native') {
            upscaler.dispatch(
                {
                    color,
                    depth: inputTarget!.depthTexture!,
                    velocity: request.velocity === 'camera' ? analyzer.cameraMotion.handle : engineVelocity,
                    deltaTime: 1 / 60,
                },
                camera,
            );
            outputTexture = upscaler.outputTexture;
        }
        if (request.reference) {
            renderer.setRenderTarget(referenceTarget);
            renderer.render(scene, camera);
            renderer.setRenderTarget(null);
        }

        //* Analysis
        const late = device.createCommandEncoder({ label: 'motion-upscaler-late' });
        const motions = [gpu(engineVelocity), analyzer.cameraMotion.gpu];
        const previousInput = analyzer.previous('input');
        const previousOutput = analyzer.previous('output');
        const heat = { mode: RESIDUAL_DEBUG_HEAT, candidate: request.heatCandidate ?? 1 };
        const classify = { mode: RESIDUAL_DEBUG_CLASSIFY };
        const motionView = { mode: RESIDUAL_DEBUG_MOTION, candidate: request.heatCandidate ?? 1 };
        if (previousInput)
            analyzer.encodeResidual(late, {
                slot: 0,
                current: gpu(color),
                previous: previousInput,
                motions,
                debug: view === 'audit' ? classify : view === 'audit-heat' ? heat : view === 'audit-motion' ? motionView : undefined,
            });
        if (previousOutput)
            analyzer.encodeResidual(late, {
                slot: 1,
                current: gpu(outputTexture),
                previous: previousOutput,
                motions,
                debug: view === 'warp' ? classify : view === 'warp-heat' ? heat : view === 'warp-motion' ? motionView : undefined,
            });
        if (request.reference)
            analyzer.encodeResidual(late, {
                slot: 2,
                current: gpu(outputTexture),
                previous: gpu(referenceTarget!.textures[0]),
                depthTest: false,
            });
        analyzer.encodeSnapshot(late, 'input', gpu(color));
        analyzer.encodeSnapshot(late, 'output', gpu(outputTexture));
        analyzer.endFrame();
        device.queue.submit([late.finish()]);
        present(view, outputTexture, width, height, renderWidth, renderHeight);

        if (!measured) continue;
        const stats = await analyzer.readStats();
        frames.push({
            frame,
            audit: stats.residuals[0],
            warp: stats.residuals[1],
            reference: stats.residuals[2]?.candidates[0].meanResidual ?? null,
            cutJS,
            cutEMD,
            reset,
        });
    }
    await device.queue.onSubmittedWorkDone();
    return { frames, renderWidth, renderHeight };
}

(window as unknown as { __motionLab: unknown }).__motionLab = { ready: true, run };
