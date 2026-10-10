/// <reference types="@webgpu/types" preserve="true" />
export { FrameGraphUpscaleTask, getBabylonTextureOptions } from './FrameGraphUpscaleTask.js';
export type { FrameGraphUpscaleOptions, FrameGraphUpscaleConfiguration, FrameGraphUpscaleGuides } from './FrameGraphUpscaleTask.js';
export { DebugView, QualityMode } from '../core/types.js';
/** Advanced host compute integration; guarded against unsupported engine internals. */
export * as babylonWebGPU from './compatibility.js';
