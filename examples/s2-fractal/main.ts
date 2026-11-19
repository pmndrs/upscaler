import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp, mix, mrt, normalize, output, screenUV, select, texture, uniform, vec2, vec4 } from 'three/tsl';
import GUI from 'lil-gui';

import { DebugView, Upscaler, type UpscalePath } from '@pmndrs/upscaler';

import { displaySize, showFatal } from '../shared/boot';
import { basePercent } from '../shared/ui';
import { buildFractal, FRACTAL, pathPoint, QUALITY_PRESETS } from './fractal';
import { GpuStats } from './stats';

//* S2 — a raymarched Mandelbox. Every pixel marches the fractal: a primary
//* ray of up to 256 steps (30–50 on average, measured on the flight path),
//* then normal, AO and soft-shadow marches, each step 12 box/sphere folds.
//* The frame cost is almost purely per-pixel, so rendering 1/4 or 1/9 of the
//* pixels is the difference between a slideshow and a smooth flight.
//*
//* It also shows the upscaler isn't tied to three meshes. There is no scene
//* graph here — one fullscreen quad marches rays — so three's `velocity` node
//* (which reprojects mesh vertices) has nothing to work with. The raymarcher
//* supplies the temporal inputs itself:
//*   - depth:    hardware depth of the hit, written via `material.depthNode`
//*   - velocity: the hit's world position through the current and previous
//*               *unjittered* view-projection, in three's VelocityNode
//*               convention (NDC, current − previous)
//*   - jitter:   primary rays are built from the camera's *jittered*
//*               projection, so the sub-pixel offset lands on the march.
//* That is why this drives the raw `Upscaler` rather than `UpscalePass`:
//* the pass bakes in a scene render with three's mesh velocity node.

//* Renderer — the shared bootRenderer() recipe, inlined because this page
//* also needs `trackTimestamp` (three times its own render passes — the
//* raymarch — with GPU timestamp queries), which bootRenderer doesn't expose.
if (!navigator.gpu) {
    showFatal('WebGPU is not available in this browser — this showcase needs Chrome/Edge 113+.');
    throw new Error('WebGPU unavailable');
}
const dpr = Math.min(window.devicePixelRatio, 2);
// `?reversed-depth` runs the same page on a reversed-Z depth buffer, to check
// that the raymarcher's hand-written depth follows the renderer's convention.
const reversedDepthBuffer = new URLSearchParams(location.search).has('reversed-depth');
const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true, reversedDepthBuffer });
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
await renderer.init();
if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    showFatal('three fell back to the WebGL backend — this showcase needs real WebGPU.');
    throw new Error('WebGL fallback active');
}

//* Camera — a regular three camera: the upscaler jitters it through its view
//* offset, and the raymarcher reads its matrices back as uniforms.
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.01, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 7.5;
controls.maxDistance = 22;
controls.enabled = false;

//* Upscaler — raw driver: we produce color/depth/velocity ourselves.
const upscaler = new Upscaler({ renderer, gpuTiming: true });

//* Raymarch uniforms, refreshed every frame between beginFrame/endFrame.
const uInvProjection = uniform(new THREE.Matrix4()); // JITTERED inverse projection → primary rays
const uCameraWorld = uniform(new THREE.Matrix4());
const uCameraPosition = uniform(new THREE.Vector3());
const uView = uniform(new THREE.Matrix4());
const uViewProjection = uniform(new THREE.Matrix4()); // unjittered, this frame
const uPrevViewProjection = uniform(new THREE.Matrix4()); // unjittered, last frame
const uNear = uniform(camera.near);
const uFar = uniform(camera.far);
const uReversedDepth = uniform(renderer.reversedDepthBuffer ? 1 : 0);
const uPixelAngle = uniform(0.001);
const uSunDirection = uniform(new THREE.Vector3(-0.45, 0.62, 0.35).normalize());

const marchMaterial = new THREE.NodeMaterial();
marchMaterial.depthTest = false; // every fragment writes its own depth; nothing to test against
marchMaterial.depthWrite = true;
marchMaterial.fog = false;
const marchQuad = new THREE.QuadMesh(marchMaterial);

let marchMRT: ReturnType<typeof mrt>;

