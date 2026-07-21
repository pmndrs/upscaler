import * as THREE from 'three/webgpu';
import {
    diffuseColor,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    texture,
    vec4,
    velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

import { DebugView, QualityMode, getQualityModeRatio } from '@pmndrs/upscaler';

/** Bench render modes — what fills the screen each frame. */
export type BenchMode = 'native' | 'bilinear' | 'fsr1-spatial' | 'upscale-temporal';

type EffectScenario = {
    id: 'Q6' | 'Q7' | 'Q8';
    subrun: string | null;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
};

type SizedEffectNode = {
    setSize(width: number, height: number): void;
};

type EffectUpdateNode = SizedEffectNode & {
    updateBefore(frame: unknown): void;
};

type SsrPrivateNode = {
    _noiseIndex: { value: number };
};

type TextureExpectation = {
    name: string;
    texture: THREE.Texture | (() => THREE.Texture);
    width: number;
    height: number;
    format?: GPUTextureFormat;
};

type NodeFrameBridge = {
    frameId: number;
    renderId: number;
    time: number;
    deltaTime: number;
    lastTime: number;
    updateMap: WeakMap<object, object>;
    updateBeforeMap: WeakMap<object, object>;
    updateAfterMap: WeakMap<object, object>;
    update(): void;
};

function deterministicDenoiseNoise(): THREE.DataTexture {
    let seed = 0x0d3e015e;
    const simplex = new SimplexNoise({
        random(): number {
            seed = (seed ^ ((seed << 13) >>> 0)) >>> 0;
            seed = (seed ^ (seed >>> 17)) >>> 0;
            seed = (seed ^ ((seed << 5) >>> 0)) >>> 0;
            return seed / 4294967296;
        },
    });
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const offset = (i * size + j) * 4;
            data[offset] = (simplex.noise(i, j) * 0.5 + 0.5) * 255;
            data[offset + 1] = (simplex.noise(i + size, j) * 0.5 + 0.5) * 255;
            data[offset + 2] = (simplex.noise(i, j + size) * 0.5 + 0.5) * 255;
            data[offset + 3] = (simplex.noise(i + size, j + size) * 0.5 + 0.5) * 255;
        }
    }
    const noise = new THREE.DataTexture(data, size, size);
    noise.wrapS = THREE.RepeatWrapping;
    noise.wrapT = THREE.RepeatWrapping;
    noise.needsUpdate = true;
    return noise;
}

function seededDenoise(
    node: unknown,
    depth: unknown,
    normal: unknown,
    camera: THREE.PerspectiveCamera,
): ReturnType<typeof denoise> {
    const originalRandom = Math.random;
    let constructorSeed = 0x0d3e015e;
    Math.random = (): number => {
        constructorSeed = (constructorSeed ^ ((constructorSeed << 13) >>> 0)) >>> 0;
        constructorSeed = (constructorSeed ^ (constructorSeed >>> 17)) >>> 0;
        constructorSeed = (constructorSeed ^ ((constructorSeed << 5) >>> 0)) >>> 0;
        return constructorSeed / 4294967296;
    };
    let effect: ReturnType<typeof denoise>;
    try {
        effect = denoise(node as never, depth as never, normal as never, camera);
    } finally {
        Math.random = originalRandom;
    }
    const mutable = effect as unknown as {
        noiseNode: { value?: THREE.Texture };
        index: { value: number };
    };
    mutable.noiseNode.value?.dispose();
    mutable.noiseNode = texture(deterministicDenoiseNoise()) as never;
    mutable.index.value = 0;
    return effect;
}

/**
 * Owns everything between "a scene + camera" and "pixels on the canvas":
 * the low-resolution scene render target (color + velocity MRT + depth),
 * the FSR3 upscaler, and the fullscreen presentation quad.
 *
 * All bench modes — including native — funnel through the same render
 * target and the same WGSL display transform, so image and performance
 * comparisons are apples-to-apples.
 */
export class BenchPipeline {
    readonly resolver: BenchmarkResolver;

    //* Presentation
    private readonly _renderer: THREE.WebGPURenderer;
    private readonly _quad: THREE.QuadMesh;
    private readonly _quadMaterial: THREE.NodeMaterial;
    private readonly _depthOnlyMaterial: THREE.MeshBasicMaterial;
    private readonly _effectMaterial: THREE.NodeMaterial;
    private readonly _effectQuad: THREE.QuadMesh;

