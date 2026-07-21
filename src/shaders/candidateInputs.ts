import { WGSL_COLOR, WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Source-policy reactive generator. Numeric/policy controls are compile-time
 * overrides so benchmark variants can specialize without changing bindings.
 * Presentation transforms are intentionally absent: both inputs stay in the
 * caller's linear/HDR domain.
 */
export const GENERATE_REACTIVE_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
override REACTIVE_USE_COMPONENT_MAX : bool = true;
override REACTIVE_APPLY_THRESHOLD : bool = true;
override REACTIVE_BINARY : bool = false;
override REACTIVE_THRESHOLD : f32 = 0.04;
override REACTIVE_SCALE : f32 = 2.0;
override REACTIVE_BINARY_VALUE : f32 = 1.0;

@group(0) @binding(1) var opaqueColor : texture_2d<f32>;
@group(0) @binding(2) var finalColor : texture_2d<f32>;
@group(0) @binding(3) var reactiveOut : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let coord = vec2i(gid.xy);
    let difference = abs(
        textureLoad(finalColor, coord, 0).rgb -
        textureLoad(opaqueColor, coord, 0).rgb
    );
    let componentMaximum = max(difference.r, max(difference.g, difference.b));
    let vectorLength = length(difference);
    var value = select(vectorLength, componentMaximum, REACTIVE_USE_COMPONENT_MAX);
    value *= REACTIVE_SCALE;
    if (REACTIVE_APPLY_THRESHOLD && value < REACTIVE_THRESHOLD) { value = 0.0; }
    if (REACTIVE_BINARY && value > 0.0) { value = REACTIVE_BINARY_VALUE; }
    textureStore(reactiveOut, coord, vec4f(clamp(value, 0.0, 1.0), 0.0, 0.0, 1.0));
}
`,
);

const WGSL_CANDIDATE_DEPTH = /* wgsl */ `
// WGSL has no isInf(); an f32 far plane past ~3.4e38 can only be +inf.
fn candidateFarIsInfinite(farPlane : f32) -> bool {
    return farPlane > 3.0e38;
}

fn candidateLinearizeDepth(depth : f32) -> f32 {
    let nearPlane = C.depthNearFar.x;
    let farPlane = C.depthNearFar.y;
    if (!hasFlag(FLAG_PERSPECTIVE)) {
        let normalized = select(depth, 1.0 - depth, hasFlag(FLAG_REVERSED_DEPTH));
        return select(
            nearPlane + normalized * (farPlane - nearPlane),
            nearPlane + normalized * 1.0e6,
            candidateFarIsInfinite(farPlane),
        );
    }
    if (candidateFarIsInfinite(farPlane)) {
        return select(
            nearPlane / max(1.0 - depth, 1.0e-7),
            nearPlane / max(depth, 1.0e-7),
            hasFlag(FLAG_REVERSED_DEPTH),
        );
    }
    return linearizeDepth(depth);
}

// Encoding "nearness" monotonically lets both depth conventions use
// atomicMax and lets commandEncoder.clearBuffer provide the empty sentinel.
fn encodeNearestDepth(depth : f32) -> u32 {
    let nearness = select(1.0 - depth, depth, hasFlag(FLAG_REVERSED_DEPTH));
    return bitcast<u32>(max(nearness, 0.0));
}

fn decodeNearestDepth(encoded : u32) -> f32 {
    let nearness = bitcast<f32>(encoded);
    return select(1.0 - nearness, nearness, hasFlag(FLAG_REVERSED_DEPTH));
}
`;

/**
 * Source-style prepare-inputs and reconstructed-depth scatter candidate.
 * A storage-buffer atomic boundary is used because WebGPU storage textures do
 * not provide portable floating-point atomics.
 */
export const PREPARE_INPUTS_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    WGSL_DEPTH,
    WGSL_CANDIDATE_DEPTH,
    /* wgsl */ `
override MOTION_INPUT_AT_DISPLAY_RESOLUTION : bool = false;
override MOTION_CANCEL_JITTER : bool = false;
override MOTION_SCALE_X : f32 = 1.0;
override MOTION_SCALE_Y : f32 = 1.0;
override PREPARE_STRUCTURAL_SIGNALS : bool = false;

