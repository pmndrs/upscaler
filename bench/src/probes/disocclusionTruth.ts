import * as THREE from 'three/webgpu';
import {
    float,
    instanceIndex,
    mrt,
    output,
    positionWorld,
    texture,
    uniform,
    varying,
    vec4,
    velocity,
} from 'three/tsl';

import { Upscaler } from '@pmndrs/upscaler';
import { getGPUTexture } from '@pmndrs/upscaler-three/internal/threeWebGPU';
import { RECONSTRUCT_CROSS_FRAME_SHADER } from '@pmndrs/upscaler-core/shaders/reconstructVariants';

import { createBenchScene } from '../BenchScene';
import { getBenchmarkScenario } from '../benchmark/scenarios';

/**
 * Exact ground-truth disocclusion probe (issue #102), driven by
 * `scripts/measure-disocclusion-truth.mjs` over CDP. Scores the published
 * `disocclusion` guide against a rasterized ground truth, per frame, and
 * (optionally) the upscaled output's error against a 2×2-supersampled
 * reference split by the same classes.
 *
 * Ground truth (no BVH: the rasterizer is the ray caster). Every frame, while
 * the camera still holds this frame's jittered projection, the scene renders
 * twice more with swapped materials:
 * - an **id buffer** at render resolution: rgba32float (object id, world
 *   position of the surface sampled at the pixel centre) — the exact point the
 *   upscaler's input sampled at that pixel;
 * - the same buffer supersampled `gtScale`× (the t−1 visibility lookup).
 * A pixel's point P (frame t) moves to t−1 through its object's matrixWorld
 * change (rigid objects; instance matrices are static in every scene scored),
 * and projects through the t−1 *jittered* view-projection — the raster the t−1
 * buffers hold. It is truly disoccluded when that position is off-screen, or
 * when P was not the first surface along the t−1 eye ray: none of the 2×2
 * supersampled taps around the reprojection is sky, lies at or behind P along
 * the ray (`RAY_EPSILON` relative), or is P's own surface (same object id,
 * within two of that surface's own sample spacings of P — a facet edge or a
 * grazing slope puts a same-surface tap slightly in front). "Any of 2×2"
 * makes the test exact for a straight edge up to 1/gtScale render px (the
 * point lies inside the four texel centres' hull, so a half-plane holding all
 * four holds it too); finer than that, which side of a silhouette a point
 * falls on is sub-pixel ambiguous anyway. A first, tangent-plane form of the
 * same-surface test failed on finely tessellated convex objects (a facet
 * narrower than a tap: the neighbouring facets' planes all pass in front of P)
 * and is not used.
 *
 * Jitter: the scored frame is jittered, so the ground truth uses the same
 * jittered rasterization for both frames. The id buffer then holds exactly
 * the surfaces the depth clip saw, pixel for pixel, and the t−1 buffers hold
 * exactly what t−1's history was built from. An unjittered truth would score
 * the mask against points the upscaler never sampled.
 *
 * Classes follow #102: receivers (not sky) only, reset frames skipped.
 * **Interior** = every 3×3 neighbour is a receiver with the same truth;
 * **band** = the remaining receivers (the 1–2 px silhouette strip).
 * **Wrong-surface** = truly disoccluded, on-screen, and no texel of the same
 * object (id incl. instance) in the 3×3 of t−1's id buffer around the true
 * reprojection — history kept there is another surface's. Off-screen
 * reprojections count as disoccluded and are reported separately.
 *
 * The mask is read back exactly (rgba8unorm `.r`) and thresholded at > 0,
 * ≥ 0.25, ≥ 0.5 and ≥ 0.75 (bytes 1, 64, 128, 192).
 */

type Variant = 'production' | 'reconstruct-cross-frame-v1';

interface TruthRequest {
    /** Bench scenario id, or `slide` (validation: one quad sliding over a wall, still camera). */
    scenario: string;
    /** First scored frame (the frame before it is rendered for its t−1 buffers). */
    start: number;
    end: number;
    variant?: Variant;
    ratio?: number;
    width?: number;
    height?: number;
    /** Supersampling of the t−1 visibility lookup (render px / gtScale is the truth's edge precision). */
    gtScale?: number;
    /** Also score the output against a 2×2-supersampled reference, per class. */
    error?: boolean;
    /** Frames returned as class-colour images (`takeSnapshot`). */
    snapshots?: number[];
    /** `slide`: the quad's speed in render px/frame. */
    slideSpeed?: number;
}

