/**
 * EXPERIMENTAL motion analysis (motion lab). Engine-free; incubating in the
 * upscaler repo until it moves to pmndrs/motion-vectors. Contract draft:
 * packages/motion/CONTRACT.md; findings: docs/research/MOTION.md.
 */
export { MotionAnalyzer, decodeCompare, decodeStats, RESIDUAL_SLOTS, HISTOGRAM_SLOTS } from './MotionAnalyzer';
export type {
    CameraMatrices,
    CandidateStats,
    CompareCandidateStats,
    CompareObjectStats,
    MotionFrameStats,
    ResidualRequest,
    ResidualStats,
} from './MotionAnalyzer';
export { COMPARE_OBJECTS, ORACLE_NO_PREVIOUS, ORACLE_VALID } from './shaders/motionCompare';
export { createDeviceTextureAllocator } from './textures';
export type { MotionTexture, MotionTextureDescriptor, MotionTextureFormat, TextureAllocator } from './textures';
export { MOVING_PIXELS, RESIDUAL_DEBUG_CLASSIFY, RESIDUAL_DEBUG_HEAT, RESIDUAL_DEBUG_MOTION } from './shaders/motionResidual';
export { HISTOGRAM_BINS } from './shaders/lumaHistogram';
export { jensenShannon, earthMovers } from './math/histogram';
export { cameraMotionAt } from './math/reprojection';
export type { CameraMotionSample } from './math/reprojection';
