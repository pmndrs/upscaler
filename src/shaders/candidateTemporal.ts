import { WGSL_COLOR, WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * Scalar exposure candidate used by the filter and structural bundles. It
 * tracks conditioning and host pre-exposure independently while retaining the
 * production metering workload for an attributable A/B.
 */
export const EXPOSURE_HISTORY_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var linearSampler : sampler;
@group(0) @binding(3) var previousFrameInfo : texture_2d<f32>;
@group(0) @binding(4) var frameInfoOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var externalConditioning : texture_2d<f32>;
@group(0) @binding(6) var hostPreExposure : texture_2d<f32>;

const EXPOSURE_KEY : f32 = 0.18;
const EXPOSURE_MIN : f32 = 0.02;
const EXPOSURE_MAX : f32 = 80.0;
const ADAPT_SPEED : f32 = 2.5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    if (any(gid.xy != vec2u(0u))) { return; }
    var logSum = 0.0;
    for (var y = 0u; y < 32u; y++) {
        for (var x = 0u; x < 32u; x++) {
            let uv = (vec2f(f32(x), f32(y)) + 0.5) / 32.0;
            let color = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
            logSum += log2(max(luma(color), 1.0e-4));
        }
    }
    let averageLuma = exp2(logSum / 1024.0);
    let targetConditioning = clamp(EXPOSURE_KEY / max(averageLuma, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX);
    let previous = textureLoad(previousFrameInfo, vec2i(0), 0);
    var conditioning = targetConditioning;
    if (!hasFlag(FLAG_RESET) && previous.r > 0.0) {
        let adaptation = clamp(1.0 - exp2(-C.deltaTime * ADAPT_SPEED), 0.0, 1.0);
        conditioning = mix(previous.r, targetConditioning, adaptation);
    }
    conditioning = select(C.exposure, conditioning, hasFlag(FLAG_AUTO_EXPOSURE));
    let externalConditioningValue = textureLoad(externalConditioning, vec2i(0), 0).r;
    conditioning = select(conditioning, externalConditioningValue, hasFlag(FLAG_EXTERNAL_EXPOSURE));
    let hostValue = textureLoad(hostPreExposure, vec2i(0), 0).r;
    let host = select(1.0, hostValue, hostValue > 0.0);
    textureStore(frameInfoOut, vec2i(0), vec4f(conditioning, averageLuma, host, log2(max(averageLuma, 1.0e-4))));
}
`,
);

/**
 * Single-dispatch luma mip candidate. Higher levels are evaluated directly
 * from the prepared luma source to avoid cross-workgroup dependencies while
 * preserving an SPD-shaped resource and dispatch boundary on WebGPU.
 */
export const LUMA_SPD_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var inputSignals : texture_2d<f32>;
@group(0) @binding(2) var previousFrameInfo : texture_2d<f32>;
@group(0) @binding(3) var externalConditioning : texture_2d<f32>;
@group(0) @binding(4) var hostPreExposure : texture_2d<f32>;
@group(0) @binding(5) var frameInfoOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var lumaMip0 : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var lumaMip1 : texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var lumaMip2 : texture_storage_2d<rgba16float, write>;

const EXPOSURE_KEY : f32 = 0.18;
const EXPOSURE_MIN : f32 = 0.02;
const EXPOSURE_MAX : f32 = 80.0;
const ADAPT_SPEED : f32 = 2.5;

fn signalLoad(coord : vec2i) -> vec2f {
    let clamped = clamp(coord, vec2i(0), vec2i(C.renderSize) - 1);
    let signal = textureLoad(inputSignals, clamped, 0);
    return vec2f(max(signal.g, 1.0e-5), signal.r);
}

fn reduceBlock(origin : vec2i, extent : i32) -> vec2f {
    var sum = vec2f(0.0);
    var count = 0.0;
    for (var y = 0; y < extent; y++) {
        for (var x = 0; x < extent; x++) {
            sum += signalLoad(origin + vec2i(x, y));
            count += 1.0;
        }
    }
    return sum / count;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let mip0Size = max(vec2u(1u), vec2u(C.renderSize + 1.0) / 2u);
    if (any(gid.xy >= mip0Size)) { return; }

    let coord = vec2i(gid.xy);
    let mip0 = reduceBlock(coord * 2, 2);
    textureStore(lumaMip0, coord, vec4f(log(max(mip0.x, 1.0e-5)), mip0.x, mip0.y, 0.0));

    // Direct reductions keep this a legal single dispatch without relying on
    // unavailable device-wide barriers between mip levels.
    if (all((gid.xy % vec2u(2u)) == vec2u(0u))) {
        let mip1 = reduceBlock(coord * 2, 4);
        textureStore(lumaMip1, coord / 2, vec4f(log(max(mip1.x, 1.0e-5)), mip1.x, mip1.y, 0.0));
    }
    if (all((gid.xy % vec2u(4u)) == vec2u(0u))) {
        let mip2 = reduceBlock(coord * 2, 8);
        textureStore(lumaMip2, coord / 4, vec4f(log(max(mip2.x, 1.0e-5)), mip2.x, mip2.y, 0.0));
    }

    if (any(gid.xy != vec2u(0u))) { return; }

    //* Frame Exposure State ===
    var logSum = 0.0;
    for (var y = 0; y < 32; y++) {
        for (var x = 0; x < 32; x++) {
            let sampleCoord = clamp(
                vec2i((vec2f(f32(x), f32(y)) + 0.5) * C.renderSize / 32.0),
                vec2i(0),
                vec2i(C.renderSize) - 1,
            );
            logSum += log2(max(textureLoad(inputSignals, sampleCoord, 0).g, 1.0e-4));
        }
    }
    let averageLuma = exp2(logSum / 1024.0);
    let targetConditioning = clamp(EXPOSURE_KEY / max(averageLuma, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX);
    let previous = textureLoad(previousFrameInfo, vec2i(0), 0);
    var conditioning = targetConditioning;
    if (!hasFlag(FLAG_RESET) && previous.r > 0.0) {
        let adaptation = clamp(1.0 - exp2(-C.deltaTime * ADAPT_SPEED), 0.0, 1.0);
        conditioning = mix(previous.r, targetConditioning, adaptation);
    }
    conditioning = select(C.exposure, conditioning, hasFlag(FLAG_AUTO_EXPOSURE));
    let externalConditioningValue = textureLoad(externalConditioning, vec2i(0), 0).r;
    conditioning = select(conditioning, externalConditioningValue, hasFlag(FLAG_EXTERNAL_EXPOSURE));

    let hostValue = textureLoad(hostPreExposure, vec2i(0), 0).r;
    let host = select(1.0, hostValue, hostValue > 0.0);
    textureStore(frameInfoOut, vec2i(0), vec4f(conditioning, averageLuma, host, log2(max(averageLuma, 1.0e-4))));
}
`,
);

