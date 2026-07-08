import * as THREE from 'three/webgpu';
import {
    convertToTexture,
    diffuseColor,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    vec4,
    velocity,
} from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import GUI from 'lil-gui';

import { fsr3, type FSR3Upscaler } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* The "kitchen sink": a full screen-space stack — SSGI (indirect diffuse) + SSR
//* (glossy reflections) — rendered at REDUCED resolution and upscaled to display
//* size by FSR3, all as ONE TSL post graph:
//*
//*   pass(scene) → SSGI + SSR → denoise → composite → fsr3() → screen
//*
//* This is the whole-scene temporal path: the scene *and* both effects render at
//* 1/ratio, and FSR3 upscales the final composited frame. FSR3 doubles as the
//* effects' temporal resolver (their per-frame noise rotation converges under
//* FSR3's jittered accumulation) — so, like example 06, there is NO separate
//* TRAA. Because the composable `fsr3()` node registers its inputs as graph
//* dependencies, three renders the whole reduced-res chain in-pipeline, jittered,
//* right before the FSR compute — no manual driving.

const { renderer, dpr } = await bootRenderer();

//* Scene — a shallow "room": glossy floor (SSR), colored walls for indirect
//* bounce (SSGI), boxes + a sphere as occluders/reflectors.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);
addStudioLighting(scene);
scene.add(new THREE.AmbientLight(0x404860, 0.4));

const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x20242c, metalness: 0.9, roughness: 0.12 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const wallGeo = new THREE.BoxGeometry(20, 10, 0.4);
const leftWall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 }));
leftWall.position.set(-8, 5, -4);
leftWall.rotation.y = Math.PI / 2;
scene.add(leftWall);
const rightWall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness: 0.9 }));
rightWall.position.set(8, 5, -4);
rightWall.rotation.y = -Math.PI / 2;
scene.add(rightWall);
const backWall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9 }));
backWall.position.set(0, 5, -12);
scene.add(backWall);

for (let i = 0; i < 5; i++) {
    const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 2 + i * 0.5, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
    );
    box.position.set(-5 + i * 2.5, 1 + i * 0.25, -6 + (i % 2) * 3);
    scene.add(box);
}
const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.5, roughness: 0.15 }),
);
ball.position.set(2, 1.6, -2);
scene.add(ball);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4, 10);
camera.lookAt(0, 3, -5);

//* three's addon effect nodes are typed as their concrete class, which doesn't
//* expose the swizzle / getTextureNode proxy members TSL adds at runtime — cast
//* through the swizzle-capable node object type (same shim as example 06).
const sw = (n: unknown) => n as ReturnType<typeof vec4>;
const texNode = (n: unknown) => (n as { getTextureNode(): unknown }).getTextureNode();

const post = new THREE.PostProcessing(renderer);

const state = { ssgi: true, ssr: true, ratio: 2.0, rcasDenoise: true, jitter: true };
let fsrNode: ReturnType<typeof fsr3> | null = null;

