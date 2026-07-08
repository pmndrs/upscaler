import { Vector2, type Texture } from 'three';
import { NodeUpdateType, TempNode, type WebGPURenderer } from 'three/webgpu';
import { convertToTexture, mrt, nodeObject, output, pass, passTexture, velocity } from 'three/tsl';

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
    /**
     * Apply the sub-pixel camera jitter (temporal path). Jitter is what buys
     * *reconstruction* (detail beyond render res), but it requires the input to
     * be re-rendered under the jittered projection every frame — see
     * {@link FSRConfig.jitter} for the full why.
     *
     * Defaults differ by entry point, because they differ in whether they
     * control the render:
     * - {@link fsrScene} → **on**. It builds and renders the scene pass itself,
     *   in-graph, so the jitter always lands — free reconstruction.
     * - {@link fsr3} → **off**. It consumes whatever texture you give it; it
     *   can't guarantee that texture is re-rendered under the jitter, so the safe
     *   default is a non-jittered temporal upscale (still reprojects, denoises,
     *   and accumulates — just no smear risk). Turn it **on** only when your
     *   inputs render in-graph under this node (e.g. a `pass()` you hand it that
     *   the post render drives).
     */
    jitter?: boolean;
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
 * For the plain "just upscale my scene" case, use {@link fsrScene} — it wraps
 * this node around a scene pass for you.
 *
 * **How the inputs render.** Like three's own `FSR1Node` / `TAAUNode`, the input
 * nodes are registered as graph dependencies (in `setup`), so three renders them
 * in dependency order *inside* the post-processing render, right before this
 * node's `updateBefore` runs the FSR compute. Two things follow from that:
 * 1. You don't render the inputs yourself — hand this node a node chain (a scene
 *    pass, or `denoise(ssgi(…))`) and three drives it. The chain must ultimately
 *    reach this node (i.e. be part of `post.outputNode`), which it is by
 *    construction.
 * 2. Sub-pixel jitter is applied via the render-pipeline hook (like `TAAUNode`)
 *    *before the pipeline renders*, and because the inputs render in-pipeline the
 *    jitter lands on them — no manual jitter plumbing. (An imperative pipeline
 *    that composites into a low-res target *outside* the post render still wants
 *    the raw {@link FSR3Upscaler}; see `examples/06-screenspace-gi`.)
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
    // Composable node defaults to non-jittered (safe for any input); fsrScene
    // opts in via options.jitter. See FSR3NodeOptions.jitter for the why.
    private readonly _jitter: boolean;

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
        this._jitter = options.jitter ?? false;
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
            // When we jitter, motion vectors must stay jitter-free — feed the
            // velocity node the upscaler's (stable) unjittered projection. When
            // we don't jitter, the camera projection is already jitter-free, so
            // the velocity node needs no compensation.
            if (this._jitter) {
                velocity.setProjectionMatrix(this._upscaler.unjitteredProjectionMatrix);
            }
        }

        // Register the inputs as graph dependencies so three renders them in
        // dependency order, in-pipeline, before this node's updateBefore. Our
        // fields are `_`-prefixed, which three's automatic child discovery
        // (Node._getChildren) skips — so we register them explicitly, exactly as
        // FSR1Node does with `properties.textureNode`. Without this the input
        // passes are never built → never rendered → black output. depth/velocity
        // are optional (a non-jittered spatial upscale needs neither).
        const props = builder.getNodeProperties(this);
        props.colorNode = this._color;
        if (this._depth) props.depthNode = this._depth;
        if (this._velocity) props.velocityNode = this._velocity;

        // Apply the sub-pixel jitter before the input passes render — same hook
        // three's TAAUNode uses. Only installed when jittering: the hook is
        // pointless (and the camera offset undesirable) otherwise.
        const renderPipeline = builder.context?.renderPipeline;
        if (this._jitter && renderPipeline) {
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
            jitter: this._jitter,
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
        if (!color) return;
        // The temporal path reprojects history, so it needs depth + velocity
        // (jittered or not). The spatial path needs only color.
        const isTemporal = (this._options.path ?? 'temporal') === 'temporal';
        const depth = this._depth ? this._texture(this._depth) : null;
        const velocityTex = this._velocity ? this._texture(this._velocity) : null;
        if (isTemporal && (!depth || !velocityTex)) return;

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
            {
                color,
                depth: depth ?? undefined,
                velocity: velocityTex ?? undefined,
                deltaTime: dt,
            },
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
    // Materialize the (possibly composited) color into a texture — same as
    // FSR1/TAAU do with their beauty input. depth/velocity are already pass
    // texture nodes, so they pass through untouched (matching TAAUNode).
    nodeObject(new FSR3Node(convertToTexture(color), depth, velocityNode, camera, options));

/**
 * Convenience for the plain "upscale my scene" case: builds a reduced-resolution
 * scene pass (color + jitter-free velocity MRT) and hands it to the composable
 * {@link fsr3} node — the same shape as three's `taau(pass.getTextureNode(…), …)`
 * factory. So it's a thin wrapper, not a separate code path: the scene renders
 * in-graph as an FSR3 input, jitter and all.
 *
 * ```ts
 * post.outputNode = fsrScene(scene, camera, { quality: FSRQualityMode.Quality });
 * ```
 *
 * For an effect pipeline as the input (SSGI etc.), compose {@link fsr3} directly
 * against your own reduced-res passes — see `examples/09-kitchen-sink`.
 *
 * @param scene - Scene to render at reduced resolution and upscale
 * @param camera - Scene camera
 * @param options - Quality / ratio / path (see {@link FSR3NodeOptions})
 * @returns A TSL node whose value is the upscaled, display-ready texture
 */
export const fsrScene = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scene: any,
    camera: CameraLike,
    options: FSR3NodeOptions = {},
): ReturnType<typeof nodeObject> => {
    const ratio = options.ratio ?? getQualityModeRatio(options.quality ?? FSRQualityMode.Quality);

    //* Render the scene at 1/ratio with a color + velocity MRT — the two inputs
    //* FSR3's temporal path needs (depth is the pass's own depth buffer). The
    //* `velocity` node is the shared TSL singleton whose projection the upscaler
    //* pins to its unjittered matrix each frame, so motion vectors stay jitter-free.
    const scenePass = pass(scene, camera as never);
    scenePass.setMRT(mrt({ output, velocity }));
    scenePass.setResolutionScale(1 / ratio);

    return fsr3(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera, {
        // fsrScene owns the render (the pass renders in-graph under this node),
        // so the jitter always lands — opt into it for free reconstruction
        // unless the caller explicitly overrode it.
        jitter: true,
        ...options,
    });
};
