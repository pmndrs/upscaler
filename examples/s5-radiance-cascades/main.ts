import * as THREE from 'three/webgpu';
import { Fn, OnBeforeFrameUpdate, convertToTexture, velocity } from 'three/tsl';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RectAreaLightHelper as RectAreaLightHelperType } from 'three/addons/helpers/RectAreaLightHelper.js';
import GUI from 'lil-gui';

import { DebugView, upscale } from '@pmndrs/upscaler';

import { displaySize, showFatal } from '../shared/boot';
import { basePercent } from '../shared/ui';
import { RealtimeRadianceCascades } from './RealtimeRadianceCascades.js';

//* zalo's radiance cascades demo (three.js#35349) with its TRAA pass swapped for
//* the upscaler. The GI is the expensive part of the frame and nearly all of it
//* scales with the G-buffer's pixel count: one ray per 2×2 pixels, the probe
//* allocation per pixel, the final gather per pixel. So instead of resolving a
//* native-resolution G-buffer with TRAA, the cascades render their G-buffer at
//* 1/ratio and `upscale()` reconstructs the display image from it.
//*
//* The wiring mirrors the demo's TRAA wiring exactly. The cascades render their
//* own G-buffer inside the render pipeline (`OnBeforeFrameUpdate` in the Fn that
//* returns the composite), so the camera jitter the pipeline hook applies lands
//* on it; the composite is pinned to a render-size texture and handed to
//* `upscale()` with the G-buffer's depth and velocity. Two patches to the
//* vendored addon make that possible on three r186 (see its header).
//*
//*   TRAA:      G-buffer (native) → GI → composite (native) → traa() → screen
//*   Upscaler:  G-buffer (1/ratio) → GI → composite (1/ratio) → upscale() → screen

type Resolve = 'TRAA (native)' | 'Upscaler' | 'None (native)';
type ProbeBasis = 'display px' | 'render px';

// Assets the demo loads from three's examples folder, streamed from pinned
// commits (like example 14) so nothing binary lands in this repo.
const SPONZA_URL =
    'https://raw.githubusercontent.com/zalo/three.js/54250617f2724d034909080e576cfe3c6ab1a8b3/examples/models/gltf/Sponza.glb';
const SKY_URL =
    'https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/textures/equirectangular/blouberg_sunrise_2_1k.hdr';
const DRACO_DECODER_URL = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

//* Renderer — the tracing passes bind 9 storage buffers (one over the default
//* limit) and the probes need storage buffers larger than the default 128 MB,
//* so this asks for the adapter's limits (as the demo does) instead of using
//* the shared bootRenderer().
if (!navigator.gpu) {
    showFatal('WebGPU is not available in this browser — try Chrome/Edge 113+.');
    throw new Error('WebGPU unavailable');
}
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
    showFatal('No WebGPU adapter.');
    throw new Error('No WebGPU adapter');
}
const renderer = new THREE.WebGPURenderer({
    antialias: false,
    powerPreference: 'high-performance',
    // GI compute time is read from three's timestamp queries.
    trackTimestamp: true,
    requiredLimits: {
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
    },
});
// The demo caps the pixel ratio at 1: the probes' memory scales with the canvas
// (539 MB at 1600×900). Kept, so both resolves draw the same display pixels.
const dpr = 1;
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
await renderer.init();
if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    showFatal('three fell back to the WebGL backend — this example needs real WebGPU.');
    throw new Error('WebGL fallback active');
}

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const renderPipeline = new THREE.RenderPipeline(renderer);

//* State
const params = {
    scene: 'Sponza',
    resolve: 'Upscaler' as Resolve,
    ratio: 2,
    probeBasis: 'display px' as ProbeBasis,
    view: 'Lit',
    rays: '1 per 4 pixels',
    // Off by default (the demo's default is on): adaptive quality trades GI
    // quality for frame rate, which would hide exactly the difference this
    // example measures.
    adaptiveQuality: false,
    quality: 1,
    halfResolution: false,
    secondary: true,
    smoothing: 0.97,
    probeSize: 12,
    intensity: 1,
    sunAngle: 40,
    animateSun: false,
    autoRotate: false,
    sharpness: 0.8,
    debug: DebugView.None as DebugView,
};

