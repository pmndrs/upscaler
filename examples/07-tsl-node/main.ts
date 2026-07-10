import * as THREE from 'three/webgpu';

import { upscaleScene, QualityMode, type Upscaler } from '@pmndrs/upscaler';

import { bootRenderer } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* FSR3 as a TSL node — the declarative drop-in.
// Instead of driving the upscaler imperatively (UpscalePass), hand `upscaleScene(scene,
// camera)` to a THREE.PostProcessing graph as the output node. It builds a
// reduced-res scene pass and feeds it to the composable `upscale()` node, which
// runs the FSR compute passes and outputs the upscaled texture — so the whole
// "render small, reconstruct big" pipeline is one line, and other TSL effects
// can sit around it (see 08). For an effect pipeline as the input (SSGI etc.),
// use `upscale(color, depth, velocity, camera)` directly — see 06.

const { renderer } = await bootRenderer();

//* Scene — a spinning knot + thin pickets on a grid floor (aliasing bait).
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

const pickets = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.08, 2.0, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 }),
    40,
);
const m = new THREE.Matrix4();
for (let i = 0; i < 40; i++) {
    m.setPosition(-7.8 + i * 0.4, 1.0, 3.0);
    pickets.setMatrixAt(i, m);
}
scene.add(pickets);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6, 4, 9);
camera.lookAt(0, 1.6, 0);

//* The whole upscaler, as one post-processing node.
const post = new THREE.PostProcessing(renderer);
const fsrNode = upscaleScene(scene, camera, { quality: QualityMode.Performance }); // 2.0x
post.outputNode = fsrNode as unknown as THREE.Node;

const badge = document.getElementById('badge')!;
function updateBadge(): void {
    const u = (fsrNode as unknown as { upscaler?: Upscaler }).upscaler;
    badge.innerHTML =
        `<b>@pmndrs/upscaler</b>  upscaleScene() TSL node\n` +
        `post.outputNode = upscaleScene(scene, camera)\n` +
        (u ? `render   ${u.renderWidth}×${u.renderHeight}\n` +
            `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(1)}x)` : '');
}

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

//* Loop — the node handles jitter/velocity/dispatch internally; we just render
//* the post graph. Orbit slowly so the temporal history keeps working.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    camera.position.set(Math.cos(t * 0.2) * 10, 4.5, Math.sin(t * 0.2) * 10);
    camera.lookAt(0, 1.6, 0);

    post.render();
    updateBadge();
});