/**
 * Builds the raymarch material's color, depth and velocity nodes for a quality
 * preset. All three read one march result — a node shared by the three
 * outputs (three caches a node used more than once in a temporary), so the
 * generated fragment shader calls `fractal_march` once
 * (checked against the WGSL three emits).
 * @param quality - Key into {@link QUALITY_PRESETS}
 */
function buildMarchMaterial(quality: string): void {
    const { march, shade } = buildFractal(QUALITY_PRESETS[quality]);

    //* Primary ray through this fragment's centre, via the JITTERED projection.
    // screenUV is y-down (framebuffer space); NDC is y-up.
    const ndc = vec2(screenUV.x.mul(2).sub(1), screenUV.y.mul(-2).add(1));
    const viewPoint = uInvProjection.mul(vec4(ndc, 0.5, 1));
    const rayView = normalize(viewPoint.xyz.div(viewPoint.w));
    const rayDir = normalize(uCameraWorld.mul(vec4(rayView, 0)).xyz);
    const rayOrigin = uCameraPosition;

    const hit = march(rayOrigin, rayDir, uPixelAngle);
    const isHit = hit.y.greaterThan(0.5);
    const hitPos = rayOrigin.add(rayDir.mul(hit.x));

    //* Velocity — three's VelocityNode convention exactly: NDC xy of the
    //* surface through the current unjittered view-projection minus the same
    //* point through the previous one. Static geometry, so the world position
    //* is shared; only the camera moved. Misses are directions at infinity
    //* (w = 0): the sky reprojects by camera rotation alone.
    const homogeneous = select(isHit, vec4(hitPos, 1), vec4(rayDir, 0));
    const clipCurrent = uViewProjection.mul(homogeneous);
    const clipPrevious = uPrevViewProjection.mul(homogeneous);
    const velocityNode = clipCurrent.xy.div(clipCurrent.w).sub(clipPrevious.xy.div(clipPrevious.w));

    //* Depth — the hardware depth a mesh at hitPos would have written:
    //* WebGPU's [0,1] perspective z, far plane for the sky, flipped when the
    //* renderer uses a reversed depth buffer (reversed-Z perspective depth is
    //* exactly 1 − standard). The upscaler linearizes it with the camera's
    //* near/far and the renderer's reversed flag.
    const viewZ = uView.mul(vec4(hitPos, 1)).z.negate();
    const standardDepth = select(
        isHit,
        uFar.mul(viewZ.sub(uNear)).div(viewZ.mul(uFar.sub(uNear))),
        1,
    );
    marchMaterial.depthNode = clamp(mix(standardDepth, standardDepth.oneMinus(), uReversedDepth), 0, 1);

    marchMaterial.colorNode = vec4(shade(rayOrigin, rayDir, hit, uPixelAngle, uSunDirection), 1);
    marchMaterial.needsUpdate = true;

    // MRT routes by attachment NAME ('output' / 'velocity'), and its output
    // count matches the render target's attachment count (2) on every path.
    marchMRT = mrt({ output, velocity: velocityNode });
}

//* Present — the upscaled linear/HDR output; the renderer applies ACES + sRGB.
const presentMaterial = new THREE.NodeMaterial();
presentMaterial.depthTest = false;
presentMaterial.depthWrite = false;
presentMaterial.fog = false;
const presentQuad = new THREE.QuadMesh(presentMaterial);

//* State.
type CameraMode = 'flight' | 'orbit';
const state = {
    path: 'temporal' as UpscalePath,
    ratio: 2.0,
    quality: 'high',
    debug: DebugView.None,
    sharpness: 0.8,
    camera: 'flight' as CameraMode,
    paused: false,
    speed: 1.0,
};
// The pre-"native" settings, so the native toggle can restore them.
let beforeNative: { path: UpscalePath; ratio: number } | null = null;

let rt: THREE.RenderTarget | null = null;

