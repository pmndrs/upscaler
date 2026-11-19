import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

// Exposure names the final reserved slot of the shared 96-byte layout.
// Other passes keep it as padding; the writer always supplies 32 here.
const EXPOSURE_CONSTANTS = WGSL_CONSTANTS.replace('_pad            : u32,    // offset 92',
    'exposureTaps    : u32,    // offset 92 — fixed metering grid, uniform loop bound');

// Bindings and tuning constants, shared by the production and frozen forms.
const EXPOSURE_HEAD = /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var linearSampler : sampler;
@group(0) @binding(3) var prevExposure : texture_2d<f32>;
@group(0) @binding(4) var exposureOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var externalExposure : texture_2d<f32>;
@group(0) @binding(6) var hostPreExposure : texture_2d<f32>;
@group(0) @binding(7) var resetSignal : texture_2d<f32>;

// 32×32 = 1024 bilinear taps across the whole frame — a coarse but stable
// average for exposure (each tap already averages 4 texels).
const EXPOSURE_TAPS : u32 = 32u;
// Middle-grey target: the exposure maps average scene luma to this.
const EXPOSURE_KEY : f32 = 0.18;
// Clamp so a pitch-black or fully blown-out frame can't drive exposure to
// infinity/zero and destabilize the accumulation it is meant to steady.
const EXPOSURE_MIN : f32 = 0.02;
// The brightening cap is also the dark-scene highlight ceiling. History is
// stored in f16 as x/(1+x), x the pre-exposed color, and tonemapInvert clamps
// at 0.999: nothing resolves above 999 / exposure, and below that a stored
// value moves in relative steps of ~(1 + x)/2048. A mostly-black frame drives the
// log-average to its floor, so the old cap (80) put every highlight above
// ~12.5 linear on the ceiling and averaged sub-pixel ones to the same value
// whatever their brightness (issue #49). 8 (three stops) lifts the ceiling to
// ~125 and stays above every bench scene's metered target (2.4–6.8), so
// ordinary scenes are unchanged. Highlights can't key the exposure instead:
// the 32×32 taps miss small and sub-pixel lights. See bench/docs/NEXT-STEPS.md.
const EXPOSURE_MAX : f32 = 8.0;
// Eye-adaptation rate (per second) toward the target exposure.
const ADAPT_SPEED : f32 = 2.5;
// Adaptation dead-band, in stops. The metering taps read the JITTERED input, so
// on a still scene the log-average wobbles with the jitter phase (edges and
// sub-pixel detail land on different texels each phase). Easing toward that
// moving target re-conditions the stored history every frame (plus f16 storage
// rounding of the exposure itself), which reads as low-level contour shimmer
// across smooth gradients. Holding the stored exposure exactly while the target
// stays within 1/16 stop (~4.4%) freezes a still scene's conditioning
// bit-for-bit; genuine lighting changes are far larger and adapt as before.
// Exposure is divided back out before display, so resting up to 1/16 stop off
// target changes nothing visible.
const ADAPT_DEADBAND_STOPS : f32 = 0.0625;
`;

// Host pre-exposure, target, adaptation and overrides, from the metered logSum.
const EXPOSURE_PUBLISH = /* wgsl */ `    // Meter host-invariantly (FSR2 divides pre-exposure out of every input
    // load): the app already metered what it baked in, so a host pre-exposure
    // step must not send auto-exposure re-adapting — that multi-frame
    // conditioning drift would desynchronize history from the current frame
    // and read as a full-screen shading change.
    let hostRaw = textureLoad(hostPreExposure, vec2i(0), 0).r;
    let host = select(1.0, hostRaw, hostRaw > 0.0);
    let avgLum = exp2(logSum / f32(EXPOSURE_TAPS * EXPOSURE_TAPS)) / host;

    let targetExposure = clamp(EXPOSURE_KEY / max(avgLum, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX);

    // This frame's resolved reset: the CPU flag or the app's GPU signal.
    let reset = hasFlag(FLAG_RESET) || textureLoad(resetSignal, vec2i(0), 0).r > 0.5;

    // Ease toward the target for eye-adaptation; snap on reset so a stale value
    // doesn't slowly fade in after a camera cut / resize.
    let prev = textureLoad(prevExposure, vec2i(0), 0).r;
    var exposure = targetExposure;
    if (!reset && prev > 0.0) {
        exposure = prev;
        if (abs(log2(targetExposure / prev)) > ADAPT_DEADBAND_STOPS) {
            let rate = clamp(1.0 - exp2(-C.deltaTime * ADAPT_SPEED), 0.0, 1.0);
            exposure = prev + (targetExposure - prev) * rate;
        }
    }

    // Manual override: when auto-exposure is off, publish the fixed setting so
    // downstream passes read exposure from one place regardless of mode.
    exposure = select(C.exposure, exposure, hasFlag(FLAG_AUTO_EXPOSURE));

    // App-supplied exposure wins over both: a pipeline that already computes
    // exposure (its own metering pass) feeds it here, and every downstream
    // pass keeps reading this one 1×1 value. That includes the shading-change
    // detector, which scales both frames by this conditioning exposure (.r).
    // avgLum (.g) stays our own measurement, but no shader reads it.
    let ext = textureLoad(externalExposure, vec2i(0), 0).r;
    exposure = select(exposure, ext, hasFlag(FLAG_EXTERNAL_EXPOSURE));

    // Host pre-exposure rides along in .b: 0 (the dummy) means "not supplied"
    // and publishes as 1.0 so the accumulate-side ratio correction is inert.
    // .a is the resolved reset, read by shading change and accumulate.
    textureStore(exposureOut, vec2i(0), vec4f(exposure, avgLum, host, select(0.0, 1.0, reset)));
}
`;

/**
 * Luminance reduction → auto-exposure (FSR2/3's "compute luminance pyramid"
 * stage, in the pragmatic form the rest of this port needs).
 *
 * FSR2 downsamples the input into a full luminance mip chain with a single
 * atomic SPD dispatch and reads the coarsest mip for exposure. Nothing here
 * consumes the intermediate mips (the shading-change detector does its own
 * fused workgroup-local reduction in shadingChange.ts), so this pass computes
 * only the value that is actually used: a single
 * scene-average luminance, reduced in one workgroup, mapped to an exposure and
 * eased over time for eye-adaptation.
 *
 * The exposure conditions the invertible-tonemap accumulation so a very bright
 * or very dark HDR scene lands in the same working range (steadier variance
 * clip + firefly guard). It is **divided back out before display**, so it does
 * not change final image brightness — only accumulation stability.
 *
 * Runs as a single 8×8 workgroup (dispatch one group). All 64 invocations
 * share the 1024 metering taps (16 each), a workgroup-memory tree sums their
 * partial log-sums, and invocation 0 maps the result to an exposure. The
 * grid-overrun guard sits after the barriers and is a formality here —
 * display size is always ≥ 8, so no lane returns early.
 *
 * Bindings:
 * - 1: scene color, render size (linear HDR)
 * - 2: linear clamp sampler
 * - 3: previous frame's exposure (rgba16float; r = exposure, g = avg luma)
 * - 4: exposure out (rgba16float storage, 1×1)
 * - 5: external exposure (app-supplied; r = exposure). Read only when
 *      FLAG_EXTERNAL_EXPOSURE is set — else a 1×1 dummy is bound and ignored.
 * - 6: host pre-exposure (app-supplied; r = the pre-exposure baked into this
 *      frame's input color). Published in the output's .b so accumulate can
 *      ratio-correct history across a change (FSR3's DeltaPreExposure). A zero
 *      dummy (no input) publishes 1.0, keeping the correction inert.
 * - 7: reset signal (app-supplied; `.r > 0.5` at texel (0, 0) = this frame is
 *      a reset, e.g. a GPU cut detector's flag). Folded with FLAG_RESET into
 *      the output's .a, which every later pass of the frame reads as "reset"
 *      — so a GPU-side cut needs no readback and no per-pass binding. The
 *      zero dummy (no input) reads as "no reset", keeping this inert.
 */
export const LUMINANCE_PYRAMID_SHADER = assembleShader(
    EXPOSURE_CONSTANTS,
    WGSL_COLOR,
    EXPOSURE_HEAD + /* wgsl */ `
