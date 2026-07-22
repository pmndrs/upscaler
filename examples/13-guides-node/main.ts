import * as THREE from 'three/webgpu';
import { convertToTexture, mix, mrt, output, pass, texture, vec3, vec4, velocity } from 'three/tsl';

import { temporalGuides, upscale, type TemporalGuidesNode, type Upscaler } from '@pmndrs/upscaler';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* Temporal guides as a TSL node — one computation, two consumers.
// `temporalGuides(depth, velocity, camera)` publishes the upscaler's guide
// products into the post graph; a toy effect tints the pre-upscale color
// wherever `disocclusion` fires (orange trailing silhouettes), and
// `upscale(..., { guides })` SHARES the guides node's upscaler — the frame
// runs split (guides dispatch → effect renders → late upscale), so the
// reconstruct pass runs once and serves both. The imperative twin of this
// wiring is `examples/12-temporal-guides`.

const { renderer, dpr } = await bootRenderer();

//* Scene — orbiting spheres + spinning knot, so disocclusion trails are
//* always live behind the movers.
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

const spheres: THREE.Mesh[] = [];
for (let i = 0; i < 3; i++) {
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 48, 24),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.2, roughness: 0.4 }),
    );
    scene.add(sphere);
    spheres.push(sphere);
}

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);

//* Post graph — rebuilt on resize (the reduced-res sizes are baked in).
const post = new THREE.PostProcessing(renderer);
const RATIO = 2;
let guidesNode: TemporalGuidesNode | null = null;
let fsrNode: ReturnType<typeof upscale> | null = null;

function configure(): void {
    const { width, height } = displaySize(dpr);
    const rw = Math.max(1, Math.floor(width / RATIO));
    const rh = Math.max(1, Math.floor(height / RATIO));

    //* Reduced-res scene pass with the color + velocity MRT.
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, velocity }));
    scenePass.setResolutionScale(1 / RATIO);

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const vel = scenePass.getTextureNode('velocity');

    // Dispose the previous graph's upscaler before replacing it. The linked
    // guides node shares the upscale node's upscaler, so fsrNode owns it.
    (fsrNode as unknown as { dispose?(): void } | null)?.dispose?.();
    (guidesNode as unknown as { dispose?(): void } | null)?.dispose?.();

    //* The guides node — same depth/velocity/camera as the upscale below.
    guidesNode = temporalGuides(depth, vel, camera);

    //* Toy consumer: paint the same-frame disocclusion product into the
    //* pre-upscale color. Any guide-fed effect (SSGI temporal reprojection,
    //* a denoiser's history rejection) slots in exactly here.
    const disocclusion = guidesNode.getTextureNode('disocclusion');
    const tinted = mix(beauty.rgb, vec3(1.0, 0.45, 0.15), disocclusion.r.mul(0.85));

    // Pin the effected color to render res (a bare convertToTexture would
    // render it full-res — see 09), then upscale with the SHARED computation.
    const colorTex = convertToTexture(vec4(tinted, beauty.a), rw, rh);
    fsrNode = upscale(colorTex, depth, vel, camera, { ratio: RATIO, guides: guidesNode });
    post.outputNode = fsrNode as unknown as THREE.Node;
    post.needsUpdate = true;
}
configure();

const badge = document.getElementById('badge')!;
function updateBadge(): void {
    const u = (fsrNode as unknown as { upscaler?: Upscaler | null })?.upscaler;
    const shared = u !== null && u !== undefined && guidesNode?.upscaler === u;
    const reconstruct = u?.gpuTimings.get('reconstruct');
    badge.innerHTML =
        `<b>@pmndrs/upscaler</b>  temporalGuides() + upscale({ guides })\n` +
        `orange = disocclusion guide, consumed pre-upscale\n` +
        (u
            ? `render   ${u.renderWidth}×${u.renderHeight}\n` +
              `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(1)}x)\n` +
              `shared upscaler: ${shared ? 'yes (split frame)' : 'NO'}\n` +
              (reconstruct !== undefined ? `reconstruct ${reconstruct.toFixed(3)} ms` : '')
            : '');
}

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

// Exposed for the headless GPU-verification harness (the tsl/THREE handles let
// it assemble a second, standalone guides graph against this live renderer).
Object.assign(window as unknown as Record<string, unknown>, {
    __guidesNodeExample: {
        renderer,
        camera,
        scene,
        THREE,
        temporalGuides,
        tsl: { pass, mrt, output, velocity, texture },
        get guidesNode() {
            return guidesNode;
        },
        get fsrNode() {
            return fsrNode;
        },
    },
});

//* Loop — the nodes drive the split frame; we just render the post graph.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();

    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    for (let i = 0; i < spheres.length; i++) {
        const phase = t * 0.9 + (i * Math.PI * 2) / spheres.length;
        spheres[i].position.set(Math.cos(phase) * 3.4, 1.1 + Math.sin(t * 1.3 + i) * 0.4, Math.sin(phase) * 3.4);
    }
    camera.position.set(Math.cos(t * 0.12) * 9, 4.5, Math.sin(t * 0.12) * 9);
    camera.lookAt(0, 1.6, 0);

    post.render();
    updateBadge();
});
