import * as THREE from 'three/webgpu';

/**
 * Shared WebGPU bootstrap for the examples. Guards for WebGPU support, creates
 * a `WebGPURenderer` configured to present the upscaler's linear/HDR output,
 * and awaits `init()` — throwing loudly if three falls back to WebGL.
 *
 * @param options - Optional canvas parent (defaults to `document.body`)
 * @returns The initialized renderer and the capped device-pixel-ratio used
 */
export async function bootRenderer(options: { parent?: HTMLElement } = {}): Promise<{
    renderer: THREE.WebGPURenderer;
    dpr: number;
}> {
    if (!navigator.gpu) {
        showFatal(
            'WebGPU is not available in this browser. These FSR3 examples are ' +
                'WebGPU-only — try Chrome/Edge 113+, or enable the flag in Safari/Firefox.',
        );
        throw new Error('WebGPU unavailable');
    }

    // Cap DPR — an upscaler demo is about controlling pixel counts, not chasing
    // the panel's native density.
    const dpr = Math.min(window.devicePixelRatio, 2);

    const renderer = new THREE.WebGPURenderer({ antialias: false });
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    // The upscaler does not own presentation; examples choose ACES + sRGB.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    (options.parent ?? document.body).appendChild(renderer.domElement);

    await renderer.init();
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    if (backend.isWebGPUBackend !== true) {
        showFatal('three fell back to the WebGL backend — these examples need real WebGPU.');
        throw new Error('WebGL fallback active');
    }

    return { renderer, dpr };
}

/** Physical-pixel display size for the current window at a given DPR. */
export function displaySize(dpr: number): { width: number; height: number } {
    return {
        width: Math.floor(window.innerWidth * dpr),
        height: Math.floor(window.innerHeight * dpr),
    };
}

/** Renders a full-screen fatal-error message (used by the WebGPU guards). */
export function showFatal(message: string): void {
    let el = document.getElementById('fatal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'fatal';
        document.body.appendChild(el);
    }
    el.style.cssText =
        'position:fixed;inset:0;display:grid;place-items:center;color:#fda4af;' +
        'font:14px/1.5 ui-monospace,Menlo,monospace;text-align:center;padding:24px;z-index:50;';
    el.textContent = message;
}