struct AtomicDepthBuffer {
    values : array<atomic<u32>>,
}

@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var inputColor : texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> reconstructedDepth : AtomicDepthBuffer;
@group(0) @binding(5) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(6) var dilatedMotion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var inputSignals : texture_storage_2d<rgba16float, write>;

fn motionLoadCoord(renderCoord : vec2i) -> vec2i {
    if (!MOTION_INPUT_AT_DISPLAY_RESOLUTION) { return renderCoord; }
    let uv = (vec2f(renderCoord) + 0.5) * C.renderSizeInv;
    let dimensions = vec2i(textureDimensions(sceneVelocity));
    return clamp(vec2i(uv * vec2f(dimensions)), vec2i(0), dimensions - 1);
}

fn scatterDepth(coord : vec2i, encoded : u32) {
    if (any(coord < vec2i(0)) || any(coord >= vec2i(C.renderSize))) { return; }
    let index = u32(coord.y) * u32(C.renderSize.x) + u32(coord.x);
    atomicMax(&reconstructedDepth.values[index], encoded);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maximum = vec2i(C.renderSize) - 1;
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var nearestDepth = textureLoad(sceneDepth, center, 0);
    var farthestDepth = nearestDepth;
    var nearestCoord = center;

    //* Depth Extents ===
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let coord = clamp(center + vec2i(x, y), vec2i(0), maximum);
            let depth = textureLoad(sceneDepth, coord, 0);
            let nearer = select((depth < nearestDepth), (depth > nearestDepth), reversed);
            let farther = select((depth > farthestDepth), (depth < farthestDepth), reversed);
            if (nearer) {
                nearestDepth = depth;
                nearestCoord = coord;
            }
            if (PREPARE_STRUCTURAL_SIGNALS && farther) { farthestDepth = depth; }
        }
    }

    //* Motion Convention Adapter ===
    let velocityCoord = motionLoadCoord(nearestCoord);
    var motion = textureLoad(sceneVelocity, velocityCoord, 0).xy;
    motion *= C.motionScale * vec2f(MOTION_SCALE_X, MOTION_SCALE_Y);
    if (MOTION_CANCEL_JITTER) {
        motion -= (C.jitter - C.jitterPrev) * C.renderSizeInv;
    }

    let nearestMeters = min(candidateLinearizeDepth(nearestDepth), 65504.0);
    let motionPixels4K = length(motion * vec2f(3840.0, 2160.0));
    let motionThreshold = mix(0.25, 0.75, clamp(nearestMeters / 100.0, 0.0, 1.0));
    if (motionPixels4K <= motionThreshold) { motion = vec2f(0.0); }

    //* Atomic Previous-Depth Scatter ===
    let uv = (vec2f(center) + 0.5) * C.renderSizeInv;
    let previousPosition = (uv - motion) * C.renderSize - 0.5;
    let base = vec2i(floor(previousPosition));
    let fraction = fract(previousPosition);
    let weights = vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
    let encoded = encodeNearestDepth(nearestDepth);
    if (weights.x > 6.1e-4) { scatterDepth(base, encoded); }
    if (weights.y > 6.1e-4) { scatterDepth(base + vec2i(1, 0), encoded); }
    if (weights.z > 6.1e-4) { scatterDepth(base + vec2i(0, 1), encoded); }
    if (weights.w > 6.1e-4) { scatterDepth(base + vec2i(1, 1), encoded); }

    var farthestMeters = nearestMeters;
    var currentLuma = 0.0;
    if (PREPARE_STRUCTURAL_SIGNALS) {
        farthestMeters = min(candidateLinearizeDepth(farthestDepth), 65504.0);
        currentLuma = min(
            luma(max(textureLoad(inputColor, center, 0).rgb, vec3f(0.0))),
            65504.0,
        );
    }
    textureStore(dilatedDepth, center, vec4f(nearestDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, center, vec4f(motion, 0.0, 0.0));
    textureStore(inputSignals, center, vec4f(farthestMeters, currentLuma, nearestMeters, 0.0));
}
`,
);

/**
 * Source-style disocclusion and motion-divergence candidate consuming the
 * synchronized reconstructed-depth buffer.
 */
export const DEPTH_CLIP_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    WGSL_CANDIDATE_DEPTH,
    /* wgsl */ `
