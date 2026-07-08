import { WGSL_CONSTANTS, WGSL_DISPLAY_TRANSFORM, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * RCAS — Robust Contrast Adaptive Sharpening, the sharpening half of FSR1
 * and the final pass of FSR2/3.
 *
 * A faithful WGSL port of the f32 reference (`FsrRcasF`) from AMD's
 * `ffx_fsr1.h` (MIT licensed). Unlike plain CAS, RCAS derives its maximum
 * sharpening lobe analytically from the local min/max ring so it cannot
 * over-shoot (ring) regardless of the sharpness setting.
 *
 * Runs at display resolution over the upscaled image:
 * - spatial path — input is EASU output, already display-referred
 * - temporal path — input is accumulation history in invertible-tonemap
 *   space (`FLAG_INPUT_REINHARD`), expanded + display-transformed per tap
 *
 * Bindings:
 * - 1: input color (display size)
 * - 2: exposure, 1×1 (rgba16float; r = pre-exposure to undo on the temporal path)
 * - 3: output storage (rgba8unorm, display size)
 */
export const RCAS_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_TONEMAP,
    WGSL_DISPLAY_TRANSFORM,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var exposureTex : texture_2d<f32>;
@group(0) @binding(3) var outputColor : texture_storage_2d<rgba8unorm, write>;

// Maximum sharpening lobe magnitude — set so a single tap cannot exceed the
// local contrast ring (0.25 - 1/16 in the reference).
const RCAS_LIMIT : f32 = 0.25 - (1.0 / 16.0);

// Loads a display-resolution texel in final display space.
fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        return displayTransform(tonemapInvert(c) / exposure);
    }
    return c;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    let sp = vec2i(gid.xy);

    //* Cross Neighborhood
    //   b
    // d e f
    //   h
    let b = rcasLoad(sp + vec2i(0, -1));
    let d = rcasLoad(sp + vec2i(-1, 0));
    let e = rcasLoad(sp);
    let f = rcasLoad(sp + vec2i(1, 0));
    let h = rcasLoad(sp + vec2i(0, 1));

    //* Sharpening Lobe
    // Min/max ring per channel bounds how strong the negative lobe may be
    // before the output would exceed local contrast.
    let mn4 = min(min(b, d), min(f, h));
    let mx4 = max(max(b, d), max(f, h));
    let hitMin = mn4 / (4.0 * mx4);
    let hitMax = (vec3f(1.0) - mx4) / (4.0 * mn4 - 4.0);
    let lobeRGB = max(-hitMin, hitMax);
    // C.sharpness 1 -> 0 attenuation stops (sharpest), 0 -> 2 stops.
    let peak = exp2(-2.0 * (1.0 - C.sharpness));
    let lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * peak;

    //* Resolve
    let rcpL = 1.0 / (4.0 * lobe + 1.0);
    let pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;

    textureStore(outputColor, gid.xy, vec4f(pix, 1.0));
}
`,
);