    //* Scene Target
    private _renderTarget: THREE.RenderTarget | null = null;
    private _reactiveTarget: THREE.RenderTarget | null = null;
    private readonly _mrtNode = mrt({ output, velocity });
    // Single-output MRT for non-temporal modes — its output count matches the
    // count:1 render target so color attachment 0 is actually written.
    private readonly _mrtOutputOnly = mrt({ output });
    private _effectScenario: EffectScenario | null = null;
    private _effectPass: ReturnType<typeof pass> | null = null;
    private _effectSsrNodes: SsrPrivateNode[] = [];
    private _effectSizedNodes: SizedEffectNode[] = [];
    private _effectTemporalNodes: unknown[] = [];
    private _effectTextures: TextureExpectation[] = [];
    private _velocitySeedFrame = -2;

    private _mode: BenchMode = 'upscale-temporal';
    private _quality: QualityMode = QualityMode.Quality;
    private _displayWidth = 0;
    private _displayHeight = 0;

    /**
     * Creates a pipeline around exactly one resolver factory.
     * @param renderer - Initialized WebGPU renderer
     * @param resolverFactory - Registry-owned factory for the active variant
     * @param metadata - Selected variant metadata
     */
    constructor(
        renderer: THREE.WebGPURenderer,
        resolverFactory: BenchmarkResolverFactory,
        metadata: BenchmarkVariantMetadata,
    ) {
        this._renderer = renderer;
        this.resolver = resolverFactory(renderer, metadata);

        // Motion vectors must be jitter-free — hand the velocity node the
        // upscaler's unjittered projection (contents refresh every frame).
        velocity.setProjectionMatrix(
            this.resolver.unjitteredProjectionMatrix as THREE.Matrix4,
        );

        this._quadMaterial = new THREE.NodeMaterial();
        // Plain fullscreen present — no depth interaction, no fog.
        this._quadMaterial.depthTest = false;
        this._quadMaterial.depthWrite = false;
        this._quadMaterial.fog = false;
        this._quad = new THREE.QuadMesh(this._quadMaterial);
        this._effectMaterial = new THREE.NodeMaterial();
        this._effectMaterial.depthTest = false;
        this._effectMaterial.depthWrite = false;
        this._effectMaterial.fog = false;
        this._effectQuad = new THREE.QuadMesh(this._effectMaterial);
        this._depthOnlyMaterial = new THREE.MeshBasicMaterial({
            colorWrite: false,
            depthWrite: true,
        });
    }

    get mode(): BenchMode {
        return this._mode;
    }

    get renderTarget(): THREE.RenderTarget | null {
        return this._renderTarget;
    }

    get metadata(): BenchmarkVariantMetadata {
        return this.resolver.metadata;
    }

    get usesEffectGraph(): boolean {
        return this._effectScenario !== null;
    }

    /**
     * Selects the pinned three.js effect graph built during configuration.
     * @param id - Q6, Q7, or Q8
     * @param subrun - Manifest-selected effect subrun
     * @param scene - Fixed room fixture
     * @param camera - Scenario camera
     */
    configureEffectScenario(
        id: 'Q6' | 'Q7' | 'Q8',
        subrun: string | null,
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
    ): void {
        this._effectScenario = { id, subrun, scene, camera };
    }

    /**
     * (Re)builds the pipeline for a display size, mode, and quality preset.
     * @param displayWidth - Canvas width in physical pixels
     * @param displayHeight - Canvas height in physical pixels
     * @param mode - Bench render mode
     * @param quality - FSR quality preset (ignored in native mode)
     */
    configure(
        displayWidth: number,
        displayHeight: number,
        mode: BenchMode,
        quality: QualityMode,
    ): void {
        const ratio = mode === 'native' ? 1 : getQualityModeRatio(quality);
        this._configure(displayWidth, displayHeight, mode, quality, ratio, false);
    }

    /**
     * Configures an exact manifest ratio for automated execution.
     * @param displayWidth - Physical output width
     * @param displayHeight - Physical output height
     * @param ratio - Manifest display/render ratio
     * @param reactive - Allocate the Q5 reactive coverage target
     */
    configureBenchmark(
        displayWidth: number,
        displayHeight: number,
        ratio: number,
        reactive: boolean,
    ): void {
        this._configure(
            displayWidth,
            displayHeight,
            'upscale-temporal',
            QualityMode.Quality,
            ratio,
            reactive,
        );
    }