const rayStrides: Record<string, number> = { '1 per 4 pixels': 2, '1 per pixel': 1 };
const views: Record<string, number> = { Lit: 0, Indirect: 1, Irradiance: 2, Probes: 3, Levels: 4 };

interface World {
    root: THREE.Group;
    background?: THREE.Color | THREE.Texture;
    camera: THREE.Vector3;
    target: THREE.Vector3;
    levelDistance: number;
    fov?: number;
    exposure?: number;
    sun?: THREE.DirectionalLight;
    sunAzimuth?: [number, number];
    sunAngle?: number;
    sunDistance?: number;
}

const scenes: Record<string, () => Promise<World>> = {
    Sponza: createSponza,
    Courtyard: createCourtyard,
    'Cornell Box': () => createCornellBox('panel'),
    'Cornell Box (Rect Area Light)': () => createCornellBox('rect'),
    'Cornell Box (Spot Light)': () => createCornellBox('spot'),
};

const scene = new THREE.Scene();
let world: World | null = null;
let cascades: RealtimeRadianceCascades | null = null;

const hud = document.getElementById('hud')!;
let status = 'Loading…';

//* Output graph — rebuilt when the cascades rebuild their passes (a new
//* composite node), the resolve changes, or the render size changes.
let builtComposite: unknown = null;
let builtKey = '';
let traaNode: ReturnType<typeof traa> | null = null;
let colorTexture: ReturnType<typeof convertToTexture> | null = null;
let fsrNode: ReturnType<typeof upscale> | null = null;
const _size = new THREE.Vector2();

/** The G-buffer size: native for TRAA/None, 1/ratio of the display for the upscaler. */
function renderSize(): { width: number; height: number } {
    renderer.getDrawingBufferSize(_size);
    const scale = params.resolve === 'Upscaler' ? params.ratio : 1;
    // Same floor as PassNode / example 09, so the upscaler's input is exactly this.
    return { width: Math.max(1, Math.floor(_size.x / scale)), height: Math.max(1, Math.floor(_size.y / scale)) };
}

function updateOutput(): void {
    if (!cascades) return;
    const upscaling = params.resolve === 'Upscaler';
    const { width, height } = renderSize();

    // Both temporal resolves read the G-buffer's velocity; `velocity` rebuilds
    // the cascades' passes, so the composite below may be a new node.
    cascades.velocity = params.resolve !== 'None (native)';
    cascades.renderSize = upscaling ? { x: width, y: height } : null;
    const composite = cascades.getCompositeNode();
    const key = `${params.resolve}|${width}x${height}`;
    if (composite === builtComposite && key === builtKey) return;
    builtComposite = composite;
    builtKey = key;

    // The previous graph's private textures and upscaler go with it.
    traaNode?.beautyNode.dispose();
    traaNode?.dispose();
    traaNode = null;
    fsrNode?.dispose();
    fsrNode = null;
    colorTexture?.dispose();
    colorTexture = null;
    // upscale() pins the shared velocity node to its unjittered projection;
    // release it so TRAA (which manages it per frame) or nothing owns it next.
    velocity.setProjectionMatrix(null);

    const cc = cascades;
    // The cascades render their G-buffer and run their passes in the render
    // pipeline, before the composite, so the camera jitter that TRAA or the
    // upscaler applies for the pipeline lands on the G-buffer.
    const frameNode = Fn(() => {
        OnBeforeFrameUpdate(() => cc.update(renderer, scene, camera));
        return composite;
    })();

    let output: THREE.Node;
    if (params.resolve === 'TRAA (native)') {
        traaNode = traa(frameNode, cc.getTextureNode('depth'), cc.getTextureNode('velocity'), camera);
        // r186 shim: TRAA copies the input depth into its history, which r186
        // makes depth32float only under a reversed depth buffer — the cascades'
        // G-buffer depth is always float, so the copy fails validation every
        // frame (three's dev branch keeps the depth history apart). Private.
        (traaNode as unknown as { _historyRenderTarget: THREE.RenderTarget })._historyRenderTarget.depthTexture!.type =
            THREE.FloatType;
        output = traaNode;
    } else if (upscaling) {
        // Pinned to the render size (autoResize off): a plain convertToTexture()
        // would render the composite at display size, defeating the point.
        colorTexture = convertToTexture(frameNode, width, height);
        fsrNode = upscale(colorTexture, cc.getTextureNode('depth'), cc.getTextureNode('velocity'), camera, {
            path: 'temporal',
            ratio: params.ratio,
            gpuTiming: true,
        });
        output = fsrNode;
    } else {
        output = frameNode;
    }
    renderPipeline.outputNode = output;
    renderPipeline.needsUpdate = true;
}