// Lanes per axis of the 8×8 workgroup that shares the metering grid.
const EXPOSURE_LANES : u32 = 8u;
// One partial log-sum per lane; the tree below folds them into slot 0.
var<workgroup> laneLogSums : array<f32, 64>;

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_index) lane : u32,
) {
    // Geometric mean of luminance (average in log space) resists a few bright
    // pixels dragging the whole exposure, matching FSR2's log-average.
    // The 64 lanes split the 32×32 grid: lane (x, y) takes rows y, y + 8, …
    // and in each row columns x, x + 8, x + 16, x + 24, so 16 taps a lane with
    // the serial form's UVs and per-tap math. Only the summation order differs
    // (16-tap lane sums, then a 64-way tree). The row loop keeps the uniform
    // bound that holds DXC's compile time down (docs/windows-followups.md); the
    // column loop is 4 constant steps. gid is the local id: one workgroup runs.
    var logSum = 0.0;
    for (var y = gid.y; y < C.exposureTaps; y = y + EXPOSURE_LANES) {
        for (var i = 0u; i < EXPOSURE_TAPS / EXPOSURE_LANES; i = i + 1u) {
            let x = gid.x + i * EXPOSURE_LANES;
            let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(EXPOSURE_TAPS);
            let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
            logSum = logSum + log2(max(luma(c), 1.0e-4));
        }
    }
    laneLogSums[lane] = logSum;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride = stride >> 1u) {
        if (lane < stride) {
            laneLogSums[lane] = laneLogSums[lane] + laneLogSums[lane + stride];
        }
        workgroupBarrier();
    }

    // Both returns come after the last barrier, which every lane must reach.
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    if (lane != 0u) { return; }
    logSum = laneLogSums[0];

