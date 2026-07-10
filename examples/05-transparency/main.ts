import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { DebugView, type UpscalePath } from '@pmndrs/upscaler';

import { bootRenderer, displaySize } from '../shared/boot';
import { UpscalePresenter } from '../shared/UpscalePresenter';
import { addStudioLighting, createGridFloor } from '../shared/props';
import { addRenderScale } from '../shared/ui';

//* Transparency and particles are the honest weak spot of a depth+motion
//* temporal upscaler: they have no watertight depth and no motion vectors, so
//* history reprojection cannot follow them and they ghost. The fix — and this
//* demo's whole point — is the **reactive mask**: render the transparents'
//* coverage into a render-res mask, hand it to FSR3, and those pixels favour the
//* current frame instead of trailing. Toggle "reactive mask" to see it work, and
//* the Reactivity / Accumulation-age debug views to see why.

const { renderer, dpr } = await bootRenderer();

//* Opaque base — gives the temporal path solid structure to lock onto.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1017);
addStudioLighting(scene);
const floor = createGridFloor();
scene.add(floor);

const pillars: THREE.Mesh[] = [];
for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 4, 24),
        new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.4, roughness: 0.5 }),
    );
    p.position.set(-8 + i * 4, 2, -3);
    scene.add(p);
    pillars.push(p);
}
//* Opaque objects are hidden while authoring the reactive mask.
const opaque: THREE.Object3D[] = [floor, ...pillars];

//* Transparent quads — sweep across the frame; watch them trail.
const glass: THREE.Mesh[] = [];
const glassColors = [0xe86a5f, 0x5fb1e8, 0x8fe85f];
for (let i = 0; i < 3; i++) {
    const q = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 3.2),
        new THREE.MeshStandardMaterial({
            color: glassColors[i],
            transparent: true,
            opacity: 0.5,
            roughness: 0.2,
            side: THREE.DoubleSide,
        }),
    );
    scene.add(q);
    glass.push(q);
}

//* Additive particle cloud.
const PARTICLES = 2000;
const positions = new Float32Array(PARTICLES * 3);
for (let i = 0; i < PARTICLES; i++) {
    const r = 3 + Math.random() * 4;
    const a = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = 0.5 + Math.random() * 5;
    positions[i * 3 + 2] = Math.sin(a) * r - 1;
}
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const pMat = new THREE.PointsNodeMaterial({
    color: 0xffd28a,
    size: 10,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
});
const particles = new THREE.Points(pGeo, pMat);
scene.add(particles);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(7, 4.5, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2, -1);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;

//* Reactive-mask authoring.
// The transparents have no depth/motion, so we hand FSR3 a render-res mask
// marking where they are — those pixels then favour the current frame instead
// of ghosting through history. We author it by rendering the transparents alone
// (opaque hidden) with flat-white stand-in materials into a render-res target;
// the red channel becomes the reactivity. (One extra scene draw per frame.)
const maskMeshMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
const maskPointsMat = new THREE.PointsNodeMaterial({
    color: 0xffffff,
    size: 10,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
});
let maskRT: THREE.RenderTarget | null = null;
let opaqueRT: THREE.RenderTarget | null = null;

//* Presenter + state.
type MaskSource = 'off' | 'manual' | 'auto';
const state = {
    tier: 'temporal' as UpscalePath,
    ratio: 2.0,
    maskSource: 'manual' as MaskSource,
    debug: DebugView.None,
};
const presenter = new UpscalePresenter(renderer);
function configure(): void {
    const { width, height } = displaySize(dpr);
    presenter.configure({
        displayWidth: width,
        displayHeight: height,
        path: state.tier,
        ratio: state.ratio,
    });
    const rw = presenter.upscaler.renderWidth;
    const rh = presenter.upscaler.renderHeight;
    maskRT?.dispose();
    maskRT = new THREE.RenderTarget(rw, rh, { depthBuffer: true });
    opaqueRT?.dispose();
    opaqueRT = new THREE.RenderTarget(rw, rh, { depthBuffer: true });
}
configure();

const transparents: THREE.Object3D[] = [...glass, particles];

/**
 * Feeds the presenter a reactive signal for the transparents, per the selected
 * source: `manual` renders their flat-white coverage into a mask; `auto` renders
 * the opaque-only scene and lets FSR3 diff it against the final frame.
 */
function authorReactive(): void {
    if (state.tier !== 'temporal' || state.maskSource === 'off') {
        presenter.setReactiveMask(null);
        presenter.setReactiveOpaqueColor(null);
        return;
    }

    if (state.maskSource === 'auto' && opaqueRT) {
        //* Opaque-only render — FSR3 diffs it against the final color internally.
        transparents.forEach((o) => (o.visible = false));
        renderer.setRenderTarget(opaqueRT);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        transparents.forEach((o) => (o.visible = true));
        presenter.setReactiveOpaqueColor(opaqueRT.texture);
        presenter.setReactiveMask(null);
        return;
    }

    if (state.maskSource === 'manual' && maskRT) {
        //* Flat-white coverage of the transparents; black elsewhere.
        const glassMats = glass.map((q) => q.material);
        glass.forEach((q) => (q.material = maskMeshMat));
        const pointsMat = particles.material;
        particles.material = maskPointsMat;
        opaque.forEach((o) => (o.visible = false));
        const prevBg = scene.background;
        scene.background = new THREE.Color(0x000000);

        renderer.setRenderTarget(maskRT);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);

        glass.forEach((q, i) => (q.material = glassMats[i]));
        particles.material = pointsMat;
        opaque.forEach((o) => (o.visible = true));
        scene.background = prevBg;

        presenter.setReactiveMask(maskRT.texture);
        presenter.setReactiveOpaqueColor(null);
    }
}

const gui = new GUI({ title: 'Transparency' });
gui.add(state, 'tier', {
    'FSR3 temporal': 'temporal',
    'Bilinear (no history)': 'bilinear',
})
    .name('mode')
    .onChange(configure);
addRenderScale(gui, state, configure);
gui.add(state, 'maskSource', {
    'Off (ghosts)': 'off',
    'Manual coverage': 'manual',
    'Auto (opaque diff)': 'auto',
}).name('reactive mask');
gui.add(state, 'debug', {
    Off: DebugView.None,
    Reactivity: DebugView.Reactivity,
    'Accumulation age': DebugView.AccumulationAge,
}).name('debug view');

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

//* Loop.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();
    controls.update();

    glass.forEach((q, i) => {
        const a = t * 0.6 + (i * Math.PI * 2) / 3;
        q.position.set(Math.cos(a) * 5, 2.2 + Math.sin(t + i) * 0.6, Math.sin(a) * 5 - 1);
        q.lookAt(camera.position);
    });
    // Fast lateral sweep — the point cloud has no motion vectors, so the quicker
    // it moves in screen space the more obvious the temporal ghost trails are.
    particles.rotation.y = t * 1.1;
    particles.position.x = Math.sin(t * 0.9) * 4;

    presenter.applySettings({ debugView: state.debug });
    authorReactive();
    presenter.renderScene(scene, camera, dt);
});
