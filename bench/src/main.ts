import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DebugView, QualityMode } from '@pmndrs/upscaler';

import { BenchPipeline } from './BenchPipeline';
import { createBenchScene } from './BenchScene';
import { createBenchUI, type BenchState } from './BenchUI';

//* WebGPU Guard
const fatal = document.getElementById('fatal')!;
if (!navigator.gpu) {
    fatal.style.display = 'grid';
    fatal.textContent =
        'WebGPU is not available in this browser. The FSR3 bench is WebGPU-only — try Chrome/Edge 113+, or enable the flag in Safari/Firefox.';
    throw new Error('WebGPU unavailable');
}

//* State
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

// Cap DPR — the point of an upscaler bench is control over pixel counts.
const dpr = Math.min(window.devicePixelRatio, 2);
const displaySize = () => ({
    width: Math.floor(window.innerWidth * dpr),
    height: Math.floor(window.innerHeight * dpr),
});

//* Renderer
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
// The FSR output pass already applies tonemapping + sRGB encoding in WGSL, so
// the presentation quad must go to the canvas untouched.
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

await renderer.init();
const backend = renderer.backend as { isWebGPUBackend?: boolean };
if (backend.isWebGPUBackend !== true) {
    fatal.style.display = 'grid';
    fatal.textContent = 'three fell back to the WebGL backend — the FSR3 bench needs real WebGPU.';
    throw new Error('WebGL fallback active');
}

//* Scene & Camera
const bench = createBenchScene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(9, 6, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, 0);
controls.enableDamping = true;

//* Pipeline & UI
const pipeline = new BenchPipeline(renderer);

function reconfigure(): void {
    const { width, height } = displaySize();
    pipeline.configure(width, height, state.mode, state.quality);
}

createBenchUI(state, reconfigure, () => pipeline.upscaler.resetHistory());
reconfigure();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    reconfigure();
});

//* Stats Readout
const statsEl = document.getElementById('stats')!;
let frameCount = 0;
let fpsAccum = 0;
let statsClock = 0;
let fps = 0;

function updateStats(dt: number): void {
    frameCount++;
    fpsAccum += dt;
    statsClock += dt;
    if (statsClock < 0.5) return;
    fps = frameCount / fpsAccum;
    frameCount = 0;
    fpsAccum = 0;
    statsClock = 0;

    const u = pipeline.upscaler;
    const lines = [
        `mode      ${state.mode}`,
        `render    ${u.renderWidth}×${u.renderHeight}`,
        `display   ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x)`,
        `jitter    ${u.jitterPhaseCount} phases`,
        `fps       ${fps.toFixed(0)}`,
    ];
    if (u.gpuTimings.size > 0) {
        lines.push('--- gpu (ms) ---');
        let total = 0;
        for (const [label, ms] of u.gpuTimings) {
            lines.push(`${label.padEnd(10)}${ms.toFixed(3)}`);
            total += ms;
        }
        lines.push(`${'total'.padEnd(10)}${total.toFixed(3)}`);
    }
    statsEl.innerHTML = lines.map((l) => l.replace(/^(\S+)/, '<b>$1</b>')).join('\n');
}

//* Main Loop
const timer = new THREE.Timer();

renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();

    if (state.autoOrbit) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.6;
    } else {
        controls.autoRotate = false;
    }
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
    pipeline.render(bench.scene, camera, dt);
    updateStats(dt);
});