/** (Re)configures the upscaler and the render-resolution target for the current state. */
function configure(): void {
    const { width, height } = displaySize(dpr);
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        customUpscaleRatio: state.ratio,
        path: state.path,
    });

    rt?.dispose();
    const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
    depthTexture.type = THREE.FloatType;
    rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
        count: 2, // = the MRT output count (output + velocity) — see buildMarchMaterial
        type: THREE.HalfFloatType,
        depthTexture,
    });
    rt.textures[0].name = 'output';
    rt.textures[1].name = 'velocity';

    // Hit threshold = half a DISPLAY pixel's angular footprint, independent of
    // the render scale: the geometry is the same at every ratio, and only the
    // number of rays changes.
    const fovY = THREE.MathUtils.degToRad(camera.fov);
    uPixelAngle.value = (0.5 * 2 * Math.tan(fovY / 2)) / height;

    presentMaterial.colorNode = texture(upscaler.outputTexture);
    presentMaterial.needsUpdate = true;
    stats.reset();
}

const stats = new GpuStats(renderer);
buildMarchMaterial(state.quality);
configure();

//* GUI.
const gui = new GUI({ title: 'S2 · Raymarched fractal' });
const pathCtrl = gui
    .add(state, 'path', { 'temporal (FSR3)': 'temporal', 'spatial (FSR1)': 'spatial', bilinear: 'bilinear' })
    .name('path')
    .onChange(() => {
        beforeNative = null;
        configure();
    });
const ratioCtrl = gui
    .add(state, 'ratio', 1.0, 4.0, 0.05)
    .name('render scale ×')
    .onChange(() => {
        beforeNative = null;
        configure();
    });
const nativeCtrl = gui
    .add(
        {
            toggleNative: () => {
                if (beforeNative) {
                    Object.assign(state, beforeNative);
                    beforeNative = null;
                } else {
                    beforeNative = { path: state.path, ratio: state.ratio };
                    // Native = the raymarch at display resolution with no upscaler
                    // work beyond a 1:1 passthrough blit.
                    state.path = 'bilinear';
                    state.ratio = 1.0;
                }
                pathCtrl.updateDisplay();
                ratioCtrl.updateDisplay();
                nativeCtrl.name(beforeNative ? '◀ back to upscaled' : 'native (1×) comparison');
                configure();
            },
        },
        'toggleNative',
    )
    .name('native (1×) comparison');
gui.add(state, 'quality', Object.keys(QUALITY_PRESETS))
    .name('quality')
    .onChange(() => {
        buildMarchMaterial(state.quality);
        stats.reset();
    });
gui.add(state, 'debug', {
    Off: DebugView.None,
    'Motion vectors': DebugView.MotionVectors,
    Disocclusion: DebugView.Disocclusion,
    Depth: DebugView.Depth,
    'Accumulation age': DebugView.AccumulationAge,
    Locks: DebugView.Locks,
    Exposure: DebugView.Exposure,
    'Shading change': DebugView.ShadingChange,
})
    .name('debug view')
    .onChange(() => stats.reset());
gui.add(state, 'sharpness', 0, 1, 0.05).name('RCAS sharpness');
gui.add(state, 'camera', { 'flight path': 'flight', orbit: 'orbit' })
    .name('camera')
    .onChange(() => {
        controls.enabled = state.camera === 'orbit';
        if (controls.enabled) {
            camera.position.set(9, 4.5, 9);
            controls.target.set(0, 0, 0);
            controls.update();
        }
        upscaler.resetHistory(); // a camera cut — don't reproject across it
    });
gui.add(state, 'speed', 0.1, 2.5, 0.05).name('flight speed');
gui.add(state, 'paused').name('pause');

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

//* Flight path — ride the carved tunnel, looking a little way ahead.
const ahead = new THREE.Vector3();
let flightTheta = 0.35;
function updateFlight(dt: number): void {
    if (!state.paused) flightTheta += dt * 0.045 * state.speed;
    pathPoint(flightTheta, camera.position);
    pathPoint(flightTheta + 0.12, ahead);
    // A slow sway of the gaze keeps the walls sliding past at varying angles.
    ahead.y += 0.25 * Math.sin(flightTheta * 3.0);
    camera.up.set(0.12 * Math.sin(flightTheta * 2.0), 1, 0).normalize(); // gentle bank
    camera.lookAt(ahead);
}

