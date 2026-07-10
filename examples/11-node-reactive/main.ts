import * as THREE from 'three/webgpu';
import { mrt, output, pass, velocity } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { DebugView, upscale, type Upscaler } from '@pmndrs/upscaler';

import { bootRenderer } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* The node-graph acceptance test for the reactive mask. Example 05 authors the
//* mask imperatively (UpscalePass); this one proves the same thing through the
//* composable `upscale()` node — the reactive input as a *graph dependency*, so
//* three renders it in-pipeline (jittered, aligned with color) before the FSR
//* compute. Toggle "reactive mask" to watch the additive particles + glass go
//* from ghost-trailing (off) to crisp (on); the Reactivity debug view shows the
//* mask itself.
//*
//* How the mask is authored in-graph, single-camera: a parallel `reactiveScene`
//* holds flat-white stand-ins for the transparents that SHARE geometry with the
//* real ones (so a second pass renders their coverage). Because both passes use
//* the same camera, the node's jitter hook offsets both identically — no
//* two-camera jitter-sync problem, no per-material MRT. White = reactive.

const { renderer } = await bootRenderer();

//* Opaque base — solid structure for the temporal path to lock onto.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1017);
addStudioLighting(scene);
scene.add(createGridFloor());

for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 4, 24),
        new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.4, roughness: 0.5 }),
    );
    p.position.set(-8 + i * 4, 2, -3);
    scene.add(p);
}

//* reactiveScene — flat-white coverage of the transparents on black. Its stand-ins
//* SHARE geometry with the real transparents; we mirror their transforms each frame.
const reactiveScene = new THREE.Scene();
reactiveScene.background = new THREE.Color(0x000000);

//* Transparent glass quads (colored in `scene`, white in `reactiveScene`).
const glassGeo = new THREE.PlaneGeometry(2.4, 3.2);
const glassColors = [0xe86a5f, 0x5fb1e8, 0x8fe85f];
const glass: THREE.Mesh[] = [];
const glassMask: THREE.Mesh[] = [];
const whiteMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
for (let i = 0; i < 3; i++) {
    const q = new THREE.Mesh(
        glassGeo,
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
    const m = new THREE.Mesh(glassGeo, whiteMat);
    reactiveScene.add(m);
    glassMask.push(m);
}

//* Additive particle cloud — shared geometry between the real (amber) and the
//* mask (white) point clouds.
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
const pointsOpts = { size: 10, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
const particles = new THREE.Points(pGeo, new THREE.PointsNodeMaterial({ color: 0xffd28a, ...pointsOpts }));
scene.add(particles);
const particlesMask = new THREE.Points(pGeo, new THREE.PointsNodeMaterial({ color: 0xffffff, ...pointsOpts }));
reactiveScene.add(particlesMask);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(7, 4.5, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2, -1);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;

const post = new THREE.PostProcessing(renderer);
const state = { ratio: 2.0, reactive: true, jitter: true, debug: DebugView.None };
let fsrNode: ReturnType<typeof upscale> | null = null;

/** (Re)builds the node graph, with or without the reactive mask input. */
function configure(): void {
    const ratio = state.ratio;

    //* Scene color + jitter-free velocity, rendered at 1/ratio in-graph.
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, velocity }));
    scenePass.setResolutionScale(1 / ratio);
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');

    //* Reactive coverage pass — same camera, same 1/ratio, so it jitters with
    //* color. Only built when the toggle is on (off → the trails come back).
    let reactive: ReturnType<typeof scenePass.getTextureNode> | undefined;
    if (state.reactive) {
        const reactivePass = pass(reactiveScene, camera);
        reactivePass.setResolutionScale(1 / ratio);
        reactive = reactivePass.getTextureNode('output');
    }

    (fsrNode as unknown as { dispose?(): void } | null)?.dispose?.();
    fsrNode = upscale(color, depth, vel, camera, { ratio, jitter: state.jitter, reactive });
    post.outputNode = fsrNode as unknown as THREE.Node;
    post.needsUpdate = true;
}
configure();

const gui = new GUI({ title: 'Reactive (node)' });
addRenderScale(gui, state, configure);
gui.add(state, 'reactive').name('reactive mask').onChange(configure);
gui.add(state, 'jitter').name('jitter (reconstruct)').onChange(configure);
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

const hud = document.getElementById('hud')!;
function updateHud(): void {
    const u = (fsrNode as unknown as { upscaler?: Upscaler }).upscaler;
    hud.innerHTML =
        `<b>@pmndrs/upscaler</b>  reactive mask (node graph)\n` +
        `reactive  ${state.reactive ? 'on (crisp)' : 'off (ghosts)'}\n` +
        `jitter    ${state.jitter ? 'on (reconstruct)' : 'off (stable)'}\n` +
        (u
            ? `render    ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
              `display   ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x)`
            : '');
}

//* Loop — animate the transparents and mirror the motion onto their white
//* stand-ins so the reactive coverage tracks them exactly.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    controls.update();

    glass.forEach((q, i) => {
        const a = t * 0.6 + (i * Math.PI * 2) / 3;
        q.position.set(Math.cos(a) * 5, 2.2 + Math.sin(t + i) * 0.6, Math.sin(a) * 5 - 1);
        q.lookAt(camera.position);
        glassMask[i].position.copy(q.position);
        glassMask[i].quaternion.copy(q.quaternion);
    });
    particles.rotation.y = t * 1.1;
    particles.position.x = Math.sin(t * 0.9) * 4;
    particlesMask.rotation.copy(particles.rotation);
    particlesMask.position.copy(particles.position);

    const u = (fsrNode as unknown as { upscaler?: Upscaler }).upscaler;
    if (u) u.settings.debugView = state.debug;
    post.render();
    updateHud();
});
