/** Babylon 9.29 PREPASS_LINEAR_VELOCITY contains 0.5 * (previous - current) NDC,
 * including projection jitter. The core expects current - previous, top-left UV,
 * with jitter removed. Keep these uniforms in render pixels, not display pixels. */
export function inputParameters(width: number, height: number, jitter: { x: number; y: number }, previous: { x: number; y: number }, far: number, reactive: boolean, reset: boolean, authored = false): Float32Array<ArrayBuffer> {
    return new Float32Array([(jitter.x - previous.x) / width, (jitter.y - previous.y) / height, far, Number(reactive), Number(reset), Number(authored), 0, 0]);
}

export const INPUTS = /* wgsl */ `
struct Params { jitterDelta: vec2f, far: f32, reactive: f32, reset: f32, authored: f32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var rawDepth: texture_2d<f32>;
@group(0) @binding(2) var rawMotion: texture_2d<f32>;
@group(0) @binding(3) var opaque: texture_2d<f32>;
@group(0) @binding(4) var color: texture_2d<f32>;
@group(0) @binding(5) var depth: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var motion: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var reactive: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(8) var normalizedColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var authoredMask: texture_2d<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(depth))) { return; }
    let xy = vec2i(id.xy);
    // Babylon WebGPU renders offscreen targets with InternalsUBO.yFactor = -1.
    // Convert ALL inputs to the core's top-left image convention together.
    let sourceXY = vec2i(xy.x, i32(textureDimensions(depth).y) - 1 - xy.y);
    let z = textureLoad(rawDepth, sourceXY, 0).r;
    let raw = textureLoad(rawMotion, sourceXY, 0).xy;
    let velocity = select(vec2f(-raw.x, raw.y) + p.jitterDelta, vec2f(0), z <= 0 || p.reset > 0);
    textureStore(depth, xy, vec4f(select(z, p.far, z <= 0)));
    textureStore(motion, xy, vec4f(velocity, 0, 0));
    let sourceColor = textureLoad(color, sourceXY, 0);
    textureStore(normalizedColor, xy, sourceColor);
    let diff = abs(sourceColor.rgb - textureLoad(opaque, sourceXY, 0).rgb);
    let delta = max(max(diff.r, diff.g), diff.b);
    var mask = select(0.0, min(0.9, delta * 2.0), delta > 0.04) * p.reactive;
    if (p.authored > 0) { mask = textureLoad(authoredMask, sourceXY, 0).r * p.reactive; }
    textureStore(reactive, xy, vec4f(mask));
}`;
