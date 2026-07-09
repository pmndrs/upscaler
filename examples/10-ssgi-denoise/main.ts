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
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import GUI from 'lil-gui';

import { fsr3, type FSR3Upscaler } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* Kitchen sink, denoised-SSGI variant (a copy of 09 that leaves 09 untouched).
//*
//* SSGI is genuinely noisy: SSGINode's `useTemporalFiltering` only *rotates* the
//* sampling noise each frame for a downstream temporal resolver to average — it
//* is not a denoiser, so on its own the GI stays grainy. This demo runs the r185
//* recurrent spatiotemporal denoiser (`recurrentDenoise`, the same node that
//* cleans the SSR demo) over the GI in `diffuse` mode:
//*
//*   ssgi.getGINode() -> temporalReproject(velocity) -> recurrentDenoise -> composite
//*
//* KNOWN ISSUE (why the toggle defaults to `builtin`): with FSR3 jitter ON, the
//* recurrent path adds noise (bright/colored GI) and brings BACK aliasing. Root
//* cause is a temporal-resolver conflict: recurrentDenoise/temporalReproject
//* reproject history by *velocity*, which is jitter-free — so FSR3's sub-pixel
//* jitter misaligns their history every frame. They then (a) reject that
//* misaligned history → the GI noise survives, and (b) temporally stabilize the
//* signal, cancelling the very per-frame jitter variance FSR3 needs to
//* reconstruct → aliasing returns. It's the same reason this project never puts
//* TRAA before FSR3 (double-jitter). Making them coexist needs a jitter-aware
//* reprojection (hand the denoiser FSR3's offset), which is deferred — FSR3
//* itself is the priority, not bending every upstream node to it. Left here as a
//* documented A/B: `builtin` (raw SSGI, FSR3 resolves it — weak but stable) vs
//* `recurrent` (cleaner in theory, but see above). FSR3 stays the sole AA.

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
//* through the swizzle-capable node object type (same shim as example 06/09).
const sw = (n: unknown) => n as ReturnType<typeof vec4>;
const texNode = (n: unknown) => (n as { getTextureNode(): unknown }).getTextureNode();

const post = new THREE.PostProcessing(renderer);

