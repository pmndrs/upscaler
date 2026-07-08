import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Reconstruct pass — fuses FSR2/3's "reconstruct & dilate" and "depth clip"
 * stages into one render-resolution dispatch (a Phase-5 merge: depth clip only
 * ever read the current pixel's own dilated depth and motion, both of which
 * this pass already has in-register, plus the previous frame's dilated depth).
 *
 * Per render-resolution pixel:
 * 1. Dilate — find the nearest (closest-to-camera) depth in the 3×3
 *    neighborhood and take that texel's motion vector, so thin foreground
 *    silhouettes drag their motion and don't smear background history.
 * 2. Depth clip — reproject through that motion and compare the current
 *    dilated (linear) depth against last frame's dilated depth; a surface that
 *    was hidden behind something nearer last frame is disoccluded and its
 *    history must be dropped.
 *
 * Bindings:
 * - 1: scene depth (depth texture, render size)
 * - 2: velocity (rgba16float, NDC delta in .xy, render size)
 * - 3: previous frame's dilated view depth (r32float, render size)
 * - 4: dilated view depth output (r32float storage)
 * - 5: dilated motion output (rgba16float storage, UV delta in .xy)
 * - 6: mask output (rgba8unorm storage; r = disocclusion)
 */
export const RECONSTRUCT_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var previousDepth : texture_2d<f32>;
@group(0) @binding(4) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(5) var dilatedMotion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var maskOutput : texture_storage_2d<rgba8unorm, write>;

// Relative separation (fraction of current view depth) treated as a full
// disocclusion. Depth differences below ~1.5% are considered the same surface,
// absorbing depth-buffer quantization and dilation error.
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
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    //* Nearest Depth Search (dilate)
    // With a reversed depth buffer larger values are nearer; otherwise smaller.
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0);
    var bestCoord = center;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let p = clamp(center + vec2i(x, y), vec2i(0), maxCoord);
            let d = textureLoad(sceneDepth, p, 0);
            // Parenthesize the comparisons: WGSL otherwise parses the
            // '<' ... '>' as a template argument list and fails to compile.
            let nearer = select((d < bestDepth), (d > bestDepth), reversed);
            if (nearer) {
                bestDepth = d;
                bestCoord = p;
            }
        }
    }

    let curDepth = linearizeDepth(bestDepth);
    let uvDelta = textureLoad(sceneVelocity, bestCoord, 0).xy * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(curDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, 0.0, 0.0));

    //* Depth Clip — disocclusion from the just-dilated depth + motion.
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let prevUV = uv - uvDelta;
    if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }
    // History is invalid when the previous surface was meaningfully nearer than
    // the current one (i.e. the current surface was occluded).
    let prevDepth = samplePreviousDepth(prevUV);
    let separation = max(0.0, curDepth - prevDepth);
    let relative = max(0.0, separation / max(curDepth, 1.0e-4) - DEPTH_SIMILARITY_FLOOR);
    let disocclusion = clamp(relative / DEPTH_SEPARATION_SCALE, 0.0, 1.0);
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);
