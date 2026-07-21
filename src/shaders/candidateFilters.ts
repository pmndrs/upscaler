import { EASU_SHADER } from './easu';
import { WGSL_COLOR, WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

const EASU_APPROXIMATION_HELPERS = /* wgsl */ `
// FSR1's low-precision helpers trade exact division for a bit estimate plus
// one Newton step. Keeping this in a separate module makes the ALU experiment
// compile independently from the reviewed production EASU shader.
fn easuApproxRcp(v : f32) -> f32 {
    let x = max(v, 1.0e-8);
    var estimate = bitcast<f32>(0x7ef311c3u - bitcast<u32>(x));
    estimate = estimate * (2.0 - x * estimate);
    return estimate;
}

fn easuApproxRsqrt(v : f32) -> f32 {
    let x = max(v, 1.0e-12);
    var estimate = bitcast<f32>(0x5f3759dfu - (bitcast<u32>(x) >> 1u));
    estimate = estimate * (1.5 - 0.5 * x * estimate * estimate);
    return estimate;
}
`;

/**
 * Source-math EASU candidate using FSR1-style approximate reciprocal helpers.
 * The production shader remains byte-identical and available as the fallback.
 */
export const EASU_SOURCE_APPROX_SHADER = EASU_SHADER.replace(
    '@group(0) @binding(1) var inputColor',
    `${EASU_APPROXIMATION_HELPERS}\n@group(0) @binding(1) var inputColor`,
)
    .replaceAll('1.0 / max(lenX, 1.0e-5)', 'easuApproxRcp(max(lenX, 1.0e-5))')
    .replaceAll('1.0 / max(lenY, 1.0e-5)', 'easuApproxRcp(max(lenY, 1.0e-5))')
    .replaceAll('inverseSqrt(max(dirR, 1.0e-12))', 'easuApproxRsqrt(dirR)')
    .replaceAll('1.0 / lob', 'easuApproxRcp(lob)');

function createSourceFilterAccumulateShader(structuralInputs: boolean): string {
    const candidateBindings = structuralInputs
        ? /* wgsl */ `
@group(0) @binding(9) var exposureCur : texture_2d<f32>;
@group(0) @binding(10) var exposurePrev : texture_2d<f32>;
`
        : /* wgsl */ `
@group(0) @binding(9) var exposureCur : texture_2d<f32>;
@group(0) @binding(10) var reactiveMask : texture_2d<f32>;
@group(0) @binding(11) var exposurePrev : texture_2d<f32>;
`;
    const maskLoad = structuralInputs
        ? /* wgsl */ `
    let preparedMasks = textureLoad(masks, renderCoord, 0);
    let softReactivity = clamp(preparedMasks.r, 0.0, 1.0);
    let disocclusion = clamp(preparedMasks.g, 0.0, 1.0);
    let resetReactivity = clamp(preparedMasks.b, 0.0, 1.0);
    let reactivity = max(resetReactivity, softReactivity * 0.45);
`
        : /* wgsl */ `
    let disocclusion = textureLoad(masks, renderCoord, 0).r;
    var reactivity = 0.0;
    if (hasFlag(FLAG_REACTIVE)) {
        let reactiveSize = vec2i(textureDimensions(reactiveMask));
        let reactiveCoord = clamp(renderCoord, vec2i(0), reactiveSize - 1);
        reactivity = clamp(textureLoad(reactiveMask, reactiveCoord, 0).r, 0.0, 1.0);
    }
    let softReactivity = 0.0;
    let resetReactivity = reactivity;
`;

    return assembleShader(
        WGSL_CONSTANTS,
        WGSL_COLOR,
        WGSL_TONEMAP,
        /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var masks : texture_2d<f32>;
@group(0) @binding(4) var historyIn : texture_2d<f32>;
@group(0) @binding(5) var linearSampler : sampler;
@group(0) @binding(6) var historyOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var locksIn : texture_2d<f32>;
@group(0) @binding(8) var locksOut : texture_storage_2d<rgba16float, write>;
${candidateBindings}

const PI : f32 = 3.14159265358979;
const REACTIVE_STRENGTH : f32 = 0.9;
const LOCK_DECAY : f32 = 0.08;
const LOCK_GROW : f32 = 0.5;
const LOCK_CLAMP_RELAX : f32 = 8.0;
const LOCK_HISTORY_BOOST : f32 = 0.65;

fn lanczos2(x : f32) -> f32 {
    let ax = abs(x);
    if (ax < 1.0e-4) { return 1.0; }
    if (ax >= 2.0) { return 0.0; }
    let px = PI * ax;
    return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}

// FSR's polynomial Lanczos2 approximation accepts squared radial distance.
fn lanczos2ApproxSq(distanceSquared : f32) -> f32 {
    let x2 = min(distanceSquared, 4.0);
    let a = (2.0 / 5.0) * x2 - 1.0;
    let b = 0.25 * x2 - 1.0;
    return ((25.0 / 16.0) * a * a - (9.0 / 16.0)) * b * b;
}

fn historyLoad(coord : vec2i) -> vec4f {
    let maximum = vec2i(C.displaySize) - 1;
    return textureLoad(historyIn, clamp(coord, vec2i(0), maximum), 0);
}

// The source resolver reconstructs history with a full 4x4 bicubic Lanczos
// footprint. Deringing against the central 2x2 prevents negative lobes from
// manufacturing values outside the local history range.
fn sampleHistoryLanczos(uv : vec2f) -> vec4f {
    let samplePosition = uv * C.displaySize - 0.5;
    let base = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
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

fn historyInCurrentDomain(history : vec3f) -> vec3f {
    let previousConditioning = max(textureLoad(exposurePrev, vec2i(0), 0).r, 1.0e-4);
    let currentConditioning = max(textureLoad(exposureCur, vec2i(0), 0).r, 1.0e-4);
    let previousHost = max(textureLoad(exposurePrev, vec2i(0), 0).b, 1.0e-4);
    let currentHost = max(textureLoad(exposureCur, vec2i(0), 0).b, 1.0e-4);
    let previousLinear = tonemapInvert(history) / previousConditioning;
    return tonemapInvertible(previousLinear * (currentHost / previousHost) * currentConditioning);
}

fn clipToAABB(center : vec3f, extents : vec3f, color : vec3f) -> vec3f {
    let direction = color - center;
    let scale = extents / max(abs(direction), vec3f(1.0e-6));
    return center + direction * min(1.0, min(scale.x, min(scale.y, scale.z)));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }

    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    let renderCoord = clamp(vec2i(uv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
    let motion = textureLoad(dilatedMotion, renderCoord, 0).xy;
${maskLoad}
    let conditioning = max(textureLoad(exposureCur, vec2i(0), 0).r, 1.0e-4);

    //* Radial Current-Frame Reconstruction ===
    let sourcePosition = uv * C.renderSize - 0.5 - C.jitter;
    let sourceBase = vec2i(floor(sourcePosition));
    let maximum = vec2i(C.renderSize) - 1;
    let kernelBiasMax = min(1.99, max(C.displaySize.x / C.renderSize.x, 1.0));
    let historyAge = textureSampleLevel(historyIn, linearSampler, uv - motion, 0.0).a;
    let biasWeight = min(1.0 - disocclusion * 0.5, clamp(historyAge * 5.0, 0.0, 1.0));
    let kernelBias = mix(max(1.0, (1.0 + kernelBiasMax) * 0.3), kernelBiasMax, biasWeight);

    var colorSum = vec3f(0.0);
    var colorWeight = 0.0;
    var momentWeight = 0.0;
    var momentOne = vec3f(0.0);
    var momentTwo = vec3f(0.0);
    var neighborhoodMin = vec3f(1.0e6);
    var neighborhoodMax = vec3f(-1.0e6);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let tapCoord = sourceBase + vec2i(x, y);
            let coord = clamp(tapCoord, vec2i(0), maximum);
            let offset = vec2f(tapCoord) - sourcePosition;
            let distanceSquared = dot(offset, offset);
            let color = tonemapInvertible(max(textureLoad(inputColor, coord, 0).rgb, vec3f(0.0)) * conditioning);
            let weight = lanczos2ApproxSq(distanceSquared * kernelBias * kernelBias);
            let boxWeight = exp(-2.3 * distanceSquared);
            let ycc = rgbToYCoCg(color);
            colorSum += color * weight;
            colorWeight += weight;
            momentOne += ycc * boxWeight;
            momentTwo += ycc * ycc * boxWeight;
            momentWeight += boxWeight;
            neighborhoodMin = min(neighborhoodMin, ycc);
            neighborhoodMax = max(neighborhoodMax, ycc);
        }
    }

    let mean = momentOne / max(momentWeight, 1.0e-5);
    let variance = max(momentTwo / max(momentWeight, 1.0e-5) - mean * mean, vec3f(0.0));
    let currentYcc = clamp(
        rgbToYCoCg(colorSum / max(abs(colorWeight), 1.0e-5)),
        neighborhoodMin,
        neighborhoodMax,
    );
    let current = max(yCoCgToRgb(currentYcc), vec3f(0.0));

    //* Exposure-Corrected History ===
    let previousUv = uv - motion;
    let offscreen = any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0));
    if (hasFlag(FLAG_RESET) || offscreen) {
        textureStore(historyOut, gid.xy, vec4f(current, 1.0 / C.maxAccumulation));
        textureStore(locksOut, gid.xy, vec4f(0.0));
        return;
    }

    let historySample = sampleHistoryLanczos(previousUv);
    let history = historyInCurrentDomain(historySample.rgb);
    var sampleCount = historySample.a * C.maxAccumulation;
    let historyYcc = rgbToYCoCg(history);
    let contrast = neighborhoodMax.x - neighborhoodMin.x;

    //* Local Lock Compatibility ===
    var lockLife = 0.0;
    var lockedLuma = currentYcc.x;
    if (hasFlag(FLAG_LOCKS)) {
        let previousLock = textureSampleLevel(locksIn, linearSampler, previousUv, 0.0);
        let peakiness = abs(currentYcc.x - mean.x) / max(sqrt(variance.x), 1.0e-3);
        let feature = smoothstep(0.6, 2.0, peakiness) * smoothstep(0.02, 0.12, contrast);
        lockedLuma = select(previousLock.g, currentYcc.x, previousLock.r < 0.05);
        lockLife = previousLock.r + select(-LOCK_DECAY, LOCK_GROW * feature, feature > 0.1);
        let lockChange = smoothstep(max(contrast, 1.0e-3), max(contrast, 1.0e-3) * 2.0, abs(currentYcc.x - lockedLuma));
        lockLife = clamp(lockLife * (1.0 - disocclusion) * (1.0 - lockChange) * (1.0 - reactivity), 0.0, 1.0);
    }

    //* Dynamic Rectification ===
    let velocity4K = length(motion * vec2f(3840.0, 2160.0));
    let boxScaleFactor = max(
        clamp(velocity4K / 20.0, 0.0, 1.0),
        max(1.0 - historySample.a, sqrt(reactivity)),
    );
    let boxScale = mix(3.0, 1.0, boxScaleFactor);
    let extents = sqrt(variance) * vec3f(1.7, 1.0, 1.0) * boxScale * (1.0 + lockLife * LOCK_CLAMP_RELAX);
    let clippedYcc = clipToAABB(mean, max(extents, vec3f(1.193e-7)), historyYcc);
    let rectified = max(yCoCgToRgb(clippedYcc), vec3f(0.0));
    let clipAmount = clamp(length(clippedYcc - historyYcc) / max(length(extents), 1.0e-4), 0.0, 1.0);

    sampleCount *= 1.0 - disocclusion;
    sampleCount *= 1.0 - 0.5 * clipAmount * (1.0 - lockLife);
    sampleCount *= 1.0 - REACTIVE_STRENGTH * reactivity;
    let newCount = min(sampleCount + 1.0, C.maxAccumulation);
    let confidence = clamp(1.0 - length(sourcePosition - round(sourcePosition)), 0.25, 1.0);
    var alpha = clamp(confidence / newCount, 1.0 / C.maxAccumulation, 1.0);
    alpha = max(alpha * (1.0 - LOCK_HISTORY_BOOST * lockLife), 1.0 / (C.maxAccumulation * 2.0));
    alpha = mix(alpha, 1.0, REACTIVE_STRENGTH * reactivity);
    let result = mix(rectified, current, alpha);

    textureStore(historyOut, gid.xy, vec4f(result, newCount / C.maxAccumulation));
    textureStore(locksOut, gid.xy, vec4f(lockLife, lockedLuma, resetReactivity, softReactivity));
}
`,
    );
}

/** Source filter candidate retaining the local input/resource graph. */
export const ACCUMULATE_SOURCE_FILTER_SHADER = createSourceFilterAccumulateShader(false);

/** Source filter candidate consuming the structural prepared-mask channels. */
export const ACCUMULATE_SOURCE_STRUCTURAL_SHADER = createSourceFilterAccumulateShader(true);
