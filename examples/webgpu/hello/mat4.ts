// Just enough column-major 4×4 math for the demo — no engine, no dependency.
export type Mat4 = Float32Array<ArrayBuffer>;

export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
            r[c * 4 + row] = s;
        }
    }
    out.set(r);
    return out;
}

/**
 * WebGPU-convention perspective: clip z in [0, 1], 0 at near. This is the
 * "standard" (non-reversed) depth the core's `FrameCamera` defaults to.
 */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / (near - far);
    m[11] = -1;
    m[14] = (near * far) / (near - far);
    return m;
}

export function lookAt(eye: readonly number[], target: readonly number[], up: readonly number[]): Mat4 {
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    const zl = Math.hypot(zx, zy, zz);
    const z = [zx / zl, zy / zl, zz / zl];
    let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]);
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const m = new Float32Array(16);
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
    m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
    m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    m[15] = 1;
    return m;
}

/** Translation · rotationY · rotationX · scale. */
export function compose(
    t: readonly [number, number, number],
    rotY: number,
    rotX: number,
    s: readonly [number, number, number],
    out: Mat4 = new Float32Array(16),
): Mat4 {
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    // R = Ry · Rx, columns scaled by s.
    out[0] = cy * s[0];       out[1] = 0;        out[2] = -sy * s[0];      out[3] = 0;
    out[4] = sy * sx * s[1];  out[5] = cx * s[1]; out[6] = cy * sx * s[1];  out[7] = 0;
    out[8] = sy * cx * s[2];  out[9] = -sx * s[2]; out[10] = cy * cx * s[2]; out[11] = 0;
    out[12] = t[0];           out[13] = t[1];    out[14] = t[2];           out[15] = 1;
    return out;
}
