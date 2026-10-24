import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraphTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';

import type { Upscaler } from './Upscaler';

/**
 * The Babylon {@link Upscaler} as a frame-graph task — **experimental**.
 * Add it after the task that renders the inputs (a
 * `FrameGraphGeometryRendererTask` producing color, depth and
 * `geometryLinearVelocityTexture`) and feed {@link outputTexture} to the
 * presenting tasks (image processing, copy to backbuffer).
 *
 * The task owns the jitter window: it starts the jitter when the graph is
 * built and again after each dispatch (for the next frame's input renders),
 * and ends it before dispatching — no per-frame calls are needed beyond
 * `scene.render()`.
 *
 * ```ts
 * const upscale = new FrameGraphUpscaleTask('upscale', graph, upscaler);
 * upscale.camera = camera;
 * upscale.colorTexture = geometry.outputTexture;
 * upscale.depthTexture = geometry.outputDepthTexture;
 * upscale.velocityTexture = geometry.geometryLinearVelocityTexture;
 * graph.addTask(upscale);
 * ```
 * After `upscaler.configure()` (resize, mode change), rebuild the graph:
 * the output is reallocated.
 */
export class FrameGraphUpscaleTask extends FrameGraphTask {
    /** Scene color at render resolution (linear HDR, rgba16float). */
    colorTexture?: FrameGraphTextureHandle;
    /** Scene depth (a depth texture) at render resolution. Temporal path. */
    depthTexture?: FrameGraphTextureHandle;
    /** Linear velocity (`geometryLinearVelocityTexture`) at render resolution. Temporal path. */
    velocityTexture?: FrameGraphTextureHandle;
    /** Optional reactive mask (red, `[0, 1]`). */
    reactiveTexture?: FrameGraphTextureHandle;
    /** Optional opaque-only color for the auto-generated reactive mask. */
    reactiveOpaqueColorTexture?: FrameGraphTextureHandle;
    /** Optional conditioning exposure (red of texel 0, 0). */
    exposureTexture?: FrameGraphTextureHandle;
    /** Optional host pre-exposure baked into the color (red of texel 0, 0). */
    preExposureTexture?: FrameGraphTextureHandle;
    /** The camera the inputs are rendered with. */
    camera?: Camera;

    /** The upscaled output (display size, linear/HDR). Stable across rebuilds. */
    readonly outputTexture: FrameGraphTextureHandle;
    /** The upscaler this task drives. */
    readonly upscaler: Upscaler;

    constructor(name: string, frameGraph: FrameGraph, upscaler: Upscaler) {
        super(name, frameGraph);
        this.upscaler = upscaler;
        this.outputTexture = frameGraph.textureManager.createDanglingHandle();
    }

    override getClassName(): string {
        return 'FrameGraphUpscaleTask';
    }

    override initAsync(): Promise<unknown> {
        return this.upscaler.init();
    }

    override isReady(): boolean {
        return this.upscaler.isReady;
    }

    override record(): void {
        const manager = this._frameGraph.textureManager;
        const color = this.colorTexture;
        const camera = this.camera;
        if (color === undefined || !camera) {
            throw new Error(`FrameGraphUpscaleTask "${this.name}": colorTexture and camera must be set.`);
        }
        const output = manager.importTexture(`${this.name} output`, this.upscaler.outputTexture);
        manager.resolveDanglingHandle(this.outputTexture, output);

        // Generic passes declare their reads at task level; without them the
        // graph's texture aliasing could hand an input's memory to a later task.
        const inputs = [
            color,
            this.depthTexture,
            this.velocityTexture,
            this.reactiveTexture,
            this.reactiveOpaqueColorTexture,
            this.exposureTexture,
            this.preExposureTexture,
        ].filter((handle): handle is FrameGraphTextureHandle => handle !== undefined);
        this.dependencies = new Set(inputs);

        const resolve = (handle: FrameGraphTextureHandle | undefined): InternalTexture | undefined => {
            if (handle === undefined) return undefined;
            const texture = manager.getTextureFromHandle(handle);
            if (!texture) throw new Error(`FrameGraphUpscaleTask "${this.name}": input texture ${handle} is not allocated.`);
            return texture;
        };

        // The first frame after a (re)build renders jittered too.
        this.upscaler.beginFrame();

        const pass = this._frameGraph.addPass(this.name);
        pass.setExecuteFunc(() => {
            const upscaler = this.upscaler;
            // The inputs are rendered: later tasks this frame draw unjittered.
            upscaler.endFrame();
            // Still compiling: leave the output as it is this frame.
            if (upscaler.isReady) upscaler.dispatch(
                {
                    color: resolve(color)!,
                    depth: resolve(this.depthTexture),
                    velocity: resolve(this.velocityTexture),
                    reactive: resolve(this.reactiveTexture),
                    reactiveOpaqueColor: resolve(this.reactiveOpaqueColorTexture),
                    exposureTexture: resolve(this.exposureTexture),
                    preExposureTexture: resolve(this.preExposureTexture),
                    deltaTime: this._frameGraph.engine.getDeltaTime() / 1000,
                },
                camera,
            );
            // Jitter for the next frame's input renders.
            upscaler.beginFrame();
        });
    }
}
