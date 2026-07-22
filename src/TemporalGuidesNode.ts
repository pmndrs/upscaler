import { DataTexture, FloatType, NearestFilter, RedFormat, Vector2 } from 'three';
import { NodeUpdateType, TempNode, type WebGPURenderer } from 'three/webgpu';
import { nodeObject, passTexture } from 'three/tsl';

import { Upscaler } from './Upscaler';
import { getGPUTexture } from './internal/threeWebGPU';
import type { TemporalGuides } from './types';

// Same typing posture as UpscalerNode: three's node builder/frame carry
// incomplete TS types, so the boundary takes `any` and casts.
type CameraLike = { isCamera?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextureNodeLike = any;
type GuideName = keyof TemporalGuides;
type GuideTextureNode = ReturnType<typeof passTexture>;

/**
 * The {@link TemporalGuides} bundle as a TSL node for `THREE.PostProcessing`
 * graphs — the upscaler's frame-property products (dilated motion/depth,
 * disocclusion, …) consumable as ordinary texture nodes, in-graph.
 *
 * Two modes, decided by how it's wired:
 *
 * **Standalone** (no upscale in the graph): the node owns a guides-only
 * {@link Upscaler} (`path: 'guides'`) sized to its depth input, and
 * `dispatchGuides` is the whole frame — no color, no jitter, no output.
 * Only the early geometry products are non-null; consuming a late product
 * (locks, history, …) warns once and samples black.
 *
 * **Linked** (`upscale(color, depth, velocity, camera, { guides })`): the
 * upscale node adopts this node's upscaler, and the frame runs split —
 * this node dispatches the early geometry stage as soon as depth+velocity
 * have rendered, effects between the two consume the guides, and the
 * upscale node finishes with `dispatchUpscale`. One reconstruct dispatch
 * serves both the effect graph and the upscale, and every product
 * (including the frame N−1 late priors) is live.
 *
 * Products are fetched with {@link getTextureNode}; ping-ponged products are
 * re-pointed automatically each frame, so the returned node is stable.
 *
 * @experimental Rides on the guides contract (TEMPORAL-GUIDES-SPEC.md),
 * which is frozen but pre-acceptance (spec M6).
 */
export class TemporalGuidesNode extends TempNode {
    readonly isTemporalGuidesNode = true;

    private readonly _depth: TextureNodeLike;
    private readonly _velocity: TextureNodeLike;
    private readonly _camera: CameraLike;

    private _upscaler: Upscaler | null = null;
    // Linked = an UpscalerNode adopted our upscaler and owns configuration
    // (temporal path); standalone = we own it on the guides-only path.
    private _linked = false;
    private readonly _guideNodes = new Map<GuideName, GuideTextureNode>();
    private readonly _warnedNull = new Set<GuideName>();
    private _placeholder: DataTexture | null = null;
    private readonly _size = new Vector2();
    private _lastTime = 0;

    constructor(depthNode: TextureNodeLike, velocityNode: TextureNodeLike, camera: CameraLike) {
        super('vec4');
        (this as unknown as { updateBeforeType: unknown }).updateBeforeType = NodeUpdateType.FRAME;
        this._depth = depthNode;
        this._velocity = velocityNode;
        this._camera = camera;
    }

    /** The underlying upscaler — inspect `.guides`, `.gpuTimings`, etc. */
    get upscaler(): Upscaler | null {
        return this._upscaler;
    }

    /**
     * A stable texture node sampling the named guide product. Ping-ponged
     * products (`dilatedDepth`, `previousDepth`, `lockStatus`, `history`, …)
     * are re-pointed to the freshly-written half every frame, so this node
     * can be captured once at graph-construction time.
     * @param name - A {@link TemporalGuides} product name
     * @returns A texture node registered against this node (so consuming it
     *   pulls the guides dispatch into the graph, in dependency order)
     */
    getTextureNode(name: GuideName): GuideTextureNode {
        let node = this._guideNodes.get(name);
        if (node === undefined) {
            node = passTexture(this as never, this._guideTexture(name) ?? this._placeholderTexture());
            this._guideNodes.set(name, node);
        }
        return node;
    }

    /**
     * Shares this node's {@link Upscaler} with an owning upscale node — the
     * linked-mode handshake behind `upscale(..., { guides })`. The owner takes
     * over configuration (temporal path, display size, jitter); this node
     * keeps dispatching the early stage.
     * @internal
     */
    _acquireUpscaler(renderer: WebGPURenderer): Upscaler {
        if (!this._upscaler) {
            this._upscaler = new Upscaler({ renderer });
            this._upscaler.init();
        }
        this._linked = true;
        return this._upscaler;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(builder: any): any {
        const renderer = builder.renderer as WebGPURenderer;
        if (!this._upscaler) {
            //* Standalone — own a guides-only upscaler. Seeded at the drawing
            //* buffer size; corrected to the depth input's real size in
            //* updateBefore (mirrors UpscalerNode's seed-then-correct flow).
            this._upscaler = new Upscaler({ renderer });
            this._upscaler.init();
            renderer.getDrawingBufferSize(this._size);
            this._configureStandalone(this._size.x, this._size.y);
        }

        // Register the inputs as graph dependencies so three renders them
        // in-pipeline before this node's updateBefore — the same explicit
        // registration UpscalerNode does (our fields are `_`-prefixed, which
        // three's automatic child discovery skips).
        const props = builder.getNodeProperties(this);
        props.depthNode = this._depth;
        props.velocityNode = this._velocity;

        // Point the guide texture nodes at real allocations before their own
        // setup infers formats/samplers (r32float products must resolve to the
        // NearestFilter-pinned textures, not the filterable placeholder).
        this._refreshGuideNodes();
        return this.getTextureNode('disocclusion');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateBefore(frame: any): any {
        const renderer = frame.renderer as WebGPURenderer;
        const upscaler = this._upscaler;
        if (!upscaler) return;

        const depth = this._texture(this._depth);
        const velocity = this._texture(this._velocity);
        if (!depth || !velocity) return;

        let gpu: GPUTexture;
        try {
            gpu = getGPUTexture(renderer, depth);
        } catch {
            return; // input passes not GPU-backed yet (async compile)
        }

        if (this._linked) {
            try {
                void upscaler.guides;
            } catch {
                return; // the owning upscale node hasn't configured yet
            }
            // The previous split frame never completed (the owner's color pass
            // wasn't backed yet) — let the owner finish it before starting
            // another; dispatching now would throw.
            if (upscaler.guidesPending) return;
        } else if (gpu.width !== upscaler.renderWidth || gpu.height !== upscaler.renderHeight) {
            this._configureStandalone(gpu.width, gpu.height);
        }

        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        const dt = this._lastTime ? Math.min((now - this._lastTime) / 1000, 0.1) : 1 / 60;
        this._lastTime = now;

        upscaler.dispatchGuides({ depth, velocity, deltaTime: dt }, this._camera as never);
        this._refreshGuideNodes();
    }

    dispose(): void {
        // Linked mode: the owning upscale node disposes the shared upscaler.
        if (!this._linked) this._upscaler?.dispose();
        this._placeholder?.dispose();
        super.dispose();
    }

    private _configureStandalone(width: number, height: number): void {
        this._upscaler!.configure({
            displayWidth: Math.max(1, Math.round(width)),
            displayHeight: Math.max(1, Math.round(height)),
            renderWidth: Math.max(1, Math.round(width)),
            renderHeight: Math.max(1, Math.round(height)),
            path: 'guides',
        });
    }

    /** Resolves the three `Texture` behind a pass/texture node. */
    private _texture(node: TextureNodeLike) {
        return (
            node?.value ??
            node?.renderTarget?.texture ??
            node?.passNode?.renderTarget?.texture ??
            null
        );
    }

    private _guideTexture(name: GuideName) {
        if (!this._upscaler) return null;
        try {
            return this._upscaler.guides[name];
        } catch {
            return null; // not configured yet
        }
    }

    // 1×1 black stand-in so guide texture nodes can exist before configure().
    // Nearest-filtered so a transient bind never violates the r32float
    // non-filterable rule the real products are pinned for.
    private _placeholderTexture(): DataTexture {
        if (!this._placeholder) {
            this._placeholder = new DataTexture(new Float32Array([0]), 1, 1, RedFormat, FloatType);
            this._placeholder.minFilter = NearestFilter;
            this._placeholder.magFilter = NearestFilter;
            this._placeholder.needsUpdate = true;
        }
        return this._placeholder;
    }

    private _refreshGuideNodes(): void {
        for (const [name, node] of this._guideNodes) {
            const tex = this._guideTexture(name);
            if (tex) {
                (node as unknown as { value: unknown }).value = tex;
            } else if (!this._linked && !this._warnedNull.has(name) && this._guideTexture('dilatedMotion')) {
                // Configured (early products exist) but this one is null ⇒ a
                // late product on the guides-only path. Sample stays black.
                this._warnedNull.add(name);
                console.warn(
                    `@pmndrs/upscaler: guide product '${name}' is null on the guides-only path — ` +
                        'late products need the full temporal pipeline. Link the node via ' +
                        'upscale(color, depth, velocity, camera, { guides }).',
                );
            }
        }
    }
}

/**
 * Creates a {@link TemporalGuidesNode} publishing the upscaler's temporal-guides
 * bundle into a `THREE.PostProcessing` graph.
 *
 * Standalone (guides as the product, no upscale):
 * ```ts
 * const guides = temporalGuides(scenePass.getTextureNode('depth'),
 *                               scenePass.getTextureNode('velocity'), camera);
 * const disocclusion = guides.getTextureNode('disocclusion');
 * post.outputNode = myEffect(scenePass.getTextureNode('output'), disocclusion);
 * ```
 *
 * Linked (share one computation with the upscale — see `examples/13-guides-node`):
 * ```ts
 * const guides = temporalGuides(depth, velocity, camera);
 * const effected = myEffect(color, guides.getTextureNode('disocclusion'));
 * post.outputNode = upscale(effected, depth, velocity, camera, { guides });
 * ```
 *
 * @param depth - Render-res depth texture node (e.g. `pass.getTextureNode('depth')`)
 * @param velocity - Render-res jitter-free velocity texture node
 * @param camera - Scene camera (perspective or orthographic)
 * @returns The guides node — call `.getTextureNode(name)` for the products
 * @experimental See {@link TemporalGuidesNode}.
 */
export const temporalGuides = (
    depth: TextureNodeLike,
    velocityNode: TextureNodeLike,
    camera: CameraLike,
): TemporalGuidesNode => nodeObject(new TemporalGuidesNode(depth, velocityNode, camera)) as TemporalGuidesNode;
