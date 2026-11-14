import * as THREE from 'three/webgpu';
import { mrt, output, texture, velocity } from 'three/tsl';

import {
    earthMovers,
    jensenShannon,
    MotionAnalyzer,
    RESIDUAL_DEBUG_CLASSIFY,
    RESIDUAL_DEBUG_HEAT,
    RESIDUAL_DEBUG_MOTION,
    type CompareObjectStats,
    type ResidualStats,
} from '../../src/index';
import { Oracle, ORACLE_OUTPUT } from './oracle';
import { createCases } from './scenes/cases';
import { FPS, type LabScene, type SceneFactory } from './scenes/common';
import { createCourtyard } from './scenes/courtyard';
import { createDeformers } from './scenes/deformers';
import { createWater } from './scenes/water';
import { createThreeTextureAllocator, getGPUTexture } from './three';

/**
 * Motion lab (EXPERIMENTAL), driven by `packages/motion/scripts/measure-motion.mjs`
 * over CDP. Renders one of the lab's own scenes and measures, per frame, with
 * exact GPU readback:
 *
 * - **compare**: endpoint error (render pixels) of zero motion, three's
 *   `velocity` and camera motion from depth against the scene's oracle, per
 *   object. Exact: oracle and candidates describe the same rasterized point.
 * - **audit**: how well each candidate (and the oracle) warps the previous
 *   image onto the current one. The only measure of shading motion (water).
 * - **cut**: Jensen–Shannon / earth mover's distance between consecutive luma
 *   histograms, next to the scene's own cut truth.
 *
 * Knobs reproduce three's failure modes: `jitter` (Halton sub-pixel offsets,
 * optionally from a later frame), `velocityProjection: 'trap'` (materials built
 * before jitter starts keep the jittered projection) and `rendersPerTick`
 * (several renders per animation-loop tick).
 */

const SCENES: Record<string, SceneFactory> = {
    deformers: createDeformers,
    cases: createCases,
    water: createWater,
    track: createCourtyard('track'),
    cuts: createCourtyard('cuts'),
};

type LabView = 'output' | 'audit' | 'audit-heat' | 'audit-motion';

interface LabRequest {
    scene: string;
    /** Last frame (default: the scene's timeline end); frames from `start` on are measured. */
    end?: number;
    start?: number;
    width?: number;
    height?: number;
    /** Deformers subset (default: all). */
    objects?: string[];
    /** Halton jitter: off (default), on, or on from this frame. */
    jitter?: boolean | number;
    /**
     * `stable` (default): three's velocity gets one unjittered matrix before any
     * material builds. `trap`: a freshly built scene renders its first frames with
     * `setProjectionMatrix(null)`, then switches when jitter starts — what an app
     * that turns TAA or an upscaler on at runtime does.
     */
    velocityProjection?: 'stable' | 'trap';
    /** Rebuild the scene (new materials, new shader builds) before running. */
    fresh?: boolean;
    /** Renders per animation-loop tick (three advances its camera history once per tick). Default 1. */
    rendersPerTick?: number;
    view?: LabView;
    /** Candidate shown by the heat / motion views (0 zero, 1 three, 2 camera, 3 oracle). */
    heatCandidate?: number;
}

interface FrameRecord {
    frame: number;
    segment: string;
    cut: boolean;
    jittered: boolean;
    /** Per object name: oracle comparison; candidates zero, three, camera. */
    compare: Record<string, CompareObjectStats>;
    /** Warp audit; candidates zero, three, camera, oracle. */
    audit: ResidualStats | null;
    cutJS: number | null;
    cutEMD: number | null;
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
const gpu = (target: THREE.Texture) => getGPUTexture(renderer, target);

// three's velocity node rolls its *camera* history once per NodeFrame frame,
// which its own requestAnimationFrame loop advances, not once per render. The
// lab stops that loop and advances the frame itself (rendersPerTick models
// apps that render several times per tick).
const internals = renderer as unknown as {
    _animation?: { stop(): void };
    _nodes?: { nodeFrame?: { update(): void; time: number; deltaTime: number } };
};
const nodeFrame = internals._nodes?.nodeFrame;
if (!internals._animation || typeof internals._animation.stop !== 'function' || !nodeFrame || typeof nodeFrame.update !== 'function')
    throw new Error('Pinned renderer._animation / _nodes.nodeFrame shape changed.');
internals._animation.stop();

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
const analyzer = new MotionAnalyzer(device, createThreeTextureAllocator(renderer));
await analyzer.init();

// One stable matrix for the session (see `velocityProjection`).
const velocityProjection = new THREE.Matrix4();
velocity.setProjectionMatrix(velocityProjection);

const quad = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false }));
const quadMaterial = quad.material as THREE.MeshBasicNodeMaterial;