    private _configure(
        displayWidth: number,
        displayHeight: number,
        mode: BenchMode,
        quality: QualityMode,
        ratio: number,
        reactive: boolean,
    ): void {
        this._mode = mode;
        this._quality = quality;
        this._displayWidth = displayWidth;
        this._displayHeight = displayHeight;

        //* Upscaler
        this.resolver.configure({
            displayWidth,
            displayHeight,
            ratio,
            path:
                mode === 'upscale-temporal'
                    ? 'temporal'
                    : mode === 'fsr1-spatial'
                      ? 'spatial'
                      : 'bilinear',
        });

        //* Scene Render Target (color [+ velocity MRT], float depth)
        // Only the temporal path consumes velocity; the attachment count must
        // match the MRT output count used in render() (a count:2 target
        // rendered without a velocity output leaves color attachment 0 black).
        this._renderTarget?.dispose();
        this._reactiveTarget?.dispose();
        this._reactiveTarget = null;
        const rw = this.resolver.renderWidth;
        const rh = this.resolver.renderHeight;
        const temporal = mode === 'upscale-temporal';
        if (this._effectScenario) {
            this._renderTarget = new THREE.RenderTarget(rw, rh, {
                count: 1,
                type: THREE.HalfFloatType,
                depthBuffer: false,
            });
        } else {
            const depthTexture = new THREE.DepthTexture(rw, rh);
            depthTexture.type = THREE.FloatType;
            this._renderTarget = new THREE.RenderTarget(rw, rh, {
                count: temporal ? 2 : 1,
                type: THREE.HalfFloatType,
                depthTexture,
            });
        }
        // MRT routes node outputs to attachments BY TEXTURE NAME (see
        // three's getTextureIndex) — these must match the mrt({...}) keys.
        this._renderTarget.textures[0].name = 'output';
        if (temporal && !this._effectScenario) this._renderTarget.textures[1].name = 'velocity';

        if (reactive) {
            this._reactiveTarget = new THREE.RenderTarget(rw, rh, {
                count: 1,
                type: THREE.HalfFloatType,
            });
            this._reactiveTarget.textures[0].name = 'output';
        }

        // Present the (re)created output texture on the quad.
        this._quadMaterial.colorNode = texture(this.resolver.outputTexture as THREE.Texture);
        this._quadMaterial.needsUpdate = true;
        if (this._effectScenario) this._buildEffectGraph(ratio);
        this.resolver.resetTiming();
    }

