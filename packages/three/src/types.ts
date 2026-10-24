import type { Texture } from 'three';
import type {
    DispatchInputs as CoreDispatchInputs,
    GuideDispatchInputs as CoreGuideDispatchInputs,
    TemporalGuides as CoreTemporalGuides,
} from '@pmndrs/upscaler-core/types';

export {
    DebugView,
    QualityMode,
    type JitterOffset,
    type RuntimeSettings,
    type UpscalePath,
    type UpscalerConfig,
} from '@pmndrs/upscaler-core/types';

/**
 * Per-frame inputs consumed by {@link Upscaler.dispatch}. All textures are
 * three textures (render-target attachments) — the upscaler resolves the raw
 * GPU handles internally. Field contracts: the core `DispatchInputs`.
 */
// Interfaces, not aliases, so they stay mergeable and extendable as in 0.5.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DispatchInputs extends CoreDispatchInputs<Texture> {}

/**
 * Per-frame inputs for {@link Upscaler.dispatchGuides} — the early, geometry
 * stage of a split frame. Needs no color: the guides are signal-agnostic.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GuideDispatchInputs extends CoreGuideDispatchInputs<Texture> {}

/**
 * The published temporal guides as ordinary three textures, consumable as TSL
 * `texture()` nodes or via raw bind groups. Per-product contracts: the core
 * `TemporalGuides`, and docs/temporal-guides.md.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TemporalGuides extends CoreTemporalGuides<Texture> {}
