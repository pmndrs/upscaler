/**
 * CPU mirror of `cameraMotion.ts` for one pixel — the reference the unit tests
 * hold the WGSL's math to. Matrices are column-major (three's `elements`).
 */

type Mat4 = ArrayLike<number>;
type Vec4 = [number, number, number, number];

function transform(m: Mat4, v: Vec4): Vec4 {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
}

/** Result of {@link cameraMotionAt}. */
export interface CameraMotionSample {
    /** NDC delta, current − previous (three's `velocity` convention). */
    velocity: [number, number];
    /** Linear depth in the previous camera (−1 when behind it). */
    previousDepth: number;
    /** Linear depth in the current camera. */
    depth: number;
}

/**
 * Static-world motion of the point under a pixel.
 * @param uv - Pixel-center UV (y down)
 * @param depth - Device depth sample
 * @param inverseViewProjectionJittered - Inverse of the projection·view the depth was rasterized with
 * @param viewProjection - Current unjittered projection·view
 * @param previousViewProjection - Previous unjittered projection·view
 * @param view - Current view matrix
 * @param previousView - Previous view matrix
 * @returns Motion and linear depths
 */
export function cameraMotionAt(
    uv: [number, number],
    depth: number,
    inverseViewProjectionJittered: Mat4,
    viewProjection: Mat4,
    previousViewProjection: Mat4,
    view: Mat4,
    previousView: Mat4,
): CameraMotionSample {
    const h = transform(inverseViewProjectionJittered, [uv[0] * 2 - 1, 1 - uv[1] * 2, depth, 1]);
    const world: Vec4 = [h[0] / h[3], h[1] / h[3], h[2] / h[3], 1];
    const cur = transform(viewProjection, world);
    const prev = transform(previousViewProjection, world);
    const behind = prev[3] <= 1e-6;
    const viewZ = (m: Mat4) => -(m[2] * world[0] + m[6] * world[1] + m[10] * world[2] + m[14]);
    return {
        velocity: behind ? [0, 0] : [cur[0] / cur[3] - prev[0] / prev[3], cur[1] / cur[3] - prev[1] / prev[3]],
        previousDepth: behind ? -1 : viewZ(previousView),
        depth: viewZ(view),
    };
}
