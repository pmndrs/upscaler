import { OrthographicCamera, PerspectiveCamera, Vector3, type Matrix4 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { Upscaler } from '../Upscaler.js';
import { JitterSequence } from './jitter.js';
import { applyJitterViewOffset, restoreViewOffset, type ViewOffsetCamera } from './viewOffset.js';

const RENDER_W = 960;
const RENDER_H = 540;
const JX = 0.3125;
const JY = -0.2083;

// World points spread across the frustum (camera at the origin looking down -Z).
const POINTS = [
    new Vector3(0, 0, -5),
    new Vector3(1.2, -0.7, -3),
    new Vector3(-2.5, 1.4, -9),
    new Vector3(0.4, 2.1, -20),
];

function perspective(): PerspectiveCamera {
    const camera = new PerspectiveCamera(50, RENDER_W / RENDER_H, 0.1, 100);
    camera.updateMatrixWorld();
    return camera;
}

function orthographic(): OrthographicCamera {
    const camera = new OrthographicCamera(-4, 4, 2.25, -2.25, 0.1, 100);
    camera.updateMatrixWorld();
    return camera;
}

/** Projects `p` (camera space == world space here) to NDC xy with `projection`. */
function ndc(p: Vector3, projection: Matrix4): [number, number] {
    const v = p.clone().applyMatrix4(projection);
    return [v.x, v.y];
}

/**
 * The jittered projection must equal the unjittered one translated by exactly
 * the jitter in render pixels: NDC spans the render target, so a jitter of
 * `jx` px moves content by `-2·jx/renderWidth` in NDC x (the frustum shifts
 * right) and `+2·jy/renderHeight` in NDC y (three's view offsetY points down).
 */
function expectPureJitter(unjittered: Matrix4, jittered: Matrix4): void {
    for (const p of POINTS) {
        const [ux, uy] = ndc(p, unjittered);
        const [jx, jy] = ndc(p, jittered);
        expect(jx - ux).toBeCloseTo((-2 * JX) / RENDER_W, 10);
        expect(jy - uy).toBeCloseTo((2 * JY) / RENDER_H, 10);
    }
}

describe.each<[string, () => ViewOffsetCamera]>([
    ['PerspectiveCamera', perspective],
    ['OrthographicCamera', orthographic],
])('applyJitterViewOffset / restoreViewOffset — %s', (_name, make) => {
    it('without an app offset, matches the plain TRAA-style jitter offset', () => {
        const camera = make();
        const reference = make();
        reference.setViewOffset(RENDER_W, RENDER_H, JX, JY, RENDER_W, RENDER_H);

        const before = camera.projectionMatrix.clone();
        const snapshot = applyJitterViewOffset(camera, JX, JY, RENDER_W, RENDER_H);
        expect(camera.view).toEqual(reference.view);
        expect(camera.projectionMatrix.elements).toEqual(reference.projectionMatrix.elements);
        expectPureJitter(before, camera.projectionMatrix);

        restoreViewOffset(snapshot);
        expect(camera.view).toBeNull();
        expect(camera.projectionMatrix.elements).toEqual(before.elements);
    });

    it('composes the jitter onto an app view offset and restores it exactly', () => {
        const camera = make();
        // Tiled rendering: this camera draws the left half of a 2-wide view
        // (render target = the tile, so one render pixel = one view unit here).
        camera.setViewOffset(RENDER_W * 2, RENDER_H, 0, 0, RENDER_W, RENDER_H);
        const appView = { ...camera.view! };
        const viewObject = camera.view;
        const unjittered = camera.projectionMatrix.clone();

        const snapshot = applyJitterViewOffset(camera, JX, JY, RENDER_W, RENDER_H);
        expect(camera.view!.fullWidth).toBe(appView.fullWidth);
        expect(camera.view!.width).toBe(appView.width);
        expectPureJitter(unjittered, camera.projectionMatrix);

        restoreViewOffset(snapshot);
        expect(camera.view).toBe(viewObject);
        expect(camera.view).toEqual(appView);
        expect(camera.projectionMatrix.elements).toEqual(unjittered.elements);
    });

    it('scales the jitter to render pixels when the app view is resampled', () => {
        const camera = make();
        // A 1000×600 view-unit tile at (300, 120) of a 3000×1200 wall, rendered
        // into a 960×540 target: render pixels and view units differ per axis.
        camera.setViewOffset(3000, 1200, 300, 120, 1000, 600);
        const appView = { ...camera.view! };
        const unjittered = camera.projectionMatrix.clone();

        const snapshot = applyJitterViewOffset(camera, JX, JY, RENDER_W, RENDER_H);
        expectPureJitter(unjittered, camera.projectionMatrix);

        restoreViewOffset(snapshot);
        expect(camera.view).toEqual(appView);
        expect(camera.projectionMatrix.elements).toEqual(unjittered.elements);
    });

    it('restores a disabled view without re-enabling it', () => {
        const camera = make();
        camera.setViewOffset(2000, 1000, 10, 20, 500, 400);
        camera.clearViewOffset();
        const disabledView = { ...camera.view! };
        const before = camera.projectionMatrix.clone();

        const snapshot = applyJitterViewOffset(camera, JX, JY, RENDER_W, RENDER_H);
        expectPureJitter(before, camera.projectionMatrix);

        restoreViewOffset(snapshot);
        expect(camera.view).toEqual(disabledView);
        expect(camera.projectionMatrix.elements).toEqual(before.elements);
    });
});

it('leaves a perspective camera aspect untouched (setViewOffset would overwrite it)', () => {
    const camera = new PerspectiveCamera(50, 1.7, 0.1, 100);
    const snapshot = applyJitterViewOffset(camera, JX, JY, RENDER_W, RENDER_H);
    expect(camera.aspect).toBe(1.7);
    restoreViewOffset(snapshot);
    expect(camera.aspect).toBe(1.7);
});

//* Upscaler Frame Lifecycle
// beginFrame/endFrame only touch the jitter sequence and render size, so the
// device-backed init() can be skipped by seeding that state directly.

function frameOnlyUpscaler(path: 'temporal' | 'spatial' = 'temporal'): Upscaler {
    const upscaler = new Upscaler({ renderer: {} as WebGPURenderer });
    Object.assign(upscaler as unknown as Record<string, unknown>, {
        _jitter: new JitterSequence(2),
        _path: path,
        _renderWidth: RENDER_W,
        _renderHeight: RENDER_H,
    });
    return upscaler;
}

describe('Upscaler.beginFrame / endFrame', () => {
    it('keeps the no-offset behaviour: jitter applied, then cleared', () => {
        const upscaler = frameOnlyUpscaler();
        const camera = perspective();
        const before = camera.projectionMatrix.clone();

        upscaler.beginFrame(camera);
        expect(upscaler.unjitteredProjectionMatrix.elements).toEqual(before.elements);
        expect(camera.view?.enabled).toBe(true);
        expect(camera.view?.fullWidth).toBe(RENDER_W);

        upscaler.endFrame(camera);
        expect(camera.view?.enabled ?? false).toBe(false);
        expect(camera.projectionMatrix.elements).toEqual(before.elements);
    });

    it('preserves an app view offset across the frame', () => {
        const upscaler = frameOnlyUpscaler();
        const camera = perspective();
        camera.setViewOffset(RENDER_W * 2, RENDER_H, RENDER_W, 0, RENDER_W, RENDER_H);
        const appView = { ...camera.view! };
        const appProjection = camera.projectionMatrix.clone();

        for (let frame = 0; frame < 3; frame++) {
            upscaler.beginFrame(camera);
            // Motion vectors see the app's offset, minus only the jitter.
            expect(upscaler.unjitteredProjectionMatrix.elements).toEqual(appProjection.elements);
            expect(camera.projectionMatrix.elements).not.toEqual(appProjection.elements);
            upscaler.endFrame(camera);
            expect(camera.view).toEqual(appView);
            expect(camera.projectionMatrix.elements).toEqual(appProjection.elements);
        }
    });

    it('does not compound jitter when a frame is never ended', () => {
        const upscaler = frameOnlyUpscaler();
        const camera = perspective();
        camera.setViewOffset(RENDER_W * 2, RENDER_H, 0, 0, RENDER_W, RENDER_H);
        const appProjection = camera.projectionMatrix.clone();

        upscaler.beginFrame(camera);
        upscaler.beginFrame(camera);
        expect(upscaler.unjitteredProjectionMatrix.elements).toEqual(appProjection.elements);
        upscaler.endFrame(camera);
        expect(camera.projectionMatrix.elements).toEqual(appProjection.elements);
    });

    it('leaves an app view offset alone on a non-jittering path', () => {
        const upscaler = frameOnlyUpscaler('spatial');
        const camera = perspective();
        camera.setViewOffset(RENDER_W * 2, RENDER_H, 0, 0, RENDER_W, RENDER_H);
        const appView = { ...camera.view! };

        upscaler.beginFrame(camera);
        expect(camera.view).toEqual(appView);
        upscaler.endFrame(camera);
        expect(camera.view).toEqual(appView);
    });
});