    private _buildEffectGraph(ratio: number): void {
        const effect = this._effectScenario!;
        const scenePass = pass(effect.scene, effect.camera);
        this._effectPass = scenePass;
        this._effectSsrNodes = [];
        this._effectSizedNodes = [];
        this._effectTemporalNodes = [];
        this._effectTextures = [];

        const combined = effect.id === 'Q7' || effect.id === 'Q8';
        const isolated = effect.subrun;
        if (combined) {
            scenePass.setMRT(
                mrt({
                    output,
                    velocity,
                    normal: vec4(normalView, roughness),
                    diffuse: vec4(diffuseColor.rgb, metalness),
                }),
            );
        } else if (isolated === 'ssgi') {
            scenePass.setMRT(mrt({ output, normal: normalView, velocity, diffuse: diffuseColor }));
        } else if (isolated === 'ssr') {
            scenePass.setMRT(
                mrt({
                    output,
                    normal: normalView,
                    velocity,
                    material: vec4(metalness, roughness, 0, 0),
                }),
            );
        } else {
            scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
        }
        scenePass.setResolutionScale(1 / ratio);
        if (!scenePass.renderTarget.depthTexture)
            throw new Error('Effect PassNode did not allocate its required depth texture.');
        scenePass.renderTarget.depthTexture.type = THREE.FloatType;

        const beauty = scenePass.getTextureNode('output');
        const depth = scenePass.getTextureNode('depth');
        const normal = scenePass.getTextureNode('normal');
        const vel = scenePass.getTextureNode('velocity');
        let rgb = beauty.rgb;

        if (isolated === 'gtao') {
            const gtao = ao(depth, normal, effect.camera);
            gtao.useTemporalFiltering = false;
            const aoTexture = (gtao as unknown as { getTextureNode(): ReturnType<typeof vec4> })
                .getTextureNode();
            rgb = beauty.rgb.mul(aoTexture.r);
            const target = gtao as unknown as { _aoRenderTarget: THREE.RenderTarget };
            if (!target._aoRenderTarget)
                throw new Error('Pinned GTAONode._aoRenderTarget shape changed.');
            this._pinEffectResolution(gtao as unknown as EffectUpdateNode);
            this._trackEffectTexture('gtao.output', target._aoRenderTarget.texture);
        }

        if (combined || isolated === 'ssgi') {
            const diffuse = scenePass.getTextureNode('diffuse');
            const giPass = ssgi(beauty, depth, normal, effect.camera);
            if (effect.id === 'Q8') {
                giPass.sliceCount.value = 2;
                giPass.stepCount.value = 8;
            }
            const aoTexture = giPass.getAONode() as unknown as ReturnType<typeof vec4>;
            const giRaw = giPass.getGINode();
            let gi = giRaw as unknown as ReturnType<typeof vec4>;

            if (effect.id === 'Q8' && effect.subrun === 'spatial') {
                const spatial = recurrentDenoise(giRaw as never, effect.camera, {
                    depth: depth as never,
                    normal: normal as never,
                    raw: giRaw as never,
                    mode: 'diffuse',
                    accumulate: false,
                });
                gi = spatial as unknown as ReturnType<typeof vec4>;
                this._effectSizedNodes.push(spatial as unknown as SizedEffectNode);
                this._pinEffectResolution(spatial as unknown as EffectUpdateNode);
                const spatialTarget = (
                    spatial as unknown as { getRenderTarget(): THREE.RenderTarget }
                ).getRenderTarget();
                this._trackEffectTexture('recurrent.spatial-output', spatialTarget.texture);
            } else if (effect.id === 'Q8' && effect.subrun === 'recurrent') {
                const reproject = temporalReproject(
                    giRaw as never,
                    depth as never,
                    normal as never,
                    vel as never,
                    effect.camera,
                    { mode: 'diffuse' },
                );
                const recurrent = recurrentDenoise(reproject as never, effect.camera, {
                    depth: depth as never,
                    normal: normal as never,
                    raw: giRaw as never,
                    mode: 'diffuse',
                    accumulate: true,
                });
                reproject.setHistoryTexture(recurrent as never);
                gi = recurrent as unknown as ReturnType<typeof vec4>;
                this._effectSizedNodes.push(
                    reproject as unknown as SizedEffectNode,
                    recurrent as unknown as SizedEffectNode,
                );
                this._effectTemporalNodes.push(reproject, recurrent);
                this._pinEffectResolution(reproject as unknown as EffectUpdateNode);
                this._pinEffectResolution(recurrent as unknown as EffectUpdateNode);
                const temporalPrivate = reproject as unknown as {
                    _historyRenderTarget: THREE.RenderTarget;
                    _resolveRenderTarget: THREE.RenderTarget;
                    _previousNormalTexture: THREE.Texture;
                };
                const recurrentTarget = (
                    recurrent as unknown as { getRenderTarget(): THREE.RenderTarget }
                ).getRenderTarget();
                if (
                    !temporalPrivate._historyRenderTarget ||
                    !temporalPrivate._resolveRenderTarget ||
                    !temporalPrivate._previousNormalTexture
                )
                    throw new Error('Pinned TemporalReprojectNode render-target shape changed.');
                if (!temporalPrivate._historyRenderTarget.depthTexture)
                    throw new Error('Temporal history depth texture is unavailable.');
                temporalPrivate._historyRenderTarget.depthTexture.type = THREE.FloatType;
                this._trackEffectTexture(
                    'temporal.history-color',
                    temporalPrivate._historyRenderTarget.texture,
                );
                if (temporalPrivate._historyRenderTarget.depthTexture)
                    this._trackEffectTexture(
                        'temporal.history-depth',
                        temporalPrivate._historyRenderTarget.depthTexture,
                        undefined,
                        undefined,
                        'depth32float',
                    );
                this._trackEffectTexture(
                    'temporal.resolve',
                    temporalPrivate._resolveRenderTarget.texture,
                );
                this._trackEffectTexture(
                    'temporal.previous-normal',
                    () => temporalPrivate._previousNormalTexture,
                );
                this._trackEffectTexture('recurrent.output', recurrentTarget.texture);
            } else if (effect.id !== 'Q8') {
                const denoised = seededDenoise(giRaw, depth, normal, effect.camera);
                gi = denoised as unknown as ReturnType<
                    typeof vec4
                >;
                const noise = (denoised as unknown as { noiseNode: { value: THREE.Texture } })
                    .noiseNode.value;
                this._trackEffectTexture(
                    'denoise.ssgi-noise',
                    noise,
                    64,
                    64,
                    'rgba8unorm',
                );
            }
            rgb = beauty.rgb.mul(aoTexture.r).add(diffuse.rgb.mul(gi.rgb));
            const privatePass = giPass as unknown as {
                _ssgiRenderTarget: THREE.RenderTarget;
            };
            if (!privatePass._ssgiRenderTarget)
                throw new Error('Pinned SSGINode render-target shape changed.');
            this._pinEffectResolution(giPass as unknown as EffectUpdateNode);
            privatePass._ssgiRenderTarget.textures.forEach((effectTexture, index) =>
                this._trackEffectTexture(`ssgi.attachment-${index}`, effectTexture),
            );
        }

        if (combined || isolated === 'ssr') {
            const material =
                isolated === 'ssr'
                    ? scenePass.getTextureNode('material')
                    : scenePass.getTextureNode('diffuse');
            const rough = isolated === 'ssr' ? material.g : normal.a;
            const metal = isolated === 'ssr' ? material.r : material.a;
            const reflection = ssr(beauty, depth, normal as never, {
                stochastic: false,
                metalnessNode: metal,
                roughnessNode: rough,
                camera: effect.camera,
            });
            const privateSsr = reflection as unknown as SsrPrivateNode & {
                _ssrRenderTarget: THREE.RenderTarget;
            };
            if (!privateSsr._noiseIndex || !privateSsr._ssrRenderTarget)
                throw new Error('Pinned SSRNode private shape changed.');
            this._effectSsrNodes.push(privateSsr);
            this._pinEffectResolution(reflection as unknown as EffectUpdateNode);
            this._trackEffectTexture('ssr.base', privateSsr._ssrRenderTarget.texture);
            const blurTarget = (
                reflection as unknown as { _blurRenderTarget?: THREE.RenderTarget }
            )._blurRenderTarget;
            if (!blurTarget) throw new Error('Pinned SSRNode._blurRenderTarget shape changed.');
            this._trackEffectTexture('ssr.blur-mips', blurTarget.texture);
            const reflectionTexture = (
                reflection as unknown as { getTextureNode(): unknown }
            ).getTextureNode();
            const filteredNode = seededDenoise(
                reflectionTexture,
                depth,
                normal,
                effect.camera,
            );
            const filtered = filteredNode as unknown as ReturnType<typeof vec4>;
            const noise = (filteredNode as unknown as { noiseNode: { value: THREE.Texture } })
                .noiseNode.value;
            this._trackEffectTexture('denoise.ssr-noise', noise, 64, 64, 'rgba8unorm');
            rgb = rgb.add(filtered.rgb);
        }

        this._effectMaterial.colorNode = vec4(rgb, beauty.a);
        this._effectMaterial.needsUpdate = true;
        const depthTexture = scenePass.renderTarget.depthTexture;
        const velocityTexture = scenePass.getTexture('velocity');
        if (!depthTexture || !velocityTexture)
            throw new Error('Effect graph did not expose depth and velocity textures.');
        scenePass.renderTarget.textures.forEach((effectTexture, index) =>
            this._trackEffectTexture(`scene-mrt.attachment-${index}`, effectTexture),
        );
        this._trackEffectTexture('scene-mrt.depth', depthTexture, undefined, undefined, 'depth32float');
        this._trackEffectTexture('scene-mrt.velocity', velocityTexture);
        this._trackEffectTexture('effect.intermediate', this._renderTarget!.texture);
        this._trackEffectTexture(
            'resolver.output',
            this.resolver.outputTexture as THREE.Texture,
            this.resolver.displayWidth,
            this.resolver.displayHeight,
        );
    }

