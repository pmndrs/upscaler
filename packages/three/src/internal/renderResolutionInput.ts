import { FloatType, HalfFloatType, Vector2, type TextureDataType } from 'three';
import { RTTNode, type Node } from 'three/webgpu';
import { convertToTexture, nodeObject } from 'three/tsl';

import { getPassRenderResolution } from '@pmndrs/upscaler-core/math/resolution';

// TSL nodes the factories receive: three's node typings don't model the
// texture/pass duck types (`isTextureNode`, `passNode`), so read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/**
 * Where a materialised input takes its size from: the pass that renders the
 * upscaler's depth/velocity (its resolution scale, applied the way three's
 * `PassNode` applies it), a texture of known size, or — with neither — the
 * upscale ratio.
 */
export type InputSizeReference =
    | { kind: 'pass'; scale: number }
    | { kind: 'texture'; width: number; height: number };

/** The renderer surface {@link RenderResolutionInputNode} sizes from. */
export interface InputSizeRenderer {
    getDrawingBufferSize(target: Vector2): Vector2;
    getOutputRenderTarget?(): { isXRRenderTarget?: boolean; width: number; height: number } | null;
}

/** The renderer surface {@link RenderResolutionInputNode} picks its texture type from. */
export interface InputTypeRenderer {
    getOutputBufferType(): TextureDataType;
}

/**
 * Resolves a reference node to the size source it implies, or `null` when it
 * carries none (absent, or a texture not yet sized).
 *
 * Only a pass texture node (`pass.getTextureNode(…)`) is predicted for the
 * current frame. A plain texture node (say `texture(pass.getTexture('depth'))`)
 * reports its size as last rendered: if its pass renders after this input on a
 * resize frame, colour and depth disagree for that one frame, until the next
 * frame re-reads the new size.
 * @param node - The upscaler's depth (or velocity) texture node
 * @returns The size reference
 */
export function describeSizeReference(node: AnyNode): InputSizeReference | null {
    const passNode = node?.passNode;
    if (passNode && typeof passNode.getResolutionScale === 'function') {
        return { kind: 'pass', scale: passNode.getResolutionScale() };
    }
    const image = (node?.value ?? node?.renderTarget?.texture)?.image;
    if (image && image.width > 0 && image.height > 0) {
        return { kind: 'texture', width: image.width, height: image.height };
    }
    return null;
}

/**
 * The size a materialised input must render at to line up texel-for-texel
 * with the upscaler's other inputs.
 * @param base - The size three's `PassNode` sizes from this frame: the drawing
 *   buffer (or the XR output target)
 * @param reference - The depth/velocity size source, or `null`
 * @param ratio - Upscale ratio, used only without a reference
 * @returns The render size in pixels
 */
export function getInputRenderSize(
    base: { width: number; height: number },
    reference: InputSizeReference | null,
    ratio: number,
): { width: number; height: number } {
    if (reference?.kind === 'texture') return { width: reference.width, height: reference.height };
    if (reference?.kind === 'pass') {
        // PassNode.setSize: Math.floor(size * resolutionScale), the scale
        // exactly as the app set it — not 1 / (1 / scale), which can round
        // differently (#89).
        return {
            width: Math.max(1, Math.floor(base.width * reference.scale)),
            height: Math.max(1, Math.floor(base.height * reference.scale)),
        };
    }
    return getPassRenderResolution(base.width, base.height, ratio);
}

const _size = /*@__PURE__*/ new Vector2();

/**
 * An `RTTNode` that renders a composite colour (or reactive) node at the
 * upscaler's **render** resolution, in a float target. three's own
 * `convertToTexture` sizes an auto-resized target from the drawing buffer —
 * the display size — so a composite handed to `upscale()` was rendered full
 * size, and the upscaler then ran with colour at display size against depth
 * and velocity at render size.
 *
 * The size is re-derived every frame, before the render, from the same
 * inputs and arithmetic three's `PassNode` uses for the reference pass, so a
 * resize lands on the same frame for every input.
 */
export class RenderResolutionInputNode extends RTTNode {
    readonly isRenderResolutionInputNode = true;

    private readonly _reference: AnyNode;
    private readonly _ratio: number;

    /**
     * @param node - The node to materialise
     * @param reference - The upscaler's depth (or velocity) node, or `null`
     * @param ratio - Upscale ratio, used when `reference` carries no size
     * @param type - Texture type of the target (half or full float)
     */
    constructor(node: Node, reference: AnyNode, ratio: number) {
        const size = getInputRenderSize({ width: 1, height: 1 }, describeSizeReference(reference), ratio);
        // A fixed width/height turns RTTNode's own drawing-buffer resize off.
        // The type is settled in setup(), once the renderer is known.
        super(node, size.width, size.height, { type: HalfFloatType, depthBuffer: false });
        this._reference = reference;
        this._ratio = ratio;
    }

    /**
     * Sets the target's texture type from the renderer, where three's
     * `PassNode.setup()` sets its own: the renderer's output buffer type
     * overrides any type passed to `pass()`.
     * @param renderer - The renderer building this node
     * @returns The texture type applied
     */
    syncType(renderer: InputTypeRenderer): TextureDataType {
        const type = getInputTextureType(renderer.getOutputBufferType());
        this.renderTarget!.texture.type = type;
        return type;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(builder: any): any {
        this.syncType(builder.renderer);
        return super.setup(builder);
    }

    /**
     * Sizes the target for this frame.
     * @param renderer - The renderer about to draw it
     * @returns The size applied
     */
    syncSize(renderer: InputSizeRenderer): { width: number; height: number } {
        const xr = renderer.getOutputRenderTarget?.();
        // PassNode sizes an XR frame from the XR target, everything else from
        // the drawing buffer.
        const base = xr?.isXRRenderTarget === true
            ? { width: xr.width, height: xr.height }
            : renderer.getDrawingBufferSize(_size);
        const size = getInputRenderSize(base, describeSizeReference(this._reference), this._ratio);
        if (size.width !== this.width || size.height !== this.height) {
            this.width = size.width;
            this.height = size.height;
            this.renderTarget!.setSize(size.width, size.height);
        }
        return size;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateBefore(frame: any): any {
        // Size only; the render stays RTTNode's, so its renderer-state
        // handling (r187: clear colour/alpha kept across the reset) applies.
        this.syncSize(frame.renderer);
        return super.updateBefore(frame);
    }
}

/**
 * Texture type for a materialised input: full float when the renderer's
 * passes render full float (`outputBufferType: FloatType`), half float
 * otherwise — never 8-bit, which would clip HDR colour.
 * @param outputBufferType - `renderer.getOutputBufferType()`
 * @returns `FloatType` or `HalfFloatType`
 */
export function getInputTextureType(outputBufferType: TextureDataType): TextureDataType {
    return outputBufferType === FloatType ? FloatType : HalfFloatType;
}

/**
 * `convertToTexture` for an upscaler input: texture and pass nodes pass
 * through untouched (no copy); anything else — a composite like
 * `output.add(gi)` — renders into a float target at the render resolution.
 * @param node - The colour or reactive input
 * @param reference - The upscaler's depth (or velocity) node, or `null`
 * @param ratio - Upscale ratio, used when `reference` carries no size
 * @returns A texture node at the render resolution
 */
export function materializeInput(node: AnyNode, reference: AnyNode, ratio: number): AnyNode {
    if (node.isSampleNode || node.isTextureNode || node.isPassNode) return convertToTexture(node);
    return new RenderResolutionInputNode(nodeObject(node), reference, ratio);
}
