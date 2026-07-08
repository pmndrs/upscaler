import * as THREE from 'three/webgpu';
import { mrt, output, texture, velocity } from 'three/tsl';

import {
    FSR3Upscaler,
    FSRQualityMode,
    getQualityModeRatio,
    type FSRDebugView,
} from 'three-fsr3';

/** Bench render modes — what fills the screen each frame. */
export type BenchMode = 'native' | 'bilinear' | 'fsr1-spatial' | 'fsr3-temporal';

/**
 * Owns everything between "a scene + camera" and "pixels on the canvas":
 * the low-resolution scene render target (color + velocity MRT + depth),
 * the FSR3 upscaler, and the fullscreen presentation quad.
 *
 * All bench modes — including native — funnel through the same render
 * target and the same WGSL display transform, so image and performance
 * comparisons are apples-to-apples.
 */
export class BenchPipeline {
    readonly upscaler: FSR3Upscaler;

    //* Presentation
    private readonly _renderer: THREE.WebGPURenderer;
    private readonly _quad: THREE.QuadMesh;
    private readonly _quadMaterial: THREE.NodeMaterial;

    //* Scene Target
    private _renderTarget: THREE.RenderTarget | null = null;
    private readonly _mrtNode = mrt({ output, velocity });
    // Single-output MRT for non-temporal modes — its output count matches the
    // count:1 render target so color attachment 0 is actually written.
    private readonly _mrtOutputOnly = mrt({ output });

    private _mode: BenchMode = 'fsr3-temporal';
    private _quality: FSRQualityMode = FSRQualityMode.Quality;
    private _displayWidth = 0;
    private _displayHeight = 0;

    constructor(renderer: THREE.WebGPURenderer) {
        this._renderer = renderer;
        this.upscaler = new FSR3Upscaler({ renderer });
        this.upscaler.init();

        // Motion vectors must be jitter-free — hand the velocity node the
        // upscaler's unjittered projection (contents refresh every frame).
        velocity.setProjectionMatrix(this.upscaler.unjitteredProjectionMatrix);

        this._quadMaterial = new THREE.NodeMaterial();
        // Plain fullscreen present — no depth interaction, no fog.
        this._quadMaterial.depthTest = false;
        this._quadMaterial.depthWrite = false;
        this._quadMaterial.fog = false;
        this._quad = new THREE.QuadMesh(this._quadMaterial);
    }

    get mode(): BenchMode {
        return this._mode;
    }

    get renderTarget(): THREE.RenderTarget | null {
        return this._renderTarget;
    }

    /**
     * (Re)builds the pipeline for a display size, mode, and quality preset.
     * @param displayWidth - Canvas width in physical pixels
     * @param displayHeight - Canvas height in physical pixels
     * @param mode - Bench render mode
     * @param quality - FSR quality preset (ignored in native mode)
     */
    configure(
        displayWidth: number,
        displayHeight: number,
        mode: BenchMode,
        quality: FSRQualityMode,
    ): void {
        this._mode = mode;
        this._quality = quality;
        this._displayWidth = displayWidth;
        this._displayHeight = displayHeight;

        //* Upscaler
        const ratio = mode === 'native' ? 1 : getQualityModeRatio(quality);
        this.upscaler.configure({
            displayWidth,
            displayHeight,
            customUpscaleRatio: ratio,
            path:
                mode === 'fsr3-temporal'
                    ? 'temporal'
                    : mode === 'fsr1-spatial'
                      ? 'spatial'
                      : 'bilinear',
        });

        //* Scene Render Target (color [+ velocity MRT], float depth)
        // Only the temporal path consumes velocity; the attachment count must
        // match the MRT output count used in render() (a count:2 target
        // rendered without a velocity output leaves color attachment 0 black).
        this._renderTarget?.dispose();
        const rw = this.upscaler.renderWidth;
        const rh = this.upscaler.renderHeight;
        const temporal = mode === 'fsr3-temporal';
        const depthTexture = new THREE.DepthTexture(rw, rh);
        depthTexture.type = THREE.FloatType;
        this._renderTarget = new THREE.RenderTarget(rw, rh, {
            count: temporal ? 2 : 1,
            type: THREE.HalfFloatType,
            depthTexture,
        });
        // MRT routes node outputs to attachments BY TEXTURE NAME (see
        // three's getTextureIndex) — these must match the mrt({...}) keys.
        this._renderTarget.textures[0].name = 'output';
        if (temporal) this._renderTarget.textures[1].name = 'velocity';

        // Present the (re)created output texture on the quad.
        this._quadMaterial.colorNode = texture(this.upscaler.outputTexture);
        this._quadMaterial.needsUpdate = true;
    }

    /**
     * Renders one frame: scene → render target → FSR passes → canvas quad.
     * @param scene - Scene to render
     * @param camera - Scene camera
     * @param deltaTime - Seconds since last frame
     */
    render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, deltaTime: number): void {
        const rt = this._renderTarget;
        if (!rt) return;
        const temporal = this._mode === 'fsr3-temporal';

        //* Scene Pass (jittered when temporal)
        this.upscaler.beginFrame(camera);
        // The MRT output count MUST match the render target's attachment count:
        // rendering into a count:2 target without the velocity output leaves
        // color attachment 0 unwritten (black). Non-temporal modes therefore
        // use a single-output MRT into a count:1 target (see configure()).
        this._renderer.setMRT(temporal ? this._mrtNode : this._mrtOutputOnly);
        this._renderer.setRenderTarget(rt);
        this._renderer.render(scene, camera);
        this._renderer.setRenderTarget(null);
        this._renderer.setMRT(null);
        this.upscaler.endFrame(camera);

        //* FSR Passes
        this.upscaler.dispatch(
            {
                color: rt.textures[0],
                depth: rt.depthTexture ?? undefined,
                velocity: temporal ? rt.textures[1] : undefined,
                deltaTime,
            },
            camera,
        );

        //* Present — output is already display-referred sRGB
        this._quad.render(this._renderer);
    }

    /** Applies runtime settings from the UI (no reconfigure needed). */
    applySettings(settings: {
        sharpness: number;
        rcasDenoise: boolean;
        maxAccumulation: number;
        exposure: number;
        autoExposure: boolean;
        lockThinFeatures: boolean;
        detectShadingChanges: boolean;
        debugView: FSRDebugView;
    }): void {
        Object.assign(this.upscaler.settings, settings);
    }

    dispose(): void {
        this._renderTarget?.dispose();
        this.upscaler.dispose();
    }
}
