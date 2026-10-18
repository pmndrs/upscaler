import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Bench-only reconstruct identities for issue #67, handed to `Upscaler`
 * through its internal `_crossFrameReconstruct` option (never imported by the
 * library, so they stay out of dist/). Production is the scatter pair in
 * `reconstruct.ts`.
 *
 * - `cross-frame` — the frozen pre-#67 production pass
 *   ({@link RECONSTRUCT_CROSS_FRAME_SHADER}): compares this
 *   frame's depth against last frame's dilated depth, so a camera moving away
 *   from a surface reads as separation.
 * - `camera` — the cross-frame pass with the camera-motion-compensated
 *   compare: each pixel's current view-space point is carried into the
 *   previous view (relative camera transform, one dot product) and THAT
 *   predicted depth is compared. Fixes camera motion at ~zero cost; object
 *   motion in depth still disoccludes. The measured alternative to the
 *   scatter (bench/docs/NEXT-STEPS.md §15).
 * - `depth-clip-*` — production's scatter + depth clip with the depth-clip
 *   pass rebuilt toward upstream FSR2 one piece at a time
 *   ({@link buildDepthClipVariant}, issue #79; all measured, none adopted).
 */

/**
 * FROZEN bench identity (`reconstruct-cross-frame-v1`): the fused
 * cross-frame reconstruct that was production until issue #67. Kept verbatim
 * for A/B; production is `RECONSTRUCT_SHADER` + `DEPTH_CLIP_SHADER` in reconstruct.ts.
 *
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
export const RECONSTRUCT_CROSS_FRAME_SHADER = assembleShader(
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

/** Side uniform for the `camera` variant (kept out of `FsrConstants` so the
 * experiment does not re-fingerprint every production shader). */
const WGSL_REPROJECT = /* wgsl */ `
struct ReprojectConstants {
    // dot(prevDepthRow, vec4(viewPos, 1)) = previous-frame view depth of a
    // current view-space point (negated z row of prevView * currentCameraWorld).
    prevDepthRow : vec4f,
    // xy = 1/P00, 1/P11; zw = NDC offset (perspective: P20, P21; ortho: -P30, -P31)
    // of the UNJITTERED projection — the jitter is added back per texel below.
    unproject    : vec4f,
}

fn previousViewDepth(R : ReprojectConstants, coord : vec2i, depth : f32) -> f32 {
    // Texel i sampled the scene at i + jitter (render px, top-left origin).
    let uv = (vec2f(coord) + 0.5 + C.jitter) * C.renderSizeInv;
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let scale = select(1.0, depth, hasFlag(FLAG_PERSPECTIVE));
    let viewXY = (ndc + R.unproject.zw) * R.unproject.xy * scale;
    return dot(R.prevDepthRow, vec4f(viewXY, -depth, 1.0));
}
`;

/** Dilation shared by every variant: nearest depth, its coord, the farthest depth. */
const WGSL_DILATE = /* wgsl */ `
struct Dilated {
    nearest : f32,
    farthest : f32,
    coord : vec2i,
}

fn dilate(center : vec2i, maxCoord : vec2i) -> Dilated {
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0);
    var farthestDepth = bestDepth;
    var bestCoord = center;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let p = clamp(center + vec2i(x, y), vec2i(0), maxCoord);
            let d = textureLoad(sceneDepth, p, 0);
            let nearer = select((d < bestDepth), (d > bestDepth), reversed);
            if (nearer) {
                bestDepth = d;
                bestCoord = p;
            }
            let farther = select((d > farthestDepth), (d < farthestDepth), reversed);
            if (farther) { farthestDepth = d; }
        }
    }
    return Dilated(bestDepth, farthestDepth, bestCoord);
}

fn bilinearWeights(fraction : vec2f) -> vec4f {
    return vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
}

const DEPTH_SEPARATION_CONSTANT : f32 = 1.37e-5;
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;

fn tapConfidence(expectedDepth : f32, tapDepth : f32, localRelief : f32) -> f32 {
    let difference = expectedDepth - tapDepth;
    if (difference <= 0.0) { return 1.0; }
    let halfViewportWidth = length(C.renderSize * 0.5);
    let required = max(
        DEPTH_SEPARATION_CONSTANT * halfViewportWidth * max(expectedDepth, tapDepth),
        localRelief,
    );
    return clamp(required / max(difference, 1.0e-7), 0.0, 1.0);
}
`;

/**
 * `camera`: production fused pass with the camera-motion-compensated compare.
 * Bindings 1–6 as production; 7 = ReprojectConstants uniform.
 */
export const RECONSTRUCT_CAMERA_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var previousDepth : texture_2d<f32>;
@group(0) @binding(4) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(5) var dilatedMotion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var maskOutput : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(7) var<uniform> R : ReprojectConstants;
${WGSL_REPROJECT}
${WGSL_DILATE}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    let dilated = dilate(center, maxCoord);
    let curDepth = linearizeDepth(dilated.nearest);
    let localRelief = max(linearizeDepth(dilated.farthest) - curDepth, 0.0);
    let uvDelta = textureLoad(sceneVelocity, dilated.coord, 0).xy * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(curDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, 0.0, 0.0));

    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let motionUV = uv - uvDelta;
    if (any(motionUV < vec2f(0.0)) || any(motionUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }
    // The one change vs production: compare last frame's depth against where
    // THIS surface point sat in last frame's view, not against its current
    // depth — the two cameras' depth axes differ whenever the camera moves.
    // Background texels (cleared depth) are not surface points: carried into
    // the previous view they drift off the far plane and read as separation
    // under rotation, so they keep the uncompensated compare.
    let background = select(dilated.nearest >= 1.0, dilated.nearest <= 0.0, hasFlag(FLAG_REVERSED_DEPTH));
    let expectedDepth = select(previousViewDepth(R, dilated.coord, curDepth), curDepth, background);

    let prevUV = motionUV + (C.jitter - C.jitterPrev) * C.renderSizeInv;
    let samplePosition = prevUV * C.renderSize - 0.5;
    let base = vec2i(floor(samplePosition));
    let weights = bilinearWeights(fract(samplePosition));
    let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    var surfaceConfidence = 0.0;
    var sawValidTap = false;
    for (var index = 0; index < 4; index++) {
        if (weights[index] <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let p = clamp(base + offsets[index], vec2i(0), maxCoord);
        let prevDepth = textureLoad(previousDepth, p, 0).r;
        surfaceConfidence = max(surfaceConfidence, tapConfidence(expectedDepth, prevDepth, localRelief));
        sawValidTap = true;
    }
    let disocclusion = select(0.0, clamp(1.0 - surfaceConfidence, 0.0, 1.0), sawValidTap);
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);


/** Options for {@link buildDepthClipVariant} (issue #79). */
export interface DepthClipVariantOptions {
    /**
     * `ours`: `1.37e-5 · length(renderSize / 2) · maxDepth` (production).
     * `upstream`: `1.37e-5 · Kfov · length(renderSize) · maxDepth`, as
     * ffx_fsr2_depth_clip.h actually computes it — its `fHalfViewportWidth` is
     * the full diagonal, and `Kfov` = |corner| / |center| of the view plane.
     */
    tolerance: 'ours' | 'upstream';
    /** Widen the tolerance by the 3×3 depth relief (production). */
    relief: boolean;
    /**
     * `best-tap`: max confidence over the footprint (production).
     * `upstream`: weighted mean over the positive-separation taps of
     * `saturate(required / difference)^power`, power 1 → 3 with render size.
     */
    vote: 'best-tap' | 'upstream';
    /**
     * Upstream's `EvaluateSurface`: no disocclusion where the reconstructed
     * depth falls monotonically by > 1% per texel down the column (a plane
     * receding toward the horizon) — upstream's answer to grazing floors.
     */
    surfaceCheck: boolean;
}

/**
 * Bench-only depth-clip variants for issue #79: production's
 * `DEPTH_CLIP_SHADER` with the cross-frame-era stabilizers (relief widening,
 * best-tap vote) and the tolerance scale toggled one at a time, up to
 * upstream's full formulation. Same bindings as production.
 *
 * `Kfov` needs the camera's vertical FOV, which the constants UBO doesn't
 * carry: it is the pipeline override `TAN_HALF_VFOV` (default: the bench
 * camera's 50°), with the aspect taken from the render size.
 * @param options - Which pieces to take from upstream
 * @returns A WGSL module with `DEPTH_CLIP_SHADER`'s bindings
 */
export function buildDepthClipVariant(options: DepthClipVariantOptions): string {
    const required =
        options.tolerance === 'upstream'
            ? 'DEPTH_SEPARATION_CONSTANT * kfov() * length(C.renderSize) * max(curDepth, tapDepth)'
            : 'DEPTH_SEPARATION_CONSTANT * length(C.renderSize * 0.5) * max(curDepth, tapDepth)';
    const tolerance = options.relief ? `max(${required}, localRelief)` : required;
    const vote =
        options.vote === 'upstream'
            ? /* wgsl */ `
        if (difference > 0.0) {
            let ratio = clamp(${tolerance} / max(difference, 1.0e-7), 0.0, 1.0);
            confidenceSum += pow(ratio, power) * weight;
            weightSum += weight;
        }`
            : /* wgsl */ `
        var tapConfidence = 1.0;
        if (difference > 0.0) {
            tapConfidence = clamp(${tolerance} / max(difference, 1.0e-7), 0.0, 1.0);
        }
        surfaceConfidence = max(surfaceConfidence, tapConfidence);
        sawValidTap = true;`;
    const resolve =
        options.vote === 'upstream'
            ? 'var disocclusion = select(0.0, clamp(1.0 - confidenceSum / weightSum, 0.0, 1.0), weightSum > 0.0);'
            : 'var disocclusion = select(0.0, clamp(1.0 - surfaceConfidence, 0.0, 1.0), sawValidTap);';
    const surface = options.surfaceCheck
        ? /* wgsl */ `
    // Upstream EvaluateSurface: a column of reconstructed depth falling by
    // > 1% per texel is a receding plane, not a disocclusion.
    let d0 = reconstructedAt(center + vec2i(0, -1));
    let d1 = reconstructedAt(center);
    let d2 = reconstructedAt(center + vec2i(0, 1));
    if (((d0 - d1) > (d1 * 0.01)) && ((d1 - d2) > (d2 * 0.01))) { disocclusion = 0.0; }`
        : '';
    return assembleShader(
        WGSL_CONSTANTS,
        /* wgsl */ `
@group(0) @binding(1) var dilatedDepth : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var<storage, read> reconstructedDepth : array<u32>;
@group(0) @binding(4) var maskOutput : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read_write> nextReconstructedDepth : array<u32>;

override TAN_HALF_VFOV : f32 = 0.46630766;
const DEPTH_SEPARATION_CONSTANT : f32 = 1.37e-5;
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;
const EMPTY_DEPTH : u32 = 0x7f800000u;

// |corner| / |center| of the view plane at any depth.
fn kfov() -> f32 {
    let aspect = C.renderSize.x / C.renderSize.y;
    let t = TAN_HALF_VFOV;
    return sqrt(1.0 + t * t * (1.0 + aspect * aspect));
}

fn reconstructedAt(coord : vec2i) -> f32 {
    let p = clamp(coord, vec2i(0), vec2i(C.renderSize) - 1);
    return bitcast<f32>(reconstructedDepth[u32(p.y * i32(C.renderSize.x) + p.x)]);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;
    let width = i32(C.renderSize.x);
    nextReconstructedDepth[u32(center.y * width + center.x)] = EMPTY_DEPTH;

    let curDepth = textureLoad(dilatedDepth, center, 0).r;
    let motion = textureLoad(dilatedMotion, center, 0);
    let uvDelta = motion.xy;
    let localRelief = motion.z;

    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let prevUV = uv - uvDelta;
    if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }
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
    let power = mix(1.0, 3.0, clamp(length(C.renderSize) / length(vec2f(1920.0, 1080.0)), 0.0, 1.0));
    var surfaceConfidence = 0.0;
    var sawValidTap = false;
    var confidenceSum = 0.0;
    var weightSum = 0.0;
    for (var index = 0; index < 4; index++) {
        let weight = weights[index];
        if (weight <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let tapDepth = reconstructedAt(base + offsets[index]);
        let difference = curDepth - tapDepth;${vote}
    }
    ${resolve}${surface}
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
    );
}

/** The #79 matrix by bench identity: one change at a time, then all of upstream. */
export const DEPTH_CLIP_VARIANTS = {
    'depth-clip-no-relief-v1': { tolerance: 'ours', relief: false, vote: 'best-tap', surfaceCheck: false },
    'depth-clip-mean-vote-v1': { tolerance: 'ours', relief: true, vote: 'upstream', surfaceCheck: false },
    'depth-clip-upstream-tolerance-v1': { tolerance: 'upstream', relief: true, vote: 'best-tap', surfaceCheck: false },
    'depth-clip-upstream-v1': { tolerance: 'upstream', relief: false, vote: 'upstream', surfaceCheck: true },
} as const satisfies Record<string, DepthClipVariantOptions>;
