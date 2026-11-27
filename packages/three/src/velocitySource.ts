import type { Matrix4 } from 'three';
import type { Node } from 'three/webgpu';
import { velocity } from 'three/tsl';

/**
 * An object that owns a velocity MRT node and the projection it measures
 * with — the shape of `@pmndrs/motion-vectors`' `MotionVectors` instance
 * (`MotionVectors.for(renderer)`), matched structurally so the library never
 * imports a producer. See docs/inputs-and-contracts.md → Motion vectors.
 */
export interface VelocityProducer {
    /** The node written into the MRT output named `velocity`. */
    readonly velocity: Node;
    /**
     * The unjittered projection both motion endpoints use, or `null` for the
     * camera's own. The upscaler points it at its
     * {@link Upscaler.unjitteredProjectionMatrix} while it jitters the camera,
     * and back to `null` when it hands the view offset to another node.
     */
    projectionMatrix: Matrix4 | null;
    /**
     * Starts the producer's frame. When present the upscaler calls it once per
     * frame, before the scene render: the producer's "previous frame" is then
     * the upscaler's, however many other renders the app makes per tick.
     */
    beginFrame?(): void;
}

/**
 * What {@link UpscalePass} and {@link upscaleScene} write as motion — and what
 * {@link upscale} hands the unjittered projection to:
 * - a three node in the `velocity` convention (`.xy` NDC current − previous,
 *   jitter-free). A node with `setProjectionMatrix()` (three's `VelocityNode`)
 *   gets the unjittered projection like three's own `velocity`; any other node
 *   must be made jitter-free by the caller, e.g. from
 *   `upscaler.unjitteredProjectionMatrix`.
 * - a {@link VelocityProducer}, e.g. `MotionVectors.for(renderer)` from
 *   `@pmndrs/motion-vectors/three`: its `velocity` node is written, its
 *   `projectionMatrix` set and its `beginFrame()` driven by the upscaler.
 */
export type VelocityNodeSource = Node | VelocityProducer;

/** @internal A velocity source reduced to the three operations the surfaces need. */
export interface ResolvedVelocitySource {
    /** The node for the MRT output named `velocity`. */
    readonly node: Node;
    /** Hands the source the projection its motion must use (`null`: the camera's own). */
    setProjection(matrix: Matrix4 | null): void;
    /** Advances the source's frame, if it has one. */
    beginFrame(): void;
}

type ProjectionNode = Node & { setProjectionMatrix?: (matrix: Matrix4 | null) => void };

/**
 * Resolves a {@link VelocityNodeSource} (default: three's shared `velocity`).
 * @internal
 * @param source - A velocity node, a producer, or nothing for three's `velocity`
 * @returns The node plus its projection and frame hooks
 * @throws {TypeError} When `source` is neither a node nor a producer
 */
export function resolveVelocitySource(source?: VelocityNodeSource | null): ResolvedVelocitySource {
    const candidate = (source ?? velocity) as unknown as Record<string, unknown>;
    // Nodes first: a node never has to answer `.velocity` (r184/r185 TSL proxies
    // turned unknown member names into nodes).
    if (candidate.isNode === true) {
        const node = candidate as unknown as ProjectionNode;
        return {
            node,
            setProjection: (matrix) => {
                if (typeof node.setProjectionMatrix === 'function') node.setProjectionMatrix(matrix);
            },
            beginFrame: () => {},
        };
    }
    const producer = candidate as unknown as VelocityProducer;
    if ((producer.velocity as unknown as { isNode?: boolean } | undefined)?.isNode !== true)
        throw new TypeError(
            '@pmndrs/upscaler: velocityNode must be a three node or an object with a `velocity` node ' +
                '(e.g. MotionVectors.for(renderer) from @pmndrs/motion-vectors/three).',
        );
    return {
        node: producer.velocity,
        setProjection: (matrix) => {
            producer.projectionMatrix = matrix;
        },
        beginFrame: () => producer.beginFrame?.(),
    };
}
