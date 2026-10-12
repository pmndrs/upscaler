import { Constants } from '@babylonjs/core/Engines/constants.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import { babylonWebGPU, getBabylonTextureOptions } from '@pmndrs/upscaler/babylon';
import type { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphSSAO2RenderingPipelineTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/ssao2RenderingPipelineTask.js';
import { FrameGraphSSRRenderingPipelineTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/ssrRenderingPipelineTask.js';
import { FrameGraphBloomTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask.js';

/** Native SSAO samples filtered depth and cannot reconstruct a zero-depth background. */
class EffectGeometryTask extends FrameGraphTask {
    readonly depth: number;
    readonly normal: number;
    private readonly pipeline: GPUComputePipeline;
    constructor(graph: FrameGraph, private readonly geometry: FrameGraphGeometryRendererTask, far: number) {
        super('filterable-effect-geometry', graph);
        const { width, height } = geometry.size;
        const allocate = (name: string) => graph.textureManager.createRenderTargetTexture(name, getBabylonTextureOptions({ name: 'output', width, height, format: 'rgba16float', usage: 12, history: false, sampling: 'linear', initialization: 'zero' }));
        this.depth = allocate('effect-depth'); this.normal = allocate('effect-normal');
        const device = babylonWebGPU.getBabylonDevice(graph.engine);
        const module = device.createShaderModule({ code: /* wgsl */ `
@group(0) @binding(0) var depth: texture_2d<f32>;
@group(0) @binding(1) var normal: texture_2d<f32>;
@group(0) @binding(2) var depthOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var normalOut: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(depthOut))) { return; }
    let z = textureLoad(depth, id.xy, 0).r;
    textureStore(depthOut, id.xy, vec4f(select(${far.toFixed(8)}, z, z > 0.0), 0, 0, 1));
    textureStore(normalOut, id.xy, select(vec4f(0, 0, -1, 1), textureLoad(normal, id.xy, 0), z > 0.0));
}` });
        this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    record(): void {
        const graph = this._frameGraph, device = babylonWebGPU.getBabylonDevice(graph.engine);
        const handles = [this.geometry.geometryViewDepthTexture, this.geometry.geometryViewNormalTexture, this.depth, this.normal];
        const pass = graph.addRenderPass(this.name); pass.setRenderTarget([this.depth, this.normal]); pass.addDependencies(handles);
        pass.setExecuteFunc(() => {
            const entries = handles.map((handle, binding) => ({ binding, resource: babylonWebGPU.resolveBabylonTexture(graph.textureManager, handle, true).view }));
            const group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
            const compute = babylonWebGPU.getBabylonEncoder(graph.engine).beginComputePass({ label: this.name });
            const { width, height } = graph.textureManager.getTextureDescription(this.depth).size;
            compute.setPipeline(this.pipeline); compute.setBindGroup(0, group); compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); compute.end();
        });
    }
}

/** Babylon-native effects operate on the original Babylon-oriented G-buffer.
 * The host normalizes color/depth/motion together only after this chain. */
export function addScreenSpaceEffects(graph: FrameGraph, camera: Camera, geometry: FrameGraphGeometryRendererTask, color: number, add: (task: FrameGraphTask) => void, stack: boolean) {
    const inputs = new EffectGeometryTask(graph, geometry, camera.maxZ); add(inputs);
    const ao = new FrameGraphSSAO2RenderingPipelineTask('low-resolution-ssao', graph, 1, 1, Constants.TEXTURETYPE_HALF_FLOAT);
    ao.sourceTexture = color; ao.depthTexture = inputs.depth; ao.normalTexture = inputs.normal; ao.camera = camera;
    ao.ssao.samples = 16; ao.ssao.radius = 1.5; ao.ssao.totalStrength = 1.4; ao.ssao.maxZ = camera.maxZ;
    add(ao);
    const ssr = new FrameGraphSSRRenderingPipelineTask('low-resolution-ssr', graph, Constants.TEXTURETYPE_HALF_FLOAT);
    ssr.sourceTexture = ao.outputTexture; ssr.depthTexture = inputs.depth; ssr.normalTexture = inputs.normal;
    ssr.reflectivityTexture = geometry.geometryReflectivityTexture; ssr.camera = camera;
    ssr.ssr.useScreenspaceDepth = false; ssr.ssr.normalsAreInWorldSpace = false;
    ssr.ssr.inputTextureColorIsInGammaSpace = false; ssr.ssr.generateOutputInGammaSpace = false;
    ssr.ssr.maxSteps = 64; ssr.ssr.step = 1; ssr.ssr.maxDistance = 30; ssr.ssr.thickness = 0.3;
    ssr.ssr.strength = 1; ssr.ssr.reflectivityThreshold = 0.03; ssr.ssr.blurDispersionStrength = 0.02;
    add(ssr);
    let output = ssr.outputTexture;
    let bloom: FrameGraphBloomTask | undefined;
    if (stack) {
        bloom = new FrameGraphBloomTask('low-resolution-bloom', graph, 0.45, 24, 0.8, true, 0.5);
        bloom.sourceTexture = output; output = bloom.outputTexture; add(bloom);
    }
    return {
        ao, ssr, bloom, output,
        // Babylon 9.29's SSR blur combiner samples these again after its main pass.
        // Keep them alive through the host's last pass, including with aliasing.
        dependencies: [inputs.depth, inputs.normal, geometry.geometryReflectivityTexture],
    };
}