` + EXPOSURE_PUBLISH,
);

/**
 * The single-invocation form that shipped until the parallel metering above:
 * invocation (0,0) takes all 1024 taps in row-major order while the other 63
 * lanes return. Frozen for the bench identity `exposure-serial-v1`, the
 * frozen candidate bundles and scripts/measure-exposure-parallel.mjs
 * (bench/docs/NEXT-STEPS.md §16). Its metering loop is frozen; the shared head
 * and epilogue are not, so it carries the GPU reset signal (binding 7, the
 * resolved reset in .a, issue #102) like every exposure form — the late stage
 * binds it whichever form runs, and shading change / accumulate read that .a.
 */
export const LUMINANCE_PYRAMID_SERIAL_SHADER = assembleShader(
    EXPOSURE_CONSTANTS,
    WGSL_COLOR,
    EXPOSURE_HEAD + /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    // Single-thread reduction — the other 63 lanes of the lone workgroup idle.
    if (any(gid.xy != vec2u(0u))) { return; }

    // Geometric mean of luminance (average in log space) resists a few bright
    // pixels dragging the whole exposure, matching FSR2's log-average.
    var logSum = 0.0;
    for (var y = 0u; y < C.exposureTaps; y = y + 1u) {
        for (var x = 0u; x < EXPOSURE_TAPS; x = x + 1u) {
            let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(EXPOSURE_TAPS);
            let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
            logSum = logSum + log2(max(luma(c), 1.0e-4));
        }
    }
` + EXPOSURE_PUBLISH,
);

//* Every-Texel Metering (NEXT-STEPS §17) ======================================
// Production below 2^19 render texels (UpscalerCore's EVERY_TEXEL_MAX_TEXELS):
// the hooks of a @pmndrs/downsampler ScalarReduction (internal/EveryTexelExposure).
// The taps above wobble with the jitter phase as the render shrinks; the log
// average of every texel holds still scenes well inside the dead-band.

