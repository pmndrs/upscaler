import type * as THREE from 'three/webgpu';
import type { Node, TextureNode, UniformNode } from 'three/webgpu';

/** Options of the vendored `RealtimeRadianceCascades` (the subset this example sets). */
export interface RadianceCascadesOptions {
    spacing?: number;
    levelDistance?: number;
    levels?: number;
    blendingRadius?: number;
    maxProbes?: number;
    rayStride?: number;
    secondary?: boolean;
    qualityDecay?: number;
    orientations?: boolean;
    velocity?: boolean;
    quality?: number;
    halfResolution?: boolean;
    adaptiveQuality?: boolean;
}

/**
 * Types for the vendored three.js PR #35349 addon (plain JS). Only the surface
 * this example uses; see the `.js` file's JSDoc for the full contract.
 */
export class RealtimeRadianceCascades implements RadianceCascadesOptions {
    constructor(options?: RadianceCascadesOptions);
    spacing: number;
    levelDistance: number;
    levels: number;
    blendingRadius: number;
    maxProbes: number;
    rayStride: number;
    secondary: boolean;
    qualityDecay: number;
    orientations: boolean;
    velocity: boolean;
    quality: number;
    halfResolution: boolean;
    adaptiveQuality: boolean;
    /** `[upscaler port]` G-buffer size, or `null` for the drawing buffer's. */
    renderSize: { x: number; y: number } | null;
    readonly mode: UniformNode<number>;
    readonly intensity: UniformNode<number>;
    readonly memory: number;
    readonly capacities: number[];
    readonly lodBias: number;
    readonly newProbes: number;
    readonly activeTargetFrameTime: number;
    setScene(renderer: THREE.WebGPURenderer, scene: THREE.Scene): void;
    getCompositeNode(): Node;
    getTextureNode(name: 'output' | 'albedo' | 'normal' | 'depth' | 'velocity'): TextureNode;
    update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): void;
    readGPUTime(renderer: THREE.WebGPURenderer): Promise<number | null>;
    readStats(renderer: THREE.WebGPURenderer): Promise<number[]>;
    dispose(): void;
}
