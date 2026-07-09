import * as THREE from 'three/webgpu';

import { FSRQualityMode } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { FSRPresenter } from '../shared/FSRPresenter';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* The smallest possible FSR3 temporal upscale.
// Render a scene at a fraction of the display resolution, then let FSR3
// reconstruct it back to full size. Everything tricky lives in FSRPresenter.

const { renderer, dpr } = await bootRenderer();

//* Scene — a single spinning knot on a grid floor.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
addStudioLighting(scene);
scene.add(createGridFloor());

const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28),
    new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 }),
);
knot.position.y = 2;
scene.add(knot);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6, 4, 8);
camera.lookAt(0, 1.6, 0);

//* Upscaler — render at half resolution per axis (2x), reconstruct to display.
const presenter = new FSRPresenter(renderer);
function configure(): void {
    const { width, height } = displaySize(dpr);
    presenter.configure({
        displayWidth: width,
        displayHeight: height,
        path: 'temporal',
        quality: FSRQualityMode.Performance, // 2.0x
    });
}
configure();

const badge = document.getElementById('badge')!;
function updateBadge(): void {
    const u = presenter.upscaler;
    badge.innerHTML =
        `<b>three-fsr3</b>  FSR3 temporal\n` +
        `render   ${u.renderWidth}×${u.renderHeight}\n` +
        `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(1)}x)`;
}

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

//* Loop — orbit the camera slowly so the temporal history keeps working.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();

    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    camera.position.set(Math.cos(t * 0.2) * 9, 4.5, Math.sin(t * 0.2) * 9);
    camera.lookAt(0, 1.6, 0);

    presenter.renderScene(scene, camera, dt);
    updateBadge();
});
