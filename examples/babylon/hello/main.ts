import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphImageProcessingTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask.js';
import { FrameGraphClearTextureTask } from '@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js';
import { backbufferColorTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Scene } from '@babylonjs/core/scene.js';
// Deep imports skip Babylon's side-effect registrations: the WebGPU engine
// extensions (render targets, multi-render for the geometry renderer) load here.
import '@babylonjs/core/Engines/WebGPU/Extensions/index.js';

import { DebugView, FrameGraphUpscaleTask, QualityMode, Upscaler, type UpscalePath } from '@pmndrs/upscaler/babylon';

/**
 * The Babylon adapter in a frame graph: a geometry renderer writes linear HDR
 * color, depth and linear velocity at render resolution, the upscale task
 * runs the core on Babylon's device, and image processing presents the
 * output. The jitter goes through Babylon's TAAMaterialManager, so the
 * velocity buffer stays jitter-free. Contract: docs/babylon.md.
 */

type Mode = 'temporal' | 'spatial' | 'bilinear' | 'native';

const badge = document.getElementById('badge')!;
const canvas = document.querySelector('canvas')!;

if (!navigator.gpu) {
    badge.textContent = 'WebGPU is not available in this browser — try Chrome/Edge 113+.';
    throw new Error('WebGPU unavailable');
}

const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
await engine.initAsync();
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));

//* Scene

const scene = new Scene(engine);
scene.clearColor = new Color4(0.03, 0.045, 0.07, 1);

const camera = new ArcRotateCamera('camera', 0, 1.1, 8, new Vector3(0, 0.4, 0), scene);
camera.minZ = 0.1;
camera.maxZ = 100;

const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
sky.intensity = 0.35;
sky.groundColor = new Color3(0.25, 0.25, 0.3);
const sun = new DirectionalLight('sun', new Vector3(-0.45, -0.8, -0.35), scene);
sun.intensity = 1.6; // linear HDR: lit faces go above 1

/** A checker with a fine line grid over it, unmipped — plenty to alias on. */
function gridTexture(name: string, cells: number, lines: boolean): DynamicTexture {
    const size = 1024;
    const tex = new DynamicTexture(name, { width: size, height: size }, scene, false, Texture.NEAREST_SAMPLINGMODE);
    const ctx = tex.getContext();
    const step = size / cells;
    for (let y = 0; y < cells; y++) {
        for (let x = 0; x < cells; x++) {
            ctx.fillStyle = (x + y) % 2 ? '#707070' : '#e0e0e0';
            ctx.fillRect(x * step, y * step, step, step);
        }
    }
    if (lines) {
        ctx.fillStyle = '#0d0d0d';
        for (let i = 0; i < cells * 8; i++) {
            const p = (i * step) / 8;
            ctx.fillRect(p, 0, step / 8 * 0.08, size);
            ctx.fillRect(0, p, size, step / 8 * 0.08);
        }
    }
    tex.update(false);
    // DynamicTexture defaults to clamp; the floor tiles it.
    tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
    return tex;
}

const ground = CreateGround('ground', { width: 40, height: 40 }, scene);
const groundMat = new StandardMaterial('ground', scene);
groundMat.diffuseTexture = gridTexture('ground-grid', 8, true);
(groundMat.diffuseTexture as Texture).uScale = (groundMat.diffuseTexture as Texture).vScale = 5;
groundMat.specularColor = Color3.Black();
ground.material = groundMat;

const cubes: Mesh[] = [];
for (let i = 0; i < 7; i++) {
    const cube = CreateBox(`cube-${i}`, { size: 0.9 }, scene);
    const mat = new StandardMaterial(`cube-${i}`, scene);
    const hue = i / 7;
    mat.diffuseColor = new Color3(
        0.5 + 0.5 * Math.cos(6.283 * hue),
        0.5 + 0.5 * Math.cos(6.283 * (hue + 0.33)),
        0.5 + 0.5 * Math.cos(6.283 * (hue + 0.67)),
    );
    mat.diffuseTexture = gridTexture(`cube-grid-${i}`, 4, false);
    mat.specularColor = new Color3(0.2, 0.2, 0.2);
    cube.material = mat;
    cubes.push(cube);
}

//* Upscaler + Frame Graph

const upscaler = new Upscaler({ engine, scene });
const state = { mode: 'temporal' as Mode, paused: false, debugView: DebugView.None, frames: 0, time: 0 };
let graph: FrameGraph | null = null;
let building: Promise<void> | null = null;

