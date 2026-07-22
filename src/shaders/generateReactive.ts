import { WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

/**
 * Auto-generate a reactive mask (FSR2/3's `ffxFsr2GenerateReactiveMask`).
 *
 * Given the scene rendered twice — once with only opaque geometry, once with
 * transparents composited on top — the per-pixel color difference marks where
 * transparent/additive content sits. That difference, thresholded and scaled,
 * becomes the reactive mask fed to {@link accumulate}: those pixels favour the
 * current frame instead of ghosting. It saves the caller from authoring
 * coverage by hand when they can render an opaque-only pass.
 *
 * Reactivity is bidirectional (TEMPORAL-GUIDES-SPEC §6): an incoming mask —
 * the caller's explicit coverage, or one an effect wrote — merges with the
 * generated diff by `max`, never overwritten. With no incoming mask the 1×1
 * zero dummy is bound and the merge is inert.
 *
 * Bindings:
 * - 1: opaque-only color, render size
 * - 2: final (opaque + transparent) color, render size
 * - 3: reactive out (rgba8unorm storage, render size; r = reactivity)
 * - 4: incoming reactive mask, render size (r = reactivity; 1×1 zero dummy
 *      when absent). Must not alias binding 3.
 */
export const GENERATE_REACTIVE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var opaqueColor : texture_2d<f32>;
@group(0) @binding(2) var finalColor : texture_2d<f32>;
@group(0) @binding(3) var reactiveOut : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var incomingReactive : texture_2d<f32>;

// Below this per-channel difference the pixel is treated as unchanged (opaque);
// above it, scaled up to a cap so a faint transparent still reacts meaningfully.
const REACTIVE_THRESHOLD : f32 = 0.04;
const REACTIVE_SCALE : f32 = 2.0;
const REACTIVE_MAX : f32 = 0.9;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let p = vec2i(gid.xy);
    let o = textureLoad(opaqueColor, p, 0).rgb;
    let f = textureLoad(finalColor, p, 0).rgb;
    let d = abs(f - o);
    let diff = max(d.r, max(d.g, d.b));
    let generated = clamp((diff - REACTIVE_THRESHOLD) * REACTIVE_SCALE, 0.0, REACTIVE_MAX);
    // Merge, don't overwrite: the strongest reactivity claim wins. The dummy
    // is 1×1 — clamp the load so any render-res incoming mask reads per-texel
    // while the dummy reads its lone zero everywhere.
    let incomingSize = vec2i(textureDimensions(incomingReactive));
    let incoming = textureLoad(incomingReactive, min(p, incomingSize - 1), 0).r;
    let reactive = max(generated, clamp(incoming, 0.0, 1.0));
    textureStore(reactiveOut, p, vec4f(reactive, 0.0, 0.0, 1.0));
}
`,
);