//* Scene switching — ported from the demo.
async function setScene(): Promise<void> {
    status = `Loading ${params.scene}…`;
    const previous: THREE.Object3D[] = [];
    world?.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Light).isLight) previous.push(o);
    });

    let next: World;
    try {
        next = await scenes[params.scene]();
    } catch (error) {
        status = `${params.scene} could not be loaded: ${(error as Error).message ?? error}`;
        return;
    }

    // Building the BVH of a large scene blocks the page for a while; show it first.
    status = `Building the BVH of ${params.scene}…`;
    updateHud();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

    world = next;
    scene.clear();
    scene.background = world.background ?? new THREE.Color(0);
    scene.add(world.root);

    const used = new Set<unknown>();
    world.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh || (o as THREE.Line).isLine) used.add(m.geometry).add(m.material);
        else used.add(o);
    });
    for (const o of previous) {
        if ((o as THREE.Light).isLight) {
            if (!used.has(o)) (o as THREE.Light).dispose();
        } else {
            const m = o as THREE.Mesh;
            if (!used.has(m.geometry)) m.geometry.dispose();
            if (!used.has(m.material)) (m.material as THREE.Material).dispose();
        }
    }

    camera.position.copy(world.camera);
    camera.fov = world.fov ?? 50;
    camera.updateProjectionMatrix();
    controls.target.copy(world.target);
    controls.update();

    renderer.toneMappingExposure = world.exposure ?? 1;
    if (world.sunAngle !== undefined) params.sunAngle = world.sunAngle;

    if (!cascades) {
        cascades = new RealtimeRadianceCascades({ ...probeLayout(), ...cascadeOptions() });
        cascades.mode.value = views[params.view];
        cascades.intensity.value = params.intensity;
        updateQuality();
    } else {
        Object.assign(cascades, probeLayout(), cascadeOptions());
    }

    const start = performance.now();
    cascades.setScene(renderer, scene);
    updateOutput();
    updateSun();
    status = `BVH built in ${(performance.now() - start).toFixed(0)} ms, ${(cascades.memory / 2 ** 20).toFixed(0)} MB of probes`;
}

/**
 * The probes are about `probeSize` pixels wide at the far edge of each level of
 * detail. "display px" sizes them on the display, so the GI is the same in
 * world space whatever the render scale and only the ray count drops with it;
 * "render px" sizes them on the G-buffer (the demo's own behaviour, where the
 * two are the same), so the probes coarsen — and cheapen — with the render scale.
 */
function probeLayout(): Partial<RealtimeRadianceCascades> {
    renderer.getDrawingBufferSize(_size);
    const scale = params.probeBasis === 'render px' && params.resolve === 'Upscaler' ? params.ratio : 1;
    const w = _size.x / scale;
    const h = _size.y / scale;
    const focal = h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tiles = (w * h) / params.probeSize ** 2;
    const levelDistance = world!.levelDistance;
    return {
        levelDistance: levelDistance / 8,
        levels: 11,
        spacing: ((levelDistance / 8) * params.probeSize) / focal,
        maxProbes: Math.max(4096, Math.ceil(tiles * 4.5)),
    };
}

function cascadeOptions(): Partial<RealtimeRadianceCascades> {
    return {
        rayStride: rayStrides[params.rays],
        secondary: params.secondary,
        blendingRadius: 2,
        orientations: true,
        qualityDecay: params.smoothing,
    };
}

function updateCascades(): void {
    if (cascades) Object.assign(cascades, cascadeOptions());
}

function updateProbeLayout(): void {
    if (cascades && world) Object.assign(cascades, probeLayout());
}