/** (Re)configures the upscaler for the mode and rebuilds the frame graph around it. */
async function build(): Promise<void> {
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const native = state.mode === 'native';
    // Native = the bilinear blit at ratio 1: a passthrough of a display-res render.
    const path: UpscalePath = state.mode === 'native' ? 'bilinear' : state.mode;
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        path,
        ...(native ? { customUpscaleRatio: 1 } : { qualityMode: QualityMode.Performance }),
    });
    await upscaler.init();

    scene.frameGraph = null;
    graph?.dispose();
    graph = new FrameGraph(scene);
    const rw = upscaler.renderWidth;
    const rh = upscaler.renderHeight;
    const size = { width: rw, height: rh };
    const manager = graph.textureManager;

    const color = manager.createRenderTargetTexture('color', {
        size,
        sizeIsPercentage: false,
        options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_HALF_FLOAT], formats: [Constants.TEXTUREFORMAT_RGBA] },
    });
    const depth = manager.createRenderTargetTexture('depth', {
        size,
        sizeIsPercentage: false,
        options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT] },
    });

    const clear = new FrameGraphClearTextureTask('clear', graph);
    clear.targetTexture = color;
    clear.depthTexture = depth;
    clear.color = scene.clearColor;
    clear.clearColor = true;
    clear.clearDepth = true;
    graph.addTask(clear);

    const geometry = new FrameGraphGeometryRendererTask('geometry', graph, scene);
    geometry.targetTexture = clear.outputTexture;
    geometry.depthTexture = clear.outputDepthTexture;
    geometry.camera = camera;
    geometry.objectList = { meshes: scene.meshes, particleSystems: [] };
    geometry.isMainObjectRenderer = true;
    // Linear HDR into the upscaler; tone mapping happens after it.
    geometry.disableImageProcessing = true;
    geometry.size = size;
    geometry.sizeIsPercentage = false;
    geometry.textureDescriptions = [
        {
            type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE,
            textureType: Constants.TEXTURETYPE_HALF_FLOAT,
            textureFormat: Constants.TEXTUREFORMAT_RGBA,
        },
    ];
    graph.addTask(geometry);

    const upscale = new FrameGraphUpscaleTask('upscale', graph, upscaler);
    upscale.camera = camera;
    upscale.colorTexture = geometry.outputTexture;
    upscale.depthTexture = geometry.outputDepthTexture;
    upscale.velocityTexture = geometry.geometryLinearVelocityTexture;
    graph.addTask(upscale);

    const present = new FrameGraphImageProcessingTask('present', graph);
    present.sourceTexture = upscale.outputTexture;
    present.targetTexture = backbufferColorTextureHandle;
    const ip = present.postProcess;
    ip.fromLinearSpace = true;
    ip.imageProcessingConfiguration.toneMappingEnabled = true;
    ip.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    graph.addTask(present);

    await graph.buildAsync();
    scene.frameGraph = graph;
}

function rebuild(): void {
    building = build().finally(() => {
        building = null;
    });
}

//* Frame Loop

scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (!state.paused) state.time += dt;
    const t = state.time;
    camera.alpha = t * 0.15;
    cubes.forEach((cube, i) => {
        const a = (i / cubes.length) * Math.PI * 2 + t * 0.3;
        const r = 2.6 + (i % 2) * 0.9;
        cube.position.set(Math.cos(a) * r, 0.55 + 0.35 * Math.sin(t * 1.3 + i), Math.sin(a) * r);
        cube.rotation.set(t * 0.4 + i, t * (0.6 + 0.15 * i), 0);
    });
    upscaler.settings.debugView = state.debugView;
});

engine.runRenderLoop(() => {
    if (building || !graph) return;
    scene.render();
    state.frames++;
    badge.innerHTML =
        `<b>Babylon.js · @pmndrs/upscaler/babylon</b>\n` +
        `mode     ${state.mode}\n` +
        `render   ${upscaler.renderWidth}×${upscaler.renderHeight}\n` +
        `display  ${upscaler.displayWidth}×${upscaler.displayHeight}\n` +
        (state.mode === 'temporal' ? `jitter   phase ${upscaler.jitterPhase}/${upscaler.jitterPhaseCount}\n` : '') +
        (state.debugView !== DebugView.None ? `debug    ${DebugView[state.debugView]}\n` : '') +
        `\n[1] temporal [2] spatial [3] bilinear [4] native\n[d] debug view  [space] pause`;
});

//* Controls

const MODES: Record<string, Mode> = { '1': 'temporal', '2': 'spatial', '3': 'bilinear', '4': 'native' };
const DEBUG_VIEWS = Object.values(DebugView).filter((v): v is DebugView => typeof v === 'number');
window.addEventListener('keydown', (e) => {
    const mode = MODES[e.key];
    if (mode && mode !== state.mode) {
        state.mode = mode;
        rebuild();
    } else if (e.key === 'd') {
        state.debugView = DEBUG_VIEWS[(DEBUG_VIEWS.indexOf(state.debugView) + 1) % DEBUG_VIEWS.length];
    } else if (e.key === ' ') {
        state.paused = !state.paused;
    }
});
window.addEventListener('resize', () => {
    engine.resize();
    rebuild();
});

// Headless verification handle (CDP harness).
Object.assign(window, {
    __babylonHello: {
        upscaler,
        scene,
        state,
        setMode(m: Mode) {
            state.mode = m;
            rebuild();
        },
    },
});

rebuild();