    private _pinEffectResolution(node: EffectUpdateNode): void {
        if (typeof node.setSize !== 'function' || typeof node.updateBefore !== 'function')
            throw new Error('Pinned effect sizing shape changed.');
        const width = this.resolver.renderWidth;
        const height = this.resolver.renderHeight;
        const originalUpdate = node.updateBefore;
        node.setSize(width, height);
        node.updateBefore = function updateAtResolverResolution(frame: unknown): void {
            const renderer = (frame as { renderer?: THREE.WebGPURenderer }).renderer;
            if (!renderer || typeof renderer.getDrawingBufferSize !== 'function')
                throw new Error('Pinned effect NodeFrame renderer shape changed.');
            const mutableRenderer = renderer as unknown as {
                getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
            };
            const originalGetDrawingBufferSize = mutableRenderer.getDrawingBufferSize;
            mutableRenderer.getDrawingBufferSize = (target: THREE.Vector2): THREE.Vector2 =>
                target.set(width, height);
            try {
                originalUpdate.call(node, frame);
            } finally {
                mutableRenderer.getDrawingBufferSize = originalGetDrawingBufferSize;
            }
        };
    }

    private _trackEffectTexture(
        name: string,
        textureValue: THREE.Texture | (() => THREE.Texture),
        width = this.resolver.renderWidth,
        height = this.resolver.renderHeight,
        format?: GPUTextureFormat,
    ): void {
        this._effectTextures.push({ name, texture: textureValue, width, height, format });
    }

    private _rawTexture(textureValue: THREE.Texture): GPUTexture | null {
        const backend = this._renderer.backend as unknown as {
            get(texture: THREE.Texture): { texture?: GPUTexture } | undefined;
        };
        return backend.get(textureValue)?.texture ?? null;
    }

