import type { Camera } from '@babylonjs/core/Cameras/camera.js';

import type { FrameCamera, JitterOffset } from '@pmndrs/upscaler-core/types';

/*
 * Babylon's WebGPU engine draws every render target Y-flipped (InternalsUBO
 * yFactor = −1, so a sampled RTT matches the WebGL texture-space
 * convention): texel row 0 holds NDC y = −1, the bottom of the image. The
 * adapter keeps the inputs in that orientation rather than flipping them —
 * the core is orientation-agnostic once jitter and motion agree with the
 * texel rows, and its output then has the same orientation as any other
 * Babylon render target, so Babylon samples it upright.
 */

/**
 * `motionScale` for Babylon's linear velocity (`PREPASS_VELOCITY_LINEAR`,
 * the frame graph's `geometryLinearVelocityTexture`): it stores
 * `0.5 · (previousNDC − currentNDC)`, and on a flipped target a texel-row UV
 * delta is `+0.5 · ΔNDC` on both axes, so `current − previous` in texel UV is
 * exactly `−velocity`.
 */
export const BABYLON_MOTION_SCALE: readonly [number, number] = [-1, -1];

/**
 * The clip-space offset that puts the core's jitter on a flipped render
 * target: the core moves the sample by `(x, y)` render pixels along the texel
 * rows, and texel rows grow with NDC y here, so the projection shifts by
 * `(−2x / width, −2y / height)` (× w — applied after projection, as
 * `TAAMaterialManager` does).
 * @param jitter - The core's jitter (render pixels)
 * @param renderWidth - Render-target width
 * @param renderHeight - Render-target height
 * @param out - Receives the clip-space offset
 * @returns `out`
 */
export function jitterToClip(
    jitter: JitterOffset,
    renderWidth: number,
    renderHeight: number,
    out: { x: number; y: number },
): { x: number; y: number } {
    out.x = (-2 * jitter.x) / renderWidth;
    out.y = (-2 * jitter.y) / renderHeight;
    return out;
}

// Camera.PERSPECTIVE_CAMERA, inlined so this module stays import-free at runtime.
const PERSPECTIVE_CAMERA = 0;

/**
 * Fills a {@link FrameCamera} from a Babylon camera. Babylon's WebGPU depth
 * is already the core's [0, 1] convention (`isNDCHalfZRange`): 0 at `minZ`,
 * 1 at `maxZ`, or reversed under `useReverseDepthBuffer`.
 * @param camera - The camera the inputs were rendered with
 * @param reversedDepth - The engine's `useReverseDepthBuffer`
 * @param out - Receives the camera facts
 * @returns `out`
 */
export function toFrameCamera(camera: Camera, reversedDepth: boolean, out: FrameCamera): FrameCamera {
    if (!(camera.maxZ > 0) || camera.ignoreCameraMaxZ) {
        throw new Error(
            '@pmndrs/upscaler/babylon: the camera needs a finite far plane (maxZ > 0, ignoreCameraMaxZ off) ' +
                'to linearize depth.',
        );
    }
    out.near = camera.minZ;
    out.far = camera.maxZ;
    out.perspective = camera.mode === PERSPECTIVE_CAMERA;
    out.reversedDepth = reversedDepth;
    return out;
}