/** Mask thresholds as rgba8unorm bytes: > 0, ≥ 0.25, ≥ 0.5, ≥ 0.75. */
const THRESHOLDS = [1, 64, 128, 192] as const;
/** Relative distance along the t−1 ray a tap must be in front of P to occlude it. */

const RAY_EPSILON = 5e-4;
/** Instances per object id (id = object · 1024 + instance). */
const INSTANCE_STRIDE = 1024;
const NEIGHBOURS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
] as const;

/**
 * Output-error classes (display px → the render px it lies in). "Flagged"
 * and "caught" are the mask at ≥ 0.5.
 */
const ERROR_CLASSES = [
    'interior-stable',
    'interior-stable-flagged',
    'band-stable',
    'band-stable-flagged',
    'revealed-caught',
    'revealed-missed',
    'wrong-surface-caught',
    'wrong-surface-missed',
    'off-screen',
] as const;

interface ClassErrors {
    count: number;
    /** Sum of |c(out) − c(ref)|, c = conditioned luma l / (1 + l). */
    sum: number;
    /** Pixels with |Δc| > 0.05 (visible-scale error). */
    over: number;
}

interface FrameCounts {
    frame: number;
    receivers: number;
    positives: number;
    offScreen: number;
    wrongSurface: number;
    interiorPositive: number;
    interiorNegative: number;
    bandPositive: number;
    bandNegative: number;
    /** Per threshold: flagged truly-disoccluded pixels (all classes). */
    hit: number[];
    /** Per threshold: flagged pixels that are not disoccluded. */
    falseAlarm: number[];
    interiorHit: number[];
    interiorFalse: number[];
    bandHit: number[];
    bandFalse: number[];
    wrongSurfaceHit: number[];
    offScreenHit: number[];
    /** Max / mean distance (render px) of P reprojected through this frame's own matrices to its pixel centre. */
    selfCheckMax: number;
    selfCheckMean: number;
    errors?: Record<string, ClassErrors>;
}

interface Snapshot {
    frame: number;
    width: number;
    height: number;
    /** Packed RGB8, base64. */
    rgb: string;
}

//* Renderer
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
// Nothing is presented; every target stays linear.
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();
const device = (renderer.backend as unknown as { device: GPUDevice }).device;
const gpu = (texture: THREE.Texture) => getGPUTexture(renderer, texture);

// three's velocity node rolls its camera history once per NodeFrame frame;
// the probe renders many frames per tick, so it advances the frame itself.
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

//* Validation Scene — a quad sliding over a frontal wall, still camera
const SLIDE_WALL_DISTANCE = 15;
const SLIDE_QUAD_DISTANCE = 10;
const SLIDE_QUAD_SIZE = 3;
const slideScene = new THREE.Scene();
slideScene.background = new THREE.Color(0x101418);
slideScene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2));
const slideWall = new THREE.Mesh(new THREE.PlaneGeometry(80, 50), new THREE.MeshStandardMaterial({ color: 0x8090a0 }));
slideWall.position.z = -SLIDE_WALL_DISTANCE;
const slideQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(SLIDE_QUAD_SIZE, SLIDE_QUAD_SIZE),
    new THREE.MeshStandardMaterial({ color: 0xe0a040 }),
);
slideQuad.position.z = -SLIDE_QUAD_DISTANCE;
slideScene.add(slideWall, slideQuad);

