import {
    CubeGeometry,
    DirectionalLight,
    Material3D,
    Mesh3D,
    PlaneGeometry,
    SphereGeometry,
    TorusKnotGeometry,
    View3D,
} from '@pixi/3d';
import { Application, RenderTexture, Sprite, Texture } from 'pixi.js';

import { QualityMode, Upscaler, type UpscalePath } from '@pmndrs/upscaler/pixi';

/**
 * The pixi adapter under a pixi-3d scene (closed beta, examples/pixi3d/README.md):
 * a View3D renders into a reduced-size RenderTexture, the spatial path (FSR1:
 * EASU + RCAS) upscales it between pixi renders, and a Sprite on the stage
 * presents the output. pixi-3d has no motion vectors or projection jitter yet,
 * so this is the color-only path; once it does, the same adapter runs the
 * temporal path (docs/pixi.md#temporal).
 */

type Mode = 'spatial' | 'bilinear' | 'native';

// Not top-level await: pixi-3d's renderer hook dynamically imports its backend
// chunk during app.init(), and in a production build that chunk imports back
// from this entry chunk — awaiting it at module level deadlocks the two.
async function main(): Promise<void> {
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

    //* Scene: thin geometry and fine specular, what naive upscaling smears

    // Sized to the render resolution in configure(); never on the stage — it only
    // ever draws into the low-res target.
    const view3d = new View3D({ environment: { skyColor: 0xcfe8ff, groundColor: 0x2a2438 } });
    view3d.camera.fov = 45;

    const sun = new DirectionalLight({ color: 0xfff2df, intensity: 3 });
    sun.position.set(5, 8, 6);
    sun.lookAt({ x: 0, y: 0, z: 0 });
    view3d.root.addChild(sun);

    const floor = new Mesh3D({
        geometry: new PlaneGeometry({ width: 24, height: 24 }),
        material: new Material3D({ baseColor: 0x39415c, roughness: 0.85 }),
    });
    floor.rotation.set(-Math.PI / 2, 0, 0);
    view3d.root.addChild(floor);

    // A picket fence of thin slats: sub-pixel at half resolution.
    const slat = new CubeGeometry({ width: 0.035, height: 1.6, depth: 0.035 });
    const slatMaterial = new Material3D({ baseColor: 0xe8e2d4, roughness: 0.5 });
    for (let i = 0; i < 48; i++) {
        const post = new Mesh3D({ geometry: slat, material: slatMaterial });
        post.position.set(-6 + i * 0.25, 0.8, -2.5);
        view3d.root.addChild(post);
    }

    // Glossy spheres: small, bright specular highlights.
    const sphere = new SphereGeometry({ radius: 0.45, widthSegments: 48, heightSegments: 32 });
    const palette = [0xe6404d, 0x33b366, 0x4073e6, 0xf2b326, 0xb34dd9];
    for (let i = 0; i < palette.length; i++) {
        const ball = new Mesh3D({ geometry: sphere, material: new Material3D({ baseColor: palette[i], roughness: 0.12, metallic: 0.2 }) });
        ball.position.set((i - 2) * 1.3, 0.45, 1.2);
        view3d.root.addChild(ball);
    }

    const knot = new Mesh3D({
        geometry: new TorusKnotGeometry({ tubularSegments: 256, radialSegments: 24 }),
        material: new Material3D({ baseColor: 0x9aa3ad, roughness: 0.2, metallic: 1 }),
    });
    knot.position.set(0, 1.9, -0.6);
    knot.scale.set(0.8);
    view3d.root.addChild(knot);

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
        // The view draws exactly the render resolution (the input must be render-sized).
        view3d.setSize(upscaler.renderWidth, upscaler.renderHeight);
        present.texture = upscaler.outputTexture;
        // The output is in physical pixels; the stage is in CSS pixels.
        present.setSize(renderer.screen.width, renderer.screen.height);
        ready = true;
    }

    //* Frame Loop

    app.ticker.add((ticker) => {
        if (!ready || !lowRes) return;
        if (!state.paused) state.time += ticker.deltaMS / 1000;
        const t = state.time;
        const radius = 8;
        view3d.camera.position.set(Math.sin(t * 0.15) * radius, 3.2, Math.cos(t * 0.15) * radius);
        view3d.camera.lookAt({ x: 0, y: 0.9, z: 0 });
        knot.rotation.set(t * 0.4, t * 0.25, 0);

        renderer.render({ container: view3d, target: lowRes, clearColor: '#0b0d10' });
        upscaler.dispatch({ color: lowRes, deltaTime: ticker.deltaMS / 1000 });

        state.frames++;
        badge.innerHTML =
            `<b>pixi-3d · @pmndrs/upscaler/pixi</b>\n` +
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
        __pixi3dHello: {
            upscaler,
            renderer,
            view3d,
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
}

void main();
