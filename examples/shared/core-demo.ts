import type { TextureResource } from '@pmndrs/upscaler/core';

// Analytic HDR scene: sub-pixel edges, moving foreground, positive view depth,
// unjittered object motion and a reactive transparent patch.
const INPUT_SHADER = /* wgsl */ `
struct Frame { size : vec2f, time : f32, previousTime : f32, jitter : vec2f, host : f32, conditioning : f32 }
@group(0) @binding(0) var<uniform> f : Frame;
@group(0) @binding(1) var color : texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var depth : texture_storage_2d<r32float, write>;
@group(0) @binding(3) var motion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var reactive : texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= f.size)) { return; }
    let uv = (vec2f(gid.xy) + 0.5 + f.jitter) / f.size;
    let center = 0.45 + 0.12 * sin(f.time);
    let previousCenter = 0.45 + 0.12 * sin(f.previousTime);
    let box = abs(uv.x - center) < 0.12 && abs(uv.y - 0.5) < 0.22;
    let stripes = select(0.04, 0.8, fract(uv.x * 140.0 + uv.y * 23.0) < 0.22);
    var rgb = vec3f(stripes, stripes * 0.7, stripes * 0.5);
    if (box) { rgb = vec3f(2.5, 0.2 + 2.0 * uv.y, 0.15); }
    let transparentPatch = distance(uv, vec2f(0.74, 0.58)) < 0.11;
    let alpha = select(1.0, 0.55, transparentPatch);
    if (transparentPatch) { rgb = mix(rgb, vec3f(0.1, 0.4, 3.0), 0.55); }
    textureStore(color, gid.xy, vec4f(rgb * f.host, alpha));
    textureStore(depth, gid.xy, vec4f(select(20.0, 2.0, box)));
    // Exokosm example convention: previous-minus-current UV, core scale (-1,-1).
    textureStore(motion, gid.xy, vec4f(select(0.0, previousCenter - center, box), 0.0, 0.0, 0.0));
    textureStore(reactive, gid.xy, vec4f(select(0.0, 0.85, transparentPatch)));
}
`;

export type DemoInputs = Record<'color' | 'depth' | 'velocity' | 'reactive' | 'exposureTexture' | 'preExposureTexture', TextureResource>;
const EXPOSURES = [
    'struct Frame { size : vec2f, time : f32, previousTime : f32, jitter : vec2f, host : f32, conditioning : f32 }',
    '@group(0) @binding(0) var<uniform> f : Frame;',
    '@group(0) @binding(1) var conditioning : texture_storage_2d<rgba32float, write>;',
    '@group(0) @binding(2) var host : texture_storage_2d<rgba32float, write>;',
    '@compute @workgroup_size(1) fn main() {',
    'textureStore(conditioning, vec2i(0), vec4f(f.conditioning, 0.0, 0.0, 0.0));',
    'textureStore(host, vec2i(0), vec4f(f.host, 0.0, 0.0, 0.0)); }',
].join('\n');
export async function readOutput(device: GPUDevice, resource: TextureResource): Promise<{ finite: boolean; max: number; alphaMin: number }> {
    const { width, height } = resource.texture; const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: resource.texture }, { buffer, bytesPerRow }, { width, height }); device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ); const data = new Uint16Array(buffer.getMappedRange());
    let finite = true; let max = 0; let alphaMin = 1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) {
        const bits = data[y * bytesPerRow / 2 + x * 4 + channel]; const exponent = (bits >> 10) & 31; const mantissa = bits & 1023;
        const value = (bits & 32768 ? -1 : 1) * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exponent - 15));
        finite &&= Number.isFinite(value); if (channel === 3) alphaMin = Math.min(alphaMin, value); else max = Math.max(max, value);
    }
    buffer.unmap(); buffer.destroy(); return { finite, max, alphaMin };
}
export class DemoScene {
    private readonly uniform: GPUBuffer;
    private readonly pipeline: GPUComputePipeline;
    private readonly exposures: GPUComputePipeline;
    constructor(private readonly device: GPUDevice) {
        this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: INPUT_SHADER }), entryPoint: 'main' } });
        this.exposures = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: EXPOSURES }), entryPoint: 'main' } });
    }
    encode(encoder: GPUCommandEncoder, inputs: DemoInputs, time: number, previousTime: number, jitter: { x: number; y: number }, host = 1, conditioning = 1): void {
        const data = new Float32Array([inputs.color.texture.width, inputs.color.texture.height, time, previousTime, jitter.x, jitter.y, host, conditioning]);
        this.device.queue.writeBuffer(this.uniform, 0, data);
        const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }, ...(['color', 'depth', 'velocity', 'reactive'] as const).map((key, index) => ({ binding: index + 1, resource: inputs[key].view }))] });
        const pass = encoder.beginComputePass({ label: 'demo-scene-inputs' }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(data[0] / 8), Math.ceil(data[1] / 8)); pass.end();
        const exposureGroup = this.device.createBindGroup({ layout: this.exposures.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: inputs.exposureTexture.view }, { binding: 2, resource: inputs.preExposureTexture.view }] });
        const exposurePass = encoder.beginComputePass(); exposurePass.setPipeline(this.exposures); exposurePass.setBindGroup(0, exposureGroup); exposurePass.dispatchWorkgroups(1); exposurePass.end();
    }
    dispose(): void { this.uniform.destroy(); }
}

const PRESENT = /* wgsl */ `
@group(0) @binding(0) var source : texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) index : u32) -> @builtin(position) vec4f {
    let positions = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(positions[index],0,1);
}
@fragment fn fragment(@builtin(position) p : vec4f) -> @location(0) vec4f {
    let rgb = max(textureLoad(source, vec2i(p.xy), 0).rgb, vec3f(0));
    return vec4f(pow(rgb / (1.0 + rgb), vec3f(1.0 / 2.2)), 1.0);
}`;
export class DemoPresent {
    private readonly pipeline: GPURenderPipeline;
    constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
        const module = device.createShaderModule({ code: PRESENT });
        this.pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    }
    encode(encoder: GPUCommandEncoder, source: TextureResource, target: GPUTextureView): void {
        const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.view }] });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    }
}