function updateQuality(): void {
    if (!cascades) return;
    cascades.adaptiveQuality = params.adaptiveQuality;
    cascades.quality = params.quality;
    cascades.halfResolution = params.halfResolution;
}

function updateSun(): void {
    const sun = world?.sun;
    if (!sun || !world) return;
    const angle = THREE.MathUtils.degToRad(params.sunAngle);
    const [x, z] = world.sunAzimuth ?? [0.5, 0.6];
    sun.position
        .set(Math.cos(angle) * x, Math.sin(angle), Math.cos(angle) * z)
        .normalize()
        .multiplyScalar(world.sunDistance ?? 30)
        .add(sun.target.position);
    sun.shadow.needsUpdate = true;
}

//* Scenes — ported verbatim from the demo.
let sponza: Promise<THREE.Group> | null = null;
let sky: Promise<THREE.Texture> | null = null;
let rectAreaLights: Promise<typeof RectAreaLightHelperType> | null = null;

async function createCornellBox(light: 'panel' | 'rect' | 'spot'): Promise<World> {
    const root = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const green = new THREE.MeshStandardMaterial({ color: 0x00ff00 });

    function wall(w: number, h: number, m: THREE.Material, x: number, y: number, z: number, rx: number, ry: number) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx, ry, 0);
        root.add(mesh);
    }
    wall(6, 6, white, 0, 0, 0, -Math.PI / 2, 0);
    wall(6, 6, white, 0, 5, 0, Math.PI / 2, 0);
    wall(6, 5, white, 0, 2.5, -3, 0, 0);
    wall(6, 5, white, 0, 2.5, 3, 0, Math.PI);
    wall(6, 5, red, -3, 2.5, 0, 0, Math.PI / 2);
    wall(6, 5, green, 3, 2.5, 0, 0, -Math.PI / 2);

    const tallBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.5, 1.2), new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
    tallBox.position.set(-0.8, 1.25, -0.8);
    tallBox.rotation.y = Math.PI / 8;
    root.add(tallBox);

    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.65, 32, 32),
        new THREE.MeshStandardMaterial({ color: 0x0044ff, roughness: 0.15 }),
    );
    sphere.position.set(1, 0.65, 0.5);
    root.add(sphere);

    if (light === 'rect') {
        rectAreaLights ??= Promise.all([
            import('three/addons/lights/RectAreaLightTexturesLib.js'),
            import('three/addons/helpers/RectAreaLightHelper.js'),
        ]).then(([{ RectAreaLightTexturesLib }, { RectAreaLightHelper }]) => {
            THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
            return RectAreaLightHelper;
        });
        const RectAreaLightHelper = await rectAreaLights;
        const rect = new THREE.RectAreaLight(0xffffff, 20, 2, 2);
        rect.rotation.x = -Math.PI / 2;
        rect.position.y = 4.99;
        rect.add(new RectAreaLightHelper(rect));
        root.add(rect);
    } else if (light === 'spot') {
        const spot = new THREE.SpotLight(0xffffff, 80, 0, Math.PI / 6, 0.5);
        spot.position.set(0, 4.9, 0);
        spot.castShadow = true;
        spot.shadow.mapSize.setScalar(1024);
        spot.shadow.bias = -0.0005;
        spot.shadow.autoUpdate = false;
        root.add(spot, spot.target);
    } else {
        const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 20 }),
        );
        panel.rotation.x = Math.PI / 2;
        panel.position.y = 4.99;
        root.add(panel);
    }

    return {
        root,
        background: new THREE.Color(0x111111),
        camera: new THREE.Vector3(0, 2.5, 8),
        target: new THREE.Vector3(0, 2.5, 0),
        levelDistance: 4,
    };
}

