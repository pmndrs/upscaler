import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE from 'three/webgpu';

import { DebugView, QualityMode } from '@pmndrs/upscaler';

import { BenchPipeline } from './BenchPipeline';
import { createBenchScene } from './BenchScene';
import { createBenchUI, type BenchState } from './BenchUI';
import { createBenchmarkApi } from './benchmark/api';
import { parseBenchmarkConfig } from './benchmark/config';
import {
    collectBenchmarkEnvironment,
    getManifestDigest,
    monitorDeviceLoss,
} from './benchmark/environment';
import { getBenchmarkScenario } from './benchmark/scenarios';
import { SingleVariantRegistry } from './benchmark/variants';

//* WebGPU Guard
const fatal = document.getElementById('fatal')!;
if (!navigator.gpu) {
    fatal.style.display = 'grid';
    fatal.textContent =
        'WebGPU is not available in this browser. The FSR3 bench is WebGPU-only — try Chrome/Edge 113+, or enable the flag in Safari/Firefox.';
    throw new Error('WebGPU unavailable');
}

//* Deterministic Configuration ==============================================
const config = parseBenchmarkConfig();
const automated = config.mode !== 'interactive';
const scenario = getBenchmarkScenario(config.scenario, config.subrun);
const registry = new SingleVariantRegistry();
// Validation occurs before renderer construction, so bad identities never render.
const variantMetadata = registry.resolve(config.variant, config.ratio);

const state: BenchState = {
    mode: 'upscale-temporal',
    quality: QualityMode.Performance,
    sharpness: 0.8,
    rcasDenoise: false,
    maxAccumulation: 24,
    exposure: 1.0,
    autoExposure: true,
    lockThinFeatures: true,
    detectShadingChanges: true,
    debugView: DebugView.None,
    animate: true,
    autoOrbit: true,
};

const dpr = config.dimensions.devicePixelRatio;
const displaySize = () => ({
    width: automated ? config.dimensions.width : Math.floor(window.innerWidth * dpr),
    height: automated ? config.dimensions.height : Math.floor(window.innerHeight * dpr),
});

//* Renderer
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setPixelRatio(dpr);
renderer.setSize(
    automated ? config.dimensions.width / dpr : window.innerWidth,
    automated ? config.dimensions.height / dpr : window.innerHeight,
    true,
);
// The upscaler stays linear/HDR; presentation belongs to the renderer.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

await renderer.init();
const backend = renderer.backend as { isWebGPUBackend?: boolean; device?: GPUDevice };
if (backend.isWebGPUBackend !== true || !backend.device) {
    fatal.style.display = 'grid';
    fatal.textContent = 'three fell back to the WebGL backend — the bench needs real WebGPU.';
    throw new Error('WebGPU backend unavailable');
}
if (automated) {
    const animation = (renderer as unknown as { _animation?: { stop(): void } })._animation;
    if (!animation || typeof animation.stop !== 'function')
        throw new Error('Pinned renderer._animation bridge shape changed.');
    // Automated frames advance the pinned NodeFrame bridge explicitly; leaving
    // three's ambient RAF loop active would inject uncontrolled wall-clock ticks.
    animation.stop();
}
const validation: BenchmarkValidationRecord[] = [];
monitorDeviceLoss(renderer, validation);

//* Scene & Camera
const bench = createBenchScene();
const camera = new THREE.PerspectiveCamera(
    50,
    config.dimensions.width / config.dimensions.height,
    0.1,
    200,
);
camera.position.set(9, 6, 12);
camera.lookAt(0, 1.6, 0);
camera.layers.enable(1);
if (scenario.id === 'Q6' || scenario.id === 'Q7' || scenario.id === 'Q8') {
    camera.fov = 55;
    camera.position.set(0, 4, scenario.id === 'Q6' ? 10 : 10.5);
    camera.lookAt(0, 3, -5);
    camera.updateProjectionMatrix();
}
const controls = automated ? null : new OrbitControls(camera, renderer.domElement);
if (controls) {
    controls.target.set(0, 1.6, 0);
    controls.enableDamping = true;
}

//* Pipeline & UI
const pipeline = scenario.unsupported
    ? null
    : new BenchPipeline(
          renderer,
          (activeRenderer) => registry.create(config.variant, config.ratio, activeRenderer),
          variantMetadata,
      );
if (pipeline && (scenario.id === 'Q6' || scenario.id === 'Q7' || scenario.id === 'Q8'))
    pipeline.configureEffectScenario(scenario.id, config.subrun, bench.roomScene, camera);

