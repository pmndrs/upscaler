import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

function createCandidateDebugShader(
    preparedChannels: boolean,
    sourceHistoryState: boolean,
): string {
    const disocclusion = preparedChannels
        ? 'textureLoad(candidateMasks, renderCoord, 0).g'
        : 'textureLoad(candidateMasks, renderCoord, 0).r';
    const accumulation = sourceHistoryState
        ? 'textureLoad(candidateMasks, renderCoord, 0).a'
        : 'textureLoad(historyIn, vec2i(gid.xy), 0).a';
    const locks = sourceHistoryState
        ? /* wgsl */ `
            let lock = textureLoad(historyIn, vec2i(gid.xy), 0).a * 0.5;
            let instability = textureLoad(auxiliaryState, renderCoord, 0).r;
            c = vec3f(lock, max(lock, instability * 0.25), lock);
`
        : 'c = vec3f(textureLoad(auxiliaryState, vec2i(gid.xy), 0).r);';
    const shading = preparedChannels
        ? 'textureLoad(candidateMasks, renderCoord, 0).b'
        : 'textureLoad(auxiliaryState, vec2i(gid.xy), 0).b';
    const reactivity = preparedChannels
        ? /* wgsl */ `
            let prepared = textureLoad(candidateMasks, renderCoord, 0);
            let direct = textureLoad(reactiveInput, renderCoord, 0).r;
            c = vec3f(max(direct, max(prepared.r, prepared.b)));
`
        : /* wgsl */ `
            let dimensions = vec2i(textureDimensions(reactiveInput));
            let reactiveCoord = clamp(renderCoord, vec2i(0), dimensions - 1);
            c = vec3f(textureLoad(reactiveInput, reactiveCoord, 0).r);
`;

    return assembleShader(
        WGSL_CONSTANTS,
        WGSL_COLOR,
        /* wgsl */ `
@group(0) @binding(1) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(2) var candidateMasks : texture_2d<f32>;
@group(0) @binding(3) var inputSignals : texture_2d<f32>;
@group(0) @binding(4) var historyIn : texture_2d<f32>;
@group(0) @binding(5) var auxiliaryState : texture_2d<f32>;
@group(0) @binding(6) var frameInfo : texture_2d<f32>;
@group(0) @binding(7) var inputColor : texture_2d<f32>;
@group(0) @binding(8) var reactiveInput : texture_2d<f32>;
@group(0) @binding(9) var outputColor : texture_storage_2d<rgba16float, write>;

fn motionToColor(motion : vec2f) -> vec3f {
    let magnitude = clamp(sqrt(length(motion) * 8.0), 0.0, 1.0);
    let direction = normalize(select(motion, vec2f(1.0, 0.0), length(motion) < 1.0e-6));
    return vec3f(
        0.5 + 0.5 * direction.x * magnitude,
        0.5 + 0.5 * direction.y * magnitude,
        magnitude,
    );
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    let renderCoord = clamp(vec2i(uv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
    var c = vec3f(0.0);
    switch (C.debugMode) {
        case 1u: {
            c = motionToColor(textureLoad(dilatedMotion, renderCoord, 0).xy);
        }
        case 2u: {
            c = vec3f(${disocclusion});
        }
        case 3u: {
            let depthMeters = textureLoad(inputSignals, renderCoord, 0).b;
            c = vec3f(clamp(log2(1.0 + depthMeters) / 8.0, 0.0, 1.0));
        }
        case 4u: {
            c = vec3f(${accumulation});
        }
        case 5u: {
${locks}
        }
        case 6u: {
            let conditioning = textureLoad(frameInfo, vec2i(0), 0).r;
            c = vec3f(clamp(luma(textureLoad(inputColor, renderCoord, 0).rgb) * conditioning, 0.0, 1.0));
        }
        case 7u: {
            c = vec3f(${shading});
        }
        case 8u: {
${reactivity}
        }
        default: {}
    }
    textureStore(outputColor, gid.xy, vec4f(c, 1.0));
}
`,
    );
}

/** Candidate debug shader for source filters with local state packing. */
export const DEBUG_SOURCE_FILTER_SHADER = createCandidateDebugShader(false, false);

/** Candidate debug shader for prepared reactivity with local state packing. */
export const DEBUG_SOURCE_STRUCTURAL_SHADER = createCandidateDebugShader(true, false);

/** Candidate debug shader for source resolver state packing. */
export const DEBUG_SOURCE_RESOLVER_SHADER = createCandidateDebugShader(true, true);
