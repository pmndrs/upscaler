import * as THREE from 'three/webgpu';
import { mrt, output, texture, velocity } from 'three/tsl';

import { Upscaler } from './Upscaler';
import { getQualityModeRatio } from './math/resolution';
import { QualityMode, type RuntimeSettings, type UpscalePath } from './types';

/** Options for {@link UpscalePass.configure}. */
export interface UpscalePassConfig {
    /** Output size in physical pixels. */
    displayWidth: number;
    displayHeight: number;
    /** Which FSR path to run. Defaults to `'temporal'`. */
    path?: UpscalePath;
    /** Quality preset (render-resolution ratio). Ignored if `ratio` is set. */
    quality?: QualityMode;
    /** Explicit upscale ratio (overrides `quality`). `1` = render at display res. */
    ratio?: number;
}

/**
 * High-level drop-in driver: turns "a scene + camera" into an upscaled texture,
 * wrapping every non-obvious integration detail {@link Upscaler} needs.
 *
 * - jitter-free velocity (`velocity.setProjectionMatrix(unjitteredProjectionMatrix)`)
 * - MRT output count matched to the render-target attachment count (a `count: 2`
 *   target rendered without a velocity output yields black)
 * - render resolution taken from the upscaler, float depth + half-float color
 * - a full-screen present that uses the renderer's normal output transform
 *
 * Use {@link renderScene} for the common single-view case, or {@link draw} +
 * {@link outputTexture} when you want to present the result yourself (split
 * views, custom composites, feeding another pass). For fine-grained control,
 * drive {@link Upscaler} directly instead.
 */
export class UpscalePass {
    readonly upscaler: Upscaler;

    private readonly _renderer: THREE.WebGPURenderer;
    private readonly _mrtFull = mrt({ output, velocity });
    private readonly _mrtColorOnly = mrt({ output });
    private readonly _quad: THREE.QuadMesh;
    private readonly _quadMaterial: THREE.NodeMaterial;

    private _rt: THREE.RenderTarget | null = null;
    private _path: UpscalePath = 'temporal';
    private _reactive: THREE.Texture | null = null;
    private _reactiveOpaque: THREE.Texture | null = null;

    /**
     * @param renderer - An initialized `WebGPURenderer`
     * @param options.shareVelocityMatrix - Set false when several passes share
     *   one renderer and only one should own the global `velocity` node
     *   projection (default true).
     */
    constructor(
        renderer: THREE.WebGPURenderer,
        options: { shareVelocityMatrix?: boolean } = {},
    ) {
        this._renderer = renderer;
        this.upscaler = new Upscaler({ renderer });
        this.upscaler.init();

        // Motion vectors must be jitter-free — hand the velocity node the
        // upscaler's unjittered projection (a stable instance, refreshed each
        // frame). Only one pass should own this per renderer.
        if (options.shareVelocityMatrix !== false) {
            velocity.setProjectionMatrix(this.upscaler.unjitteredProjectionMatrix);
        }

        this._quadMaterial = new THREE.NodeMaterial();
        this._quadMaterial.depthTest = false;
        this._quadMaterial.depthWrite = false;
        this._quadMaterial.fog = false;
        this._quad = new THREE.QuadMesh(this._quadMaterial);
    }

    /** The render target the scene is drawn into (color [+ velocity], depth). */
    get renderTarget(): THREE.RenderTarget | null {
        return this._rt;
    }

    /** The upscaled linear/HDR result — sample or post-process before presentation. */
    get outputTexture(): THREE.Texture {
        return this.upscaler.outputTexture;
    }

    /** (Re)builds the pipeline + render target for a size/path/quality. */
    configure(config: UpscalePassConfig): void {
        if (config.path === 'guides') {
            throw new Error(
                "@pmndrs/upscaler: UpscalePass presents an upscaled image — the 'guides' path " +
                    'produces none. Drive Upscaler directly (configure + dispatchGuides).',
            );
        }
        this._path = config.path ?? 'temporal';
        const ratio = config.ratio ?? getQualityModeRatio(config.quality ?? QualityMode.Quality);

        this.upscaler.configure({
            displayWidth: config.displayWidth,
            displayHeight: config.displayHeight,
            customUpscaleRatio: ratio,
            path: this._path,
        });

        const rw = this.upscaler.renderWidth;
        const rh = this.upscaler.renderHeight;
        const temporal = this._path === 'temporal';

        this._rt?.dispose();
        const depthTexture = new THREE.DepthTexture(rw, rh);
        depthTexture.type = THREE.FloatType;
        this._rt = new THREE.RenderTarget(rw, rh, {
            // Attachment count MUST match the MRT output count used in draw().
            count: temporal ? 2 : 1,
            type: THREE.HalfFloatType,
            depthTexture,
        });
        // MRT routes node outputs to attachments BY TEXTURE NAME.
        this._rt.textures[0].name = 'output';
        if (temporal) this._rt.textures[1].name = 'velocity';

        this._quadMaterial.colorNode = texture(this.upscaler.outputTexture);
        this._quadMaterial.needsUpdate = true;
    }

    /**
     * Renders the scene into the low-res target and runs the FSR passes. The
     * upscaled result lands in {@link outputTexture}; call {@link present} (or
     * sample the texture yourself) to display it.
     * @param scene - Scene to render
     * @param camera - Scene camera
     * @param deltaTime - Seconds since the previous frame
     */
    draw(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
        deltaTime: number,
    ): void {
        const rt = this._rt;
        if (!rt) return;
        const temporal = this._path === 'temporal';

        this.upscaler.beginFrame(camera);
        this._renderer.setMRT(temporal ? this._mrtFull : this._mrtColorOnly);
        this._renderer.setRenderTarget(rt);
        this._renderer.render(scene, camera);
        this._renderer.setRenderTarget(null);
        this._renderer.setMRT(null);
        this.upscaler.endFrame(camera);

        this.upscaler.dispatch(
            {
                color: rt.textures[0],
                depth: rt.depthTexture ?? undefined,
                velocity: temporal ? rt.textures[1] : undefined,
                reactive: this._reactive ?? undefined,
                reactiveOpaqueColor: this._reactiveOpaque ?? undefined,
                deltaTime,
            },
            camera,
        );
    }

    /** Presents {@link outputTexture} using the renderer's output transform. */
    present(): void {
        this._quad.render(this._renderer);
    }

    /** Convenience: {@link draw} then {@link present}. */
    renderScene(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
        deltaTime: number,
    ): void {
        this.draw(scene, camera, deltaTime);
        this.present();
    }

    /** Applies runtime settings (sharpness / accumulation / exposure / locks / debug). */
    applySettings(settings: Partial<RuntimeSettings>): void {
        Object.assign(this.upscaler.settings, settings);
    }

    /**
     * Sets the render-resolution reactive mask fed to the next {@link draw}
     * (red channel = reactivity). Pass `null` to clear it.
     * @param texture - A render-res mask texture, or null
     */
    setReactiveMask(texture: THREE.Texture | null): void {
        this._reactive = texture;
    }

    /**
     * Sets a render-res opaque-only color for the next {@link draw}; the
     * upscaler auto-generates the reactive mask from its difference with the
     * final render. Ignored if an explicit mask is set. Pass `null` to clear.
     * @param texture - A render-res opaque-only color texture, or null
     */
    setReactiveOpaqueColor(texture: THREE.Texture | null): void {
        this._reactiveOpaque = texture;
    }

    dispose(): void {
        this._rt?.dispose();
        this.upscaler.dispose();
    }
}
