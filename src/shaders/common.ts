/**
 * Shared WGSL chunks: the per-frame constants UBO (binding 0 of every pass)
 * and color/depth helpers used across passes.
 *
 * The `FsrConstants` layout must stay in sync with the TS-side writer in
 * `internal/ConstantsBuffer.ts` — offsets are documented on both sides.
 */

//* Flag Bits (must match ConstantsBuffer.ts)
export const FLAG_RESET = 1;
export const FLAG_REVERSED_DEPTH = 2;
export const FLAG_PERSPECTIVE = 4;
export const FLAG_INPUT_REINHARD = 8;
export const FLAG_INPUT_DISPLAY = 16;
export const FLAG_LOCKS = 32;

/** Per-frame constants uniform block. Binding 0 in every FSR pass. */
export const WGSL_CONSTANTS = /* wgsl */ `
struct FsrConstants {
    renderSize      : vec2f,  // offset  0 — jittered render resolution (px)
    displaySize     : vec2f,  // offset  8 — output resolution (px)
    renderSizeInv   : vec2f,  // offset 16
    displaySizeInv  : vec2f,  // offset 24
    jitter          : vec2f,  // offset 32 — current sub-pixel offset (render px, top-left origin)
    jitterPrev      : vec2f,  // offset 40
    motionScale     : vec2f,  // offset 48 — NDC velocity delta -> UV delta (0.5, -0.5)
    depthNearFar    : vec2f,  // offset 56 — camera near/far for linearization
    sharpness       : f32,    // offset 64 — RCAS attenuation 0..1 (1 = sharpest)
    maxAccumulation : f32,    // offset 68 — max history sample count
    exposure        : f32,    // offset 72 — pre-exposure before invertible tonemap
    deltaTime       : f32,    // offset 76 — seconds
    flags           : u32,    // offset 80 — FLAG_* bits
    frameIndex      : u32,    // offset 84
    debugMode       : u32,    // offset 88 — FSRDebugView
    _pad            : u32,    // offset 92
}
@group(0) @binding(0) var<uniform> C : FsrConstants;

const FLAG_RESET : u32 = 1u;
const FLAG_REVERSED_DEPTH : u32 = 2u;
const FLAG_PERSPECTIVE : u32 = 4u;
const FLAG_INPUT_REINHARD : u32 = 8u;
const FLAG_INPUT_DISPLAY : u32 = 16u;
const FLAG_LOCKS : u32 = 32u;

fn hasFlag(bit : u32) -> bool { return (C.flags & bit) != 0u; }
`;

/** Luma + YCoCg color space helpers (YCoCg gives tighter AABBs for history clamping). */
export const WGSL_COLOR = /* wgsl */ `
fn luma(c : vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rgbToYCoCg(c : vec3f) -> vec3f {
    return vec3f(
         0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
         0.5  * c.r             - 0.5  * c.b,
        -0.25 * c.r + 0.5 * c.g - 0.25 * c.b,
    );
}

fn yCoCgToRgb(c : vec3f) -> vec3f {
    return vec3f(
        c.x + c.y - c.z,
        c.x       + c.z,
        c.x - c.y - c.z,
    );
}
`;

/**
 * Invertible tonemap pair (FSR2's `Tonemap`/`InverseTonemap`).
 *
 * Temporal accumulation happens in this compressed space so HDR fireflies
 * cannot dominate the running average; the final pass inverts it before the
 * display transform.
 */
export const WGSL_TONEMAP = /* wgsl */ `
fn tonemapInvertible(c : vec3f) -> vec3f {
    return c / (1.0 + max(max(c.r, c.g), max(c.b, 0.0)));
}

fn tonemapInvert(c : vec3f) -> vec3f {
    let m = min(max(max(c.r, c.g), max(c.b, 0.0)), 0.999);
    return c / (1.0 - m);
}
`;

/**
 * Display transform: ACES filmic approximation (Narkowicz) + sRGB OETF.
 * Every output path (blit, EASU, RCAS) funnels through this so all bench
 * modes are visually comparable.
 */
export const WGSL_DISPLAY_TRANSFORM = /* wgsl */ `
fn acesFilm(x : vec3f) -> vec3f {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn srgbEncode(c : vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

fn displayTransform(linearHdr : vec3f) -> vec3f {
    return srgbEncode(acesFilm(linearHdr));
}
`;

/**
 * Depth linearization for three's WebGPU projection conventions
 * (see Matrix4.makePerspective — both standard and reversed [0,1] depth).
 * Returns positive view-space distance; orthographic depth interpolates
 * linearly between near/far already.
 */
export const WGSL_DEPTH = /* wgsl */ `
fn linearizeDepth(d : f32) -> f32 {
    let near = C.depthNearFar.x;
    let far = C.depthNearFar.y;
    if (!hasFlag(FLAG_PERSPECTIVE)) {
        let t = select(d, 1.0 - d, hasFlag(FLAG_REVERSED_DEPTH));
        return near + t * (far - near);
    }
    if (hasFlag(FLAG_REVERSED_DEPTH)) {
        return (far * near) / (near + d * (far - near));
    }
    return (far * near) / (far - d * (far - near));
}
`;