function applyFrame(request: TruthRequest, frame: number, renderHeight: number): { scene: THREE.Scene; reset: boolean } {
    if (request.scenario === 'slide') {
        camera.position.set(0, 0, 0);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 0, -1);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        // Render px per world unit at the quad's distance.
        const pxPerUnit = renderHeight / (2 * SLIDE_QUAD_DISTANCE * Math.tan((camera.fov * Math.PI) / 360));
        slideQuad.position.x = -6 + (frame * (request.slideSpeed ?? 4)) / pxPerUnit;
        slideScene.updateMatrixWorld(true);
        return { scene: slideScene, reset: false };
    }
    const definition = getBenchmarkScenario(request.scenario as BenchmarkScenarioId);
    const state = definition.frame(Math.min(frame, definition.endFrame));
    camera.position.fromArray(state.cameraPosition);
    camera.up.set(0, 1, 0);
    camera.lookAt(...state.cameraTarget);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    bench.applyFrame(state);
    const scene =
        state.scene === 'cornell'
            ? bench.cornellScene
            : state.scene === 'sparse-wires'
              ? bench.sparseWireScene
              : state.scene === 'emitters'
                ? bench.emitterScene
                : state.scene === 'hot-spots'
                  ? bench.hotSpotScene
                  : state.scene === 'chart'
                    ? bench.chartScene
                    : state.scene === 'dense'
                      ? bench.denseScene
                      : bench.scene;
    scene.updateMatrixWorld(true);
    return { scene, reset: state.resetHistory };
}

//* Ground-Truth Materials
// One uniform for every draw, set per object from userData.gtId.
const objectId = uniform(0).onObjectUpdate(({ object }) => (object?.userData.gtId as number | undefined) ?? 0);
const gtMaterials = new Map<string, THREE.MeshBasicNodeMaterial>();
function gtMaterial(side: THREE.Side): THREE.MeshBasicNodeMaterial {
    const key = String(side);
    let material = gtMaterials.get(key);
    if (material) return material;
    material = new THREE.MeshBasicNodeMaterial({ side, fog: false });
    const id = objectId.mul(INSTANCE_STRIDE).add(varying(float(instanceIndex)));
    material.fragmentNode = vec4(id, positionWorld);
    gtMaterials.set(key, material);
    return material;
}

let nextObjectId = 1;
/** Ensures every mesh carries a unique id; returns this frame's drawn meshes. */
function drawnMeshes(scene: THREE.Scene): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    scene.traverseVisible((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.userData.gtId === undefined) mesh.userData.gtId = nextObjectId++;
        meshes.push(mesh);
    });
    return meshes;
}

/** Renders the scene with ground-truth materials into `target`, restoring everything after. */
function renderTruth(scene: THREE.Scene, meshes: THREE.Mesh[], target: THREE.RenderTarget): void {
    const saved = meshes.map((mesh) => [mesh, mesh.material, mesh.visible] as const);
    for (const mesh of meshes) {
        const material = mesh.material as THREE.Material;
        // Depth-less transparents never reach the upscaler's depth: not surfaces.
        if (material.transparent && !material.depthWrite) mesh.visible = false;
        else mesh.material = gtMaterial(material.side);
    }
    const background = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.background = background;
    scene.fog = fog;
    for (const [mesh, material, visible] of saved) {
        mesh.material = material;
        mesh.visible = visible;
    }
}

//* Pipeline
const velocityProjection = new THREE.Matrix4();
velocity.setProjectionMatrix(velocityProjection);
const mrtFull = mrt({ output, velocity });
let upscaler: Upscaler | null = null;
let upscalerVariant = '';
let configured = '';
let inputTarget: THREE.RenderTarget | null = null;
let idTarget: THREE.RenderTarget | null = null;
let sampleTarget: THREE.RenderTarget | null = null;
let referenceTarget: THREE.RenderTarget | null = null;
let referenceDown: THREE.RenderTarget | null = null;
const downsampleMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
const downsampleQuad = new THREE.QuadMesh(downsampleMaterial);

function upscalerFor(variant: Variant): Upscaler {
    if (upscaler && upscalerVariant === variant) return upscaler;
    upscaler?.dispose();
    upscaler = new Upscaler({
        renderer,
        ...(variant === 'reconstruct-cross-frame-v1'
            ? { _crossFrameReconstruct: { shader: RECONSTRUCT_CROSS_FRAME_SHADER, cameraCompensated: false } }
            : {}),
    } as ConstructorParameters<typeof Upscaler>[0]);
    upscalerVariant = variant;
    configured = '';
    return upscaler;
}

