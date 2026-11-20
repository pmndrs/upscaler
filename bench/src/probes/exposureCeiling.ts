import * as THREE from 'three/webgpu';

import { velocity } from 'three/tsl';

import { UpscalePass, Upscaler, type RuntimeSettings } from '@pmndrs/upscaler';

/**
 * Dark-scene HDR highlight probe (issue #49), driven by
 * `scripts/measure-exposure-ceiling.mjs` over CDP.
 *
 * A still orthographic view of emissive squares on a flat background: five
 * levels (0.25 … 64 linear) × three sizes (16 render px, 3 render px, and a
 * 0.5 render px sub-pixel emitter placed off the render grid so only some
 * jitter phases rasterize it). The temporal path runs at 512² display,
 * ratio 2, and the rgba16float output is read back exactly, next to a native
 * display-res render of the same scene.
 *
 * Per emitter it reports the output centre value (plateau fidelity: native is
 * the level itself) and the window energy above background, averaged over one
 * full jitter cycle (native: level × one display pixel for the sub-pixel row).
 * It also mirrors the luminance pyramid's 32×32 bilinear metering taps on the
 * render-res input, to show what a highlight-keyed exposure would see.
 */

const DISPLAY = 512;
const RATIO = 2;
const RENDER = DISPLAY / RATIO;
const WORLD_PER_RENDER_PIXEL = 2 / RENDER;
const LEVELS = [0.25, 1, 4, 16, 64];
const SIZES = { large: 16, medium: 3, sub: 0.5 } as const;
type SizeKey = keyof typeof SIZES;
const ROWS: Record<SizeKey, number> = { large: 96, medium: 256, sub: 400 };
// Window radius (display px) summed for each size's energy.
const RADIUS: Record<SizeKey, number> = { large: 14, medium: 6, sub: 6 };

interface Emitter {
    level: number;
    size: SizeKey;
    /** Display-pixel centre (continuous). */
    x: number;
    y: number;
    mesh: THREE.Mesh;
}

/** One measurement request from the CDP driver. */
interface ProbeRequest {
    /** Linear background value (0 = black). */
    background: number;
    /** RuntimeSettings overrides (e.g. a fixed `exposure`). */
    settings: Partial<RuntimeSettings>;
    /** Frames to run; the last `average` frames are averaged. */
    frames: number;
    average: number;
    /** Emitter sizes to hide (e.g. `['large']`). */
    hide?: SizeKey[];
}

const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(DISPLAY, DISPLAY);
document.body.appendChild(renderer.domElement);
await renderer.init();
const backend = renderer.backend as unknown as {
    device: GPUDevice;
    get(texture: THREE.Texture): { texture: GPUTexture };
};
const device = backend.device;

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

const background = new THREE.Color(0, 0, 0);
const scene = new THREE.Scene();
scene.background = background;
const emitters: Emitter[] = [];
LEVELS.forEach((level, column) => {
    for (const size of Object.keys(SIZES) as SizeKey[]) {
        const pixels = SIZES[size];
        const material = new THREE.MeshBasicNodeMaterial();
        material.color.setScalar(level);
        const extent = pixels * WORLD_PER_RENDER_PIXEL;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), material);
        // Medium squares centre on a render pixel so they cover exactly 3×3
        // render pixels on every jitter phase; sub-pixel emitters sit off-grid.
        const offset = size === 'sub' ? [0.37, 0.61] : size === 'medium' ? [1, 1] : [0, 0];
        const x = 64 + column * 96 + offset[0];
        const y = ROWS[size] + offset[1];
        mesh.position.set((x / DISPLAY) * 2 - 1, 1 - (y / DISPLAY) * 2, 0);
        scene.add(mesh);
        emitters.push({ level, size, x, y, mesh });
    }
});

const pass = new UpscalePass(renderer);
// Bench-only metering form (NEXT-STEPS §17), e.g. ?exposureMetering=every-texel:
// swap in an upscaler built with it before first use, and point the velocity
// node at its unjittered projection as the pass's own constructor does.
const metering = new URLSearchParams(location.search).get('exposureMetering');
if (metering) {
    const upscaler = new Upscaler({ renderer, _exposureMetering: metering } as ConstructorParameters<typeof Upscaler>[0]);
    (pass as { upscaler: Upscaler }).upscaler = upscaler;
    velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);
}
pass.configure({ displayWidth: DISPLAY, displayHeight: DISPLAY, ratio: RATIO });
await pass.init();
const nativeTarget = new THREE.RenderTarget(DISPLAY, DISPLAY, { type: THREE.FloatType });