async function createCourtyard(): Promise<World> {
    const background = await loadSky();
    const root = new THREE.Group();

    const stone = new THREE.MeshStandardMaterial({ color: 0xddd0b8 });
    const plaster = new THREE.MeshStandardMaterial({ color: 0xd9a066 });
    const tiles = new THREE.MeshStandardMaterial({ color: 0xb59a7e });
    const water = new THREE.MeshStandardMaterial({ color: 0x3c7a8a });
    const leaves = new THREE.MeshStandardMaterial({ color: 0x4a7a32 });
    const banners = [0xb02a20, 0x2a4ab0, 0xd8a020, 0x2a8a50].map((color) => new THREE.MeshStandardMaterial({ color }));

    function add(parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) {
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(x, y, z);
        parent.add(mesh);
        return mesh;
    }

    const arches = [-4.5, -1.5, 1.5, 4.5];
    const facadeShape = new THREE.Shape().moveTo(-6.5, 0);
    for (const x of arches)
        facadeShape
            .lineTo(x - 1, 0)
            .lineTo(x - 1, 2.4)
            .absarc(x, 2.4, 1, Math.PI, 0, true)
            .lineTo(x + 1, 0);
    facadeShape.lineTo(6, 0).lineTo(6, 7.5).lineTo(-6.5, 7.5).closePath();
    for (const x of arches)
        facadeShape.holes.push(
            new THREE.Path()
                .moveTo(x + 0.9, 5.2)
                .lineTo(x + 0.9, 5.8)
                .absarc(x, 5.8, 0.9, 0, Math.PI)
                .lineTo(x - 0.9, 5.2)
                .closePath() as THREE.Path,
        );

    const facade = new THREE.ExtrudeGeometry(facadeShape, { depth: 0.5, bevelEnabled: false, curveSegments: 16 });
    const floorSlab = new THREE.BoxGeometry(15.5, 0.3, 2.5);
    const roof = new THREE.BoxGeometry(15.2, 0.3, 3.8);
    const banner = new THREE.PlaneGeometry(0.7, 2.4);

    for (let i = 0; i < 4; i++) {
        const wing = new THREE.Group();
        wing.rotation.y = (-i * Math.PI) / 2;
        root.add(wing);
        add(wing, facade, stone, 0, 0, -6.5);
        add(wing, floorSlab, stone, -1.25, 4.15, -7.75);
        add(wing, roof, stone, -1.9, 7.65, -7.6);
        for (const x of [-3, 0, 3]) add(wing, banner, banners[i], x, 6.25, -5.95);
    }

    add(root, new THREE.PlaneGeometry(19, 19), tiles, 0, 0, 0).rotation.x = -Math.PI / 2;

    const octagon = (radius: number) =>
        Array.from({ length: 8 }, (_v, i) =>
            new THREE.Vector2(radius, 0).rotateAround(new THREE.Vector2(), ((i + 0.5) * Math.PI) / 4),
        );
    const basin = new THREE.Shape(octagon(1.9));
    basin.holes.push(new THREE.Path(octagon(1.6)));
    add(root, new THREE.ExtrudeGeometry(basin, { depth: 0.55, bevelEnabled: false }), stone, 0, 0, 0).rotation.x =
        -Math.PI / 2;
    add(root, new THREE.ShapeGeometry(new THREE.Shape(octagon(1.6))), water, 0, 0.4, 0).rotation.x = -Math.PI / 2;
    add(root, new THREE.CylinderGeometry(0.2, 0.3, 1.3, 16), stone, 0, 0.65, 0);
    add(root, new THREE.CylinderGeometry(0.8, 0.3, 0.3, 16), stone, 0, 1.45, 0);
    add(root, new THREE.SphereGeometry(0.25, 16, 12), stone, 0, 1.85, 0);

    for (const [x, z] of [
        [-4.6, -4.6],
        [4.6, -4.6],
        [4.6, 4.6],
        [-4.6, 4.6],
    ]) {
        add(root, new THREE.BoxGeometry(1.2, 0.6, 1.2), plaster, x, 0.3, z);
        add(root, new THREE.ConeGeometry(0.55, 3.2, 12), leaves, x, 2.2, z);
    }

    return {
        root,
        background,
        camera: new THREE.Vector3(-5.6, 1.6, 1.5),
        target: new THREE.Vector3(3, 3.4, -2.5),
        levelDistance: 6,
    };
}

