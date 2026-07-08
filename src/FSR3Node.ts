import { Vector2, type Texture } from 'three';
import { NodeUpdateType, TempNode, type WebGPURenderer } from 'three/webgpu';
import { nodeObject, passTexture, velocity } from 'three/tsl';

import { FSR3Pass } from './FSR3Pass';
import { FSR3Upscaler } from './FSR3Upscaler';
import { getGPUTexture } from './internal/threeWebGPU';
import { getQualityModeRatio } from './math/resolution';
import { FSRQualityMode, type FSRUpscalePath } from './types';

// three's node base + its builder/frame carry incomplete TS types and expect a
// WebGPURenderer the public d.ts only types as `Renderer`, so setup()/
// updateBefore() take `any` and cast — the runtime contract follows three's own
// display nodes (TAAUNode).
type CameraLike = { isCamera?: boolean };
// A TSL node whose backing texture we can reach (a pass/texture node).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextureNodeLike = any;

/** Options for {@link fsr3} / {@link fsrScene}. */
export interface FSR3NodeOptions {
    /** Which FSR path to run. Defaults to `'temporal'`. */
    path?: FSRUpscalePath;
    /** Quality preset — only used by {@link fsrScene} to size its scene pass. */
    quality?: FSRQualityMode;
    /** Explicit upscale ratio — only used by {@link fsrScene} (overrides quality). */
    ratio?: number;
}

/**
 * FSR3 as a TSL node for `THREE.PostProcessing` graphs — the composable
 * drop-in. It consumes the **already reduced-resolution** color, depth, and
 * (jitter-free) velocity of your render as texture nodes, and outputs the
 * upscaled result — so it slots anywhere in a post graph, including on top of an
 * effect pipeline (GTAO / SSR / SSGI composited at low res):
 *
 * ```ts
 * const scenePass = pass(scene, camera);
 * scenePass.setResolutionScale(0.5);            // render small
 * const gi = denoise(ssgi(scenePass.getTextureNode('output'), …));
 * // composite `gi` into a reduced-res color texture, then:
 * post.outputNode = fsr3(giColor, scenePass.getTextureNode('depth'),
 *                        scenePass.getTextureNode('velocity'), camera);
 * ```
 *
 * For the plain "just upscale my scene" case, use {@link fsrScene} — it owns
 * the render, so its jitter is always correct.
 *
 * **Advanced — read this.** This composable form does *not* render its inputs;
 * it consumes the textures you give it. Two consequences:
 * 1. Something else must actually render those input passes each frame (they are
 *    not shader-graph dependencies of this node). The node no-ops on a frame
 *    where the input textures aren't GPU-backed yet.
 * 2. Sub-pixel jitter is applied via the render-pipeline hook (like `TAAUNode`)
 *    *before the pipeline renders*. For that jitter to land on your input, the
 *    input passes must render **inside** the post-processing render (not earlier
 *    in your own loop). For an imperative pipeline where you control the render
 *    order (composite SSGI into a low-res target yourself), drive
 *    {@link FSR3Upscaler} directly instead — you get full jitter control and it
 *    is the proven path (see `examples/06-screenspace-gi`).
 *
 * Present the result untouched — set `renderer.toneMapping = NoToneMapping` and
 * `renderer.outputColorSpace = LinearSRGBColorSpace` (the examples' bootRenderer
 * does this) so the PostProcessing output transform is identity.
 */
export class FSR3Node extends TempNode {
    readonly isFSR3Node = true;

    private readonly _color: TextureNodeLike;
    private readonly _depth: TextureNodeLike;
    private readonly _velocity: TextureNodeLike;
    private readonly _camera: CameraLike;
    private readonly _options: FSR3NodeOptions;

    private readonly _output = new Vector2();
    private readonly _input = new Vector2();

    private _renderer: WebGPURenderer | null = null;
    private _upscaler: FSR3Upscaler | null = null;
    private _configured = false;
    private _textureNode: ReturnType<typeof passTexture> | null = null;
    private _lastTime = 0;

    constructor(
        colorNode: TextureNodeLike,
        depthNode: TextureNodeLike,
        velocityNode: TextureNodeLike,
        camera: CameraLike,
        options: FSR3NodeOptions = {},
    ) {
        super('vec4');
        (this as unknown as { updateBeforeType: unknown }).updateBeforeType = NodeUpdateType.FRAME;
        this._color = colorNode;
        this._depth = depthNode;
        this._velocity = velocityNode;
        this._camera = camera;
        this._options = options;
    }