//* HUD.
const hud = document.getElementById('hud')!;
function updateHud(fps: number): void {
    const s = stats.averages();
    const ms = (v: number | null) => (v === null ? '   n/a' : v.toFixed(2).padStart(6));
    const renderPx = upscaler.renderWidth * upscaler.renderHeight;
    const displayPx = upscaler.displayWidth * upscaler.displayHeight;
    const native = beforeNative !== null;
    hud.innerHTML =
        `<b>S2 · raymarched fractal</b>  ${native ? '<i>native 1× — no upscaling</i>' : state.path}\n` +
        `render    ${upscaler.renderWidth}×${upscaler.renderHeight}  ` +
        `(${basePercent(upscaler.upscaleRatio)} · ${((100 * renderPx) / displayPx).toFixed(1)}% of pixels)\n` +
        `display   ${upscaler.displayWidth}×${upscaler.displayHeight}  ${upscaler.upscaleRatio.toFixed(2)}×\n` +
        `quality   ${state.quality}  (${QUALITY_PRESETS[state.quality].steps} steps × ` +
        `${QUALITY_PRESETS[state.quality].iterations} folds)\n` +
        `<b>gpu ms</b>    (timestamp queries, ~1 s avg)\n` +
        `raymarch  ${ms(s.raymarch)}\n` +
        `upscale   ${ms(s.upscale)}\n` +
        `present   ${ms(s.present)}\n` +
        `total     ${ms(s.total)}\n` +
        `fps       ${fps.toFixed(0).padStart(6)}` +
        (stats.supported ? '' : '\n<i>timestamp-query unavailable — gpu ms n/a</i>');
}

//* Debug/verification handle for the headless GPU harness.
Object.assign(window as unknown as Record<string, unknown>, {
    __fractal: {
        upscaler,
        renderer,
        camera,
        state,
        stats,
        configure,
        buildMarchMaterial,
        controls,
        FRACTAL,
        setFlightTheta: (theta: number) => {
            flightTheta = theta;
        },
        renderFrame: (dt: number) => renderFrame(dt),
        getRenderTarget: () => rt,
    },
});

//* Loop.
const timer = new THREE.Timer();
const viewProjection = new THREE.Matrix4();
let hasPrevious = false;
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 0;
await Promise.all([upscaler.init()]);

renderer.setAnimationLoop(() => {
    if (!upscaler.isReady) return;
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
        fps = fpsFrames / fpsAcc;
        fpsAcc = 0;
        fpsFrames = 0;
    }
    renderFrame(dt);
});

/**
 * Renders one frame: camera update, jittered raymarch, upscale, present.
 * Split from the loop so the verification harness can step frames itself.
 * @param dt - Frame delta in seconds
 */
function renderFrame(dt: number): void {
    if (!rt) return;

    if (state.camera === 'flight') updateFlight(dt);
    else controls.update();
    camera.updateMatrixWorld();

    upscaler.settings.debugView = state.debug;
    upscaler.settings.sharpness = state.sharpness;

    //* 1. Jitter the camera, then read its matrices into the march uniforms.
    // beginFrame snapshots the unjittered projection first, then offsets the
    // view; the camera's own projection(Inverse) is now the JITTERED one.
    upscaler.beginFrame(camera);
    uInvProjection.value.copy(camera.projectionMatrixInverse);
    uCameraWorld.value.copy(camera.matrixWorld);
    uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
    uView.value.copy(camera.matrixWorldInverse);
    viewProjection.multiplyMatrices(upscaler.unjitteredProjectionMatrix, camera.matrixWorldInverse);
    // First frame: previous = current (zero motion), like VelocityNode.
    uPrevViewProjection.value.copy(hasPrevious ? uViewProjection.value : viewProjection);
    uViewProjection.value.copy(viewProjection);
    hasPrevious = true;

    //* 2. March at render resolution into color + velocity MRT and depth.
    renderer.setMRT(marchMRT);
    renderer.setRenderTarget(rt);
    marchQuad.render(renderer);
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    upscaler.endFrame(camera);

    //* 3. Upscale (raw dispatch), then present.
    upscaler.dispatch(
        { color: rt.textures[0], depth: rt.depthTexture ?? undefined, velocity: rt.textures[1], deltaTime: dt },
        camera,
    );
    presentQuad.render(renderer);

    stats.sample(upscaler.gpuTimings, state.path, upscaler.settings);
    updateHud(fps);
}
