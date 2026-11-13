/**
 * EXPERIMENTAL motion analysis (motion lab). Engine-free; bench-only — not
 * re-exported from any public entry. Findings: docs/research/MOTION.md.
 */
export { MotionAnalyzer, decodeStats, RESIDUAL_SLOTS, HISTOGRAM_SLOTS } from './MotionAnalyzer';
export type { CameraMatrices, CandidateStats, MotionFrameStats, ResidualRequest, ResidualStats } from './MotionAnalyzer';
export { MOVING_PIXELS, RESIDUAL_DEBUG_CLASSIFY, RESIDUAL_DEBUG_HEAT, RESIDUAL_DEBUG_MOTION } from './shaders/motionResidual';
export { HISTOGRAM_BINS } from './shaders/lumaHistogram';
export { jensenShannon, earthMovers } from './math/histogram';
export { cameraMotionAt } from './math/reprojection';
export type { CameraMotionSample } from './math/reprojection';