const state = {
    ssgi: true,
    ssr: true,
    ratio: 2.0,
    rcasDenoise: true,
    jitter: true,
    ssgiSlices: 2,
    ssgiSteps: 8,
    // `builtin` = raw SSGI (stable, weak). `spatial` = recurrentDenoise as a
    // spatial-only à-trous with FSR3 owning all temporal (no jitter conflict).
    // `recurrent` = full spatiotemporal denoise (fights FSR3 jitter — see header).
    ssgiDenoiser: 'spatial' as 'recurrent' | 'builtin' | 'spatial',
};
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
    //* rides in normal.a and metalness in diffuse.a.
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
        const giPass = ssgi(beauty, depth, normal, camera);
        giPass.sliceCount.value = state.ssgiSlices;
        giPass.stepCount.value = state.ssgiSteps;
        const ao = sw(giPass.getAONode());
        const giRaw = giPass.getGINode();

        let gi;
        if (state.ssgiDenoiser === 'spatial') {
            //* "Share our temporal": run recurrentDenoise as a SPATIAL-ONLY à-trous
            //* (accumulate: false, no temporalReproject) so there is no second
            //* temporal stage and nothing is reprojected by velocity — FSR3 owns
            //* ALL temporal work. No jitter conflict; the denoiser just lowers the
            //* per-frame variance FSR3 then accumulates. This is the composition a
            //* jittered temporal upscaler actually wants: spatial clean → temporal.
            const giDenoise = recurrentDenoise(giRaw as never, camera, {
                depth: depth as never,
                normal: normal as never,
                raw: giRaw as never,
                mode: 'diffuse',
                accumulate: false,
            });
            gi = sw(giDenoise);
        } else if (state.ssgiDenoiser === 'recurrent') {
            //* Full spatiotemporal denoise: reproject along velocity, à-trous +
            //* temporally accumulate, feed the result back as history. Its own
            //* accumulation is what fights FSR3 jitter (see the header KNOWN ISSUE).
            const giReproj = temporalReproject(giRaw as never, depth as never, normal as never, vel as never, camera, {
                mode: 'diffuse',
            });
            const giDenoise = recurrentDenoise(giReproj as never, camera, {
                depth: depth as never,
                normal: normal as never,
                raw: giRaw as never,
                mode: 'diffuse',
                accumulate: true,
            });
            giReproj.setHistoryTexture(giDenoise as never);
            gi = sw(giDenoise);
        } else {
            //* Raw built-in path (SSGINode's own output) — grainy, resolved only
            //* by FSR3's accumulation. The A/B baseline.
            gi = sw(giRaw);
        }

        // beauty * AO  +  albedo * indirect-bounce
        rgb = beauty.rgb.mul(ao.r).add(diffuseTex.rgb.mul(gi.rgb));
    }
    if (state.ssr) {
        // Unpack material scalars (current-pixel reads inside SSR).
        const mtl = diffuseTex.a;
        const rgh = normal.a;
        // three r185 moved SSR's material scalars + camera into an options object.
        const ssrTex = texNode(ssr(beauty, depth, normal as never, { metalnessNode: mtl, roughnessNode: rgh, camera }));
        const refl = sw(denoise(ssrTex as never, depth, normal, camera));
        rgb = rgb.add(refl.rgb);
    }
    const composite = vec4(rgb, beauty.a);

    //* Pin the composite to a reduced-res texture (autoResize off) so the effects
    //* run at render res — then FSR3 upscales that to display size.
    const colorTex = convertToTexture(composite, rw, rh);

    // Dispose the previous node's upscaler before replacing the graph.
    (fsrNode as unknown as { dispose?(): void } | null)?.dispose?.();
    fsrNode = fsr3(colorTex, depth, vel, camera, { path: 'temporal', ratio, jitter: state.jitter });
    post.outputNode = fsrNode as unknown as THREE.Node;
    post.needsUpdate = true;
}
configure();

const gui = new GUI({ title: 'SSGI denoise A/B → FSR3' });
gui.add(state, 'ssgi').name('SSGI (indirect)').onChange(configure);
gui.add(state, 'ssgiDenoiser', {
    'spatial (FSR owns temporal)': 'spatial',
    'built-in (raw)': 'builtin',
    'recurrent (⚠ fights jitter)': 'recurrent',
})
    .name('SSGI denoiser')
    .onChange(configure);
gui.add(state, 'ssgiSlices', 1, 4, 1).name('SSGI slices').onChange(configure);
gui.add(state, 'ssgiSteps', 4, 16, 1).name('SSGI steps').onChange(configure);
gui.add(state, 'ssr').name('SSR (reflections)').onChange(configure);
addRenderScale(gui, state, configure);
gui.add(state, 'jitter').name('jitter (reconstruct)').onChange(configure);
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
        `<b>three-fsr3</b>  SSGI denoise A/B\n` +
        `effects  ${fx}\n` +
        `SSGI     ${state.ssgiDenoiser} · ${state.ssgiSlices} slices / ${state.ssgiSteps} steps\n` +
        `jitter   ${state.jitter ? 'on (reconstruct)' : 'off (stable)'}\n` +
        (u
            ? `render   ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
              `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x FSR3)`
            : '');
}

//* Loop.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    camera.position.set(Math.sin(t * 0.15) * 7, 4, 9 + Math.cos(t * 0.15) * 1.5);
    camera.lookAt(0, 3, -5);

    const u = (fsrNode as unknown as { upscaler?: FSR3Upscaler }).upscaler;
    if (u) u.settings.rcasDenoise = state.rcasDenoise;
    post.render();
    updateHud();
});
