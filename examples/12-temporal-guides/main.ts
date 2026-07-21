import * as THREE from 'three/webgpu';
import { fract, mix, mrt, output, step, texture, uv, vec3, vec4, velocity } from 'three/tsl';

import { Upscaler } from '@pmndrs/upscaler';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* Temporal guides — the upscaler as a data-products provider.
// The frame is driven with the SPLIT dispatch: dispatchGuides() right after
// the G-buffer produces the geometry guides (dilated motion/depth,
// disocclusion) that other temporal effects (SSGI temporal passes, denoisers)
// can consume *before* the final color exists; dispatchUpscale() then
// finishes the frame. The 2×2 view samples the published guide textures
// straight from `upscaler.guides` as ordinary TSL texture() nodes — exactly
// the consumer contract (ping-ponged products are re-pointed per frame).

const { renderer, dpr } = await bootRenderer();

//* Scene — moving knot + orbiting spheres over a grid floor, so motion,
//* disocclusion trails, and depth all have something to show.
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

//* Upscaler — raw driver (no UpscalePass: we need the split dispatch).
const upscaler = new Upscaler({ renderer });
upscaler.init();
// Motion vectors must be jitter-free.
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

const mrtFull = mrt({ output, velocity });
let rt: THREE.RenderTarget | null = null;

function configure(): void {
    const { width, height } = displaySize(dpr);
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        customUpscaleRatio: 2,
        path: 'temporal',
    });

    rt?.dispose();
    const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
    depthTexture.type = THREE.FloatType;
    rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
        count: 2, // MUST match the MRT output count
        type: THREE.HalfFloatType,
        depthTexture,
    });
    // MRT routes node outputs to attachments BY TEXTURE NAME.
    rt.textures[0].name = 'output';
    rt.textures[1].name = 'velocity';
}
configure();

//* Present — one quad, 2×2 quadrants sampling the published guides.
// top-left: disocclusion   top-right: dilated depth
// bottom-left: final       bottom-right: dilated motion
const tile = uv().mul(2);
const local = fract(tile);
const right = step(1.0, tile.x);
const top = step(1.0, tile.y);

// Texture nodes are created once; ping-ponged guides (dilated depth) get
// their `.value` re-pointed every frame — the documented consumer pattern.
const finalNode = texture(upscaler.outputTexture, local);
const motionNode = texture(upscaler.guides.dilatedMotion, local);
const disocclusionNode = texture(upscaler.guides.disocclusion, local);
const depthNode = texture(upscaler.guides.dilatedDepth, local);

function refreshGuideNodes(): void {
    const guides = upscaler.guides;
    finalNode.value = upscaler.outputTexture;
    motionNode.value = guides.dilatedMotion;
    disocclusionNode.value = guides.disocclusion;
    depthNode.value = guides.dilatedDepth;
}

const motionVis = vec3(motionNode.xy.mul(40.0).add(0.5), 0.5);
const disocclusionVis = vec3(disocclusionNode.r);
// Linear eye-Z → a readable gradient (near bright, far dark).
const depthVis = vec3(depthNode.r.div(depthNode.r.add(8.0)).oneMinus());

// Note: the quad's uv v axis runs top-down on screen, so `top = 1` selects
// the LOWER half — order the rows accordingly.
const quadColor = mix(
    mix(disocclusionVis, depthVis, right), // screen top row
    mix(finalNode.rgb, motionVis, right), // screen bottom row
    top,
);
const quadMaterial = new THREE.NodeMaterial();
quadMaterial.colorNode = vec4(quadColor, 1.0);
quadMaterial.depthTest = false;
quadMaterial.depthWrite = false;
quadMaterial.fog = false;
const quad = new THREE.QuadMesh(quadMaterial);

const badge = document.getElementById('badge')!;
function updateBadge(): void {
    const reconstruct = upscaler.gpuTimings.get('reconstruct');
    badge.innerHTML =
        `<b>@pmndrs/upscaler</b>  temporal guides (split dispatch)\n` +
        `render   ${upscaler.renderWidth}×${upscaler.renderHeight}\n` +
        `display  ${upscaler.displayWidth}×${upscaler.displayHeight}  (${upscaler.upscaleRatio.toFixed(1)}x)\n` +
        `guides   dispatched post-G-buffer, pre-color\n` +
        (reconstruct !== undefined ? `reconstruct ${reconstruct.toFixed(3)} ms` : '');
}

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
    // configure() reallocates the working set — re-point every guide node.
    refreshGuideNodes();
});

// Exposed for the headless GPU-verification harness (drives the guides-only
// path against this page's live renderer + render target).
Object.assign(window as unknown as Record<string, unknown>, {
    __guidesExample: { upscaler, renderer, camera, Upscaler, getRenderTarget: () => rt },
});

//* Loop — the split frame.
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();

    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    for (let i = 0; i < spheres.length; i++) {
        const phase = t * 0.9 + (i * Math.PI * 2) / spheres.length;
        spheres[i].position.set(Math.cos(phase) * 3.4, 1.1 + Math.sin(t * 1.3 + i) * 0.4, Math.sin(phase) * 3.4);
    }
    camera.position.set(Math.cos(t * 0.12) * 9, 4.5, Math.sin(t * 0.12) * 9);
    camera.lookAt(0, 1.6, 0);

    //* 1. G-buffer: jittered scene render with color + velocity MRT.
    upscaler.beginFrame(camera);
    renderer.setMRT(mrtFull);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    upscaler.endFrame(camera);

    //* 2. Early stage: geometry guides, valid from here on.
    upscaler.dispatchGuides(
        { depth: rt!.depthTexture!, velocity: rt!.textures[1], deltaTime: dt },
        camera,
    );

    // (A real pipeline runs its guide-consuming effects here — SSGI temporal
    // reprojection, denoisers — then composites the final color.)

    //* 3. Late stage: accumulate + sharpen into outputTexture.
    upscaler.dispatchUpscale({ color: rt!.textures[0], deltaTime: dt }, camera);

    //* 4. Present the quadrants (re-point ping-ponged guides first).
    depthNode.value = upscaler.guides.dilatedDepth;
    quad.render(renderer);
    updateBadge();
});