    private _assertTexture(expectation: TextureExpectation): void {
        const textureValue =
            typeof expectation.texture === 'function'
                ? expectation.texture()
                : expectation.texture;
        const raw = this._rawTexture(textureValue);
        if (!raw) throw new Error(`GPU texture ${expectation.name} is not backed.`);
        if (raw.width !== expectation.width || raw.height !== expectation.height)
            throw new Error(
                `GPU texture ${expectation.name} is ${raw.width}x${raw.height}; ` +
                    `expected ${expectation.width}x${expectation.height}.`,
            );
        if (expectation.format && raw.format !== expectation.format)
            throw new Error(
                `GPU texture ${expectation.name} uses ${raw.format}; expected ${expectation.format}.`,
            );
    }

    private _assertDispatchTextures(
        color: THREE.Texture,
        depth: THREE.Texture | undefined,
        velocityTexture: THREE.Texture | undefined,
        reactive: THREE.Texture | undefined,
    ): void {
        const width = this.resolver.renderWidth;
        const height = this.resolver.renderHeight;
        this._assertTexture({ name: 'dispatch.color', texture: color, width, height });
        if (depth)
            this._assertTexture({ name: 'dispatch.depth', texture: depth, width, height });
        if (velocityTexture)
            this._assertTexture({
                name: 'dispatch.velocity',
                texture: velocityTexture,
                width,
                height,
            });
        if (reactive)
            this._assertTexture({ name: 'dispatch.reactive', texture: reactive, width, height });
        this._assertTexture({
            name: 'resolver.output',
            texture: this.resolver.outputTexture as THREE.Texture,
            width: this.resolver.displayWidth,
            height: this.resolver.displayHeight,
        });
    }

    /**
     * Renders deterministic scene inputs without dispatching or presenting.
     * @param scene - Scene to render
     * @param camera - Scene camera
     * @param reactiveScene - Optional Q5 particle-coverage scene
     */
    renderInput(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        reactiveScene?: THREE.Scene,
    ): void {
        const rt = this._renderTarget;
        if (!rt) return;
        const temporal = this._mode === 'upscale-temporal';

        //* Scene Pass (jittered when temporal)
        this.resolver.beginFrame(camera);
        if (this._effectPass) {
            this._renderer.setMRT(null);
            this._renderer.setRenderTarget(rt);
            this._effectQuad.render(this._renderer);
            this._renderer.setRenderTarget(null);
            this.resolver.endFrame(camera);
            return;
        }
        // The MRT output count MUST match the render target's attachment count:
        // rendering into a count:2 target without the velocity output leaves
        // color attachment 0 unwritten (black). Non-temporal modes therefore
        // use a single-output MRT into a count:1 target (see configure()).
        this._renderer.setMRT(temporal ? this._mrtNode : this._mrtOutputOnly);
        this._renderer.setRenderTarget(rt);
        this._renderer.render(scene, camera);
        this._renderer.setRenderTarget(null);
        this._renderer.setMRT(null);

        //* Optional Q5 Reactive Coverage
        if (reactiveScene && this._reactiveTarget) {
            const autoClear = this._renderer.autoClear;
            this._renderer.autoClear = false;
            this._renderer.setMRT(this._mrtOutputOnly);
            this._renderer.setRenderTarget(this._reactiveTarget);
            this._renderer.clear(true, true, false);

            // Populate an opaque-only depth attachment first. Particles live on
            // layer 1, so the manual coverage pass cannot flag occluded volume.
            const overrideMaterial = scene.overrideMaterial;
            const background = scene.background;
            const cameraLayerMask = camera.layers.mask;
            scene.overrideMaterial = this._depthOnlyMaterial;
            scene.background = null;
            camera.layers.disable(1);
            this._renderer.render(scene, camera);
            scene.overrideMaterial = overrideMaterial;
            scene.background = background;
            camera.layers.mask = cameraLayerMask;
            this._renderer.render(reactiveScene, camera);
            this._renderer.setRenderTarget(null);
            this._renderer.setMRT(null);
            this._renderer.autoClear = autoClear;
        }
        this.resolver.endFrame(camera);
    }

    /**
     * Dispatches the active resolver against the most recent input render.
     * @param camera - Camera used for input rendering
     * @param deltaTime - Fixed or interactive timestep
     * @param frameTag - Deterministic frame identity for fresh timing
     */
    dispatchResolver(
        camera: THREE.PerspectiveCamera,
        deltaTime: number,
        frameTag: number,
    ): void {
        const rt = this._renderTarget;
        if (!rt) return;
        const temporal = this._mode === 'upscale-temporal';
        const effectDepth = this._effectPass?.renderTarget.depthTexture ?? undefined;
        const effectVelocity = this._effectPass?.getTexture('velocity');
        const color = rt.textures[0];
        const depth = effectDepth ?? rt.depthTexture ?? undefined;
        const velocityTexture = this._effectPass
            ? effectVelocity
            : temporal
              ? rt.textures[1]
              : undefined;
        const reactive = this._reactiveTarget?.textures[0];
        this._assertDispatchTextures(color, depth, velocityTexture, reactive);
        this.resolver.dispatch(
            {
                color,
                depth,
                velocity: velocityTexture,
                reactive,
                deltaTime,
                frameTag,
            },
            camera,
        );
    }