function reconfigure(): void {
    if (!pipeline) return;
    const { width, height } = displaySize();
    pipeline.configure(width, height, state.mode, state.quality);
}

function resizeBenchmark(dimensions: BenchmarkDimensions): void {
    renderer.setPixelRatio(dimensions.devicePixelRatio);
    renderer.setSize(
        dimensions.width / dimensions.devicePixelRatio,
        dimensions.height / dimensions.devicePixelRatio,
        true,
    );
    camera.aspect = dimensions.width / dimensions.height;
    camera.updateProjectionMatrix();
    pipeline?.configureBenchmark(
        dimensions.width,
        dimensions.height,
        config.ratio,
        scenario.id === 'Q5',
    );
}

if (automated) {
    resizeBenchmark(config.dimensions);
    await pipeline?.prepareEffectReadiness(camera);
    pipeline?.reset(bench.scene, camera, 0);
}
else {
    createBenchUI(state, reconfigure, () => pipeline?.reset(bench.scene, camera));
    reconfigure();
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        reconfigure();
    });
}

//* Stats Readout
const statsEl = document.getElementById('stats')!;
if (automated) statsEl.style.display = 'none';
let frameCount = 0;
let fpsAccum = 0;
let statsClock = 0;
let fps = 0;

function updateStats(dt: number): void {
    if (!pipeline) return;
    frameCount++;
    fpsAccum += dt;
    statsClock += dt;
    if (statsClock < 0.5) return;
    fps = frameCount / fpsAccum;
    frameCount = 0;
    fpsAccum = 0;
    statsClock = 0;

    const resolver = pipeline.resolver;
    const lines = [
        `mode      ${state.mode}`,
        `render    ${resolver.renderWidth}×${resolver.renderHeight}`,
        `display   ${resolver.displayWidth}×${resolver.displayHeight}  (${resolver.upscaleRatio.toFixed(2)}x)`,
        `jitter    ${resolver.jitterPhaseCount} phases`,
        `fps       ${fps.toFixed(0)}`,
    ];
    if (resolver.timings.size > 0) {
        lines.push('--- gpu (ms) ---');
        let total = 0;
        for (const [label, milliseconds] of resolver.timings) {
            lines.push(`${label.padEnd(10)}${milliseconds.toFixed(3)}`);
            total += milliseconds;
        }
        lines.push(`${'total'.padEnd(10)}${total.toFixed(3)}`);
    }
    statsEl.innerHTML = lines.map((line) => line.replace(/^(\S+)/, '<b>$1</b>')).join('\n');
}

//* Automated API =============================================================
const manifestDigest = await getManifestDigest();
const environment = await collectBenchmarkEnvironment(renderer, config);
window.__UPSCALER_BENCH__ = createBenchmarkApi({
    renderer,
    camera,
    bench,
    pipeline,
    config,
    metadata: variantMetadata,
    scenario,
    environment,
    manifestDigest,
    validation,
    resize: resizeBenchmark,
});

let pageDisposed = false;
window.addEventListener(
    'pagehide',
    () => {
        if (pageDisposed) return;
        pageDisposed = true;
        renderer.setAnimationLoop(null);
        controls?.dispose();
        if (pipeline) {
            pipeline.dispose();
            registry.releaseDisposed(pipeline.resolver);
        }
        renderer.dispose();
        window.__UPSCALER_BENCH__ = undefined;
    },
    { once: true },
);

//* Main Loop
const timer = new THREE.Timer();
let interactiveFrame = 0;

if (!automated && pipeline && controls) {
    renderer.setAnimationLoop(() => {
        timer.update();
        const dt = Math.min(timer.getDelta(), 0.1);
        const time = timer.getElapsed();

        controls.autoRotate = state.autoOrbit;
        controls.autoRotateSpeed = 0.6;
        controls.update();

        bench.update(time, state.animate);
        pipeline.applySettings({
            sharpness: state.sharpness,
            rcasDenoise: state.rcasDenoise,
            maxAccumulation: state.maxAccumulation,
            exposure: state.exposure,
            autoExposure: state.autoExposure,
            lockThinFeatures: state.lockThinFeatures,
            detectShadingChanges: state.detectShadingChanges,
            debugView: state.debugView,
        });
        pipeline.render(bench.scene, camera, dt, interactiveFrame++);
        updateStats(dt);
    });
}
