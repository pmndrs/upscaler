import { WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

function createRcasShader(fsr315NumericParity: boolean): string {
    const luma = fsr315NumericParity
        ? /* wgsl */ `
    // FSR's inexpensive luma is scaled by two; the scale cancels in ratios.
    let bL = 0.5 * b.r + b.g + 0.5 * b.b;
    let dL = 0.5 * d.r + d.g + 0.5 * d.b;
    let eL = 0.5 * e.r + e.g + 0.5 * e.b;
    let fL = 0.5 * f.r + f.g + 0.5 * f.b;
    let hL = 0.5 * h.r + h.g + 0.5 * h.b;
`
        : '';
    const lowerLimiter = fsr315NumericParity
        ? /* wgsl */ `
    let lowerLimiterMultiplier = clamp(
        eL / min(min(bL, dL), min(fL, hL)),
        0.0,
        1.0
    );
`
        : '';
    const hitMinMultiplier = fsr315NumericParity ? ' * lowerLimiterMultiplier' : '';
    const denoise = fsr315NumericParity
        ? /* wgsl */ `
        let mn = min(min(min(bL, dL), eL), min(fL, hL));
        let mx = max(max(max(bL, dL), eL), max(fL, hL));
        var nz = 0.25 * (bL + dL + fL + hL) - eL;
        nz = clamp(abs(nz) / max(mx - mn, 1.0e-4), 0.0, 1.0);
        lobe *= 1.0 - 0.5 * nz;
`
        : /* wgsl */ `
        let mn = min(min(b.g, d.g), min(f.g, h.g));
        let mx = max(max(b.g, d.g), max(f.g, h.g));
        var nz = 0.25 * (b.g + d.g + f.g + h.g) - e.g;
        nz = clamp(abs(nz) / max(mx - mn, 1.0e-4), 0.0, 1.0);
        lobe *= 1.0 - 0.5 * nz;
`;

    return assembleShader(
        WGSL_CONSTANTS,
        WGSL_TONEMAP,
        /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var exposureTex : texture_2d<f32>;
@group(0) @binding(3) var outputColor : texture_storage_2d<rgba16float, write>;

// Maximum sharpening lobe magnitude — set so a single tap cannot exceed the
// local contrast ring (0.25 - 1/16 in the reference).
const RCAS_LIMIT : f32 = 0.25 - (1.0 / 16.0);

// Loads a display-resolution texel in the caller's linear/HDR domain.
fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        return tonemapInvert(c) / exposure;
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
${luma}

    //* Sharpening Lobe
    // Min/max ring per channel bounds how strong the negative lobe may be
    // before the output would exceed local contrast.
    let mn4 = min(min(b, d), min(f, h));
    let mx4 = max(max(b, d), max(f, h));
${lowerLimiter}
    let hitMin = mn4 / (4.0 * mx4)${hitMinMultiplier};
    let hitMax = (vec3f(1.0) - mx4) / (4.0 * mn4 - 4.0);
    let lobeRGB = max(-hitMin, hitMax);
    // C.sharpness 1 -> 0 attenuation stops (sharpest), 0 -> 2 stops.
    let peak = exp2(-2.0 * (1.0 - C.sharpness));
    var lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * peak;

    //* Denoise (FSR1's FSR_RCAS_DENOISE)
    // A lone luma outlier vs its cross-neighborhood, normalized by the local
    // range, reads as noise; attenuate the lobe there (up to 50%) so RCAS
    // doesn't amplify grain from noisy inputs (e.g. reduced-res SSR/GI).
    if (hasFlag(FLAG_RCAS_DENOISE)) {
${denoise}
    }

    //* Resolve
    let rcpL = 1.0 / (4.0 * lobe + 1.0);
    let pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;

    textureStore(outputColor, gid.xy, vec4f(pix, 1.0));
}
`,
    );
}

/**
 * Legacy RCAS shader retained only for benchmark comparisons.
 */
export const RCAS_LEGACY_SHADER = createRcasShader(false);

/**
 * Production RCAS shader with FSR 3.1.5 lower-limiter and denoise parity.
 */
export const RCAS_SHADER = createRcasShader(true);