async function createSponza(): Promise<World> {
    // chandra's Sponza in Y-up meters, one flat color per material; its red and
    // cyan curtains are emitters, with chandra's albedo of 0.7.
    sponza ??= new GLTFLoader()
        .setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_DECODER_URL))
        .loadAsync(SPONZA_URL)
        .then((gltf) => {
            gltf.scene.traverse((o) => {
                const mesh = o as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.castShadow = mesh.receiveShadow = true;
                const material = mesh.material as THREE.MeshStandardMaterial;
                if (material.name === 'emitter_red') material.emissive.setRGB(1, 0, 0).multiplyScalar(10 * 0.7);
                if (material.name === 'emitter_cyan') material.emissive.setRGB(0, 1, 1).multiplyScalar(7 * 0.7);
            });
            return gltf.scene;
        });

    const [model, background] = await Promise.all([sponza, loadSky()]);
    const root = new THREE.Group();
    root.add(model);

    const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
    const sun = new THREE.DirectionalLight(0xffffff, 10 * Math.PI);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(4096);
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -sphere.radius;
    cam.right = cam.top = sphere.radius;
    cam.near = 0.5;
    cam.far = sphere.radius * 2 + 1;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    sun.target.position.copy(sphere.center);
    root.add(sun, sun.target);
    // The scene doesn't move: the shadow map re-renders only when the sun does.
    sun.shadow.autoUpdate = false;

    const toSun = new THREE.Vector3(0.5, 1, 0.1).normalize();
    const azimuth = new THREE.Vector2(toSun.x, toSun.z).normalize();
    const position = new THREE.Vector3(-9.372, 6.134, -0.945);

    return {
        root,
        sun,
        background,
        camera: position,
        target: new THREE.Vector3(0.879, -0.457, 0.136).multiplyScalar(6).add(position),
        levelDistance: 8,
        fov: THREE.MathUtils.radToDeg(1.15),
        exposure: 0.3,
        sunAzimuth: [azimuth.x, azimuth.y],
        sunAngle: THREE.MathUtils.radToDeg(Math.asin(toSun.y)),
        sunDistance: sphere.radius + 0.5,
    };
}

function loadSky(): Promise<THREE.Texture> {
    sky ??= new HDRLoader().loadAsync(SKY_URL).then((texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        return texture;
    });
    return sky;
}

//* GUI
const gui = new GUI({ title: 'Radiance cascades → upscale' });
gui.add(params, 'scene', Object.keys(scenes)).name('scene').onChange(setScene);

const resolveFolder = gui.addFolder('Resolve');
resolveFolder
    .add(params, 'resolve', ['TRAA (native)', 'Upscaler', 'None (native)'] satisfies Resolve[])
    .name('resolve')
    .listen()
    .onChange(() => {
        updateProbeLayout();
        updateOutput();
    });
resolveFolder
    .add(params, 'ratio', 1, 3, 0.05)
    .name('render scale ×')
    .listen()
    .onChange(() => {
        if (params.probeBasis === 'render px') updateProbeLayout();
        updateOutput();
    });
resolveFolder.add(params, 'probeBasis', ['display px', 'render px'] satisfies ProbeBasis[]).name('probes sized in').onChange(updateProbeLayout);
resolveFolder.add(params, 'sharpness', 0, 1, 0.01).name('RCAS sharpness');
resolveFolder
    .add(params, 'debug', {
        Off: DebugView.None,
        'Motion vectors': DebugView.MotionVectors,
        Disocclusion: DebugView.Disocclusion,
        Depth: DebugView.Depth,
        'Accumulation age': DebugView.AccumulationAge,
        Locks: DebugView.Locks,
        Exposure: DebugView.Exposure,
        'Shading change': DebugView.ShadingChange,
    })
    .name('upscaler debug view');
resolveFolder.add({ benchmark: () => void runBenchmark() }, 'benchmark').name('▶ benchmark TRAA vs upscaler');

const qualityFolder = gui.addFolder('GI quality');
qualityFolder.add(params, 'probeSize', [6, 8, 12, 16]).name('probe size (px)').onChange(updateProbeLayout);
qualityFolder.add(params, 'rays', Object.keys(rayStrides)).name('rays').onChange(updateCascades);
qualityFolder.add(params, 'smoothing', 0, 1, 0.01).name('temporal smoothing').onChange(updateCascades);
qualityFolder
    .add(params, 'quality', 0, 1, 0.01)
    .name('quality')
    .onChange(() => {
        params.adaptiveQuality = false;
        updateQuality();
    })
    .listen();