function halfToFloat(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Exact readback of an rgba16float texture as floats. */
async function readHalfTexture(texture: THREE.Texture, width: number, height: number): Promise<Float32Array> {
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: backend.get(texture).texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width * 4; x++) out[y * width * 4 + x] = halfToFloat(halves[(y * bytesPerRow) / 2 + x]);
    return out;
}

function luma(image: Float32Array, x: number, y: number, width = DISPLAY): number {
    const i = (y * width + x) * 4;
    return 0.2126 * image[i] + 0.7152 * image[i + 1] + 0.0722 * image[i + 2];
}

function measure(image: Float32Array): { centre: number; energy: number }[] {
    const floor = luma(image, 2, 2);
    return emitters.map((emitter) => {
        const cx = Math.floor(emitter.x);
        const cy = Math.floor(emitter.y);
        const radius = RADIUS[emitter.size];
        let energy = 0;
        for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++) energy += luma(image, cx + dx, cy + dy) - floor;
        return { centre: luma(image, cx, cy), energy };
    });
}

/** CPU mirror of luminancePyramid's 32×32 bilinear taps: the brightest one. */
function meteredMax(input: Float32Array): number {
    const at = (x: number, y: number) =>
        luma(input, Math.min(RENDER - 1, Math.max(0, x)), Math.min(RENDER - 1, Math.max(0, y)), RENDER);
    let peak = 0;
    for (let ty = 0; ty < 32; ty++)
        for (let tx = 0; tx < 32; tx++) {
            const px = ((tx + 0.5) / 32) * RENDER - 0.5;
            const py = ((ty + 0.5) / 32) * RENDER - 0.5;
            const x0 = Math.floor(px);
            const y0 = Math.floor(py);
            const fx = px - x0;
            const fy = py - y0;
            const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
            const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
            peak = Math.max(peak, top * (1 - fy) + bottom * fy);
        }
    return peak;
}

async function run(request: ProbeRequest) {
    background.setScalar(request.background);
    for (const emitter of emitters) emitter.mesh.visible = !(request.hide ?? []).includes(emitter.size);
    pass.applySettings({
        sharpness: 0.8,
        maxAccumulation: 24,
        autoExposure: true,
        exposure: 1,
        debugView: 0,
        ...request.settings,
    });
    pass.upscaler.resetHistory();

    renderer.setRenderTarget(nativeTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const native = (await renderer.readRenderTargetPixelsAsync(nativeTarget, 0, 0, DISPLAY, DISPLAY)) as Float32Array;

    const sums = emitters.map(() => ({ centre: 0, energy: 0 }));
    let metered = { min: Infinity, max: 0 };
    let exposure = 0;
    let outputMax = 0;
    let nonFinite = 0;
    const first = request.frames - request.average;
    for (let frame = 0; frame < request.frames; frame++) {
        pass.draw(scene, camera, 1 / 60);
        pass.present();
        if (frame < first) continue;
        await device.queue.onSubmittedWorkDone();
        const input = await readHalfTexture(pass.renderTarget!.textures[0], RENDER, RENDER);
        const tap = meteredMax(input);
        metered = { min: Math.min(metered.min, tap), max: Math.max(metered.max, tap) };
        const output = await readHalfTexture(pass.outputTexture, DISPLAY, DISPLAY);
        measure(output).forEach((row, i) => {
            sums[i].centre += row.centre / request.average;
            sums[i].energy += row.energy / request.average;
        });
        for (let i = 0; i < output.length; i++) {
            if (i % 4 === 3) continue;
            if (Number.isFinite(output[i])) outputMax = Math.max(outputMax, output[i]);
            else nonFinite++;
        }
        exposure = (await readHalfTexture(pass.upscaler.guides.exposure!, 1, 1))[0];
    }
    const nativeRows = measure(native);
    return {
        exposure,
        meteredTapMax: metered,
        outputMax,
        nonFinite,
        emitters: emitters.map((emitter, i) => ({
            level: emitter.level,
            size: SIZES[emitter.size],
            visible: emitter.mesh.visible,
            centre: sums[i].centre,
            energy: sums[i].energy,
            nativeEnergy: nativeRows[i].energy,
        })),
    };
}

(window as unknown as { __exposureCeiling: unknown }).__exposureCeiling = { ready: true, run };
