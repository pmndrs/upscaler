// The Babylon.js WebGPUEngine adapter (`@pmndrs/upscaler/babylon`), experimental.
export { Upscaler, type UpscalerOptions } from './Upscaler';
export { FrameGraphUpscaleTask } from './FrameGraphUpscaleTask';
export { BABYLON_MOTION_SCALE } from './internal/conventions';
export {
    DebugView,
    QualityMode,
    type DispatchInputs,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
    type UpscalerConfig,
} from './types';
export { UpscalerNotReadyError } from '@pmndrs/upscaler-core/initializationError';