/**
 * Signed current/previous luma-difference pyramid. Previous luma is corrected
 * into the current host pre-exposure domain before every comparison.
 */
export const SHADING_CHANGE_SPD_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var inputSignals : texture_2d<f32>;
@group(0) @binding(2) var lumaHistory : texture_2d<f32>;
@group(0) @binding(3) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(4) var frameInfoCur : texture_2d<f32>;
@group(0) @binding(5) var frameInfoPrev : texture_2d<f32>;
@group(0) @binding(6) var shadingMip0 : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var shadingMip1 : texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var shadingMip2 : texture_storage_2d<rgba16float, write>;

fn signedDifference(coord : vec2i) -> vec2f {
    if (hasFlag(FLAG_RESET)) { return vec2f(0.0); }
    let clamped = clamp(coord, vec2i(0), vec2i(C.renderSize) - 1);
    let uv = (vec2f(clamped) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, clamped, 0).xy;
    let previousUv = uv - motion;
    if (any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
        return vec2f(0.0);
    }

    let previousCoord = clamp(vec2i(previousUv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
    let currentFrameInfo = textureLoad(frameInfoCur, vec2i(0), 0);
    let previousFrameInfo = textureLoad(frameInfoPrev, vec2i(0), 0);
    let hostRatio = currentFrameInfo.b / max(previousFrameInfo.b, 1.0e-4);
    let conditioning = currentFrameInfo.r;
    let currentLuma = textureLoad(inputSignals, clamped, 0).g * conditioning;
    let previousLuma = textureLoad(lumaHistory, previousCoord, 0).r * hostRatio * conditioning;
    let maximum = max(currentLuma, previousLuma);
    if (maximum <= 1.0e-5) { return vec2f(0.0); }
    let difference = sign(currentLuma - previousLuma) *
        (1.0 - min(currentLuma, previousLuma) / maximum);
    return vec2f(difference, select(0.0, sign(difference), difference != 0.0));
}

fn reduceBlock(origin : vec2i, extent : i32) -> vec2f {
    var sum = vec2f(0.0);
    var count = 0.0;
    for (var y = 0; y < extent; y++) {
        for (var x = 0; x < extent; x++) {
            sum += signedDifference(origin + vec2i(x, y));
            count += 1.0;
        }
    }
    return sum / count;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let mip0Size = max(vec2u(1u), vec2u(C.renderSize + 1.0) / 2u);
    if (any(gid.xy >= mip0Size)) { return; }
    let coord = vec2i(gid.xy);
    textureStore(shadingMip0, coord, vec4f(reduceBlock(coord * 2, 2), 0.0, 0.0));
    if (all((gid.xy % vec2u(2u)) == vec2u(0u))) {
        textureStore(shadingMip1, coord / 2, vec4f(reduceBlock(coord * 2, 4), 0.0, 0.0));
    }
    if (all((gid.xy % vec2u(4u)) == vec2u(0u))) {
        textureStore(shadingMip2, coord / 4, vec4f(reduceBlock(coord * 2, 8), 0.0, 0.0));
    }
}
`,
);

/** Resolves the three signed-difference mips into one half-resolution mask. */
export const SHADING_CHANGE_RESOLVE_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var shadingPyramid : texture_2d<f32>;
@group(0) @binding(2) var shadingChangeOut : texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let outputSize = vec2u(textureDimensions(shadingChangeOut));
    if (any(gid.xy >= outputSize)) { return; }
    let baseCoord = vec2i(gid.xy);
    let mip0 = textureLoad(shadingPyramid, baseCoord, 0).xy;
    let mip1 = textureLoad(shadingPyramid, baseCoord / 2, 1).xy;
    let mip2 = textureLoad(shadingPyramid, baseCoord / 4, 2).xy;
    let response = clamp(
        max(abs(mip0.x * mip0.y), max(abs(mip1.x * mip1.y), abs(mip2.x * mip2.y))) *
        (1.0 + 2.0 / 3.0),
        0.0,
        1.0,
    );
    textureStore(shadingChangeOut, baseCoord, vec4f(response, 0.0, 0.0, 1.0));
}
`,
);

/**
 * Four-frame render-resolution luma instability candidate. History channels
 * remain in caller/host pre-exposure space; conditioning is applied only for
 * comparisons and removed again before storage.
 */
export const LUMA_INSTABILITY_SOURCE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var inputSignals : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var preparedMasks : texture_2d<f32>;
@group(0) @binding(4) var lumaHistoryIn : texture_2d<f32>;
@group(0) @binding(5) var frameInfoCur : texture_2d<f32>;
@group(0) @binding(6) var frameInfoPrev : texture_2d<f32>;
@group(0) @binding(7) var lumaHistoryOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var instabilityOut : texture_storage_2d<r32float, write>;

fn similarity(a : f32, b : f32) -> f32 {
    return min(a, b) / max(max(a, b), 1.0e-5);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let coord = vec2i(gid.xy);
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    let previousUv = uv - motion + C.jitterPrev * C.renderSizeInv;
    let currentFrameInfo = textureLoad(frameInfoCur, vec2i(0), 0);
    let previousFrameInfo = textureLoad(frameInfoPrev, vec2i(0), 0);
    let conditioning = max(currentFrameInfo.r, 1.0e-4);
    let currentHostLuma = max(textureLoad(inputSignals, coord, 0).g, 0.0);
    // Seed every slot after reset/offscreen reprojection. Leaving zeros here
    // makes the next shading pass compare valid current luma with empty state.
    var history = vec4f(currentHostLuma);
    var instability = 0.0;

    if (
        !hasFlag(FLAG_RESET) &&
        all(previousUv >= vec2f(0.0)) &&
        all(previousUv <= vec2f(1.0))
    ) {
        let previousCoord = clamp(vec2i(previousUv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
        let hostRatio = currentFrameInfo.b / max(previousFrameInfo.b, 1.0e-4);
        history = textureLoad(lumaHistoryIn, previousCoord, 0) * hostRatio * conditioning;
        let current = currentHostLuma * conditioning;
        let firstDifference = current - history.x;
        let firstSimilarity = similarity(current, history.x);
        var maximumSimilarity = firstSimilarity;
        if (firstSimilarity < 1.0) {
            for (var index = 1; index < 4; index++) {
                let difference = current - history[index];
                if (sign(firstDifference) == sign(difference)) {
                    maximumSimilarity = max(maximumSimilarity, similarity(current, history[index]));
                }
            }
            instability = select(0.0, 1.0, maximumSimilarity > firstSimilarity);
        }

        let masks = textureLoad(preparedMasks, coord, 0);
        let velocityWeight = 1.0 - clamp(length(motion * vec2f(3840.0, 2160.0)) / 20.0, 0.0, 1.0);
        let mature = select(0.0, 1.0, masks.a > 0.9);
        instability *= mature * velocityWeight * (1.0 - masks.r) * (1.0 - masks.g) * (1.0 - masks.b);
        history = vec4f(current, history.xyz);
        history /= conditioning;
        if (history.w == 0.0) { instability = 0.0; }
    }

    textureStore(lumaHistoryOut, coord, history);
    textureStore(instabilityOut, coord, vec4f(instability, 0.0, 0.0, 1.0));
}
`,
);

/**
 * Coordinated source-style resolver. History alpha stores lock lifetime, not
 * local sample age; accumulation and instability are render-resolution state.
 */
export const ACCUMULATE_SOURCE_RESOLVER_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    WGSL_TONEMAP,
    /* wgsl */ `
struct AtomicLockBuffer {
    values : array<atomic<u32>>,
}

@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var preparedMasks : texture_2d<f32>;
@group(0) @binding(4) var historyIn : texture_2d<f32>;
// No sampler: history is reconstructed with explicit textureLoad taps, and a
// statically-unused binding would be dropped from the 'auto' layout.
@group(0) @binding(5) var historyOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var inputSignals : texture_2d<f32>;
@group(0) @binding(7) var lumaInstability : texture_2d<f32>;
@group(0) @binding(8) var<storage, read_write> newLocks : AtomicLockBuffer;
@group(0) @binding(9) var frameInfoCur : texture_2d<f32>;
@group(0) @binding(10) var frameInfoPrev : texture_2d<f32>;

const PI : f32 = 3.14159265358979;
const LOCK_THRESHOLD : f32 = 1.0;
const LOCK_MAX : f32 = 2.0;
const AVERAGE_LANCZOS_WEIGHT : f32 = 0.74 / 16.0;

fn lanczos2(value : f32) -> f32 {
    let x = abs(value);
    if (x < 1.0e-4) { return 1.0; }
    if (x >= 2.0) { return 0.0; }
    let px = PI * x;
    return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}

fn lanczos2ApproxSq(value : f32) -> f32 {
    let x2 = min(value, 4.0);
    let a = (2.0 / 5.0) * x2 - 1.0;
    let b = 0.25 * x2 - 1.0;
    return ((25.0 / 16.0) * a * a - (9.0 / 16.0)) * b * b;
}

fn historyLoad(coord : vec2i) -> vec4f {
    return textureLoad(historyIn, clamp(coord, vec2i(0), vec2i(C.displaySize) - 1), 0);
}

fn sampleHistoryLanczos(uv : vec2f) -> vec4f {
    let position = uv * C.displaySize - 0.5;
    let base = vec2i(floor(position));
    let fraction = fract(position);
    var rows = array<vec4f, 4>();
    var centerMin = vec4f(1.0e6);
    var centerMax = vec4f(-1.0e6);
    for (var y = 0; y < 4; y++) {
        var row = vec4f(0.0);
        var rowWeight = 0.0;
        for (var x = 0; x < 4; x++) {
            let sample = historyLoad(base + vec2i(x - 1, y - 1));
            let weight = lanczos2(f32(x - 1) - fraction.x);
            row += sample * weight;
            rowWeight += weight;
            if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
                centerMin = min(centerMin, sample);
                centerMax = max(centerMax, sample);
            }
        }
        rows[y] = row / max(abs(rowWeight), 1.0e-5);
    }
    var result = vec4f(0.0);
    var weightSum = 0.0;
    for (var y = 0; y < 4; y++) {
        let weight = lanczos2(f32(y - 1) - fraction.y);
        result += rows[y] * weight;
        weightSum += weight;
    }
    return clamp(result / max(abs(weightSum), 1.0e-5), centerMin, centerMax);
}

fn clipToEllipsoid(center : vec3f, extents : vec3f, color : vec3f) -> vec3f {
    let safeExtents = max(extents, vec3f(1.193e-7));
    let transformed = (color - center) / safeExtents;
    let distance = length(transformed);
    return select(color, center + normalize(transformed) * safeExtents, distance > 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    let renderCoord = clamp(vec2i(uv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
    let motion = textureLoad(dilatedMotion, renderCoord, 0).xy;
    let masks = textureLoad(preparedMasks, renderCoord, 0);
    let instability = textureLoad(lumaInstability, renderCoord, 0).r;
    let currentFrameInfo = textureLoad(frameInfoCur, vec2i(0), 0);
    let previousFrameInfo = textureLoad(frameInfoPrev, vec2i(0), 0);
    let conditioning = max(currentFrameInfo.r, 1.0e-4);

    //* Source Radial Reconstruction ===
    let sourcePosition = uv * C.renderSize - 0.5 - C.jitter;
    let sourceBase = vec2i(floor(sourcePosition));
    let kernelBiasMax = min(1.99, max(C.displaySize.x / C.renderSize.x, 1.0));
    let kernelBiasMin = max(1.0, (1.0 + kernelBiasMax) * 0.3);
    let kernelBiasWeight = min(1.0 - masks.g * 0.5, min(1.0 - masks.b, clamp(masks.a * 5.0, 0.0, 1.0)));
    let kernelBias = mix(kernelBiasMin, kernelBiasMax, kernelBiasWeight);
    var upsampled = vec3f(0.0);
    var upsampledWeight = 0.0;
    var boxCenter = vec3f(0.0);
    var boxSecondMoment = vec3f(0.0);
    var boxWeight = 0.0;
    var aabbMinimum = vec3f(1.0e6);
    var aabbMaximum = vec3f(-1.0e6);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let tapCoord = sourceBase + vec2i(x, y);
            let coord = clamp(tapCoord, vec2i(0), vec2i(C.renderSize) - 1);
            let offset = vec2f(tapCoord) - sourcePosition;
            let distanceSquared = dot(offset, offset);
            let prepared = rgbToYCoCg(max(textureLoad(inputColor, coord, 0).rgb, vec3f(0.0)) * conditioning);
            let reconstructionWeight = lanczos2ApproxSq(distanceSquared * kernelBias * kernelBias);
            let rectificationWeight = exp(-2.3 * distanceSquared);
            upsampled += prepared * reconstructionWeight;
            upsampledWeight += reconstructionWeight;
            boxCenter += prepared * rectificationWeight;
            boxSecondMoment += prepared * prepared * rectificationWeight;
            boxWeight += rectificationWeight;
            aabbMinimum = min(aabbMinimum, prepared);
            aabbMaximum = max(aabbMaximum, prepared);
        }
    }
    upsampled /= max(abs(upsampledWeight), 1.0e-5);
    upsampled = clamp(upsampled, aabbMinimum, aabbMaximum);
    upsampledWeight = max(upsampledWeight, 0.0) * AVERAGE_LANCZOS_WEIGHT;
    boxCenter /= max(boxWeight, 1.0e-5);
    let boxVector = sqrt(abs(boxSecondMoment / max(boxWeight, 1.0e-5) - boxCenter * boxCenter));

    //* Reprojected Linear/HDR History ===
    let previousUv = uv - motion;
    let existing = !hasFlag(FLAG_RESET) &&
        all(previousUv >= vec2f(0.0)) &&
        all(previousUv <= vec2f(1.0));
    var historyYcc = upsampled;
    var lock = 0.0;
    if (existing) {
        let history = sampleHistoryLanczos(previousUv);
        let hostRatio = currentFrameInfo.b / max(previousFrameInfo.b, 1.0e-4);
        historyYcc = rgbToYCoCg(max(history.rgb * hostRatio, vec3f(0.0)) * conditioning);
        lock = history.a;
    }

    //* Coordinated Lock Lifetime ===
    let decrease = max(masks.b, max(masks.r, masks.g));
    lock = max(0.0, lock - decrease * LOCK_MAX);
    let lockContribution = clamp(clamp(lock - LOCK_THRESHOLD, 0.0, 1.0) * (LOCK_MAX - LOCK_THRESHOLD), 0.0, 1.0);
    let lockIndex = gid.y * u32(C.displaySize.x) + gid.x;
    let newLock = f32(atomicLoad(&newLocks.values[lockIndex])) / 65535.0;
    lock = min(lock + newLock * (1.0 - masks.r), LOCK_MAX);
    lock = max(0.0, lock - (0.1 / max(C.maxAccumulation, 1.0)) * (1.0 - decrease));
    lock *= select(0.0, 1.0, all((uv - motion) >= vec2f(0.0)) && all((uv - motion) <= vec2f(1.0)));

    //* Source-Driven Dynamic Rectification ===
    let velocity4K = length(motion * vec2f(3840.0, 2160.0));
    let farthestDepth = textureLoad(inputSignals, renderCoord, 0).r;
    let boxScaleSignal = max(
        clamp(velocity4K / 20.0, 0.0, 1.0),
        max(
            clamp(0.75 - farthestDepth / 20.0, 0.0, 1.0),
            max(1.0 - masks.a, max(sqrt(masks.r), masks.b)),
        ),
    );
    let boxScale = mix(3.0, 1.0, boxScaleSignal);
    let scaledBox = boxVector * vec3f(1.7, 1.0, 1.0) * boxScale;
    let rectifiedHistory = clipToEllipsoid(boxCenter, scaledBox, historyYcc);
    let preserveHistory = max(instability, lockContribution) * masks.a * (1.0 - masks.g);
    historyYcc = mix(rectifiedHistory, historyYcc, clamp(preserveHistory, 0.0, 1.0));

    //* Source Weight Model ===
    var historyWeight = masks.a;
    historyWeight = min(
        historyWeight,
        // 20-pixel 4K-motion normalization, matching every other velocity
        // falloff in the candidate graph (0.5 saturated at half a pixel and
        // collapsed history under any camera motion).
        mix(historyWeight, 0.15, clamp(max(0.0, velocity4K / 20.0), 0.0, 1.0)),
    );
    if (!existing) { historyWeight = 0.0; }
    let totalWeight = max(6.1e-5, historyWeight + upsampledWeight);
    let alpha = clamp(upsampledWeight / totalWeight, 0.0, 1.0);

    // Tonemap only for the blend, then restore linear/HDR and remove internal
    // conditioning. Host pre-exposure remains part of the caller's domain.
    let historyTone = rgbToYCoCg(tonemapInvertible(yCoCgToRgb(historyYcc)));
    let currentTone = rgbToYCoCg(tonemapInvertible(yCoCgToRgb(upsampled)));
    let resultTone = mix(historyTone, currentTone, alpha);
    let result = max(tonemapInvert(yCoCgToRgb(resultTone)) / conditioning, vec3f(0.0));
    textureStore(historyOut, gid.xy, vec4f(result, lock));
}
`,
);
