import { WGSL_CONSTANTS, WGSL_DISPLAY_TRANSFORM, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * EASU — Edge Adaptive Spatial Upsampling, the upscale half of FSR1.
 *
 * A faithful WGSL port of the f32 reference (`FsrEasuF`) from AMD's
 * `ffx_fsr1.h` (MIT licensed). The algorithm:
 *
 * 1. Analyze the local luma gradient over the 4 texels nearest the output
 *    pixel to find the dominant edge direction and edge strength.
 * 2. Evaluate a 12-tap Lanczos-like kernel that is rotated to the edge
 *    direction and anisotropically stretched along it.
 * 3. Dering by clamping to the min/max of the 4 nearest texels.
 *
 * Differences from the reference: the fast `APrxLo*` reciprocal bit-tricks
 * are replaced by exact `1/x` / `inverseSqrt` (negligible cost on modern
 * GPUs, and WGSL has no direct float bit-cast idiom for them), and taps are
 * `textureLoad`s instead of packed `textureGather`s — an acceptable trade
 * for a test bench (noted in the package README as a Phase 5 optimization).
 *
 * Per the FSR1 spec, EASU runs on display-referred (tonemapped, perceptual)
 * data, so the display transform is applied per tap here and RCAS runs on
 * this pass's output space directly.
 *
 * Bindings:
 * - 1: input color, render resolution (linear HDR)
 * - 2: output storage (rgba16float, display size — RCAS reads it next)
 */
export const EASU_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_TONEMAP,
    WGSL_DISPLAY_TRANSFORM,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var outputColor : texture_storage_2d<rgba16float, write>;

// Loads a render-resolution texel in display space (clamped at the borders).
fn easuLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.renderSize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    return displayTransform(c * C.exposure);
}

// EASU operates on a green-weighted luma: L = 0.5*R + G + 0.5*B.
fn easuLuma(c : vec3f) -> f32 {
    return 0.5 * c.r + c.g + 0.5 * c.b;
}

// Gradient analysis for one of the 4 nearest texels ('c' center of a +
// pattern: a above, b left, d right, e below). Accumulates the bilinearly
// weighted edge direction and edge strength (FsrEasuSetF).
fn easuSet(
    dir : ptr<function, vec2f>, len : ptr<function, f32>,
    w : f32,
    lA : f32, lB : f32, lC : f32, lD : f32, lE : f32,
) {
    //* Horizontal Gradient
    let dc = lD - lC;
    let cb = lC - lB;
    var lenX = max(abs(dc), abs(cb));
    lenX = 1.0 / max(lenX, 1.0e-5);
    let dirX = lD - lB;
    (*dir).x += dirX * w;
    lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
    lenX *= lenX;
    *len += lenX * w;

    //* Vertical Gradient
    let ec = lE - lC;
    let ca = lC - lA;
    var lenY = max(abs(ec), abs(ca));
    lenY = 1.0 / max(lenY, 1.0e-5);
    let dirY = lE - lA;
    (*dir).y += dirY * w;
    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
    lenY *= lenY;
    *len += lenY * w;
}