    /** Presents the resolver output without another transfer transform. */
    present(): void {
        this._quad.render(this._renderer);
    }

    /** Advances the pinned NodeFrame exactly once for one automated frame. */
    advanceAutomatedFrame(frame: number): void {
        const nodeFrame = this._nodeFrame();
        if (nodeFrame.frameId !== frame)
            throw new Error(
                `Pinned NodeFrame expected frameId ${frame} before update; got ${nodeFrame.frameId}.`,
            );
        nodeFrame.update();
        nodeFrame.time = (frame + 1) / 60;
        nodeFrame.deltaTime = 1 / 60;
        nodeFrame.lastTime = performance.now();
    }

    /**
     * Compiles and allocates the selected effect graph before recorded frame zero.
     * @param camera - Effect scenario camera
     */
    async prepareEffectReadiness(camera: THREE.PerspectiveCamera): Promise<void> {
        if (!this._effectScenario) return;
        const backend = this._renderer.backend as unknown as {
            device?: GPUDevice;
            get(texture: THREE.Texture): { texture?: GPUTexture } | undefined;
        };
        if (!backend.device || typeof backend.device.queue?.onSubmittedWorkDone !== 'function')
            throw new Error('Pinned WebGPU backend device shape changed.');
        const nodes = this._nodeManager();
        this._resetEffectState(camera);
        this._resetNodeFrame(0);

        let ready = false;
        for (let readinessFrame = 0; readinessFrame < 180; readinessFrame++) {
            this.advanceAutomatedFrame(readinessFrame);
            this.renderInput(this._effectScenario.scene, camera);
            this.dispatchResolver(camera, 1 / 60, -1 - readinessFrame);
            this.present();
            await backend.device.queue.onSubmittedWorkDone();
            try {
                this._effectTextures.forEach((expectation) => this._assertTexture(expectation));
                ready = nodes._buildQueue.length === 0 && nodes._buildInProgress === false;
            } catch {
                ready = false;
            }
            if (ready) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!ready) throw new Error('Effect graph readiness barrier timed out.');

        await this.drainTiming();
        this.reset(this._effectScenario.scene, camera);
    }

    private _nodeManager(): {
        nodeFrame: NodeFrameBridge;
        _buildQueue: unknown[];
        _buildInProgress: boolean;
    } {
        const nodes = (this._renderer as unknown as { _nodes?: unknown })._nodes as {
            nodeFrame?: NodeFrameBridge;
            _buildQueue?: unknown[];
            _buildInProgress?: boolean;
        };
        if (
            !nodes?.nodeFrame ||
            !Array.isArray(nodes._buildQueue) ||
            typeof nodes._buildInProgress !== 'boolean'
        )
            throw new Error('Pinned renderer._nodes readiness shape changed.');
        return nodes as {
            nodeFrame: NodeFrameBridge;
            _buildQueue: unknown[];
            _buildInProgress: boolean;
        };
    }

    private _nodeFrame(): NodeFrameBridge {
        const nodeFrame = this._nodeManager().nodeFrame;
        if (
            !(nodeFrame.updateMap instanceof WeakMap) ||
            !(nodeFrame.updateBeforeMap instanceof WeakMap) ||
            !(nodeFrame.updateAfterMap instanceof WeakMap) ||
            typeof nodeFrame.update !== 'function'
        )
            throw new Error('Pinned NodeFrame mutable shape changed.');
        return nodeFrame;
    }

    private _resetEffectState(camera: THREE.PerspectiveCamera): void {
        if (!this._effectScenario) return;
        for (const ssrNode of this._effectSsrNodes) {
            if (!ssrNode._noiseIndex || typeof ssrNode._noiseIndex.value !== 'number')
                throw new Error('Pinned SSRNode._noiseIndex shape changed.');
            ssrNode._noiseIndex.value = 0;
        }
        if (this._effectScenario.id === 'Q8')
            for (const sizedNode of this._effectSizedNodes) {
                if (typeof sizedNode.setSize !== 'function')
                    throw new Error('Pinned recurrent effect setSize shape changed.');
                sizedNode.setSize(1, 1);
            }

        for (const temporalNode of this._effectTemporalNodes) {
            const candidate = temporalNode as {
                _cameraUniforms?: { updateFromCamera(cameraValue: THREE.Camera): void };
                _noiseIndex?: { value: number };
            };
            if (candidate._cameraUniforms) {
                if (typeof candidate._cameraUniforms.updateFromCamera !== 'function')
                    throw new Error('Pinned temporal camera-uniform shape changed.');
                candidate._cameraUniforms.updateFromCamera(camera);
                candidate._cameraUniforms.updateFromCamera(camera);
            }
            if (candidate._noiseIndex) candidate._noiseIndex.value = 0;
        }
    }

