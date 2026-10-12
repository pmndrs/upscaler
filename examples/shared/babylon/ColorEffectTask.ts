import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { babylonWebGPU, getBabylonTextureOptions } from '@pmndrs/upscaler/babylon';

/** A downstream graph consumer: input/output handles remain visible to alias analysis. */
export class ColorEffectTask extends FrameGraphTask {
    readonly outputTexture: number;
    vignette = 0;
    exposure = 1;
    private readonly uniform: GPUBuffer;
    private readonly pipeline: GPUComputePipeline;
    constructor(name: string, graph: FrameGraph, readonly inputTexture: number, width: number, height: number, flipY = false) {
        super(name, graph);
        this.outputTexture = graph.textureManager.createRenderTargetTexture(name, getBabylonTextureOptions({ name: 'output', width, height, format: 'rgba16float', usage: 12, history: false, sampling: 'load', initialization: 'zero' }));
        const device = babylonWebGPU.getBabylonDevice(graph.engine);
        this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const code = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> settings: vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(destination); if (any(id.xy >= size)) { return; }
    let xy = vec2i(id.xy);
    let sourceXY = ${flipY ? 'vec2i(xy.x, i32(size.y) - 1 - xy.y)' : 'xy'};
    let rgba = textureLoad(source, sourceXY, 0);
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size) - 0.5;
    let vignette = 1.0 - settings.x * smoothstep(0.2, 0.7, length(uv));
    textureStore(destination, xy, vec4f(rgba.rgb * vignette * settings.y, rgba.a));
}`;
        this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    }
    record(): void {
        const graph = this._frameGraph, device = babylonWebGPU.getBabylonDevice(graph.engine);
        const pass = graph.addRenderPass(this.name); pass.setRenderTarget(this.outputTexture); pass.addDependencies(this.inputTexture);
        pass.setExecuteFunc(() => {
            device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.vignette, this.exposure, 0, 0]));
            const group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: babylonWebGPU.resolveBabylonTexture(graph.textureManager, this.inputTexture, true).view },
                { binding: 1, resource: babylonWebGPU.resolveBabylonTexture(graph.textureManager, this.outputTexture, true).view },
                { binding: 2, resource: { buffer: this.uniform } },
            ] });
            const size = graph.textureManager.getTextureDescription(this.outputTexture).size;
            const compute = babylonWebGPU.getBabylonEncoder(graph.engine).beginComputePass({ label: this.name });
            compute.setPipeline(this.pipeline); compute.setBindGroup(0, group); compute.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8)); compute.end();
        });
    }
    override dispose(): void { this.uniform.destroy(); super.dispose(); }
}