// One kernel tap: rotate the offset into edge space, apply anisotropy, then
// evaluate the polynomial Lanczos2 approximation (FsrEasuTapF).
fn easuTap(
    aC : ptr<function, vec3f>, aW : ptr<function, f32>,
    off : vec2f, dir : vec2f, len : vec2f, lob : f32, clp : f32, c : vec3f,
) {
    var v = vec2f(
        off.x * dir.x + off.y * dir.y,
        off.x * (-dir.y) + off.y * dir.x,
    );
    v *= len;
    var d2 = dot(v, v);
    d2 = min(d2, clp);
    // (25/16 * (2/5 x² - 1)² - 9/16) * (lob x² - 1)²  — base * window
    var wB = (2.0 / 5.0) * d2 - 1.0;
    var wA = lob * d2 - 1.0;
    wB *= wB;
    wA *= wA;
    wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
    let w = wB * wA;
    *aC += c * w;
    *aW += w;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }

    //* Source Position
    // Map the output pixel into render-texture space and split into the
    // integer base + sub-texel offset used for kernel/gradient weights.
    var pp = (vec2f(gid.xy) + 0.5) * C.renderSize * C.displaySizeInv - 0.5;
    let fp = floor(pp);
    pp -= fp;
    let ip = vec2i(fp);

    //* 12-Tap Footprint
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    let cB = easuLoad(ip + vec2i(0, -1));
    let cC = easuLoad(ip + vec2i(1, -1));
    let cE = easuLoad(ip + vec2i(-1, 0));
    let cF = easuLoad(ip + vec2i(0, 0));
    let cG = easuLoad(ip + vec2i(1, 0));
    let cH = easuLoad(ip + vec2i(2, 0));
    let cI = easuLoad(ip + vec2i(-1, 1));
    let cJ = easuLoad(ip + vec2i(0, 1));
    let cK = easuLoad(ip + vec2i(1, 1));
    let cL = easuLoad(ip + vec2i(2, 1));
    let cN = easuLoad(ip + vec2i(0, 2));
    let cO = easuLoad(ip + vec2i(1, 2));

    let lB = easuLuma(cB); let lC = easuLuma(cC);
    let lE = easuLuma(cE); let lF = easuLuma(cF);
    let lG = easuLuma(cG); let lH = easuLuma(cH);
    let lI = easuLuma(cI); let lJ = easuLuma(cJ);
    let lK = easuLuma(cK); let lL = easuLuma(cL);
    let lN = easuLuma(cN); let lO = easuLuma(cO);

    //* Edge Analysis
    // Bilinear blend of the gradient analysis at the 4 nearest texels
    // (f, g, j, k), weighted by the sub-texel position.
    var dir = vec2f(0.0);
    var len = 0.0;
    easuSet(&dir, &len, (1.0 - pp.x) * (1.0 - pp.y), lB, lE, lF, lG, lJ);
    easuSet(&dir, &len, pp.x * (1.0 - pp.y), lC, lF, lG, lH, lK);
    easuSet(&dir, &len, (1.0 - pp.x) * pp.y, lF, lI, lJ, lK, lN);
    easuSet(&dir, &len, pp.x * pp.y, lG, lJ, lK, lL, lO);

    //* Kernel Shaping
    // Normalize the direction; degenerate (flat) regions fall back to axis
    // aligned with zero edge strength.
    let dir2 = dir * dir;
    var dirR = dir2.x + dir2.y;
    let zro = dirR < (1.0 / 32768.0);
    dirR = inverseSqrt(max(dirR, 1.0e-12));
    dirR = select(dirR, 1.0, zro);
    dir.x = select(dir.x, 1.0, zro);
    dir *= dirR;
    // Edge strength from {0..2} to {0..1}, shaped with a square.
    len = len * 0.5;
    len *= len;
    // Stretch the kernel along the edge: 1.0 axis-aligned up to sqrt(2)
    // on diagonals, and contract it across the edge.
    let stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
    let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    // Negative lobe strength and window clipping point.
    let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    let clp = 1.0 / lob;

    //* Accumulation
    // Dering clamp uses the 4 nearest texels only.
    let min4 = min(min(cF, cG), min(cJ, cK));
    let max4 = max(max(cF, cG), max(cJ, cK));
    var aC = vec3f(0.0);
    var aW = 0.0;
    easuTap(&aC, &aW, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, cB);
    easuTap(&aC, &aW, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
    easuTap(&aC, &aW, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, cE);
    easuTap(&aC, &aW, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, cF);
    easuTap(&aC, &aW, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, cG);
    easuTap(&aC, &aW, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, cH);
    easuTap(&aC, &aW, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, cI);
    easuTap(&aC, &aW, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, cJ);
    easuTap(&aC, &aW, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, cK);
    easuTap(&aC, &aW, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, cL);
    easuTap(&aC, &aW, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, cN);
    easuTap(&aC, &aW, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, cO);

    let pix = min(max4, max(min4, aC / aW));
    textureStore(outputColor, gid.xy, vec4f(pix, 1.0));
}
`,
);