qualityFolder.add(params, 'adaptiveQuality').name('adaptive quality').onChange(updateQuality).listen();
qualityFolder
    .add(params, 'halfResolution')
    .name('half-res shading')
    .onChange(() => {
        params.adaptiveQuality = false;
        updateQuality();
    })
    .listen();
qualityFolder.add(params, 'secondary').name('secondary bounces').onChange(updateCascades);

const viewFolder = gui.addFolder('Visualization');
viewFolder
    .add(params, 'view', Object.keys(views))
    .name('view')
    .onChange(() => {
        if (cascades) cascades.mode.value = views[params.view];
    });
viewFolder
    .add(params, 'intensity', 0, 4)
    .name('indirect')
    .onChange(() => {
        if (cascades) cascades.intensity.value = params.intensity;
    });
viewFolder.add(params, 'sunAngle', 5, 175).name('sun angle').onChange(updateSun).listen();
viewFolder.add(params, 'animateSun').name('animate sun');
viewFolder
    .add(params, 'autoRotate')
    .name('auto rotate')
    .onChange(() => (controls.autoRotate = params.autoRotate));
viewFolder.close();

//* Timing — frame intervals for FPS, plus GPU time of the GI compute (the
//* cascades' own timestamp read) and of the upscale (its per-pass timings).
const intervals: number[] = [];
let lastFrame = 0;
let giMs: number | null = null;
let readingGi = false;
// Samples gathered while a benchmark segment is measuring.
let sampling: { intervals: number[]; gi: number[]; upscale: number[] } | null = null;

