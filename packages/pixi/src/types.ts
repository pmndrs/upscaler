import type { Texture, TextureSource } from 'pixi.js';
import type {
    DispatchInputs as CoreDispatchInputs,
    GuideDispatchInputs as CoreGuideDispatchInputs,
    TemporalGuides as CoreTemporalGuides,
} from '@pmndrs/upscaler-core/types';

export {
    DebugView,
    QualityMode,
    type FrameCamera,
    type JitterOffset,
    type RuntimeSettings,
    type UpscalePath,
    type UpscalerConfig,
} from '@pmndrs/upscaler-core/types';

/** A pixi texture input: a `Texture` (e.g. a `RenderTexture`) or its `TextureSource`. */
export type PixiTextureInput = Texture | TextureSource;

/**
 * Per-frame inputs for the pixi {@link Upscaler.dispatch}, as pixi textures.
 * Field contracts: the core `DispatchInputs` and docs/engine-contract.md.
 */
export type DispatchInputs = CoreDispatchInputs<PixiTextureInput>;

/** Per-frame inputs for the pixi {@link Upscaler.dispatchGuides}. */
export type GuideDispatchInputs = CoreGuideDispatchInputs<PixiTextureInput>;

/**
 * The published temporal guides as pixi `Texture`s. Per-product contracts:
 * the core `TemporalGuides` and docs/temporal-guides.md.
 */
export type TemporalGuides = CoreTemporalGuides<Texture>;
