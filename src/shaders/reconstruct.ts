import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Reconstruct pass — fuses FSR2/3's "reconstruct & dilate" and "depth clip"
 * stages into one render-resolution dispatch (fused deliberately: depth clip only
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
 * The comparison is cross-frame (current depth vs last frame's dilated-depth
 * texture) — deliberately cheaper than the reference, which scatters current
 * depth into a same-frame "reconstructed previous depth" buffer and compares
 * against that (measured +22–30% for those passes in the parity program). The
 * price of the cross-frame form is sampling mismatch: the reprojected point
 * carries sub-texel error (bilinear taps, jitter phase), so on steep depth
 * gradients — a ground plane at grazing incidence — neighboring taps differ
 * by many view units and a fixed tolerance reads that as separation
 * (measured: full-screen disocclusion flicker on the distant floor in
 * example 12). Two compensations make the cheap form sound: the reprojection
 * is jitter-delta-compensated (same derivation as shadingChange.ts), and the
 * separation tolerance is widened by the 3×3 neighborhood's own depth relief,
 * which the dilation ring provides for free.
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

// AMD's separation tolerance (ffx_fsr2_depth_clip.h): the minimum view-depth
// gap that reads as a different surface scales with viewport resolution and
// scene depth, absorbing depth-buffer quantization without a scene-tuned guess.
const DEPTH_SEPARATION_CONSTANT : f32 = 1.37e-5;
// Bilinear taps lighter than this cannot vote (matches the reference).
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    //* Nearest Depth Search (dilate)
    // With a reversed depth buffer larger values are nearer; otherwise smaller.
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0);
    var farthestDepth = bestDepth;
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
            let farther = select((d > farthestDepth), (d < farthestDepth), reversed);
            if (farther) { farthestDepth = d; }
        }
    }

    let curDepth = linearizeDepth(bestDepth);
    // The neighborhood's own depth relief in view units — how much the local
    // surface slopes across one texel ring. A reprojected tap can legitimately
    // land anywhere inside this relief without being a different surface.
    let localRelief = max(linearizeDepth(farthestDepth) - curDepth, 0.0);
    let uvDelta = textureLoad(sceneVelocity, bestCoord, 0).xy * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(curDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, 0.0, 0.0));

    //* Depth Clip — disocclusion from the just-dilated depth + motion.
    // Derived from AMD's formulation (ffx_fsr2_depth_clip.h ComputeDepthClip,
    // via the GPU-verified candidate port): each bilinear tap of last frame's
    // dilated depth votes a confidence that its separation from the current
    // depth is within the viewport/depth-scaled tolerance. We diverge in the
    // aggregation — the best tap wins instead of a positive-separation-only
    // weighted mean — because our cross-frame compare (unlike upstream's
    // same-frame scatter) carries the previous frame's silhouette
    // quantization; see the vote comment below.
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    // Off-screen is a property of the world point, so it is tested on the
    // motion-only reprojection. The jitter-delta shift below can move a border
    // texel's comparison point up to a texel past the edge even on a still
    // camera — testing that instead read as a disoccluded viewport border on
    // ~14% of frames (example 09) — and last frame's border texel still covers
    // it (taps are clamped).
    let motionUV = uv - uvDelta;
    if (any(motionUV < vec2f(0.0)) || any(motionUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }
    // Texel i samples the scene at i + jitter, so the previous frame's
    // equivalent position shifts by the jitter delta — without this the
    // comparison point oscillates ±½ texel with the jitter sequence, which
    // on a depth gradient reads as per-phase disocclusion flicker.
    let prevUV = motionUV + (C.jitter - C.jitterPrev) * C.renderSizeInv;
    let samplePosition = prevUV * C.renderSize - 0.5;
    let base = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    let weights = vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
    let halfViewportWidth = length(C.renderSize * 0.5);
    var surfaceConfidence = 0.0;
    var sawValidTap = false;
    for (var index = 0; index < 4; index++) {
        let weight = weights[index];
        if (weight <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let p = clamp(base + offsets[index], vec2i(0), maxCoord);
        let prevDepth = textureLoad(previousDepth, p, 0).r;
        let difference = curDepth - prevDepth;
        // A tap at or behind the current surface recognizes it as visible last
        // frame — full confidence. Taps in front witness a possible occluder,
        // with confidence falling as the separation exceeds the tolerance.
        var tapConfidence = 1.0;
        if (difference > 0.0) {
            // Tolerance: the viewport/depth-scaled quantization term (reference
            // formulation), widened by the neighborhood's own relief so a
            // slope's legitimate per-texel depth change is not read as
            // separation.
            let required = max(
                DEPTH_SEPARATION_CONSTANT * halfViewportWidth * max(curDepth, prevDepth),
                localRelief,
            );
            tapConfidence = clamp(required / max(difference, 1.0e-7), 0.0, 1.0);
        }
        // MAX vote, not a weighted mean: the previous dilated-depth field is
        // quantized to texels, so its silhouette boundary lands up to a texel
        // away from this frame's — on a still scene one straddling tap then
        // reads the old occluder and, under a mean (worse: under the old
        // positive-difference-only vote, where agreeing taps carried no
        // weight), re-disoccludes every silhouette every frame — rolling
        // accumulation-age rings and permanent edge shimmer (consumer report
        // 3). If ANY footprint tap recognizes the current surface, it is the
        // same surface; a genuine disocclusion trail has every tap on the old
        // occluder and still reads ~1.
        surfaceConfidence = max(surfaceConfidence, tapConfidence);
        sawValidTap = true;
    }
    let disocclusion = select(0.0, clamp(1.0 - surfaceConfidence, 0.0, 1.0), sawValidTap);
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);