    /** The underlying upscaler — inspect `.settings`, `.gpuTimings`, etc. */
    get upscaler(): FSR3Upscaler | null {
        return this._upscaler;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(builder: any): any {
        const renderer = builder.renderer as WebGPURenderer;
        this._renderer = renderer;
        if (!this._upscaler) {
            this._upscaler = new FSR3Upscaler({ renderer });
            this._upscaler.init();
            // Motion vectors must be jitter-free — feed the velocity node the
            // upscaler's (stable) unjittered projection.
            velocity.setProjectionMatrix(this._upscaler.unjitteredProjectionMatrix);
        }

        // Apply the sub-pixel jitter before the input passes render — same hook
        // three's TAAUNode uses. The upscaler's beginFrame/endFrame do the
        // setViewOffset + unjittered-projection snapshot.
        const renderPipeline = builder.context?.renderPipeline;
        if (renderPipeline) {
            renderPipeline.context.onBeforeRenderPipeline = () => {
                if (this._configured) this._upscaler!.beginFrame(this._camera as never);
            };
            renderPipeline.context.onAfterRenderPipeline = () => {
                if (this._configured) this._upscaler!.endFrame(this._camera as never);
            };
        }

        // Seed a configuration so outputTexture exists for passTexture; the real
        // input size is picked up in updateBefore once the passes have rendered.
        if (!this._configured) {
            renderer.getDrawingBufferSize(this._output);
            const ratio = this._options.ratio ??
                getQualityModeRatio(this._options.quality ?? FSRQualityMode.Quality);
            this._input.set(Math.max(1, this._output.x / ratio), Math.max(1, this._output.y / ratio));
            this._configureUpscaler();
        }
        if (!this._textureNode) {
            this._textureNode = passTexture(this as never, this._upscaler.outputTexture);
        }
        return this._textureNode;
    }

    private _configureUpscaler(): void {
        this._upscaler!.configure({
            displayWidth: Math.max(1, Math.round(this._output.x)),
            displayHeight: Math.max(1, Math.round(this._output.y)),
            renderWidth: Math.max(1, Math.round(this._input.x)),
            renderHeight: Math.max(1, Math.round(this._input.y)),
            path: this._options.path,
        });
        this._configured = true;
        if (this._textureNode) {
            (this._textureNode as unknown as { value: unknown }).value = this._upscaler!.outputTexture;
        }
    }

    /** Resolves the three `Texture` behind a pass/texture node. */
    private _texture(node: TextureNodeLike): Texture | null {
        return (
            node?.value ??
            node?.renderTarget?.texture ??
            node?.passNode?.renderTarget?.texture ??
            null
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateBefore(frame: any): any {
        const renderer = frame.renderer as WebGPURenderer;
        if (!this._upscaler) return;

        const color = this._texture(this._color);
        const depth = this._texture(this._depth);
        const velocityTex = this._texture(this._velocity);
        if (!color || !depth || !velocityTex) return;

        // Exact input size from the GPU texture (throws until it's backed).
        let gpu: GPUTexture;
        try {
            gpu = getGPUTexture(renderer, color);
        } catch {
            return; // pass textures not GPU-backed yet (async compile)
        }

        renderer.getDrawingBufferSize(this._output);
        const outputChanged =
            Math.round(this._output.x) !== this._upscaler.displayWidth ||
            Math.round(this._output.y) !== this._upscaler.displayHeight;
        const inputChanged =
            gpu.width !== this._upscaler.renderWidth || gpu.height !== this._upscaler.renderHeight;
        if (outputChanged || inputChanged) {
            this._input.set(gpu.width, gpu.height);
            this._configureUpscaler();
        }

        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        const dt = this._lastTime ? Math.min((now - this._lastTime) / 1000, 0.1) : 1 / 60;
        this._lastTime = now;

        this._upscaler.dispatch(
            { color, depth, velocity: velocityTex, deltaTime: dt },
            this._camera as never,
        );
    }

    dispose(): void {
        this._upscaler?.dispose();
        super.dispose();
    }
}

/**
 * Creates a composable {@link FSR3Node} from reduced-resolution input nodes.
 * @param color - Reduced-res color texture node (your composited render)
 * @param depth - Reduced-res depth texture node (e.g. `pass.getTextureNode('depth')`)
 * @param velocity - Reduced-res jitter-free velocity texture node
 * @param camera - Scene camera (perspective or orthographic)
 * @param options - Path (see {@link FSR3NodeOptions})
 * @returns A TSL node whose value is the upscaled, display-ready texture
 */
export const fsr3 = (
    color: TextureNodeLike,
    depth: TextureNodeLike,
    velocityNode: TextureNodeLike,
    camera: CameraLike,
    options: FSR3NodeOptions = {},
): ReturnType<typeof nodeObject> =>
    nodeObject(new FSR3Node(color, depth, velocityNode, camera, options));

/**
 * The plain "upscale my scene" node — used by {@link fsrScene}. Unlike the
 * composable {@link FSR3Node}, it *owns* the render (via {@link FSR3Pass}): the
 * scene isn't a graph dependency of anything, so the node must render it itself
 * in `updateBefore` rather than expecting the pipeline to.
 */
export class FSR3SceneNode extends TempNode {
    readonly isFSR3SceneNode = true;

    private readonly _scene: { isScene?: boolean };
    private readonly _camera: CameraLike;
    private readonly _options: FSR3NodeOptions;
    private readonly _size = new Vector2();

    private _pass: FSR3Pass | null = null;
    private _textureNode: ReturnType<typeof passTexture> | null = null;
    private _lastTime = 0;

    constructor(scene: { isScene?: boolean }, camera: CameraLike, options: FSR3NodeOptions = {}) {
        super('vec4');
        (this as unknown as { updateBeforeType: unknown }).updateBeforeType = NodeUpdateType.FRAME;
        this._scene = scene;
        this._camera = camera;
        this._options = options;
    }

    /** The underlying upscaler — inspect `.settings`, `.gpuTimings`, etc. */
    get upscaler(): FSR3Upscaler | null {
        return this._pass?.upscaler ?? null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(builder: any): any {
        if (!this._pass) {
            this._pass = new FSR3Pass(builder.renderer as WebGPURenderer);
            (builder.renderer as WebGPURenderer).getDrawingBufferSize(this._size);
            this._configure();
        }
        if (!this._textureNode) {
            this._textureNode = passTexture(this as never, this._pass.outputTexture);
        }
        return this._textureNode;
    }

    private _configure(): void {
        this._pass!.configure({
            displayWidth: Math.max(1, this._size.x),
            displayHeight: Math.max(1, this._size.y),
            path: this._options.path,
            quality: this._options.quality ?? FSRQualityMode.Quality,
            ratio: this._options.ratio,
        });
        if (this._textureNode) {
            (this._textureNode as unknown as { value: unknown }).value = this._pass!.outputTexture;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateBefore(frame: any): any {
        const renderer = frame.renderer as WebGPURenderer;
        if (!this._pass) return;
        const size = renderer.getDrawingBufferSize(new Vector2());
        if (size.x !== this._size.x || size.y !== this._size.y) {
            this._size.copy(size);
            this._configure();
        }
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        const dt = this._lastTime ? Math.min((now - this._lastTime) / 1000, 0.1) : 1 / 60;
        this._lastTime = now;
        this._pass.draw(this._scene as never, this._camera as never, dt);
    }

    dispose(): void {
        this._pass?.dispose();
        super.dispose();
    }
}

/**
 * Convenience for the plain "upscale my scene" case — the node renders a
 * reduced-resolution scene pass itself and outputs the upscaled result:
 *
 * ```ts
 * post.outputNode = fsrScene(scene, camera, { quality: FSRQualityMode.Quality });
 * ```
 *
 * For an effect pipeline as the input (SSGI etc.), use the composable
 * {@link fsr3} instead.
 *
 * @param scene - Scene to render at reduced resolution and upscale
 * @param camera - Scene camera
 * @param options - Quality / ratio / path (see {@link FSR3NodeOptions})
 * @returns A TSL node whose value is the upscaled, display-ready texture
 */
export const fsrScene = (
    scene: { isScene?: boolean },
    camera: CameraLike,
    options: FSR3NodeOptions = {},
): ReturnType<typeof nodeObject> => nodeObject(new FSR3SceneNode(scene, camera, options));
