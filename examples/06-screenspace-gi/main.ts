import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    diffuseColor,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    texture,
    vec4,
    velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import GUI from 'lil-gui';

import { FSR3Upscaler } from 'three-fsr3';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* The "complex" example: an expensive screen-space effect (GTAO / SSR / SSGI)
//* is rendered at REDUCED resolution via a TSL pass graph, and FSR3 upscales
//* the result to full size. The pass graph produces textures; FSR3 (a raw
//* compute pipeline) consumes them and owns the final present — so we drop the
//* pass graph's own temporal node (TRAA) and let FSR3 be the sole temporal
//* resolver, which doubles as the effect's temporal denoiser.

type Effect = 'gtao' | 'ssr' | 'ssgi';

const { renderer, dpr } = await bootRenderer();

//* Scene — a shallow "room" that flatters every effect: a glossy floor (SSR),
//* colored side walls for indirect bounce (SSGI), boxes as occluders (GTAO).
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);
addStudioLighting(scene);
scene.add(new THREE.AmbientLight(0x404860, 0.6));

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

const props: THREE.Mesh[] = [];
for (let i = 0; i < 5; i++) {
    const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 2 + i * 0.5, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
    );
    box.position.set(-5 + i * 2.5, 1 + i * 0.25, -6 + (i % 2) * 3);
    scene.add(box);
    props.push(box);
}
const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.5, roughness: 0.15 }),
);
ball.position.set(2, 1.6, -2);
scene.add(ball);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3, -5);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;

//* FSR3 — raw upscaler (this example drives the passes itself).
const upscaler = new FSR3Upscaler({ renderer });
upscaler.init();
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

//* Present quad.
const presentMat = new THREE.NodeMaterial();
presentMat.depthTest = false;
presentMat.depthWrite = false;
presentMat.fog = false;
const presentQuad = new THREE.QuadMesh(presentMat);

//* Composite quad — renders the low-res effect graph into the FSR3 color input.
const compositeMat = new THREE.NodeMaterial();
compositeMat.depthTest = false;
compositeMat.depthWrite = false;
compositeMat.fog = false;
const compositeQuad = new THREE.QuadMesh(compositeMat);

const state = { effect: 'gtao' as Effect, ratio: 2.0, rcasDenoise: true };

let colorRT: THREE.RenderTarget | null = null;
let scenePass: ReturnType<typeof pass> | null = null;

/** (Re)builds the pass graph, effect composite, and low-res color target. */
function configure(): void {
    const { width, height } = displaySize(dpr);
    const ratio = state.ratio;
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        customUpscaleRatio: ratio,
        path: 'temporal',
    });

    const rw = upscaler.renderWidth;
    const rh = upscaler.renderHeight;

    // Low-res color target the composite is rendered into (= FSR3 render res).
    colorRT?.dispose();
    colorRT = new THREE.RenderTarget(rw, rh, { type: THREE.HalfFloatType, depthBuffer: false });
    colorRT.texture.name = 'gi-color';

    //* G-buffer pass — MRT tailored to the selected effect. normalView is stored
    //* directly (float MRT), velocity feeds FSR3, depth is the pass's own buffer.
    const mrtInputs: Record<string, unknown> = { output, normal: normalView, velocity };
    if (state.effect === 'ssr') {
        // WebGPU caps color-attachment bytes/sample at 32 = four RGBA16Float
        // targets. output + normal + velocity is three; SSR's two material
        // scalars would push it to five (40 bytes) and blow the cap — so PACK
        // metalness + roughness into one vec4 attachment. (Same trick as ex. 09.)
        mrtInputs.material = vec4(metalness, roughness, 0, 0);
    } else if (state.effect === 'ssgi') {
        mrtInputs.diffuse = diffuseColor;
    }

    scenePass = pass(scene, camera);
    scenePass.setMRT(mrt(mrtInputs as never));
    // Render the scene (and the effect chained on it) at 1/ratio resolution.
    scenePass.setResolutionScale(1 / ratio);

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = scenePass.getTextureNode('normal');

    // three's addon effect nodes are typed as their concrete class, which
    // doesn't expose the swizzle/`getTextureNode` proxy members TSL adds at
    // runtime — cast through the swizzle-capable node object type.
    const sw = (n: unknown) => n as ReturnType<typeof vec4>;
    const texNode = (n: unknown) => (n as { getTextureNode(): unknown }).getTextureNode();

    let composite: ReturnType<typeof vec4>;
    if (state.effect === 'gtao') {
        const aoTex = sw(texNode(ao(depth, normal, camera)));
        composite = sw(beauty.mul(vec4(aoTex.r, aoTex.r, aoTex.r, 1)));
    } else if (state.effect === 'ssr') {
        // Unpack the material scalars from the single packed attachment (kept to
        // four MRT targets above to fit WebGPU's 32-byte/sample cap).
        const mat = sw(scenePass.getTextureNode('material'));
        const ssrTex = texNode(ssr(beauty, depth, normal, mat.r, mat.g, camera));
        // Reflection is additive over the beauty; spatial-denoise it first.
        const refl = sw(denoise(ssrTex as never, depth, normal, camera));
        composite = vec4(beauty.rgb.add(refl.rgb), beauty.a);
    } else {
        const giTex = texNode(ssgi(beauty, depth, normal, camera));
        const gi = sw(denoise(giTex as never, depth, normal, camera));
        const diffuse = scenePass.getTextureNode('diffuse');
        // color * AO + albedo * GI  (indirect diffuse recombination)
        composite = vec4(beauty.rgb.mul(gi.a).add(diffuse.rgb.mul(gi.rgb)), beauty.a);
    }

    compositeMat.colorNode = composite;
    compositeMat.needsUpdate = true;
    presentMat.colorNode = texture(upscaler.outputTexture);
    presentMat.needsUpdate = true;

    upscaler.resetHistory();
}
configure();

