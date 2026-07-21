import { WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * Output/blit pass.
 *
 * Samples the input (bilinear — which doubles as the naive-upscale
 * comparison mode in the bench) and writes in the caller's color domain.
 * Input interpretation by flag:
 * - `FLAG_INPUT_REINHARD` — temporal history in invertible-tonemap space
 * - otherwise — caller-domain color, passed through unchanged
 *
 * Bindings:
 * - 1: input color (filterable float)
 * - 2: linear clamp sampler
 * - 3: exposure, 1×1 (rgba16float; r = pre-exposure to undo on the temporal path)
 * - 4: output storage (rgba16float, display size)
 */
export const BLIT_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_TONEMAP,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var linearSampler : sampler;
@group(0) @binding(3) var exposureTex : texture_2d<f32>;
@group(0) @binding(4) var outputColor : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }

    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    var c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;

    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        c = tonemapInvert(c) / exposure;
    }

    textureStore(outputColor, gid.xy, vec4f(c, 1.0));
}
`,
);