//* Scenes
interface LoadedScene {
    lab: LabScene;
    oracle: Oracle;
    mrt: ReturnType<typeof mrt>;
}
const loaded = new Map<string, LoadedScene>();
/**
 * The cached instance of a scene, or a new one. `throwaway` instances are not
 * cached: their materials build under the trap's projection and stay that way.
 */
function load(name: string, fresh: boolean, throwaway: boolean): LoadedScene {
    const factory = SCENES[name];
    if (!factory) throw new Error(`Unknown lab scene "${name}" (${Object.keys(SCENES).join(', ')}).`);
    let entry = throwaway ? undefined : loaded.get(name);
    if (!entry || fresh) {
        const oracle = new Oracle();
        entry = { lab: factory(oracle), oracle, mrt: mrt({ output, velocity, [ORACLE_OUTPUT]: oracle.staticNode }) };
        if (!throwaway) loaded.set(name, entry);
    }
    return entry;
}

//* Targets
let target: THREE.RenderTarget | null = null;
function configure(width: number, height: number): void {
    if (target && target.width === width && target.height === height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    target?.dispose();
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.type = THREE.FloatType;
    target = new THREE.RenderTarget(width, height, { count: 3, type: THREE.HalfFloatType, depthTexture });
    // MRT routes outputs to attachments by texture name.
    target.textures[0].name = 'output';
    target.textures[1].name = 'velocity';
    target.textures[2].name = ORACLE_OUTPUT;
    analyzer.configure(width, height);
}

//* Jitter
function halton(index: number, base: number): number {
    let result = 0;
    let fraction = 1 / base;
    for (let i = index; i > 0; i = Math.floor(i / base), fraction /= base) result += fraction * (i % base);
    return result;
}
/** Offsets the projection by a sub-pixel Halton(2, 3) step (8 phases). */
function applyJitter(frame: number, width: number, height: number): void {
    const phase = (frame % 8) + 1;
    const x = halton(phase, 2) - 0.5;
    const y = halton(phase, 3) - 0.5;
    camera.projectionMatrix.elements[8] += (2 * x) / width;
    camera.projectionMatrix.elements[9] += (2 * y) / height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function present(view: LabView, color: THREE.Texture, width: number, height: number): void {
    quadMaterial.colorNode = texture(view === 'output' ? color : analyzer.debugTexture(width, height).handle);
    quadMaterial.needsUpdate = true;
    renderer.toneMapping = view === 'output' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.setRenderTarget(null);
    quad.render(renderer);
}

async function run(request: LabRequest): Promise<{ frames: FrameRecord[]; objects: Record<number, string>; segments: unknown }> {
    const width = request.width ?? 1280;
    const height = request.height ?? 720;
    const trap = request.velocityProjection === 'trap';
    const { lab, oracle, mrt: sceneMrt } = load(request.scene, request.fresh === true, trap);
    const end = request.end ?? lab.end;
    const start = request.start ?? 1;
    const view = request.view ?? 'output';
    const jitterFrom = request.jitter === true ? 0 : typeof request.jitter === 'number' ? request.jitter : Infinity;
    const rendersPerTick = Math.max(1, Math.round(request.rendersPerTick ?? 1));
    configure(width, height);
    lab.select?.(request.objects);
    analyzer.reset();
    oracle.reset();
    if (trap) velocity.setProjectionMatrix(null);

    const frames: FrameRecord[] = [];
    let previousHistogram: Uint32Array | null = null;
    try {
        for (let frame = 0; frame <= end; frame++) {
            //* Scene State
            const truth = lab.update(frame, camera);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);
            lab.scene.updateMatrixWorld(true);
            const unjittered = camera.projectionMatrix.clone();
            const jittered = frame >= jitterFrom;
            if (jittered) {
                if (trap && frame === jitterFrom) velocity.setProjectionMatrix(velocityProjection);
                applyJitter(frame, width, height);
            }
            velocityProjection.copy(unjittered);
            const view4 = camera.matrixWorldInverse;
            oracle.beginFrame(new THREE.Matrix4().multiplyMatrices(unjittered, view4), frame / FPS);
            if (frame % rendersPerTick === 0) {
                nodeFrame!.update();
                nodeFrame!.time = (frame + 1) / FPS;
                nodeFrame!.deltaTime = rendersPerTick / FPS;
            }

            //* Render
            renderer.setMRT(sceneMrt);
            renderer.setRenderTarget(target);
            renderer.render(lab.scene, camera);
            renderer.setRenderTarget(null);
            renderer.setMRT(null);

            const [color, engine, oracleTexture] = target!.textures;
            const early = device.createCommandEncoder({ label: 'motion-lab-early' });
            analyzer.beginFrame(early);
            analyzer.encodeCameraMotion(early, gpu(target!.depthTexture!), {
                viewProjection: new THREE.Matrix4().multiplyMatrices(unjittered, view4).elements,
                inverseViewProjectionJittered: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view4).invert().elements,
                view: view4.elements,
            });
            analyzer.encodeHistogram(early, 0, gpu(color));
            device.queue.submit([early.finish()]);

            //* Cut Distances
            const measured = frame >= start;
            let cutJS: number | null = null;
            let cutEMD: number | null = null;
            if (measured || frame === start - 1) {
                const histogram = (await analyzer.readStats()).histograms[0]!;
                if (previousHistogram) {
                    cutJS = jensenShannon(previousHistogram, histogram);
                    cutEMD = earthMovers(previousHistogram, histogram);
                }
                previousHistogram = histogram;
            }

            //* Analysis
            const late = device.createCommandEncoder({ label: 'motion-lab-late' });
            const motions = [gpu(engine), analyzer.cameraMotion.gpu];
            analyzer.encodeCompare(late, gpu(oracleTexture), motions);
            const previousInput = analyzer.previous('input');
            const candidate = request.heatCandidate ?? 1;
            const debug =
                view === 'audit'
                    ? { mode: RESIDUAL_DEBUG_CLASSIFY }
                    : view === 'audit-heat'
                      ? { mode: RESIDUAL_DEBUG_HEAT, candidate }
                      : view === 'audit-motion'
                        ? { mode: RESIDUAL_DEBUG_MOTION, candidate }
                        : undefined;
            if (previousInput)
                analyzer.encodeResidual(late, { slot: 0, current: gpu(color), previous: previousInput, motions: [...motions, gpu(oracleTexture)], debug });
            analyzer.encodeSnapshot(late, 'input', gpu(color));
            analyzer.endFrame();
            device.queue.submit([late.finish()]);
            present(view, color, width, height);

            if (!measured) continue;
            const stats = await analyzer.readStats();
            const compare: Record<string, CompareObjectStats> = {};
            for (const [id, objectStats] of (stats.compare ?? []).entries())
                if (objectStats.valid + objectStats.noPrevious > 0) compare[lab.objects[id] ?? `id-${id}`] = objectStats;
            frames.push({ frame, segment: truth.segment, cut: truth.cut, jittered, compare, audit: stats.residuals[0], cutJS, cutEMD });
        }
    } finally {
        if (trap) velocity.setProjectionMatrix(velocityProjection);
    }
    await device.queue.onSubmittedWorkDone();
    return { frames, objects: lab.objects, segments: lab.segments };
}

(window as unknown as { __motionLab: unknown }).__motionLab = { ready: true, scenes: Object.keys(SCENES), run };