function configure(request: TruthRequest): { width: number; height: number; renderWidth: number; renderHeight: number; scale: number } {
    const variant = request.variant ?? 'production';
    const width = request.width ?? 1920;
    const height = request.height ?? 1080;
    const ratio = request.ratio ?? 2;
    const scale = request.gtScale ?? 4;
    const instance = upscalerFor(variant);
    const key = `${variant}:${ratio}:${width}x${height}:${scale}`;
    if (key !== configured) {
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        instance.configure({ displayWidth: width, displayHeight: height, customUpscaleRatio: ratio, path: 'temporal' });
        const renderWidth = instance.renderWidth;
        const renderHeight = instance.renderHeight;
        for (const target of [inputTarget, idTarget, sampleTarget, referenceTarget, referenceDown]) target?.dispose();
        const depthTexture = new THREE.DepthTexture(renderWidth, renderHeight);
        depthTexture.type = THREE.FloatType;
        // MRT routes by texture name; the attachment count must match the MRT's.
        inputTarget = new THREE.RenderTarget(renderWidth, renderHeight, { count: 2, type: THREE.HalfFloatType, depthTexture });
        inputTarget.textures[0].name = 'output';
        inputTarget.textures[1].name = 'velocity';
        const float = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
        idTarget = new THREE.RenderTarget(renderWidth, renderHeight, float);
        sampleTarget = new THREE.RenderTarget(renderWidth * scale, renderHeight * scale, float);
        referenceTarget = new THREE.RenderTarget(width * 2, height * 2, { type: THREE.HalfFloatType });
        referenceDown = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType });
        downsampleMaterial.colorNode = texture(referenceTarget.texture);
        downsampleMaterial.needsUpdate = true;
        configured = key;
    }
    return { width, height, renderWidth: instance.renderWidth, renderHeight: instance.renderHeight, scale };
}

//* Readback
async function readTextures(textures: { texture: GPUTexture; bytesPerTexel: number }[]): Promise<ArrayBuffer[]> {
    const encoder = device.createCommandEncoder({ label: 'disocclusion-truth-readback' });
    const buffers = textures.map(({ texture, bytesPerTexel }) => {
        const bytesPerRow = Math.ceil((texture.width * bytesPerTexel) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: texture.width, height: texture.height });
        return { buffer, bytesPerRow, rowBytes: texture.width * bytesPerTexel, rows: texture.height };
    });
    device.queue.submit([encoder.finish()]);
    return Promise.all(
        buffers.map(async ({ buffer, bytesPerRow, rowBytes, rows }) => {
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const packed = new Uint8Array(rowBytes * rows);
            if (bytesPerRow === rowBytes) packed.set(mapped.subarray(0, rowBytes * rows));
            else for (let y = 0; y < rows; y++) packed.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
            buffer.unmap();
            buffer.destroy();
            return packed.buffer;
        }),
    );
}

const HALF = (() => {
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) table[h] = THREE.DataUtils.fromHalfFloat(h);
    return table;
})();

/** rgba16float → conditioned luma l / (1 + l) per texel. */
function conditionedLuma(bytes: ArrayBuffer): Float32Array {
    const halves = new Uint16Array(bytes);
    const out = new Float32Array(halves.length / 4);
    for (let index = 0; index < out.length; index++) {
        const r = Math.max(HALF[halves[index * 4]], 0);
        const g = Math.max(HALF[halves[index * 4 + 1]], 0);
        const b = Math.max(HALF[halves[index * 4 + 2]], 0);
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        out[index] = y / (1 + y);
    }
    return out;
}

//* Per-Frame Truth State
interface TruthFrame {
    /** rgba32float (id, P) at render res. */
    ids: Float32Array;
    /** rgba32float (id, P) at gtScale× render res. */
    samples: Float32Array;
    /** gtId → matrixWorld. */
    matrices: Map<number, THREE.Matrix4>;
    viewProjection: THREE.Matrix4;
    eye: THREE.Vector3;
}

const snapshots: Snapshot[] = [];

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
}

/**
 * Scores one frame. Returns the per-pixel class (for the output-error split
 * and snapshots) alongside the counts.
 */