function upscaleMs(): number | null {
    const timings = fsrNode?.upscaler?.gpuTimings;
    if (!timings || timings.size === 0) return null;
    let sum = 0;
    for (const ms of timings.values()) sum += ms;
    return sum;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

function sampleTimings(now: number): void {
    if (lastFrame) {
        intervals.push(now - lastFrame);
        if (intervals.length > 60) intervals.shift();
        sampling?.intervals.push(now - lastFrame);
    }
    lastFrame = now;

    // Resolve every frame so neither query pool fills; the GI read is the
    // cascades' compute uid, the render pool is resolved only to drain it.
    if (cascades && !readingGi) {
        readingGi = true;
        void renderer.resolveTimestampsAsync('render');
        cascades
            .readGPUTime(renderer)
            .then((ms) => {
                if (ms !== null) {
                    giMs = ms;
                    sampling?.gi.push(ms);
                }
            })
            .finally(() => (readingGi = false));
    }
    const up = upscaleMs();
    if (up !== null) sampling?.upscale.push(up);
}

//* Benchmark — the same view, still camera, fixed GI quality: each resolve
//* warms up (history + probe re-convergence) and is then measured.
interface BenchRow {
    label: string;
    render: string;
    fps: number;
    frameMs: number;
    giMs: number;
    upscaleMs: number | null;
}
let benchRows: BenchRow[] | null = null;
let benchRunning = false;

async function runBenchmark(): Promise<void> {
    if (benchRunning || !cascades) return;
    benchRunning = true;
    const saved = {
        resolve: params.resolve,
        adaptiveQuality: params.adaptiveQuality,
        autoRotate: params.autoRotate,
        animateSun: params.animateSun,
    };
    params.adaptiveQuality = false;
    params.autoRotate = controls.autoRotate = false;
    params.animateSun = false;
    updateQuality();

    const segments: { label: string; resolve: Resolve }[] = [
        { label: 'TRAA, native', resolve: 'TRAA (native)' },
        { label: `upscaler ${params.ratio.toFixed(2)}×`, resolve: 'Upscaler' },
    ];
    const rows: BenchRow[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const segment of segments) {
        status = `benchmark: ${segment.label}…`;
        params.resolve = segment.resolve;
        updateProbeLayout();
        updateOutput();
        await wait(2500);
        sampling = { intervals: [], gi: [], upscale: [] };
        await wait(5000);
        const s = sampling;
        sampling = null;
        const frameMs = s.intervals.reduce((a, b) => a + b, 0) / Math.max(1, s.intervals.length);
        const { width, height } = renderSize();
        rows.push({
            label: segment.label,
            render: `${width}×${height}`,
            fps: 1000 / frameMs,
            frameMs,
            giMs: median(s.gi),
            upscaleMs: s.upscale.length ? median(s.upscale) : null,
        });
    }
    benchRows = rows;

    params.resolve = saved.resolve;
    params.adaptiveQuality = saved.adaptiveQuality;
    params.autoRotate = controls.autoRotate = saved.autoRotate;
    params.animateSun = saved.animateSun;
    updateQuality();
    updateProbeLayout();
    updateOutput();
    status = 'benchmark done';
    benchRunning = false;
}

function fmt(ms: number | null): string {
    return ms === null || Number.isNaN(ms) ? '—' : `${ms.toFixed(2)} ms`;
}

function updateHud(): void {
    const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const { width, height } = displaySize(dpr);
    const r = renderSize();
    const up = upscaleMs();
    let text =
        `<b>radiance cascades</b>  ${params.resolve === 'Upscaler' ? 'upscaled' : params.resolve}\n` +
        `display  ${width}×${height}\n` +
        `render   ${r.width}×${r.height}` +
        (params.resolve === 'Upscaler' ? `  (${basePercent(params.ratio)})` : '') +
        '\n' +
        `fps      ${mean ? (1000 / mean).toFixed(1) : '—'}  (${mean ? mean.toFixed(2) : '—'} ms/frame)\n` +
        `GI GPU   ${fmt(giMs)}` +
        (params.resolve === 'Upscaler' ? `\nupscale  ${fmt(up)}` : '') +
        (cascades ? `\nquality  ${cascades.quality.toFixed(2)}${cascades.halfResolution ? ' half-res' : ''}` : '') +
        `\n<span class="dim">${status}</span>`;
    if (benchRows) {
        text += '\n\n<b>benchmark</b> <span class="dim">(still camera, fixed quality)</span>';
        for (const row of benchRows)
            text +=
                `\n${row.label.padEnd(18)} ${row.render.padStart(9)}  ` +
                `${row.fps.toFixed(1).padStart(5)} fps  GI ${fmt(row.giMs)}` +
                (row.upscaleMs !== null ? ` + up ${fmt(row.upscaleMs)}` : '');
        text +=
            '\n<span class="dim">fps is capped at the display refresh; GPU ms is the uncapped cost.</span>';
    }
    hud.innerHTML = text;
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Headless-verification handle (CDP harness), like examples 09/12/13.
(window as unknown as Record<string, unknown>).__rcExample = {
    THREE,
    renderer,
    camera,
    controls,
    params,
    get cascades() {
        return cascades;
    },
    get upscaler() {
        return fsrNode?.upscaler ?? null;
    },
    get benchRows() {
        return benchRows;
    },
    get giMs() {
        return giMs;
    },
    runBenchmark,
    updateOutput,
    updateProbeLayout,
    setScene,
};

await setScene();

renderer.setAnimationLoop((now: number) => {
    if (!cascades) return;
    controls.update();
    if (params.animateSun) {
        params.sunAngle = 90 + Math.sin(performance.now() / 4000) * 70;
        updateSun();
    }

    const u = fsrNode?.upscaler;
    if (u) {
        u.settings.sharpness = params.sharpness;
        u.settings.debugView = params.debug;
    }
    // The pipeline's output transform reads the renderer's tone mapping: drop it
    // while an upscaler debug view is up so the view shows raw values.
    renderer.toneMapping =
        params.resolve === 'Upscaler' && params.debug !== DebugView.None
            ? THREE.NoToneMapping
            : THREE.ACESFilmicToneMapping;

    // Options apply before the pipeline renders the G-buffer this frame.
    updateOutput();
    renderPipeline.render();

    if (cascades.adaptiveQuality) {
        params.quality = Math.round(cascades.quality * 100) / 100;
        params.halfResolution = cascades.halfResolution;
    }
    sampleTimings(now);
    updateHud();
});