// The production head without the sampler: every texel is read with
// textureLoad, so binding 2 has nothing to do.
const EVERY_TEXEL_HEAD = EXPOSURE_HEAD.replace('@group(0) @binding(2) var linearSampler : sampler;\n', '');
const TAP_AVERAGE = 'exp2(logSum / f32(EXPOSURE_TAPS * EXPOSURE_TAPS))';
if (EVERY_TEXEL_HEAD === EXPOSURE_HEAD || !EXPOSURE_PUBLISH.includes(TAP_AVERAGE)) {
    throw new Error('luminancePyramid.ts: every-texel metering no longer matches the production head or epilogue.');
}

/**
 * Every-texel metering, `@group(1)`: the production pass's declarations
 * (constants, color, previous/next exposure, external and host exposure, the
 * reset signal) for `@pmndrs/downsampler`'s `ScalarReduction`, which owns
 * `@group(0)`. Binding numbers match production, minus the sampler (2).
 */
export const EXPOSURE_EVERY_TEXEL_BINDINGS = assembleShader(EXPOSURE_CONSTANTS, WGSL_COLOR, EVERY_TEXEL_HEAD)
    .replaceAll('@group(0)', '@group(1)');

/**
 * Every-texel metering, the scalar's `load`: channel x is the taps'
 * `log2(max(luma, 1e-4))` of one render texel (y–w unused, summed as 0).
 */
export const EXPOSURE_EVERY_TEXEL_LOAD = /* wgsl */ `
fn load(texel : vec2i, layer : u32) -> vec4f {
    let c = textureLoad(inputColor, texel, 0).rgb;
    return vec4f(log2(max(luma(c), 1.0e-4)), 0.0, 0.0, 0.0);
}
`;

/**
 * Every-quad metering, `@group(1)`: the production declarations with the
 * sampler (2) kept, for {@link EXPOSURE_EVERY_QUAD_LOAD}.
 */
export const EXPOSURE_EVERY_QUAD_BINDINGS = assembleShader(EXPOSURE_CONSTANTS, WGSL_COLOR, EXPOSURE_HEAD)
    .replaceAll('@group(0)', '@group(1)');

/**
 * Every-quad metering, the scalar's `load` over a ⌈w/2⌉×⌈h/2⌉ grid: one
 * bilinear tap at the shared corner of each 2×2 render-texel quad, i.e. the
 * quad's box average, then the taps' log. Every texel still counts once, but
 * like the taps' bilinear footprint it averages before the log, so a sub-texel
 * emitter or a dither pattern that a jitter phase moves on or off a texel
 * swings the log-average less than point samples at the 1e-4 floor do.
 */
export const EXPOSURE_EVERY_QUAD_LOAD = /* wgsl */ `
fn load(texel : vec2i, layer : u32) -> vec4f {
    let uv = (vec2f(texel) * 2.0 + 1.0) / vec2f(textureDimensions(inputColor));
    let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
    return vec4f(log2(max(luma(c), 1.0e-4)), 0.0, 0.0, 0.0);
}
`;

/**
 * Every-texel metering, the scalar's `finish`: the production epilogue (host
 * pre-exposure, target, dead-band easing, manual and external overrides, the
 * store) verbatim. `value.x`, the log2 average over every render texel,
 * replaces the taps' `logSum / 1024`.
 * @param deadband - Keep the 1/16-stop adaptation dead-band (production); false
 * eases toward every new target, to measure whether the dead-band is still needed
 * @returns WGSL defining `fn finish(value, weight)`
 */
export function exposureEveryTexelFinish(deadband = true): string {
    let body = EXPOSURE_PUBLISH.replace(TAP_AVERAGE, 'exp2(logAverage)');
    if (!deadband) body = body.replace('> ADAPT_DEADBAND_STOPS', '> 0.0');
    return '\nfn finish(value : vec4f, weight : f32) {\n    let logAverage = value.x;\n' + body;
}