function score(
    frame: number,
    current: TruthFrame,
    previous: TruthFrame,
    mask: Uint8Array,
    renderWidth: number,
    renderHeight: number,
    scale: number,
): { counts: FrameCounts; truth: Uint8Array; wrong: Uint8Array; offScreen: Uint8Array; receiver: Uint8Array; interior: Uint8Array } {
    const W = renderWidth;
    const H = renderHeight;
    const pixels = W * H;
    const receiver = new Uint8Array(pixels);
    const truth = new Uint8Array(pixels);
    const wrong = new Uint8Array(pixels);
    const offScreen = new Uint8Array(pixels);
    const { ids } = current;
    const previousIds = previous.ids;
    const samples = previous.samples;
    const PW = W * scale;
    const PH = H * scale;

    // Per object: world(t) → world(t−1) (C) and world(t) → clip(t−1) (K).
    const transforms = new Map<number, { c: number[]; k: number[] } | null>();
    const transformFor = (object: number) => {
        let entry = transforms.get(object);
        if (entry !== undefined) return entry;
        const now = current.matrices.get(object);
        const before = previous.matrices.get(object);
        if (!now || !before) entry = null;
        else {
            const c = before.clone().multiply(now.clone().invert());
            const k = previous.viewProjection.clone().multiply(c);
            entry = { c: c.elements, k: k.elements };
        }
        transforms.set(object, entry);
        return entry;
    };
    const selfVP = current.viewProjection.elements;
    const e = previous.eye;
    let selfMax = 0;
    let selfSum = 0;
    let selfCount = 0;

    //* Truth per pixel
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const index = y * W + x;
            const id = Math.round(ids[index * 4]);
            if (id <= 0) continue;
            receiver[index] = 1;
            const px = ids[index * 4 + 1];
            const py = ids[index * 4 + 2];
            const pz = ids[index * 4 + 3];
            // Self-check: P through this frame's own (jittered) projection
            // must land on its own pixel centre.
            if ((x & 7) === 0 && (y & 7) === 0) {
                const cw = selfVP[3] * px + selfVP[7] * py + selfVP[11] * pz + selfVP[15];
                const sx = (((selfVP[0] * px + selfVP[4] * py + selfVP[8] * pz + selfVP[12]) / cw + 1) / 2) * W;
                const sy = ((1 - (selfVP[1] * px + selfVP[5] * py + selfVP[9] * pz + selfVP[13]) / cw) / 2) * H;
                const distance = Math.hypot(sx - (x + 0.5), sy - (y + 0.5));
                selfMax = Math.max(selfMax, distance);
                selfSum += distance;
                selfCount++;
            }
            const transform = transformFor(Math.floor(id / INSTANCE_STRIDE));
            if (!transform) {
                // The object did not exist last frame.
                truth[index] = 1;
                continue;
            }
            const { c, k } = transform;
            const qx = c[0] * px + c[4] * py + c[8] * pz + c[12];
            const qy = c[1] * px + c[5] * py + c[9] * pz + c[13];
            const qz = c[2] * px + c[6] * py + c[10] * pz + c[14];
            const cw = k[3] * px + k[7] * py + k[11] * pz + k[15];
            const sx = (((k[0] * px + k[4] * py + k[8] * pz + k[12]) / cw + 1) / 2) * W;
            const sy = ((1 - (k[1] * px + k[5] * py + k[9] * pz + k[13]) / cw) / 2) * H;
            // Half a texel of margin: the jitter delta alone moves a border
            // pixel's sample up to one texel, past the edge of t−1's raster,
            // while its history texel (clamped) holds the same surface.
            const margin = 0.5;
            if (!(cw > 0) || !(sx >= -margin && sx < W + margin && sy >= -margin && sy < H + margin)) {
                truth[index] = 1;
                offScreen[index] = 1;
                continue;
            }
            //* Visibility at t−1: is any 2×2 supersampled tap P' itself, or behind it?
            const ux = qx - e.x;
            const uy = qy - e.y;
            const uz = qz - e.z;
            const uLength = Math.hypot(ux, uy, uz);
            const hx = sx * scale - 0.5;
            const hy = sy * scale - 0.5;
            const bx = Math.floor(hx);
            const by = Math.floor(hy);
            let visible = false;
            for (let tap = 0; tap < 4 && !visible; tap++) {
                const tx = Math.min(Math.max(bx + (tap & 1), 0), PW - 1);
                const ty = Math.min(Math.max(by + (tap >> 1), 0), PH - 1);
                const offset = (ty * PW + tx) * 4;
                const tapId = Math.round(samples[offset]);
                // Sky: nothing in front.
                if (tapId <= 0) {
                    visible = true;
                    break;
                }
                const ax = samples[offset + 1];
                const ay = samples[offset + 2];
                const az = samples[offset + 3];
                // Not in front along the ray to P': nothing occludes P' there.
                const along = ((ax - e.x) * ux + (ay - e.y) * uy + (az - e.z) * uz) / uLength;
                if (along >= uLength * (1 - RAY_EPSILON)) {
                    visible = true;
                    break;
                }
                // The same surface, sampled a fraction of a texel away: the
                // tap lies within two sample spacings of P' on its own object
                // (a facet edge or a grazing slope puts it slightly in front).
                if (tapId !== id) continue;
                let spacing = 0;
                for (const [dx, dy] of NEIGHBOURS) {
                    const nx = tx + dx;
                    const ny = ty + dy;
                    if (nx < 0 || ny < 0 || nx >= PW || ny >= PH) continue;
                    const neighbour = (ny * PW + nx) * 4;
                    if (Math.round(samples[neighbour]) !== tapId) continue;
                    spacing = Math.max(
                        spacing,
                        Math.hypot(samples[neighbour + 1] - ax, samples[neighbour + 2] - ay, samples[neighbour + 3] - az),
                    );
                }
                if (Math.hypot(ax - qx, ay - qy, az - qz) <= 2 * spacing + RAY_EPSILON * uLength) visible = true;
            }
            if (visible) continue;
            truth[index] = 1;
            //* Wrong surface: no texel of the same object in t−1's 3×3 around the reprojection.
            const cx = Math.floor(sx);
            const cy = Math.floor(sy);
            let same = false;
            for (let dy = -1; dy <= 1 && !same; dy++)
                for (let dx = -1; dx <= 1 && !same; dx++) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    if (Math.round(previousIds[(ny * W + nx) * 4]) === id) same = true;
                }
            if (!same) wrong[index] = 1;
        }
    }

    //* Counts
    const zeros = () => THRESHOLDS.map(() => 0);
    const counts: FrameCounts = {
        frame,
        receivers: 0,
        positives: 0,
        offScreen: 0,
        wrongSurface: 0,
        interiorPositive: 0,
        interiorNegative: 0,
        bandPositive: 0,
        bandNegative: 0,
        hit: zeros(),
        falseAlarm: zeros(),
        interiorHit: zeros(),
        interiorFalse: zeros(),
        bandHit: zeros(),
        bandFalse: zeros(),
        wrongSurfaceHit: zeros(),
        offScreenHit: zeros(),
        selfCheckMax: selfMax,
        selfCheckMean: selfCount ? selfSum / selfCount : 0,
    };
    const interior = new Uint8Array(pixels);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const index = y * W + x;
            if (!receiver[index]) continue;
            let isInterior = x > 0 && y > 0 && x < W - 1 && y < H - 1;
            for (let dy = -1; dy <= 1 && isInterior; dy++)
                for (let dx = -1; dx <= 1 && isInterior; dx++) {
                    const neighbour = index + dy * W + dx;
                    if (!receiver[neighbour] || truth[neighbour] !== truth[index]) isInterior = false;
                }
            interior[index] = isInterior ? 1 : 0;
            const positive = truth[index] === 1;
            const value = mask[index * 4];
            counts.receivers++;
            if (positive) counts.positives++;
            if (offScreen[index]) counts.offScreen++;
            if (wrong[index]) counts.wrongSurface++;
            if (isInterior && positive) counts.interiorPositive++;
            else if (isInterior) counts.interiorNegative++;
            else if (positive) counts.bandPositive++;
            else counts.bandNegative++;
            for (let t = 0; t < THRESHOLDS.length; t++) {
                if (value < THRESHOLDS[t]) continue;
                if (positive) {
                    counts.hit[t]++;
                    if (isInterior) counts.interiorHit[t]++;
                    else counts.bandHit[t]++;
                    if (wrong[index]) counts.wrongSurfaceHit[t]++;
                    if (offScreen[index]) counts.offScreenHit[t]++;
                } else {
                    counts.falseAlarm[t]++;
                    if (isInterior) counts.interiorFalse[t]++;
                    else counts.bandFalse[t]++;
                }
            }
        }
    }
    return { counts, truth, wrong, offScreen, receiver, interior };
}

