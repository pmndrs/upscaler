import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import { FrameGraphClearTextureTask } from '@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js';
import { FrameGraphObjectRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js';
import { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphUpscaleTask, getBabylonTextureOptions, babylonWebGPU } from '@pmndrs/upscaler/babylon';
import type { TextureResource } from '@pmndrs/upscaler/core';
import type { FrameGraphUpscaleConfiguration } from '@pmndrs/upscaler/babylon';
import { inputParameters, INPUTS } from './inputs';
import { ColorEffectTask } from './ColorEffectTask';
import { addScreenSpaceEffects } from './ScreenSpaceEffects';
import { GuideTextureTask } from './GuideTextureTask';

export interface SceneFeatures {
    spatialComparison?: boolean;
    composition?: boolean;
    authoredReactive?: boolean;
    transparentCanvas?: boolean;
    screenEffects?: 'single' | 'stack';
    guides?: 'visualize' | 'compose';
}

class CallbackTask extends FrameGraphTask {
    constructor(name: string, graph: FrameGraph, private readonly build: () => void) { super(name, graph); }
    record(): void { this.build(); }
}

const PRESENT = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var native: texture_2d<f32>;
@group(0) @binding(2) var<uniform> split: vec4f;
@group(0) @binding(3) var reactive: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(positions[i],0,1);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let width = f32(textureDimensions(source).x);
    var rgba = textureLoad(source, vec2i(p.xy), 0);
    if (p.x / width < split.x) {
        let nativeY = select(i32(p.y), i32(textureDimensions(native).y) - 1 - i32(p.y), split.w > 0);
        rgba = textureLoad(native, vec2i(i32(p.x), nativeY), 0);
    }
    if (split.z == 1) {
        let xy = vec2i(p.xy / vec2f(textureDimensions(source)) * vec2f(textureDimensions(reactive)));
        return vec4f(vec3f(textureLoad(reactive, xy, 0).r), 1);
    }
    if (split.z == 2) { return rgba; }
    let alpha = select(1.0, clamp(rgba.a, 0.0, 1.0), split.y > 0);
    // Scene coverage is premultiplied in linear HDR. Unpremultiply before the
    // nonlinear display transform, then premultiply for WebGPU's canvas contract.
    let rgb = max(rgba.rgb / max(alpha, 0.00001), vec3f(0));
    if (split.x > 0 && abs(p.x - width * split.x) < 1) { return vec4f(1); }
    return vec4f(pow(rgb / (1 + rgb), vec3f(1.0 / 2.2)) * alpha, alpha);
}`;

/** Example host integration. All textures, including normalized inputs, belong to
 * the Frame Graph. Only the engine submits; all raw GPU work borrows its encoder. */
export class BabylonScenePresenter {
    readonly graph: FrameGraph;
    readonly upscale: FrameGraphUpscaleTask;
    readonly config: FrameGraphUpscaleConfiguration;
    readonly device: GPUDevice;
    reactive = true;
    showReactive = false;
    readonly composition?: ColorEffectTask;
    readonly screenEffects?: ReturnType<typeof addScreenSpaceEffects>;
    readonly guideConsumer?: GuideTextureTask;
    readonly hasGuides: boolean;
    split = 0.5;
    frames = 0;
    private resetInputs = true;
    private previousJitter = { x: 0, y: 0 };
    private readonly tasks: FrameGraphTask[] = [];
    private readonly uniforms: GPUBuffer;
    private readonly splitUniform: GPUBuffer;
    private readonly nativeCamera: FreeCamera;
    private readonly normalized: number[];
    private readonly nativeColor: number;
    private readonly maskMaterial?: StandardMaterial;
    private readonly finalColor: number;

    constructor(private readonly engine: WebGPUEngine, private readonly scene: Scene, private readonly camera: FreeCamera, private readonly canvas: HTMLCanvasElement, width: number, height: number, ratio: number, transparency: boolean, comparison: boolean, optimize = true, features: SceneFeatures = {}) {
        this.device = babylonWebGPU.getBabylonDevice(engine);
        this.hasGuides = !!features.guides;
        this.graph = new FrameGraph(scene); this.graph.optimizeTextureAllocation = optimize;
        const graph = this.graph;
        const add = <T extends FrameGraphTask>(task: T): T => { this.tasks.push(task); graph.addTask(task); return task; };
        const rw = Math.max(1, Math.floor(width / ratio)), rh = Math.max(1, Math.floor(height / ratio));
        this.config = { renderWidth: rw, renderHeight: rh, displayWidth: width, displayHeight: height, depthMode: 'linear', exposureMode: 'provided' };
        this.upscale = new FrameGraphUpscaleTask('temporal-upscale', graph, {
            configuration: this.config,
            frame: () => ({ frameIndex: this.frames, deltaTime: engine.getDeltaTime() / 1000, near: camera.minZ, far: camera.maxZ, motionScale: { x: 1, y: 1 } }),
            settings: { autoExposure: false, exposure: 1, sharpness: 0.4 },
        });
        const texture = (name: string, format: GPUTextureFormat, w = rw, h = rh, storage = false) => graph.textureManager.createRenderTargetTexture(name, getBabylonTextureOptions({ name: 'output', width: w, height: h, format, usage: storage ? 12 : 20, history: false, sampling: 'load', initialization: 'zero' }));
        const targets = (name: string, w: number, h: number) => {
            const color = texture(name, 'rgba16float', w, h);
            const depth = graph.textureManager.createRenderTargetTexture(name + '-z', { size: { width: w, height: h }, sizeIsPercentage: false, options: { createMipMaps: false, formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT], types: [Constants.TEXTURETYPE_FLOAT], samples: 1 } });
            const clear = add(new FrameGraphClearTextureTask(name + '-clear', graph));
            clear.targetTexture = color; clear.depthTexture = depth; clear.clearDepth = true; clear.clearColor = true;
            clear.color = features.transparentCanvas ? new Color4(0, 0, 0, 0) : new Color4(0.018, 0.026, 0.052, 1);
            return { color, depth };
        };
        const setup = (task: FrameGraphObjectRendererTask, target: { color: number; depth: number }, view: FreeCamera) => {
            task.targetTexture = target.color; task.depthTexture = target.depth; task.camera = view;
            task.objectList = { meshes: scene.meshes, particleSystems: [] };
            task.disableImageProcessing = true;
        };
        // Separate camera: native rendering never inherits the low-resolution jitter.
        this.nativeCamera = new FreeCamera('native-reference', Vector3.Zero(), scene);
        const opaque = targets('opaque-color', rw, rh);
        const geometry = add(new FrameGraphGeometryRendererTask('opaque-geometry', graph, scene));
        setup(geometry, opaque, camera); geometry.isMainObjectRenderer = true;
        geometry.renderTransparentMeshes = false; geometry.size = { width: rw, height: rh }; geometry.sizeIsPercentage = false;
        geometry.textureDescriptions = [
            { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
            { type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        ];
        const retainedInputs: number[] = [];
        if (features.screenEffects) {
            // Motion uses only XY. RG16F also keeps this MRT within the default
            // 32-byte budget (RGBA8's render-target cost is 8, not 4 bytes).
            geometry.textureDescriptions[1].textureFormat = Constants.TEXTUREFORMAT_RG;
            geometry.textureDescriptions.push(
                { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
                { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
            );
        }
        let color = opaque.color;
        if (transparency) {
            const beauty = targets('complete-color', rw, rh);
            const render = add(new FrameGraphObjectRendererTask('opaque-and-transparent', graph, scene));
            setup(render, beauty, camera); color = beauty.color;
        }
        if (features.screenEffects) {
            this.screenEffects = addScreenSpaceEffects(graph, camera, geometry, color, add, features.screenEffects === 'stack');
            color = this.screenEffects.output; retainedInputs.push(...this.screenEffects.dependencies);
        }
        let authoredMask = opaque.color;
        if (features.authoredReactive) {
            authoredMask = texture('authored-coverage', 'rgba16float');
            const clear = add(new FrameGraphClearTextureTask('clear-coverage', graph));
            clear.targetTexture = authoredMask; clear.color = new Color4(0, 0, 0, 0); clear.clearColor = true; clear.clearDepth = false;
            const mask = add(new FrameGraphObjectRendererTask('transparent-coverage', graph, scene));
            setup(mask, { color: authoredMask, depth: opaque.depth }, camera); mask.depthWrite = false;
            const meshes = scene.meshes.filter(mesh => mesh.material?.needAlphaBlendingForMesh(mesh));
            mask.objectList = { meshes, particleSystems: [] };
            this.maskMaterial = new StandardMaterial('white-coverage', scene);
            this.maskMaterial.disableLighting = true; this.maskMaterial.emissiveColor = Color3.White(); this.maskMaterial.backFaceCulling = false;
            mask.objectRenderer.setMaterialForRendering(meshes, this.maskMaterial);
        }
        this.normalized = [texture('positive-depth', 'r32float', rw, rh, true), texture('unjittered-motion', 'rgba16float', rw, rh, true), texture('reactive-mask', 'rgba8unorm', rw, rh, true), texture('top-left-color', 'rgba16float', rw, rh, true)];
        this.uniforms = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const inputPipeline = this.device.createComputePipeline({ label: 'Babylon inputs', layout: 'auto', compute: { module: this.device.createShaderModule({ code: INPUTS }), entryPoint: 'main' } });
        add(new CallbackTask('normalize-inputs', graph, () => {
            const inputs = [geometry.geometryViewDepthTexture, geometry.geometryLinearVelocityTexture, opaque.color, color];
            const pass = graph.addRenderPass('normalize-inputs'); pass.setRenderTarget(this.normalized[0]); pass.addDependencies([...inputs, ...this.normalized, authoredMask]);
            pass.setExecuteFunc(() => {
                const data = inputParameters(rw, rh, this.upscale.jitter, this.previousJitter, camera.maxZ, this.reactive && transparency, this.resetInputs, features.authoredReactive);
                this.device.queue.writeBuffer(this.uniforms, 0, data);
                const bindings = [...inputs, ...this.normalized].map((handle, index) => ({ binding: index + 1, resource: this.resource(handle).view }));
                const group = this.device.createBindGroup({ layout: inputPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniforms } }, ...bindings, { binding: 9, resource: this.resource(authoredMask).view }] });
                const compute = babylonWebGPU.getBabylonEncoder(engine).beginComputePass({ label: 'normalize Babylon inputs' });
                compute.setPipeline(inputPipeline); compute.setBindGroup(0, group); compute.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8)); compute.end();
            });
        }));
        this.upscale.colorTexture = this.normalized[3]; this.upscale.depthTexture = this.normalized[0]; this.upscale.velocityTexture = this.normalized[1]; this.upscale.reactiveTexture = this.normalized[2];
        if (features.guides) {
            add(this.upscale.createGuidesTask());
            if (features.guides === 'compose') {
                this.guideConsumer = add(new GuideTextureTask('color-from-disocclusion', graph, this.normalized[3], this.upscale.guides, rw, rh, false));
                this.upscale.colorTexture = this.guideConsumer.outputTexture;
            }
        }
        add(this.upscale);
        this.finalColor = this.upscale.outputTexture;
        if (features.guides === 'visualize') {
            const view = add(new GuideTextureTask('guide-visualization', graph, this.upscale.outputTexture, this.upscale.guides, width, height, true));
            this.finalColor = view.outputTexture;
        }
        if (features.composition) {
            this.composition = add(new ColorEffectTask('vignette-after-upscale', graph, this.upscale.outputTexture, width, height));
            this.finalColor = this.composition.outputTexture;
        }
        this.nativeColor = this.upscale.outputTexture;
        if (comparison) {
            const native = targets('native-reference', width, height);
            const render = add(new FrameGraphObjectRendererTask('native-reference', graph, scene));
            setup(render, native, this.nativeCamera); this.nativeColor = native.color;
        }
        if (features.spatialComparison) {
            const reference = targets('unjittered-spatial-input', rw, rh);
            const render = add(new FrameGraphObjectRendererTask('spatial-scene', graph, scene));
            setup(render, reference, this.nativeCamera);
            const oriented = add(new ColorEffectTask('spatial-top-left-color', graph, reference.color, rw, rh, true));
            const spatial = add(new FrameGraphUpscaleTask('spatial-reference', graph, { configuration: { ...this.config, path: 'spatial' }, frame: () => ({ frameIndex: this.frames }), settings: { sharpness: 0.4, exposure: 1, autoExposure: false } }));
            spatial.colorTexture = oriented.outputTexture; this.nativeColor = spatial.outputTexture;
        }
        this.splitUniform = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const module = this.device.createShaderModule({ code: PRESENT });
        const presentPipeline = this.device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] }, primitive: { topology: 'triangle-list' } });
        add(new CallbackTask('present', graph, () => {
            const pass = graph.addRenderPass('present'); pass.setRenderTarget(0);
            // Keep diagnostic inputs alive through the last pass even with aliasing enabled.
            pass.addDependencies([this.upscale.outputTexture, this.finalColor, this.nativeColor, ...this.normalized, ...retainedInputs, ...(features.guides ? Object.values(this.upscale.guides) : [])]);
            pass.setExecuteFunc(() => {
                this.device.queue.writeBuffer(this.splitUniform, 0, new Float32Array([comparison || features.spatialComparison ? this.split : 0, Number(!!features.transparentCanvas), features.guides === 'visualize' ? 2 : Number(this.showReactive), Number(comparison)]));
                const group = this.device.createBindGroup({ layout: presentPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.presented().view }, { binding: 1, resource: this.resource(this.nativeColor).view }, { binding: 2, resource: { buffer: this.splitUniform } }, { binding: 3, resource: this.resource(this.normalized[2]).view }] });
                const render = babylonWebGPU.getBabylonEncoder(engine).beginRenderPass({ colorAttachments: [{ view: canvas.getContext('webgpu')!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
                render.setPipeline(presentPipeline); render.setBindGroup(0, group); render.draw(3); render.end();
            });
        }));
    }

    async prepare(): Promise<void> { await this.graph.buildAsync(); this.scene.frameGraph = this.graph; }
    resource(handle: number): TextureResource { return babylonWebGPU.resolveBabylonTexture(this.graph.textureManager, handle, true); }
    output(): TextureResource { return this.resource(this.upscale.outputTexture); }
    presented(): TextureResource { return this.resource(this.finalColor); }
    inputs(): TextureResource[] { return this.normalized.slice(0, 3).map(handle => this.resource(handle)); }
    native(): TextureResource { return this.resource(this.nativeColor); }
    guideResources(): TextureResource[] { return this.hasGuides ? Object.values(this.upscale.guides).map(handle => this.resource(handle)) : []; }
    inputColor(): TextureResource { return this.resource(this.normalized[3]); }
    conditionedColor(): TextureResource { return this.resource(this.upscale.colorTexture); }
    setMode(temporal: boolean): void { if (this.upscale.disabled === temporal) { this.upscale.disabled = !temporal; this.reset(); } }
    reset(): void { this.upscale.resetHistory(); this.resetInputs = true; this.previousJitter = { x: 0, y: 0 }; }
    render(): void {
        this.nativeCamera.position.copyFrom(this.camera.position); this.nativeCamera.rotation.copyFrom(this.camera.rotation);
        this.nativeCamera.freezeProjectionMatrix(this.camera.getProjectionMatrix().clone());
        this.upscale.beginFrame(this.camera);
        try {
            this.scene.render(); this.frames++; this.resetInputs = false; this.previousJitter = { ...this.upscale.jitter };
        } catch (error) { this.reset(); throw error; } finally { this.upscale.endFrame(); }
    }
    dispose(): void {
        this.scene.frameGraph = null;
        for (const task of this.tasks) task.dispose();
        this.graph.dispose(); this.nativeCamera.dispose(); this.maskMaterial?.dispose(); this.uniforms.destroy(); this.splitUniform.destroy();
    }
}
