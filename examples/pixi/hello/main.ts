import { Application, Container, Graphics, RenderTexture, Sprite, Text, Texture } from 'pixi.js';

import { QualityMode, Upscaler, type UpscalePath } from '@pmndrs/upscaler/pixi';

/**
 * The pixi adapter on pixi.js v8's WebGPURenderer: the stage renders into a
 * reduced-size RenderTexture, the spatial path (FSR1: EASU + RCAS) upscales
 * it before the app's own render, and a Sprite on the stage presents the
 * output. pixi has no depth or motion of its own, so this is the color-only
 * path; a 3D layer that can supply them runs the temporal path through the
 * same adapter. Contract: docs/pixi.md.
 */

type Mode = 'spatial' | 'bilinear' | 'native';

const badge = document.getElementById('badge')!;
if (!navigator.gpu) {
    badge.textContent = 'WebGPU is not available in this browser — try Chrome/Edge 113+.';
    throw new Error('WebGPU unavailable');
}

const app = new Application();
await app.init({
    preference: 'webgpu',
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio, 2),
    autoDensity: true,
    background: '#0b0d10',
    autoStart: false,
});
document.body.appendChild(app.canvas);
const renderer = app.renderer;

//* Scene: thin strokes, small text, rotation — what naive upscaling smears

const scene = new Container();
const spiro = new Graphics();
scene.addChild(spiro);
const labels = new Container();
scene.addChild(labels);
for (let i = 0; i < 6; i++) {
    const t = new Text({ text: 'FSR1 on pixi.js — thin lines & small type', style: { fill: '#cfd8e3', fontSize: 13 + i * 2 } });
    t.position.set(24, 150 + i * 32);
    labels.addChild(t);
}

function drawSpiro(time: number, width: number, height: number): void {
    spiro.clear();
    const cx = width * 0.62;
    const cy = height * 0.55;
    const r = Math.min(width, height) * 0.38;
    for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2 + time * 0.1;
        const b = a * 7 + time * 0.3;
        spiro.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        spiro.lineTo(cx + Math.cos(b) * r * 0.35, cy + Math.sin(b) * r * 0.35);
    }
    spiro.stroke({ width: 1, color: 0x7dd3fc, alpha: 0.9 });
    for (let k = 0; k < 24; k++) spiro.circle(cx, cy, r * (0.4 + k * 0.025)).stroke({ width: 1, color: 0xf0abfc, alpha: 0.6 });
}

//* Upscaler

const upscaler = new Upscaler({ renderer });
// The app's own render (after this ticker callback) presents the output.
const present = app.stage.addChild(new Sprite());
const state = { mode: 'spatial' as Mode, paused: false, frames: 0, time: 0 };
let lowRes: RenderTexture | null = null;
let ready = false;

async function configure(): Promise<void> {
    ready = false;
    // configure() frees the old output: unbind it from the Sprite first.
    present.texture = Texture.EMPTY;
    const width = renderer.width; // physical pixels
    const height = renderer.height;
    const path: UpscalePath = state.mode === 'native' ? 'bilinear' : state.mode;
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        path,
        ...(state.mode === 'native' ? { customUpscaleRatio: 1 } : { qualityMode: QualityMode.Performance }),
    });
    await upscaler.init();
    lowRes?.destroy(true);
    lowRes = RenderTexture.create({
        width: upscaler.renderWidth,
        height: upscaler.renderHeight,
        resolution: 1,
        format: 'rgba16float',
        autoGenerateMipmaps: false,
        // FSR1 wants anti-aliased input; pixi resolves the MSAA into this
        // single-sample texture before the upscaler reads it.
        antialias: true,
    });
    present.texture = upscaler.outputTexture;
    // The output is in physical pixels; the stage is in CSS pixels.
    present.setSize(renderer.screen.width, renderer.screen.height);
    ready = true;
}

//* Frame Loop

app.ticker.add((ticker) => {
    if (!ready || !lowRes) return;
    if (!state.paused) state.time += ticker.deltaMS / 1000;
    // Draw at render resolution: scale the CSS-pixel scene into the small target.
    const scale = upscaler.renderWidth / renderer.screen.width;
    scene.scale.set(scale);
    drawSpiro(state.time, renderer.screen.width, renderer.screen.height);

    renderer.render({ container: scene, target: lowRes, clearColor: '#0b0d10' });
    upscaler.dispatch({ color: lowRes, deltaTime: ticker.deltaMS / 1000 });

    state.frames++;
    badge.innerHTML =
        `<b>pixi.js · @pmndrs/upscaler/pixi</b>\n` +
        `mode     ${state.mode}\n` +
        `render   ${upscaler.renderWidth}×${upscaler.renderHeight}\n` +
        `display  ${upscaler.displayWidth}×${upscaler.displayHeight}\n` +
        `\n[1] spatial [2] bilinear [3] native  [space] pause`;
});

const MODES: Record<string, Mode> = { '1': 'spatial', '2': 'bilinear', '3': 'native' };
window.addEventListener('keydown', (e) => {
    const mode = MODES[e.key];
    if (mode && mode !== state.mode) {
        state.mode = mode;
        void configure();
    } else if (e.key === ' ') {
        state.paused = !state.paused;
    }
});
renderer.on('resize', () => void configure());

// Headless verification handle (CDP harness).
Object.assign(window, {
    __pixiHello: {
        upscaler,
        renderer,
        scene,
        present,
        get lowRes() {
            return lowRes;
        },
        state,
        setMode(m: Mode) {
            state.mode = m;
            void configure();
        },
    },
});

await configure();
app.start();