/** Error class index per render pixel (−1 = not scored). */
function errorClasses(
    mask: Uint8Array,
    receiver: Uint8Array,
    truth: Uint8Array,
    wrong: Uint8Array,
    offScreen: Uint8Array,
    interior: Uint8Array,
): Int8Array {
    const classes = new Int8Array(receiver.length).fill(-1);
    for (let index = 0; index < receiver.length; index++) {
        if (!receiver[index]) continue;
        const flagged = mask[index * 4] >= 128;
        if (offScreen[index]) classes[index] = 8;
        else if (wrong[index]) classes[index] = flagged ? 6 : 7;
        else if (truth[index]) classes[index] = flagged ? 4 : 5;
        else if (interior[index]) classes[index] = flagged ? 1 : 0;
        else classes[index] = flagged ? 3 : 2;
    }
    return classes;
}

function snapshot(
    frame: number,
    W: number,
    H: number,
    mask: Uint8Array,
    receiver: Uint8Array,
    truth: Uint8Array,
    wrong: Uint8Array,
    ids: Float32Array,
): Snapshot {
    // #102's figure scheme: white detected, red missed, magenta missed
    // wrong-surface, cyan false alarm; receivers dim grey (shaded by object), sky black.
    const rgb = new Uint8Array(W * H * 3);
    for (let index = 0; index < W * H; index++) {
        const flagged = mask[index * 4] >= 128;
        let color: [number, number, number] = [0, 0, 0];
        if (receiver[index]) {
            const shade = 40 + ((Math.round(ids[index * 4]) * 37) % 40);
            color = [shade, shade, shade];
            if (truth[index]) color = flagged ? [255, 255, 255] : wrong[index] ? [255, 0, 255] : [255, 40, 40];
            else if (flagged) color = [0, 220, 255];
        }
        rgb.set(color, index * 3);
    }
    return { frame, width: W, height: H, rgb: encodeBase64(rgb) };
}

