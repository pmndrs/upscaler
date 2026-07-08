import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { FSRDebugView, type FSRUpscalePath } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { FSRPresenter } from '../shared/FSRPresenter';
import { addStudioLighting, createGridFloor } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* A compact playground for understanding what each tier of the upscaler buys
//* you. Start on "bilinear" (naive), step up to "spatial" (FSR1, edge-adaptive
//* + sharpen), then "temporal" (FSR3, jittered history) and watch the thin
//* pickets and grid lines resolve. Toggle sharpening and debug views to isolate
//* each stage's contribution.

const { renderer, dpr } = await bootRenderer();

//* Scene — thin pickets + a spinning knot on a high-frequency floor.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
addStudioLighting(scene);
scene.add(createGridFloor());

const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.0, 0.3, 200, 26),
    new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 }),
);
knot.position.set(0, 2.2, -1);
scene.add(knot);

const pickets = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.08, 2.2, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 }),
    48,
);
const m = new THREE.Matrix4();
for (let i = 0; i < 48; i++) {
    m.setPosition(-9.4 + i * 0.4, 1.1, 3.2);
    pickets.setMatrixAt(i, m);
}
scene.add(pickets);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(7, 5, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;

//* State + presenter.
type Tier = 'bilinear' | 'spatial' | 'temporal';
const state = {
    tier: 'temporal' as Tier,
    ratio: 2.0,
    sharpen: true,
    locks: true,
    autoExposure: true,
    shadingChange: true,
    debug: FSRDebugView.None,
    autoRotate: true,
};

const presenter = new FSRPresenter(renderer);
function configure(): void {
    const { width, height } = displaySize(dpr);
    presenter.configure({
        displayWidth: width,
        displayHeight: height,
        path: state.tier as FSRUpscalePath,
        ratio: state.ratio,
    });
}
configure();

//* GUI.
const gui = new GUI({ title: 'FSR1 vs FSR3' });
gui.add(state, 'tier', {
    'Bilinear (naive)': 'bilinear',
    'FSR1 spatial (EASU+RCAS)': 'spatial',
    'FSR3 temporal': 'temporal',
})
    .name('tier')
    .onChange(configure);
addRenderScale(gui, state, configure);
gui.add(state, 'sharpen').name('RCAS sharpen');
gui.add(state, 'locks').name('lock thin features');
gui.add(state, 'autoExposure').name('auto exposure');
gui.add(state, 'shadingChange').name('detect shading changes');
gui.add(state, 'debug', {
    Off: FSRDebugView.None,
    'Motion vectors': FSRDebugView.MotionVectors,
    Disocclusion: FSRDebugView.Disocclusion,
    Depth: FSRDebugView.Depth,
    'Accumulation age': FSRDebugView.AccumulationAge,
    Locks: FSRDebugView.Locks,
    Exposure: FSRDebugView.Exposure,
    'Shading change': FSRDebugView.ShadingChange,
}).name('debug view');
gui.add(state, 'autoRotate').name('auto orbit');
gui.add({ reset: () => presenter.upscaler.resetHistory() }, 'reset').name('reset history');

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

//* HUD.
const hud = document.getElementById('hud')!;
function updateHud(fps: number): void {
    const u = presenter.upscaler;
    const gpu = [...u.gpuTimings].reduce((a, [, ms]) => a + ms, 0);
    hud.innerHTML =
        `<b>tier</b>     ${state.tier}\n` +
        `<b>render</b>   ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
        `<b>display</b>  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x)\n` +
        `<b>fps</b>      ${fps.toFixed(0)}\n` +
        `<b>gpu</b>      ${gpu.toFixed(2)} ms`;
}

//* Loop.
const clock = new THREE.Clock();
let acc = 0;
let frames = 0;
let fps = 0;
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    acc += dt;
    frames++;
    if (acc >= 0.5) {
        fps = frames / acc;
        acc = 0;
        frames = 0;
    }

    controls.autoRotate = state.autoRotate;
    controls.update();
    knot.rotation.y = t * 0.5;

    // Sharpening only applies on the spatial/temporal paths; bilinear ignores it.
    presenter.applySettings({
        sharpness: state.sharpen ? 0.8 : 0,
        lockThinFeatures: state.locks,
        autoExposure: state.autoExposure,
        detectShadingChanges: state.shadingChange,
        debugView: state.debug,
    });
    presenter.renderScene(scene, camera, dt);
    updateHud(fps);
});
