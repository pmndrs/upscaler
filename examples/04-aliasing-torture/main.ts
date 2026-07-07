import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';

import { type FSRUpscalePath } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { FSRPresenter } from '../shared/FSRPresenter';
import { addStudioLighting, createGridTexture } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* The classic upscaler stress test: sub-pixel-thin geometry (a chain-link
//* fence + railings) over a high-frequency moiré floor, with a slow camera
//* dolly. On "bilinear" the fence shimmers and the floor moirés; on "temporal"
//* FSR3's jittered history resolves detail below one render-pixel.

const { renderer, dpr } = await bootRenderer();

//* Scene.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);
scene.fog = new THREE.Fog(0x0e1116, 30, 120);
addStudioLighting(scene);

// Moiré floor — a very dense grid texture is a shimmer magnet under motion.
const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ map: createGridTexture(80), roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

//* Chain-link fence — two sets of thin bars crossing at 45°, far into the
//* distance. Thin + repeated = maximum aliasing.
const wireMat = new THREE.MeshStandardMaterial({ color: 0xaab4c4, metalness: 0.7, roughness: 0.4 });
function buildFence(z: number): void {
    const count = 60;
    const barGeo = new THREE.BoxGeometry(0.03, 6, 0.03);
    for (const tilt of [Math.PI / 4, -Math.PI / 4]) {
        const bars = new THREE.InstancedMesh(barGeo, wireMat, count);
        const rot = new THREE.Matrix4().makeRotationZ(tilt);
        for (let i = 0; i < count; i++) {
            const pos = new THREE.Matrix4().makeTranslation(-30 + i * 1.0, 3, z);
            bars.setMatrixAt(i, pos.multiply(rot));
        }
        scene.add(bars);
    }
}
buildFence(6);
buildFence(-8);

// Thin horizontal railings receding to the horizon.
const railMat = new THREE.MeshStandardMaterial({ color: 0xd8b46a, metalness: 0.3, roughness: 0.6 });
const railGeo = new THREE.BoxGeometry(120, 0.04, 0.04);
for (let i = 0; i < 6; i++) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(0, 0.4 + i * 1.1, 6);
    scene.add(rail);
}

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);

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

const gui = new GUI({ title: 'Aliasing torture' });
gui.add(state, 'tier', {
    'Bilinear (watch it shimmer)': 'bilinear',
    'FSR1 spatial': 'spatial',
    'FSR3 temporal': 'temporal',
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

const hud = document.getElementById('hud')!;
function updateHud(): void {
    const u = presenter.upscaler;
    hud.innerHTML =
        `<b>mode</b>     ${state.tier}\n` +
        `<b>render</b>   ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
        `<b>display</b>  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x)`;
}

//* Loop — a slow dolly through the fences keeps sub-pixel motion continuous.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    camera.position.set(Math.sin(t * 0.15) * 4, 3.2, 22 - ((t * 1.5) % 30));
    camera.lookAt(Math.sin(t * 0.15 + 0.5) * 2, 2.5, -20);

    presenter.renderScene(scene, camera, dt);
    updateHud();
});