async function run(request: TruthRequest): Promise<{ frames: FrameCounts[]; renderWidth: number; renderHeight: number; validation?: Record<string, number> }> {
    const { width, height, renderWidth, renderHeight, scale } = configure(request);
    const instance = upscaler!;
    Object.assign(instance.settings, { sharpness: 0.8, maxAccumulation: 24, autoExposure: true, exposure: 1, debugView: 0 });
    await instance.prepare();
    instance.resetHistory();
    bench.resetDeterministicState();
    snapshots.length = 0;
    const snapshotFrames = new Set(request.snapshots ?? []);

    const frames: FrameCounts[] = [];
    let previous: TruthFrame | null = null;
    for (let frame = 0; frame <= request.end; frame++) {
        const { scene, reset } = applyFrame(request, frame, renderHeight);
        nodeFrame!.update();
        nodeFrame!.time = (frame + 1) / 60;
        nodeFrame!.deltaTime = 1 / 60;
        const needTruth = frame >= request.start - 1;
        const scored = frame >= request.start;

        instance.beginFrame(camera);
        velocityProjection.copy(instance.unjitteredProjectionMatrix);
        renderer.setMRT(mrtFull);
        renderer.setRenderTarget(inputTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
        let truthState: Omit<TruthFrame, 'ids' | 'samples'> | null = null;
        if (needTruth) {
            // Still under this frame's jittered projection.
            const meshes = drawnMeshes(scene);
            const matrices = new Map<number, THREE.Matrix4>();
            for (const mesh of meshes) matrices.set(mesh.userData.gtId as number, mesh.matrixWorld.clone());
            truthState = {
                matrices,
                viewProjection: camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse),
                eye: new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld),
            };
            renderTruth(scene, meshes, idTarget!);
            renderTruth(scene, meshes, sampleTarget!);
        }
        instance.endFrame(camera);
        instance.dispatch(
            { color: inputTarget!.textures[0], depth: inputTarget!.depthTexture!, velocity: inputTarget!.textures[1], reset, deltaTime: 1 / 60 },
            camera,
        );
        const wantError = request.error === true && scored && !reset && previous !== null;
        if (wantError) {
            // Unjittered (endFrame restored the camera); one bilinear tap per
            // display pixel centre averages the 2×2 samples exactly.
            renderer.setRenderTarget(referenceTarget);
            renderer.render(scene, camera);
            renderer.setRenderTarget(referenceDown);
            downsampleQuad.render(renderer);
            renderer.setRenderTarget(null);
        }
        if (!needTruth) continue;

        const reads = [
            { texture: gpu(idTarget!.texture), bytesPerTexel: 16 },
            { texture: gpu(sampleTarget!.texture), bytesPerTexel: 16 },
            { texture: gpu(instance.guides.disocclusion), bytesPerTexel: 4 },
        ];
        if (wantError) reads.push({ texture: gpu(instance.outputTexture), bytesPerTexel: 8 }, { texture: gpu(referenceDown!.texture), bytesPerTexel: 8 });
        const [idBytes, sampleBytes, maskBytes, outputBytes, referenceBytes] = await readTextures(reads);
        const current: TruthFrame = { ...truthState!, ids: new Float32Array(idBytes), samples: new Float32Array(sampleBytes) };
        if (scored && previous && !reset) {
            const mask = new Uint8Array(maskBytes);
            const result = score(frame, current, previous, mask, renderWidth, renderHeight, scale);
            if (wantError) {
                const classes = errorClasses(mask, result.receiver, result.truth, result.wrong, result.offScreen, result.interior);
                const out = conditionedLuma(outputBytes);
                const ref = conditionedLuma(referenceBytes);
                const errors = ERROR_CLASSES.map(() => ({ count: 0, sum: 0, over: 0 }));
                for (let y = 0; y < height; y++) {
                    const ry = Math.min(Math.floor(((y + 0.5) * renderHeight) / height), renderHeight - 1);
                    for (let x = 0; x < width; x++) {
                        const rx = Math.min(Math.floor(((x + 0.5) * renderWidth) / width), renderWidth - 1);
                        const errorClass = classes[ry * renderWidth + rx];
                        if (errorClass < 0) continue;
                        const difference = Math.abs(out[y * width + x] - ref[y * width + x]);
                        const entry = errors[errorClass];
                        entry.count++;
                        entry.sum += difference;
                        if (difference > 0.05) entry.over++;
                    }
                }
                result.counts.errors = Object.fromEntries(ERROR_CLASSES.map((name, index) => [name, errors[index]]));
            }
            if (snapshotFrames.has(frame))
                snapshots.push(snapshot(frame, renderWidth, renderHeight, mask, result.receiver, result.truth, result.wrong, current.ids));
            frames.push(result.counts);
        }
        previous = reset ? null : current;
    }
    await device.queue.onSubmittedWorkDone();
    let validation: Record<string, number> | undefined;
    if (request.scenario === 'slide') {
        // Expected reveal per frame: the trailing edge sweeps slideSpeed px
        // across the quad's full height of background.
        const pxPerUnit = renderHeight / (2 * SLIDE_QUAD_DISTANCE * Math.tan((camera.fov * Math.PI) / 360));
        validation = {
            quadHeightPx: SLIDE_QUAD_SIZE * pxPerUnit,
            expectedRevealedPerFrame: (request.slideSpeed ?? 4) * SLIDE_QUAD_SIZE * pxPerUnit,
        };
    }
    return { frames, renderWidth, renderHeight, validation };
}

/** Part of snapshot `index` of the last run (CDP stalls on multi-megabyte values). */
function takeSnapshot(index: number, offset = 0, length = 1 << 20): (Omit<Snapshot, 'rgb'> & { rgb: string; total: number }) | null {
    const entry = snapshots[index];
    if (!entry) return null;
    return { ...entry, rgb: entry.rgb.slice(offset, offset + length), total: entry.rgb.length };
}

(window as unknown as { __disocclusionTruth: unknown }).__disocclusionTruth = {
    ready: true,
    run,
    takeSnapshot,
    get snapshotCount() {
        return snapshots.length;
    },
};
