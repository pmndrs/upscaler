import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
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
 * Per-frame inputs for the Babylon {@link Upscaler.dispatch}, as Babylon
 * `InternalTexture`s (a frame graph's `getTextureFromHandle()`, or a render
 * target's `texture`). `velocity` is Babylon's **linear** velocity
 * (`geometryLinearVelocityTexture`); field contracts: the core
 * `DispatchInputs` and docs/babylon.md.
 */
export type DispatchInputs = CoreDispatchInputs<InternalTexture>;

/** Per-frame inputs for the Babylon {@link Upscaler.dispatchGuides}. */
export type GuideDispatchInputs = CoreGuideDispatchInputs<InternalTexture>;

/**
 * The published temporal guides as Babylon `InternalTexture`s. They share the
 * output's orientation: Babylon's render-target convention, so they sample
 * upright like any other render target. `dilatedMotion.xy` is a texel-UV
 * delta on that flipped layout (`prevUV = uv − motion`, v growing upward).
 * Per-product contracts: the core `TemporalGuides` and
 * docs/temporal-guides.md.
 */
export type TemporalGuides = CoreTemporalGuides<InternalTexture>;
