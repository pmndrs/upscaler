/** Publishes conditioning and host exposure without reading scene luminance. */
export const PROVIDED_EXPOSURE_SHADER = /* wgsl */ `
struct ExposureValues { conditioning : f32, host : f32, useConditioningTexture : u32, useHostTexture : u32 }
@group(0) @binding(0) var<uniform> values : ExposureValues;
@group(0) @binding(1) var conditioningTexture : texture_2d<f32>;
@group(0) @binding(2) var hostTexture : texture_2d<f32>;
@group(0) @binding(3) var published : texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3u) {
    if (any(id.xy != vec2u(0))) { return; }
    var conditioning = values.conditioning;
    var host = values.host;
    if (values.useConditioningTexture != 0u) { conditioning = textureLoad(conditioningTexture, vec2i(0), 0).r; }
    if (values.useHostTexture != 0u) { host = textureLoad(hostTexture, vec2i(0), 0).r; }
    textureStore(published, vec2i(0), vec4f(conditioning, 0.0, host, 0.0));
}
`;