const gui = new GUI({ title: 'Screen-space → FSR3' });
gui.add(state, 'effect', { GTAO: 'gtao', SSR: 'ssr', SSGI: 'ssgi' }).name('effect').onChange(configure);
addRenderScale(gui, state, configure);
// The screen-space effects are noisy at reduced resolution — RCAS's denoise
// variant keeps the final sharpen from amplifying that grain.
gui.add(state, 'rcasDenoise').name('RCAS denoise');

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

const hud = document.getElementById('hud')!;
function updateHud(): void {
    hud.innerHTML =
        `<b>effect</b>   ${state.effect.toUpperCase()}\n` +
        `<b>render</b>   ${upscaler.renderWidth}×${upscaler.renderHeight}  (${basePercent(upscaler.upscaleRatio)})\n` +
        `<b>display</b>  ${upscaler.displayWidth}×${upscaler.displayHeight}  (${upscaler.upscaleRatio.toFixed(2)}x FSR3)`;
}

/** True once three has created the GPU texture behind a three Texture. */
function isBacked(tex: THREE.Texture | null | undefined): boolean {
    if (!tex) return false;
    const backend = renderer.backend as unknown as { get(t: THREE.Texture): { texture?: unknown } | undefined };
    return backend.get(tex)?.texture !== undefined;
}

//* Loop.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    controls.update();
    if (!colorRT || !scenePass) return;
    upscaler.settings.rcasDenoise = state.rcasDenoise;

    //* Render the low-res effect graph into colorRT (this also renders the
    //* scenePass, producing depth + velocity), jittered by FSR3. The pass
    //* graph compiles asynchronously on first use, so the depth/velocity GPU
    //* textures may not exist for a frame or two — feed FSR3 only once they do.
    upscaler.beginFrame(camera);
    renderer.setRenderTarget(colorRT);
    compositeQuad.render(renderer);
    renderer.setRenderTarget(null);
    upscaler.endFrame(camera);

    const depthTex = scenePass.renderTarget.depthTexture;
    const velocityTex = scenePass.getTexture('velocity');
    if (!isBacked(colorRT.texture) || !isBacked(depthTex) || !isBacked(velocityTex)) {
        return; // still warming up — skip this frame's upscale + present
    }

    //* Upscale: color from colorRT, depth + velocity from the pass graph.
    upscaler.dispatch(
        { color: colorRT.texture, depth: depthTex ?? undefined, velocity: velocityTex, deltaTime: dt },
        camera,
    );

    presentQuad.render(renderer);
    updateHud();
});
