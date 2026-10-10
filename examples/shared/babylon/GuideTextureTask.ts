import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { babylonWebGPU, getBabylonTextureOptions } from '@pmndrs/upscaler/babylon';

type GuideHandles = { dilatedDepth: number; dilatedMotion: number; disocclusion: number };

/** Ordinary graph consumer: either visualize the published products after upscale,
 * or tint low-res color from disocclusion between encodeGuides and encodeUpscale. */
export class GuideTextureTask extends FrameGraphTask {
    readonly outputTexture: number;
    amount = 1;
    private readonly pipeline: GPUComputePipeline;
    private readonly uniform: GPUBuffer;
    constructor(name: string, graph: FrameGraph, private readonly color: number, private readonly guides: GuideHandles, width: number, height: number, private readonly visualization: boolean) {
        super(name, graph);
        this.outputTexture = graph.textureManager.createRenderTargetTexture(name, getBabylonTextureOptions({ name: 'output', width, height, format: 'rgba16float', usage: 12, history: false, sampling: 'load', initialization: 'zero' }));
        const device = babylonWebGPU.getBabylonDevice(graph.engine);
        this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const code = /* wgsl */ `
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var motion: texture_2d<f32>;
@group(0) @binding(3) var masks: texture_2d<f32>;
@group(0) @binding(4) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params: vec4f;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(destination); if (any(id.xy >= size)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    ${visualization ? `
    let tile = vec2u(uv * 2); let local = fract(uv * 2);
    let xy = min(vec2u(local * vec2f(textureDimensions(depth))), textureDimensions(depth) - 1);
    var rgb = vec3f(0);
    if (tile.y == 0 && tile.x == 0) { rgb = vec3f(textureLoad(masks, xy, 0).r); }
    else if (tile.y == 0) { rgb = vec3f(1 - exp(-textureLoad(depth, xy, 0).r * 0.035)); }
    else if (tile.x == 1) { rgb = clamp(vec3f(0.5 + textureLoad(motion, xy, 0).xy * 32, 0.5), vec3f(0), vec3f(1)); }
    else {
        let colorXY = min(vec2u(local * vec2f(textureDimensions(color))), textureDimensions(color) - 1);
        let hdr = max(textureLoad(color, colorXY, 0).rgb, vec3f(0));
        rgb = pow(hdr / (1 + hdr), vec3f(1.0 / 2.2));
    }
    textureStore(destination, id.xy, vec4f(rgb, 1));
    ` : `
    let xy = vec2i(id.xy);
    let rgba = textureLoad(color, xy, 0);
    let reject = clamp(textureLoad(masks, xy, 0).r * params.x, 0.0, 1.0);
    textureStore(destination, xy, vec4f(mix(rgba.rgb, vec3f(2.5, 0.35, 0.03), reject), rgba.a));
    `}
}`;
        this.pipeline = device.createComputePipeline({ label: name, layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    }
    record(): void {
        const graph = this._frameGraph, device = babylonWebGPU.getBabylonDevice(graph.engine);
        // The tint shader uses color + masks only. Auto layouts exclude unused bindings.
        const pass = graph.addRenderPass(this.name); pass.setRenderTarget(this.outputTexture);
        pass.addDependencies([this.color, this.guides.dilatedDepth, this.guides.dilatedMotion, this.guides.disocclusion]);
        pass.setExecuteFunc(() => {
            device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.amount, 0, 0, 0]));
            const resolve = (handle: number) => babylonWebGPU.resolveBabylonTexture(graph.textureManager, handle, true).view;
            const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: resolve(this.color) }, { binding: 3, resource: resolve(this.guides.disocclusion) }, { binding: 4, resource: resolve(this.outputTexture) }];
            if (this.visualization) entries.push({ binding: 1, resource: resolve(this.guides.dilatedDepth) }, { binding: 2, resource: resolve(this.guides.dilatedMotion) });
            else entries.push({ binding: 5, resource: { buffer: this.uniform } });
            const group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
            const size = graph.textureManager.getTextureDescription(this.outputTexture).size;
            const compute = babylonWebGPU.getBabylonEncoder(graph.engine).beginComputePass({ label: this.name });
            compute.setPipeline(this.pipeline); compute.setBindGroup(0, group); compute.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8)); compute.end();
        });
    }
    override dispose(): void { this.uniform.destroy(); super.dispose(); }
}
