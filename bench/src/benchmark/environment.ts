import * as THREE from 'three/webgpu';

interface RendererBackendDetails {
    isWebGPUBackend?: boolean;
    device?: GPUDevice;
    adapter?: GPUAdapter;
}

/** Computes the immutable E00 manifest SHA-256 digest in the browser. */
export async function getManifestDigest(): Promise<string> {
    const response = await fetch('/results/experiments/e00-harness.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to read E00 manifest: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Captures browser, adapter, WebGPU, and fixed-run metadata.
 * @param renderer - Initialized renderer
 * @param config - Validated E00 configuration
 * @returns Environment metadata required by benchmark artifacts
 */
export function collectBenchmarkEnvironment(
    renderer: THREE.WebGPURenderer,
    config: BenchmarkRunConfig,
): Promise<BenchmarkEnvironment> {
    const backend = renderer.backend as RendererBackendDetails;
    const device = backend.device;
    return navigator.gpu
        .requestAdapter()
        .then((adapter) => {
            const adapterInfo = backend.adapter?.info ?? adapter?.info;
            const adapterName = adapterInfo
                ? [
                      adapterInfo.vendor,
                      adapterInfo.architecture,
                      adapterInfo.device,
                      adapterInfo.description,
                  ]
                      .filter(Boolean)
                      .join(' ')
                : 'adapter-info-unavailable';
            return {
                browser: navigator.userAgent,
                operatingSystem: navigator.platform,
                adapter: adapterName,
                backend: backend.isWebGPUBackend === true ? 'WebGPU' : 'unknown',
                webgpuFeatures: device ? [...device.features].sort() : [],
                threeVersion: THREE.REVISION,
                dimensions: { ...config.dimensions },
                ratio: config.ratio,
                fixedTimestep: config.timestepSeconds,
            };
        });
}

/**
 * Reports asynchronous device loss through the validation log channel.
 * @param renderer - Initialized WebGPU renderer
 * @param records - Mutable benchmark validation record list
 */
export function monitorDeviceLoss(
    renderer: THREE.WebGPURenderer,
    records: BenchmarkValidationRecord[],
): void {
    const backend = renderer.backend as RendererBackendDetails;
    void backend.device?.lost.then((info) => {
        const record = {
            channel: 'GPUDevice.lost',
            level: 'error',
            text: `${info.reason}: ${info.message}`,
            timestamp: performance.now(),
        };
        records.push(record);
        console.error('WebGPU device lost.', record);
    });
}
