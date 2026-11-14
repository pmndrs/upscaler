import * as THREE from 'three/webgpu';
import { checker, color as colorNode, mix, uv } from 'three/tsl';

import type { Oracle } from '../oracle';

/** A named frame range of a timeline, inclusive. */
export interface Segment {
    readonly name: string;
    readonly start: number;
    readonly end: number;
}

/** What the scene knows about a frame: its segment, and whether it is a hard cut. */
export interface FrameTruth {
    readonly segment: string;
    readonly cut: boolean;
}

/** One lab scene: a three scene, its oracle-instrumented objects and a timeline. */
export interface LabScene {
    readonly name: string;
    readonly scene: THREE.Scene;
    /** Object ids in the oracle comparison → names (0 is static world). */
    readonly objects: Readonly<Record<number, string>>;
    /** Last frame of the timeline. */
    readonly end: number;
    readonly segments: readonly Segment[];
    /**
     * Poses the camera and animates the scene for a frame (60 frames per second).
     * The caller updates matrices afterwards.
     */
    update(frame: number, camera: THREE.PerspectiveCamera): FrameTruth;
    /** Shows only the named objects (all when undefined). */
    select?(names: readonly string[] | undefined): void;
}

/** Builds a fresh scene; `fresh` scenes get new materials (shader builds). */
export type SceneFactory = (oracle: Oracle) => LabScene;

/** Frames per second of every lab timeline. */
export const FPS = 60;

/**
 * Consecutive segments from `[name, length]` pairs.
 * @param parts - Segment names and lengths in frames
 * @returns The segments, starting at frame 0
 */
export function timeline(parts: readonly (readonly [string, number])[]): Segment[] {
    let start = 0;
    return parts.map(([name, length]) => {
        const segment = { name, start, end: start + length - 1 };
        start += length;
        return segment;
    });
}

/**
 * The segment holding a frame (the last one past the end).
 * @param segments - A timeline
 * @param frame - Frame index
 * @returns Its segment
 */
export function segmentAt(segments: readonly Segment[], frame: number): Segment {
    return segments.find((segment) => frame <= segment.end) ?? segments[segments.length - 1];
}

/**
 * Frames elapsed inside `[start, start + length)`, clamped: a per-frame step
 * times this is the distance travelled by `frame`.
 * @param frame - Frame index
 * @param start - First frame of the motion
 * @param length - Frames of motion
 * @returns 0 … length
 */
export function ramp(frame: number, start: number, length: number): number {
    return Math.min(Math.max(frame - start + 1, 0), length);
}

/**
 * A checkerboard standard material (one per mesh: the oracle needs its own).
 * @param a - First colour
 * @param b - Second colour
 * @param scale - Checks per UV unit
 * @returns The material
 */
export function checkerMaterial(a: number, b: number, scale: number): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
    material.colorNode = mix(colorNode(a), colorNode(b), checker(uv().mul(scale)));
    return material;
}

/**
 * A key light with a shadow map covering `extent` around the origin.
 * @param intensity - Light intensity
 * @param position - Light position
 * @param extent - Half size of the shadow frustum
 * @returns The light
 */
export function sunLight(intensity: number, position: readonly [number, number, number], extent: number): THREE.DirectionalLight {
    const sun = new THREE.DirectionalLight(0xffffff, intensity);
    sun.position.set(...position);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, far: 120 });
    return sun;
}
