import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Depth/motion dilation pass (FSR2/3's "reconstruct & dilate" stage,
 * simplified — see the shaders README for what the full stage adds).
 *
 * For every render-resolution pixel, finds the nearest (closest-to-camera)
 * depth in the 3×3 neighborhood and outputs that texel's motion vector.
 * Dilation makes thin foreground silhouettes drag their motion with them,
 * which prevents the accumulation pass from smearing background history
 * onto object edges.
 *
 * Outputs linearized view-space distance so downstream comparisons are in
 * meaningful world units rather than non-linear depth-buffer values.
 *
 * Bindings:
 * - 1: scene depth (depth texture, render size)
 * - 2: velocity (rgba16float, NDC delta in .xy, render size)
 * - 3: dilated view depth output (r32float storage)
 * - 4: dilated motion output (rgba16float storage, UV delta in .xy)
 */
export const DILATE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(4) var dilatedMotion : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    //* Nearest Depth Search
    // With a reversed depth buffer larger values are nearer; otherwise
    // smaller values are. Track the raw winner and its texel.
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0);
    var bestCoord = center;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let p = clamp(center + vec2i(x, y), vec2i(0), maxCoord);
            let d = textureLoad(sceneDepth, p, 0);
            let nearer = select(d < bestDepth, d > bestDepth, reversed);
            if (nearer) {
                bestDepth = d;
                bestCoord = p;
            }
        }
    }

    //* Outputs
    let ndcDelta = textureLoad(sceneVelocity, bestCoord, 0).xy;
    let uvDelta = ndcDelta * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(linearizeDepth(bestDepth), 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, 0.0, 0.0));
}
`,
);