/** (Re)builds the whole reduced-res post graph and points FSR3 at its output. */
function configure(): void {
    const { width, height } = displaySize(dpr);
    const ratio = state.ratio;
    // Reduced render resolution — matches PassNode's own floor(size / ratio).
    const rw = Math.max(1, Math.floor(width / ratio));
    const rh = Math.max(1, Math.floor(height / ratio));

    //* G-buffer pass at 1/ratio. WebGPU caps color-attachment bytes/sample at 32
    //* = four RGBA16Float targets, so we PACK the material channels: roughness
    //* rides in normal.a and metalness in diffuse.a. The effects only read
    //* normal.rgb / diffuse.rgb (they `.sample(uv).rgb`), and SSR reads
    //* metalness/roughness as current-pixel scalars — so the packing is free.
    //* depth is the pass's own depth buffer (not a color attachment).
    const scenePass = pass(scene, camera);
    scenePass.setMRT(
        mrt({
            output,
            velocity,
            normal: vec4(normalView, roughness), // .rgb = normal, .a = roughness
            diffuse: vec4(diffuseColor.rgb, metalness), // .rgb = albedo, .a = metalness
        }),
    );
    scenePass.setResolutionScale(1 / ratio);

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');
    const normal = scenePass.getTextureNode('normal');
    const diffuseTex = scenePass.getTextureNode('diffuse');

    //* Composite the enabled effects onto the beauty, all at reduced res.
    let rgb = beauty.rgb;
    if (state.ssgi) {
        const giTex = texNode(ssgi(beauty, depth, normal, camera));
        const gi = sw(denoise(giTex as never, depth, normal, camera));
        // beauty * AO (gi.a)  +  albedo * indirect-bounce (gi.rgb)
        rgb = beauty.rgb.mul(gi.a).add(diffuseTex.rgb.mul(gi.rgb));
    }
    if (state.ssr) {
        // Unpack material scalars (current-pixel reads inside SSR).
        const mtl = diffuseTex.a;
        const rgh = normal.a;
        const ssrTex = texNode(ssr(beauty, depth, normal, mtl, rgh, camera));
        const refl = sw(denoise(ssrTex as never, depth, normal, camera));
        rgb = rgb.add(refl.rgb);
    }
    const composite = vec4(rgb, beauty.a);

    //* Pin the composite to a reduced-res texture (autoResize off) so the effects
    //* run at render res — then FSR3 upscales that to display size. A plain
    //* convertToTexture(composite) would render it full-res, defeating the point.
    const colorTex = convertToTexture(composite, rw, rh);

    // Dispose the previous node's upscaler before replacing the graph.
    (fsrNode as unknown as { dispose?(): void } | null)?.dispose?.();
    // The whole scene renders in-graph under this node, so jitter is safe here
    // (the reduced pass IS re-rendered under the jittered projection each frame)
    // and buys sub-pixel reconstruction — the toggle lets you A/B it against the
    // non-jittered temporal upscale, which is the composable node's safe default.
    fsrNode = fsr3(colorTex, depth, vel, camera, { path: 'temporal', ratio, jitter: state.jitter });
    post.outputNode = fsrNode as unknown as THREE.Node;
    post.needsUpdate = true;
}
configure();

const gui = new GUI({ title: 'SSGI + SSR → FSR3' });
gui.add(state, 'ssgi').name('SSGI (indirect)').onChange(configure);
gui.add(state, 'ssr').name('SSR (reflections)').onChange(configure);
addRenderScale(gui, state, configure);
// Jitter buys sub-pixel reconstruction but needs the input re-rendered under
// the jittered projection each frame — safe here (the scene renders in-graph),
// off is the composable node's default for inputs you can't re-render jittered.
gui.add(state, 'jitter').name('jitter (reconstruct)').onChange(configure);
// The reduced-res effects are noisy — RCAS's denoise variant keeps the final
// sharpen from amplifying that grain.
gui.add(state, 'rcasDenoise').name('RCAS denoise');

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

const hud = document.getElementById('hud')!;
function updateHud(): void {
    const u = (fsrNode as unknown as { upscaler?: FSR3Upscaler }).upscaler;
    const fx = [state.ssgi && 'SSGI', state.ssr && 'SSR'].filter(Boolean).join(' + ') || 'none';
    hud.innerHTML =
        `<b>three-fsr3</b>  kitchen sink (node graph)\n` +
        `effects  ${fx}\n` +
        `jitter   ${state.jitter ? 'on (reconstruct)' : 'off (stable)'}\n` +
        (u
            ? `render   ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
              `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x FSR3)`
            : '');
}

//* Loop — the node graph renders the reduced-res scene + effects and runs FSR3
//* internally; we just orbit and render the post graph.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    // Gentle front-facing orbit so the camera stays *inside* the room (a full
    // 360° would swing it behind the walls into darkness) — and the slow motion
    // keeps the temporal history working.
    const t = clock.elapsedTime;
    camera.position.set(Math.sin(t * 0.15) * 7, 4, 9 + Math.cos(t * 0.15) * 1.5);
    camera.lookAt(0, 3, -5);

    const u = (fsrNode as unknown as { upscaler?: FSR3Upscaler }).upscaler;
    if (u) u.settings.rcasDenoise = state.rcasDenoise;
    post.render();
    updateHud();
});
