import { Vector2 } from 'three';
import { NodeUpdateType, TempNode, type WebGPURenderer } from 'three/webgpu';
import { nodeObject, passTexture } from 'three/tsl';

import { FSR3Pass } from './FSR3Pass';
import { FSRQualityMode, type FSRUpscalePath } from './types';

// three's node base (TempNode) + its builder/frame carry incomplete TS types
// and expect a WebGPURenderer that the public d.ts types only as `Renderer`, so
// setup()/updateBefore() take `any` and cast internally — the runtime contract
// follows three's own display nodes (e.g. TAAUNode).
type SceneLike = { isScene?: boolean };
type CameraLike = { isCamera?: boolean };

/** Options for {@link fsr3} / {@link FSR3Node}. */
export interface FSR3NodeOptions {
    /** Which FSR path to run. Defaults to `'temporal'`. */
    path?: FSRUpscalePath;
    /** Quality preset (render-resolution ratio). Ignored if `ratio` is set. */
    quality?: FSRQualityMode;
    /** Explicit upscale ratio (overrides `quality`). `1` = render at display res. */
    ratio?: number;
    /** See {@link FSR3Pass} — set false when several passes share one renderer. */
    shareVelocityMatrix?: boolean;
}

/**
 * FSR3 as a TSL node for `THREE.PostProcessing` graphs — the declarative
 * drop-in. It owns the low-res jittered scene render + the FSR compute passes
 * (via {@link FSR3Pass}) and outputs the upscaled result as a texture node:
 *
 * ```ts
 * const post = new THREE.PostProcessing(renderer);
 * post.outputNode = fsr3(scene, camera, { quality: FSRQualityMode.Quality });
 * // per frame: post.render();
 * ```
 *
 * The FSR output is already display-referred sRGB, so present it untouched: set
 * `renderer.toneMapping = NoToneMapping` and `renderer.outputColorSpace =
 * LinearSRGBColorSpace` (the examples' `bootRenderer` does this) — then the
 * PostProcessing output transform is identity and the node passes its texture
 * straight through. For a low-res *composited* input (e.g. a TSL GI graph)
 * rather than a plain scene, drive {@link FSR3Upscaler} directly instead — this
 * node owns the scene render itself, like three's `TAAUNode`.
 */
export class FSR3Node extends TempNode {
    readonly isFSR3Node = true;

    private readonly _scene: SceneLike;
    private readonly _camera: CameraLike;
    private readonly _options: FSR3NodeOptions;
    private readonly _size = new Vector2();

    private _pass: FSR3Pass | null = null;
    private _textureNode: ReturnType<typeof passTexture> | null = null;
    private _lastTime = 0;

    constructor(scene: SceneLike, camera: CameraLike, options: FSR3NodeOptions = {}) {
        super('vec4');
        (this as unknown as { updateBeforeType: unknown }).updateBeforeType = NodeUpdateType.FRAME;
        this._scene = scene;
        this._camera = camera;
        this._options = options;
    }

    /** The underlying pass — inspect `.upscaler.settings`, `.gpuTimings`, etc. */
    get pass(): FSR3Pass | null {
        return this._pass;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(builder: any): any {
        if (!this._pass) {
            const renderer = builder.renderer as WebGPURenderer;
            this._pass = new FSR3Pass(renderer, {
                shareVelocityMatrix: this._options.shareVelocityMatrix,
            });
            renderer.getDrawingBufferSize(this._size);
            this._configure();
        }
        if (!this._textureNode) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._textureNode = passTexture(this as any, this._pass.outputTexture);
        }
        return this._textureNode;
    }

    private _configure(): void {
        if (!this._pass) return;
        this._pass.configure({
            displayWidth: Math.max(1, this._size.x),
            displayHeight: Math.max(1, this._size.y),
            path: this._options.path,
            quality: this._options.quality ?? FSRQualityMode.Quality,
            ratio: this._options.ratio,
        });
        if (this._textureNode) {
            (this._textureNode as unknown as { value: unknown }).value = this._pass.outputTexture;
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

        this._pass.draw(
            this._scene as never,
            this._camera as never,
            dt,
        );
    }

    dispose(): void {
        this._pass?.dispose();
        super.dispose();
    }
}

/**
 * Creates an {@link FSR3Node} for a `THREE.PostProcessing` graph.
 * @param scene - Scene to render at reduced resolution and upscale
 * @param camera - Scene camera (perspective or orthographic)
 * @param options - Path / quality / ratio (see {@link FSR3NodeOptions})
 * @returns A TSL node whose value is the upscaled, display-ready texture
 */
export const fsr3 = (
    scene: SceneLike,
    camera: CameraLike,
    options: FSR3NodeOptions = {},
): ReturnType<typeof nodeObject> => nodeObject(new FSR3Node(scene, camera, options));
