/**
 * Installs a node's per-frame begin/end hooks on three's `RenderPipeline`
 * across the two contracts three has shipped. Kept free of three imports so
 * the version branching is unit-testable without a device or a node builder.
 *
 * - **r186+** (mrdoob/three.js#34025): `RenderPipeline.context` is gone. Hooks
 *   register through the TSL events `OnBeforeRenderPipeline` /
 *   `OnAfterRenderPipeline`, which push into per-build callback arrays on the
 *   pipeline's context data, and a node that offsets the camera claims
 *   `renderPipelineState.viewOffsetOwner` so only one node jitters.
 * - **r184/r185** (deprecated here): a single mutable
 *   `renderPipeline.context.on{Before,After}RenderPipeline` slot pair.
 */

/** A TSL render-pipeline event factory (`OnBeforeRenderPipeline` / `OnAfterRenderPipeline`). */
export type PipelineEventFactory = (callback: () => void) => unknown;

/** The r186+ TSL event pair. */
export interface PipelineEvents {
    onBefore: PipelineEventFactory;
    onAfter: PipelineEventFactory;
}

/** The two callbacks a node wants run around every pipeline render. */
export interface PipelineHooks {
    before: () => void;
    after: () => void;
}

/**
 * What {@link installRenderPipelineHooks} did:
 * - `'events'` — registered via the r186+ TSL events and claimed the view offset
 * - `'legacy'` — assigned the r184/r185 `renderPipeline.context` slots
 * - `'installed'` — this owner's hooks were already live for this pipeline build (no-op)
 * - `'conflict'` — another node already owns the camera view offset (nothing installed)
 * - `'none'` — not built inside a render pipeline (nothing to hook)
 */
export type PipelineHookResult = 'events' | 'legacy' | 'installed' | 'conflict' | 'none';

interface RenderPipelineState {
    viewOffsetOwner: unknown;
}

interface LegacyPipelineContext {
    onBeforeRenderPipeline: (() => void) | null;
    onAfterRenderPipeline: (() => void) | null;
}

/** The slice of a node builder's `context` this module reads. */
export interface PipelineBuildContext {
    renderPipeline?: { context?: LegacyPipelineContext | null } | null;
    renderPipelineState?: RenderPipelineState | null;
}

/**
 * Feature-detects the r186+ render-pipeline events on a TSL namespace object.
 * Takes three's runtime `TSL` object rather than named imports: a named import
 * of a symbol r184/r185 don't export is a link-time error for strict ESM
 * consumers, whereas a missing property is just `undefined`.
 *
 * @param tsl - three's TSL namespace (`import { TSL } from 'three/webgpu'`)
 * @returns The event pair, or `null` when this three predates them
 */
export function getPipelineEvents(tsl: Record<string, unknown>): PipelineEvents | null {
    const onBefore = tsl.OnBeforeRenderPipeline;
    const onAfter = tsl.OnAfterRenderPipeline;
    if (typeof onBefore !== 'function' || typeof onAfter !== 'function') return null;
    return {
        onBefore: onBefore as PipelineEventFactory,
        onAfter: onAfter as PipelineEventFactory,
    };
}

/**
 * Installs `hooks` around the render pipeline that is building `context`,
 * claiming the camera view offset for `owner`. Must run inside a node's
 * `setup()`: the r186 events are `toStack()` nodes, and `Stack()` silently
 * drops them when there is no current stack.
 *
 * Re-running for the same pipeline build returns `'installed'` without
 * registering again — r186 pushes (rather than assigns) callbacks, so a
 * re-setup against unchanged context data would otherwise fire them twice.
 *
 * @param context - The node builder's `context` (`builder.context`)
 * @param owner - The node claiming the view offset; identity is the ownership key
 * @param hooks - Stable callbacks (the same instances on every call)
 * @param events - {@link getPipelineEvents} result; `null` selects the legacy path
 * @returns What was installed — see {@link PipelineHookResult}
 */
export function installRenderPipelineHooks(
    context: PipelineBuildContext | null | undefined,
    owner: object,
    hooks: PipelineHooks,
    events: PipelineEvents | null,
): PipelineHookResult {
    const renderPipeline = context?.renderPipeline;
    if (!renderPipeline) return 'none';

    //* r186+ — TSL Events + View-Offset Ownership
    if (events) {
        const state = context.renderPipelineState;
        // A pipeline type with events but no shared state can't arbitrate
        // ownership; register anyway rather than silently dropping jitter.
        if (state) {
            if (state.viewOffsetOwner === owner) return 'installed';
            if (state.viewOffsetOwner) return 'conflict';
            state.viewOffsetOwner = owner;
        }
        events.onBefore(hooks.before);
        events.onAfter(hooks.after);
        return 'events';
    }

    //* r184/r185 — Mutable Context Slots
    const legacy = renderPipeline.context;
    if (!legacy) return 'none';
    if (legacy.onBeforeRenderPipeline === hooks.before) return 'installed';
    // First claimant wins (matching r186): overwriting another node's slot
    // would silently strip its jitter — or it would later strip ours.
    if (legacy.onBeforeRenderPipeline || legacy.onAfterRenderPipeline) return 'conflict';
    legacy.onBeforeRenderPipeline = hooks.before;
    legacy.onAfterRenderPipeline = hooks.after;
    return 'legacy';
}
