// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { UpscalerCore, type UpscalerCoreOptions } from './UpscalerCore';
export { MomentsCore, type MomentsCoreOptions, type MomentsPassConfig, type MomentsSpace } from './MomentsCore';
export {
    createDeviceTextureAllocator,
    type CoreTexture,
    type CoreTextureDescriptor,
    type CoreTextureFormat,
    type TextureAllocator,
} from './textures';
export { UpscalerNotReadyError } from './initializationError';
export {
    DebugView,
    QualityMode,
    type DispatchInputs,
    type FrameCamera,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
    type UpscalerConfig,
} from './types';
export { halton, generateJitterSequence } from './math/halton';
export { getJitterPhaseCount, JitterSequence } from './math/jitter';
export { getQualityModeRatio, getRenderResolution, QUALITY_MODE_RATIOS } from './math/resolution';
