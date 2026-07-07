import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Depth-clip pass — produces the disocclusion mask (FSR2/3's "depth clip"
 * stage, simplified: it compares against last frame's dilated depth instead
 * of a scatter-reconstructed previous depth buffer; see shaders README).
 *
 * A pixel is disoccluded when the surface it shows this frame was hidden
 * behind something nearer at the reprojected position last frame — its
 * history belongs to the occluder and must not be blended in. The mask
 * feeds the accumulation pass, which drops history weight accordingly.
 *
 * Bindings:
 * - 1: dilated view depth, current frame (r32float)
 * - 2: dilated motion (rgba16float, UV delta in .xy)
 * - 3: dilated view depth, previous frame (r32float)
 * - 4: mask output (rgba8unorm storage; r = disocclusion, g/b reserved for
 *      reactive/shading-change masks in later phases)
 */
export const DEPTH_CLIP_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var currentDepth : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var previousDepth : texture_2d<f32>;
@group(0) @binding(4) var maskOutput : texture_storage_2d<rgba8unorm, write>;

// Relative separation (fraction of current view depth) treated as a full
// disocclusion. Depth differences below ~1.5% are considered the same
// surface, absorbing depth-buffer quantization and dilation error.
const DEPTH_SEPARATION_SCALE : f32 = 0.066;
const DEPTH_SIMILARITY_FLOOR : f32 = 0.015;

// Manual bilinear fetch — r32float is not filterable, but linear view-space
// depth interpolates correctly by hand.
fn samplePreviousDepth(uv : vec2f) -> f32 {
    let pos = uv * C.renderSize - 0.5;
    let base = floor(pos);
    let frac = pos - base;
    let maxCoord = vec2i(C.renderSize) - 1;
    let p00 = clamp(vec2i(base), vec2i(0), maxCoord);
    let p11 = clamp(vec2i(base) + 1, vec2i(0), maxCoord);
    let d00 = textureLoad(previousDepth, p00, 0).r;
    let d10 = textureLoad(previousDepth, vec2i(p11.x, p00.y), 0).r;
    let d01 = textureLoad(previousDepth, vec2i(p00.x, p11.y), 0).r;
    let d11 = textureLoad(previousDepth, p11, 0).r;
    return mix(mix(d00, d10, frac.x), mix(d01, d11, frac.x), frac.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }

    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, vec2i(gid.xy), 0).xy;
    let prevUV = uv - motion;

    //* Off-Screen Reprojection
    if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }

    //* Depth Separation
    // History is invalid when the previous surface was meaningfully nearer
    // than the current one (i.e. the current surface was occluded).
    let curDepth = textureLoad(currentDepth, vec2i(gid.xy), 0).r;
    let prevDepth = samplePreviousDepth(prevUV);
    let separation = max(0.0, curDepth - prevDepth);
    let relative = max(0.0, separation / max(curDepth, 1.0e-4) - DEPTH_SIMILARITY_FLOOR);
    let disocclusion = clamp(relative / DEPTH_SEPARATION_SCALE, 0.0, 1.0);

    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);
