import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { abs, mix, smoothstep, step, texture, uniform, uv, vec4 } from 'three/tsl';

import { FSRQualityMode } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { FSRPresenter } from '../shared/FSRPresenter';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* Native vs FSR3, same scene and same instant, wiped by the mouse. The left
//* side renders at a fraction of the pixel count and is reconstructed by FSR3;
//* the right side renders at full display resolution. Both funnel through the
//* same WGSL display transform, so it is a fair A/B.

const { renderer, dpr } = await bootRenderer();

//* Scene.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
addStudioLighting(scene);
scene.add(createGridFloor());

const knots: THREE.Mesh[] = [];
const knotMat = new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 });
for (let i = 0; i < 3; i++) {
    const k = new THREE.Mesh(new THREE.TorusKnotGeometry(1.0, 0.3, 200, 26), knotMat);
    k.position.set(-5 + i * 5, 2.2, -2);
    scene.add(k);
    knots.push(k);
}
const pickets = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.08, 2.2, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 }),
    56,
);
const m = new THREE.Matrix4();
for (let i = 0; i < 56; i++) {
    m.setPosition(-11 + i * 0.4, 1.1, 3.4);
    pickets.setMatrixAt(i, m);
}
scene.add(pickets);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(8, 5, 11);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;

//* Two presenters sharing the renderer.
// The FSR presenter owns the global velocity node; native (bilinear @ 1.0x)
// needs no motion vectors, so it opts out.
const fsr = new FSRPresenter(renderer, { shareVelocityMatrix: true });
const native = new FSRPresenter(renderer, { shareVelocityMatrix: false });

function configure(): void {
    const { width, height } = displaySize(dpr);
    fsr.configure({ displayWidth: width, displayHeight: height, path: 'temporal', quality: FSRQualityMode.Performance });
    native.configure({ displayWidth: width, displayHeight: height, path: 'bilinear', ratio: 1 });
}
configure();

//* Composite present quad — wipe between the two output textures.
const split = uniform(0.5);
const uvNode = uv();
const fsrTex = texture(fsr.outputTexture, uvNode);
const nativeTex = texture(native.outputTexture, uvNode);
const isLeft = step(uvNode.x, split); // 1 on the FSR side
const line = smoothstep(0.0015, 0.0, abs(uvNode.x.sub(split)));
const composited = mix(mix(nativeTex, fsrTex, isLeft), vec4(0.49, 0.83, 0.99, 1), line);

const compositeMat = new THREE.NodeMaterial();
compositeMat.depthTest = false;
compositeMat.depthWrite = false;
compositeMat.fog = false;
compositeMat.colorNode = composited;
const compositeQuad = new THREE.QuadMesh(compositeMat);

//* Rebind the sampled textures after a resize (configure recreates them).
function rebindComposite(): void {
    fsrTex.value = fsr.outputTexture;
    nativeTex.value = native.outputTexture;
    compositeMat.needsUpdate = true;
}

window.addEventListener('pointermove', (e) => {
    split.value = e.clientX / window.innerWidth;
});
window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
    rebindComposite();
});

//* Loop — draw both offscreen, then composite to the canvas.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    controls.update();

    // Native first (no jitter), then FSR (jitters the camera internally).
    native.draw(scene, camera, dt);
    fsr.draw(scene, camera, dt);
    compositeQuad.render(renderer);
});
