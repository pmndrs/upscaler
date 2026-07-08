import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

/**
 * Debug visualization pass. Replaces the RCAS output when a debug view is
 * active so pipeline inputs can be validated visually (see `FSRDebugView`).
 *
 * Bindings:
 * - 1: dilated motion (render size)
 * - 2: masks (render size)
 * - 3: dilated view depth (render size)
 * - 4: history (display size)
 * - 5: locks (display size; r = lock lifetime)
 * - 6: exposure (1×1; r = pre-exposure, g = avg luma)
 * - 7: scene color (render size)
 * - 8: output storage (rgba8unorm, display size)
 */
export const DEBUG_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    /* wgsl */ `
@group(0) @binding(1) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(2) var masks : texture_2d<f32>;
@group(0) @binding(3) var dilatedDepth : texture_2d<f32>;
@group(0) @binding(4) var historyIn : texture_2d<f32>;
@group(0) @binding(5) var locksIn : texture_2d<f32>;
@group(0) @binding(6) var exposureTex : texture_2d<f32>;
@group(0) @binding(7) var inputColor : texture_2d<f32>;
@group(0) @binding(8) var outputColor : texture_storage_2d<rgba8unorm, write>;

// Simple HSV-ish direction coloring for motion vectors.
fn motionToColor(m : vec2f) -> vec3f {
    // sqrt response so slow sub-pixel motion is still visible without the
    // fast-motion end saturating instantly (linear scaling reads as "black").
    let mag = clamp(sqrt(length(m) * 8.0), 0.0, 1.0);
    let dir = normalize(select(m, vec2f(1.0, 0.0), length(m) < 1.0e-6));
    return vec3f(0.5 + 0.5 * dir.x * mag, 0.5 + 0.5 * dir.y * mag, mag);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }

    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    let renderCoord = clamp(vec2i(uv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);

    var c = vec3f(0.0);
    switch (C.debugMode) {
        case 1u: { // Motion vectors
            c = motionToColor(textureLoad(dilatedMotion, renderCoord, 0).xy);
        }
        case 2u: { // Disocclusion mask
            c = vec3f(textureLoad(masks, renderCoord, 0).r);
        }
        case 3u: { // Linear depth, log-scaled into visible range
            let d = textureLoad(dilatedDepth, renderCoord, 0).r;
            c = vec3f(clamp(log2(1.0 + d) / 8.0, 0.0, 1.0));
        }
        case 4u: { // Accumulation age
            c = vec3f(textureLoad(historyIn, vec2i(gid.xy), 0).a);
        }
        case 5u: { // Luminance-stability locks (r = lifetime)
            c = vec3f(textureLoad(locksIn, vec2i(gid.xy), 0).r);
        }
        case 6u: { // Auto-exposed scene luminance — should read near mid-grey
            let exposure = textureLoad(exposureTex, vec2i(0), 0).r;
            let l = luma(textureLoad(inputColor, renderCoord, 0).rgb) * exposure;
            c = vec3f(clamp(l, 0.0, 1.0));
        }
        default: {}
    }

    textureStore(outputColor, gid.xy, vec4f(c, 1.0));
}
`,
);