    private _resetNodeFrame(frame: number): void {
        const nodeFrame = this._nodeFrame();
        nodeFrame.frameId = frame;
        nodeFrame.renderId = 0;
        nodeFrame.time = frame / 60;
        nodeFrame.deltaTime = 0;
        nodeFrame.lastTime = performance.now();
        nodeFrame.updateMap = new WeakMap();
        nodeFrame.updateBeforeMap = new WeakMap();
        nodeFrame.updateAfterMap = new WeakMap();
    }

    private _seedVelocityHistory(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
    ): void {
        const velocityNode = velocity as unknown as {
            update(frame: {
                frameId: number;
                camera: THREE.Camera;
                object: THREE.Object3D;
            }): void;
            updateAfter(frame: { object: THREE.Object3D }): void;
        };
        if (
            typeof velocityNode.update !== 'function' ||
            typeof velocityNode.updateAfter !== 'function'
        )
            throw new Error('Pinned VelocityNode reset bridge shape changed.');

        scene.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        const objects: THREE.Object3D[] = [];
        scene.traverseVisible((object) => {
            if (
                (object as THREE.Mesh).isMesh ||
                (object as THREE.Line).isLine ||
                (object as THREE.Points).isPoints
            )
                objects.push(object);
        });
        for (let passIndex = 0; passIndex < 2; passIndex++) {
            const frameId = this._velocitySeedFrame--;
            for (const object of objects) {
                velocityNode.update({ frameId, camera, object });
                velocityNode.updateAfter({ object });
            }
        }
    }

    /**
     * Interactive convenience preserving the original one-call lifecycle.
     * @param scene - Scene to render
     * @param camera - Scene camera
     * @param deltaTime - Seconds since the previous frame
     * @param frameTag - Optional interactive frame tag
     */
    render(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        deltaTime: number,
        frameTag = 0,
    ): void {
        this.renderInput(scene, camera);
        this.dispatchResolver(camera, deltaTime, frameTag);
        this.present();
    }

    /** Waits until a fresh timing slot can accept another frame. */
    prepareTiming(): Promise<void> {
        return this.resolver.waitForTimingCapacity();
    }

    /** Drains all pending timestamp-query readbacks. */
    drainTiming(): Promise<void> {
        return this.resolver.drainTiming();
    }

    /** Returns fresh timing samples collected since the last take/reset. */
    takeTimingSamples(): BenchmarkGpuFrameSample[] {
        return this.resolver.takeTimingSamples();
    }

    /**
     * Clears all temporal state and reseeds three's velocity history.
     * @param scene - Scene at the reset event's absolute transforms
     * @param camera - Camera at the reset event's absolute transform
     * @param frame - Declared scenario frame retained by event resets
     */
    reset(scene?: THREE.Scene, camera?: THREE.PerspectiveCamera, frame = 0): void {
        this.resolver.reset();
        this._resetNodeFrame(frame);
        if (camera) this._resetEffectState(camera);
        const activeScene = this._effectScenario?.scene ?? scene;
        if (activeScene && camera) {
            (
                this.resolver.unjitteredProjectionMatrix as THREE.Matrix4
            ).copy(camera.projectionMatrix);
            this._seedVelocityHistory(activeScene, camera);
        }
    }

    /** Applies runtime settings from the UI (no reconfigure needed). */
    applySettings(settings: {
        sharpness: number;
        rcasDenoise: boolean;
        maxAccumulation: number;
        exposure: number;
        autoExposure: boolean;
        lockThinFeatures: boolean;
        detectShadingChanges: boolean;
        debugView: DebugView;
    }): void {
        Object.assign(this.resolver.settings, settings);
        // Debug buffers are already normalized visualization colors; only the
        // final linear/HDR result should pass through presentation tone mapping.
        this._quadMaterial.toneMapped = settings.debugView === DebugView.None;
    }

    dispose(): void {
        this._effectPass?.dispose();
        this._renderTarget?.dispose();
        this._reactiveTarget?.dispose();
        this._quadMaterial.dispose();
        this._effectMaterial.dispose();
        this._depthOnlyMaterial.dispose();
        this.resolver.dispose();
    }
}
