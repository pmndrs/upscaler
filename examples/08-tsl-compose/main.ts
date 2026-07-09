import * as THREE from 'three/webgpu';
import { screenUV, smoothstep } from 'three/tsl';

import { fsrScene, FSRQualityMode } from 'three-fsr3';

import { bootRenderer } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* Composing FSR3 in a post graph.
// The reason FSR3 is a node and not just an imperative driver: it slots into a
// THREE.PostProcessing graph so other TSL effects can sit around it. Here the
// upscaled result feeds a simple vignette before hitting the screen —
// `post.outputNode = fsr3(scene, camera).mul(vignette)`.

const { renderer } = await bootRenderer();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
addStudioLighting(scene);
scene.add(createGridFloor());

const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28),
    new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 }),
);
knot.position.y = 2.2;
scene.add(knot);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6, 4, 9);
camera.lookAt(0, 1.6, 0);

//* FSR3 node → vignette → screen, all in the post graph.
const post = new THREE.PostProcessing(renderer);
// fsrScene() returns a loosely-typed TSL node; cast to reach the node math ops.
const fsrNode = fsrScene(scene, camera, { quality: FSRQualityMode.Performance }) as {
    mul(n: unknown): unknown;
};
// Darken toward the frame edges (1 at centre, ~0.35 at the corners).
const vignette = smoothstep(0.85, 0.25, screenUV.sub(0.5).length());
post.outputNode = fsrNode.mul(vignette) as unknown as THREE.Node;

const badge = document.getElementById('badge')!;
badge.innerHTML =
    `<b>three-fsr3</b>  node composition\n` +
    `post.outputNode = fsrScene(scene, camera)\n                   .mul(vignette)`;

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    camera.position.set(Math.cos(t * 0.2) * 10, 4.5, Math.sin(t * 0.2) * 10);
    camera.lookAt(0, 1.6, 0);
    post.render();
});