override DEPTH_CLIP_MOTION_DIVERGENCE : bool = false;

struct AtomicDepthBuffer {
    values : array<atomic<u32>>,
}

@group(0) @binding(1) var<storage, read_write> reconstructedDepth : AtomicDepthBuffer;
@group(0) @binding(2) var dilatedDepth : texture_2d<f32>;
@group(0) @binding(3) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(4) var masksOut : texture_storage_2d<rgba16float, write>;

fn reconstructedLoad(coord : vec2i) -> f32 {
    let clamped = clamp(coord, vec2i(0), vec2i(C.renderSize) - 1);
    let index = u32(clamped.y) * u32(C.renderSize.x) + u32(clamped.x);
    return decodeNearestDepth(atomicLoad(&reconstructedDepth.values[index]));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let coord = vec2i(gid.xy);
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    let previousUv = uv - motion;
    if (any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
        textureStore(masksOut, coord, vec4f(1.0, 0.0, 0.0, 0.0));
        return;
    }

    //* Viewport/Depth-Scaled Disocclusion ===
    let samplePosition = previousUv * C.renderSize - 0.5;
    let base = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    let weights = vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
    let currentDepth = candidateLinearizeDepth(textureLoad(dilatedDepth, coord, 0).r);
    let halfViewportWidth = length(C.renderSize * 0.5);
    var separationConfidence = 0.0;
    var weightSum = 0.0;
    var potentialDisocclusion = true;

    for (var index = 0; index < 4; index++) {
        let weight = weights[index];
        if (weight <= 6.1e-4) { continue; }
        let previousRaw = reconstructedLoad(base + offsets[index]);
        let previousDepth = candidateLinearizeDepth(previousRaw);
        let difference = currentDepth - previousDepth;
        potentialDisocclusion = potentialDisocclusion && difference > 1.175e-38;
        if (potentialDisocclusion) {
            let required = 1.37e-5 * halfViewportWidth * max(currentDepth, previousDepth);
            separationConfidence += clamp(required / max(difference, 1.0e-7), 0.0, 1.0) * weight;
            weightSum += weight;
        }
    }
    let disocclusion = select(
        0.0,
        clamp(1.0 - separationConfidence / max(weightSum, 1.0e-6), 0.0, 1.0),
        potentialDisocclusion && weightSum > 0.0,
    );

    //* Motion Divergence ===
    var motionDivergence = 0.0;
    if (DEPTH_CLIP_MOTION_DIVERGENCE) {
        let reprojectedCoord = clamp(vec2i(previousUv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
        let reprojectedMotion = textureLoad(dilatedMotion, reprojectedCoord, 0).xy;
        let reprojectedDepth = candidateLinearizeDepth(textureLoad(dilatedDepth, reprojectedCoord, 0).r);
        let velocity = length(motion * vec2f(3840.0, 2160.0));
        let reprojectedVelocity = length(reprojectedMotion * vec2f(3840.0, 2160.0));
        let depthRatio = min(currentDepth, reprojectedDepth) / max(max(currentDepth, reprojectedDepth), 1.0e-6);
        motionDivergence =
            (1.0 - clamp(reprojectedVelocity / max(velocity, 1.0e-6), 0.0, 1.0)) *
            depthRatio *
            clamp(velocity / 10.0, 0.0, 1.0);
    }

    textureStore(masksOut, coord, vec4f(disocclusion, motionDivergence, 0.0, 0.0));
}
`,
);

/**
 * Prepare-reactivity candidate. Aggressive application reactivity drives the
 * reset/shading channel; T&C and motion divergence remain a softer,
 * separately packed rectification signal.
 */
export const PREPARE_REACTIVITY_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
struct AtomicLockBuffer {
    values : array<atomic<u32>>,
}

@group(0) @binding(1) var depthMotionMasks : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var inputSignals : texture_2d<f32>;
@group(0) @binding(4) var reactiveMask : texture_2d<f32>;
@group(0) @binding(5) var transparencyCompositionMask : texture_2d<f32>;
@group(0) @binding(6) var accumulationIn : texture_2d<f32>;
@group(0) @binding(7) var shadingChange : texture_2d<f32>;
@group(0) @binding(8) var preparedMasks : texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var accumulationOut : texture_storage_2d<r32float, write>;
@group(0) @binding(10) var<storage, read_write> newLocks : AtomicLockBuffer;

fn maskLoad(mask : texture_2d<f32>, coord : vec2i) -> f32 {
    let dimensions = vec2i(textureDimensions(mask));
    let uv = (vec2f(coord) + 0.5) * C.renderSizeInv;
    let sampleCoord = clamp(vec2i(uv * vec2f(dimensions)), vec2i(0), dimensions - 1);
    return clamp(textureLoad(mask, sampleCoord, 0).r, 0.0, 1.0);
}

fn currentLuma(coord : vec2i) -> f32 {
    return textureLoad(inputSignals, clamp(coord, vec2i(0), vec2i(C.renderSize) - 1), 0).g;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let coord = vec2i(gid.xy);
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    let depthMotion = textureLoad(depthMotionMasks, coord, 0);

    //* Max-Dilated Application Reactive ===
    var aggressiveReactive = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            aggressiveReactive = max(aggressiveReactive, maskLoad(reactiveMask, coord + vec2i(x, y)));
        }
    }

    let composition = maskLoad(transparencyCompositionMask, coord);
    let softReactive = max(composition, clamp(depthMotion.g, 0.0, 1.0));
    let shading = max(aggressiveReactive, maskLoad(shadingChange, coord));
    let disocclusion = clamp(depthMotion.r, 0.0, 1.0);

    //* Accumulation Reset Coupling ===
    let previousUv = uv - motion;
    var accumulation = 0.0;
    if (
        !hasFlag(FLAG_RESET) &&
        all(previousUv >= vec2f(0.0)) &&
        all(previousUv <= vec2f(1.0))
    ) {
        let previousCoord = clamp(vec2i(previousUv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
        accumulation = textureLoad(accumulationIn, previousCoord, 0).r - 0.333;
    }
    accumulation = min(accumulation + 1.0 / max(C.maxAccumulation, 1.0), 1.0);
    accumulation = mix(accumulation, 0.0, shading);
    accumulation = mix(accumulation, min(-0.333, accumulation), disocclusion);
    let storedAccumulation = clamp(accumulation + 0.333, 0.0, 1.0);
    textureStore(accumulationOut, coord, vec4f(storedAccumulation, 0.0, 0.0, 1.0));

    //* Ridge Lock Candidate ===
    var minimumLuma = 1.0e6;
    var maximumLuma = 0.0;
    let nucleus = currentLuma(coord);
    var similarQuadrants = 0u;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let sample = currentLuma(coord + vec2i(x, y));
            minimumLuma = min(minimumLuma, sample);
            maximumLuma = max(maximumLuma, sample);
            if (abs(sample - nucleus) <= 0.1 * max(maximumLuma - minimumLuma, 1.0e-5)) {
                similarQuadrants += 1u;
            }
        }
    }
    let ridge = (nucleus > maximumLuma - 1.0e-5 || nucleus < minimumLuma + 1.0e-5) && similarQuadrants < 6u;
    let lockStrength = select(0.0, 1.0 - minimumLuma / max(maximumLuma, 1.0e-5), ridge);
    if (lockStrength > 0.01) {
        let displayCoord = clamp(
            vec2i(floor((vec2f(coord) + 0.5 - C.jitter) * C.displaySize / C.renderSize)),
            vec2i(0),
            vec2i(C.displaySize) - 1,
        );
        let lockIndex = u32(displayCoord.y) * u32(C.displaySize.x) + u32(displayCoord.x);
        atomicMax(&newLocks.values[lockIndex], u32(clamp(lockStrength, 0.0, 1.0) * 65535.0));
    }

    textureStore(preparedMasks, coord, vec4f(softReactive, disocclusion, shading, clamp(accumulation, 0.0, 1.0)));
}
`,
);
