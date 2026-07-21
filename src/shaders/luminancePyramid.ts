import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

/**
 * Luminance reduction → auto-exposure (FSR2/3's "compute luminance pyramid"
 * stage, in the pragmatic form the rest of this port needs).
 *
 * FSR2 downsamples the input into a full luminance mip chain with a single
 * atomic SPD dispatch and reads the coarsest mip for exposure. We don't yet
 * consume the intermediate mips (the shading-change detector — Phase 3 — will),
 * so this pass computes only the value that is actually used today: a single
 * scene-average luminance, reduced in one workgroup, mapped to an exposure and
 * eased over time for eye-adaptation.
 *
 * The exposure conditions the invertible-tonemap accumulation so a very bright
 * or very dark HDR scene lands in the same working range (steadier variance
 * clip + firefly guard). It is **divided back out before display**, so it does
 * not change final image brightness — only accumulation stability.
 *
 * Runs as a single 8×8 workgroup (dispatch one group); only invocation (0,0)
 * does the reduction. The grid-overrun guard is a formality here — display size
 * is always ≥ 8, so no lane returns early.
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
 */
export const LUMINANCE_PYRAMID_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var linearSampler : sampler;
@group(0) @binding(3) var prevExposure : texture_2d<f32>;
@group(0) @binding(4) var exposureOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var externalExposure : texture_2d<f32>;
@group(0) @binding(6) var hostPreExposure : texture_2d<f32>;

// 32×32 = 1024 bilinear taps across the whole frame — a coarse but stable
// average for exposure (each tap already averages 4 texels).
const EXPOSURE_TAPS : u32 = 32u;
// Middle-grey target: the exposure maps average scene luma to this.
const EXPOSURE_KEY : f32 = 0.18;
// Clamp so a pitch-black or fully blown-out frame can't drive exposure to
// infinity/zero and destabilize the accumulation it is meant to steady.
const EXPOSURE_MIN : f32 = 0.02;
const EXPOSURE_MAX : f32 = 80.0;
// Eye-adaptation rate (per second) toward the target exposure.
const ADAPT_SPEED : f32 = 2.5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    // Single-thread reduction — the other 63 lanes of the lone workgroup idle.
    if (any(gid.xy != vec2u(0u))) { return; }

    // Geometric mean of luminance (average in log space) resists a few bright
    // pixels dragging the whole exposure, matching FSR2's log-average.
    var logSum = 0.0;
    for (var y = 0u; y < EXPOSURE_TAPS; y = y + 1u) {
        for (var x = 0u; x < EXPOSURE_TAPS; x = x + 1u) {
            let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(EXPOSURE_TAPS);
            let c = textureSampleLevel(inputColor, linearSampler, uv, 0.0).rgb;
            logSum = logSum + log2(max(luma(c), 1.0e-4));
        }
    }
    // Meter host-invariantly (FSR2 divides pre-exposure out of every input
    // load): the app already metered what it baked in, so a host pre-exposure
    // step must not send auto-exposure re-adapting — that multi-frame
    // conditioning drift would desynchronize history from the current frame
    // and read as a full-screen shading change.
    let hostRaw = textureLoad(hostPreExposure, vec2i(0), 0).r;
    let host = select(1.0, hostRaw, hostRaw > 0.0);
    let avgLum = exp2(logSum / f32(EXPOSURE_TAPS * EXPOSURE_TAPS)) / host;

    let targetExposure = clamp(EXPOSURE_KEY / max(avgLum, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX);

    // Ease toward the target for eye-adaptation; snap on reset so a stale value
    // doesn't slowly fade in after a camera cut / resize.
    let prev = textureLoad(prevExposure, vec2i(0), 0).r;
    var exposure = targetExposure;
    if (!hasFlag(FLAG_RESET) && prev > 0.0) {
        let rate = clamp(1.0 - exp2(-C.deltaTime * ADAPT_SPEED), 0.0, 1.0);
        exposure = prev + (targetExposure - prev) * rate;
    }

    // Manual override: when auto-exposure is off, publish the fixed setting so
    // downstream passes read exposure from one place regardless of mode.
    exposure = select(C.exposure, exposure, hasFlag(FLAG_AUTO_EXPOSURE));

    // App-supplied exposure wins over both: a pipeline that already computes
    // exposure (its own metering pass) feeds it here, and every downstream
    // pass keeps reading this one 1×1 value. avgLum stays our own measurement
    // so the shading-change detector still has a neighbourhood reference.
    let ext = textureLoad(externalExposure, vec2i(0), 0).r;
    exposure = select(exposure, ext, hasFlag(FLAG_EXTERNAL_EXPOSURE));

    // Host pre-exposure rides along in .b: 0 (the dummy) means "not supplied"
    // and publishes as 1.0 so the accumulate-side ratio correction is inert.
    textureStore(exposureOut, vec2i(0), vec4f(exposure, avgLum, host, 0.0));
}
`,
);
