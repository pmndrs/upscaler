import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { type FSRUpscalePath } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { FSRPresenter } from '../shared/FSRPresenter';
import { addStudioLighting, createGridFloor } from '../shared/props';
import { addRenderScale } from '../shared/ui';

//* Transparency and particles are the honest weak spot of a depth+motion
//* temporal upscaler: they have no watertight depth and no motion vectors, so
//* the history reprojection cannot follow them and they ghost. The opaque scene
//* around them stays sharp — which is exactly why a reactive mask (roadmap) is
//* the fix, and this demo is its future acceptance test.

const { renderer, dpr } = await bootRenderer();

//* Opaque base — gives the temporal path solid structure to lock onto.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1017);
addStudioLighting(scene);
scene.add(createGridFloor());

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

//* Presenter + state.
const state = { tier: 'temporal' as FSRUpscalePath, ratio: 2.0 };
const presenter = new FSRPresenter(renderer);
function configure(): void {
    const { width, height } = displaySize(dpr);
    presenter.configure({
        displayWidth: width,
        displayHeight: height,
        path: state.tier,
        ratio: state.ratio,
    });
}
configure();

const gui = new GUI({ title: 'Transparency' });
gui.add(state, 'tier', {
    'FSR3 temporal (ghosts)': 'temporal',
    'Bilinear (no history)': 'bilinear',
})
    .name('mode')
    .onChange(configure);
addRenderScale(gui, state, configure);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

//* Loop.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
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

    presenter.renderScene(scene, camera, dt);
});
