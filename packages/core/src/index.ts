// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { UpscalerNotReadyError } from './initializationError';
export {
    DebugView,
    QualityMode,
    type JitterOffset,
    type RuntimeSettings,
    type UpscalePath,
    type UpscalerConfig,
} from './types';
export { halton, generateJitterSequence } from './math/halton';
export { getJitterPhaseCount, JitterSequence } from './math/jitter';
export { getQualityModeRatio, getRenderResolution, QUALITY_MODE_RATIOS } from './math/resolution';
