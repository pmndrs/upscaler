import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

/**
 * Signal-agnostic per-pixel moments — the reusable statistics primitive
 * SVGF-class consumers need (TEMPORAL-GUIDES-SPEC §5). Not part of the
 * upscaling pipeline: the upscaler's own variance clip keeps its fused
 * inline 3×3 moments; this pass exists so external consumers can run the
 * same computation on a *different* signal (pre-albedo GI irradiance) in a
 * different space, without inheriting any beauty/exposure assumption.
 *
 * Per texel of the source: `s` = the configured scalar (Rec.709 luma in the
 * caller's linear domain, or YCoCg Y — selected by `FLAG_MOMENTS_YCOCG` in
 * the pass's own constants buffer), output `(E[x], E[x²]) = (s, s²)`.
 * Variance follows as `E[x²] − E[x]²` after the consumer's own temporal
 * accumulation. A single coarse level of 4×4 block means ships alongside
 * (the consumer's short-history spatial fallback reads exactly one coarse
 * neighborhood and nothing deeper — spec §10, answer 4). One fused 8×8
 * dispatch: the block reduction is workgroup-local, one writer thread per
 * 4×4 block.
 *
 * Outputs are rgba16float with the moments in `.rg` and `.ba` reserved —
 * rg16float (the spec's suggestion) is not a core WebGPU storage format.
 * Edge blocks of a non-multiple-of-4 source average clamped (duplicated)
 * edge texels.
 *
 * Bindings:
 * - 1: source, any float texture (loaded, never filtered)
 * - 2: moments out (rgba16float storage, source size; rg = E[x], E[x²])
 * - 3: coarse moments out (rgba16float storage, ceil(source/4))
 */
export const MOMENTS_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    /* wgsl */ `
@group(0) @binding(1) var sourceTexture : texture_2d<f32>;
@group(0) @binding(2) var momentsOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var coarseOut : texture_storage_2d<rgba16float, write>;

// Declared here, not in the shared constants chunk: only this standalone pass
// reads it, and touching WGSL_CONSTANTS re-fingerprints every shader.
const FLAG_MOMENTS_YCOCG : u32 = 2048u;

// Per-thread (scalar, scalar²), shared for the workgroup-local reduction.
var<workgroup> tileMoments : array<vec2f, 64>;

fn scalarOf(c : vec3f) -> f32 {
    return select(luma(c), (c.r + 2.0 * c.g + c.b) * 0.25, hasFlag(FLAG_MOMENTS_YCOCG));
}

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id) lid : vec3u,
    @builtin(local_invocation_index) lidx : u32,
) {
    let maxCoord = vec2i(C.renderSize) - 1;
    let coord = clamp(vec2i(gid.xy), vec2i(0), maxCoord);
    let s = scalarOf(textureLoad(sourceTexture, coord, 0).rgb);
    let m = vec2f(s, s * s);
    // Out-of-range stores are no-ops, so writing before the guard is safe.
    textureStore(momentsOut, vec2i(gid.xy), vec4f(m, 0.0, 0.0));
    tileMoments[lidx] = m;
    workgroupBarrier();

    // Grid guards sit AFTER the barrier: every invocation must reach it
    // (uniform control flow).
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }

    //* Coarse Level — 4×4 block means, one writer thread per block.
    if ((lid.x % 4u) != 0u || (lid.y % 4u) != 0u) { return; }
    var sum = vec2f(0.0);
    for (var y = 0u; y < 4u; y++) {
        for (var x = 0u; x < 4u; x++) {
            sum += tileMoments[(lid.y + y) * 8u + lid.x + x];
        }
    }
    let coarseCoord = vec2i(gid.xy) / 4;
    if (any(coarseCoord >= vec2i(textureDimensions(coarseOut)))) { return; }
    textureStore(coarseOut, coarseCoord, vec4f(sum / 16.0, 0.0, 0.0));
}
`,
);
