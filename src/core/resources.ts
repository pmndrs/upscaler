import type { CoreConfiguration, ResourceDescriptor, ResourceName } from './types.js';

/**
 * Describe adapter-owned textures without allocating GPU resources.
 * Numeric usage flags allow Frame Graph registration before WebGPU initialization.
 *
 * @param config - Dimensions, path and shader variants to validate.
 * @returns Fresh allocation descriptors, including native history requirements.
 * @throws If dimensions or configuration variants are invalid.
 */
export function getResourceDescriptors(config: CoreConfiguration): ResourceDescriptor[] {
    for (const value of [config.renderWidth, config.renderHeight, config.displayWidth, config.displayHeight]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('UpscalerCore: dimensions must be positive integers.');
    }
    if (config.path && !['temporal', 'guides', 'spatial', 'bilinear'].includes(config.path)) throw new Error('UpscalerCore: unknown path.');
    if (config.depthMode && !['linear', 'hardware'].includes(config.depthMode)) throw new Error('UpscalerCore: unknown depth mode.');
    if (config.exposureMode && !['upstream', 'provided'].includes(config.exposureMode)) throw new Error('UpscalerCore: unknown exposure mode.');
    if (config.rcasAgeKnee !== undefined && (!Number.isFinite(config.rcasAgeKnee) || config.rcasAgeKnee < 0 || config.rcasAgeKnee > 1)) throw new Error('UpscalerCore: rcasAgeKnee must be in [0, 1].');
    const result: ResourceDescriptor[] = [];
    const add = (name: ResourceName, width: number, height: number, format: GPUTextureFormat, history = false, usage = 12): void => {
        result.push({ name, width, height, format, history, usage, sampling: format === 'rgba16float' || format === 'rgba8unorm' || format === 'r8unorm' ? 'linear' : 'load', initialization: 'zero' });
    };
    const { renderWidth: rw, renderHeight: rh, displayWidth: dw, displayHeight: dh } = config;
    const path = config.path ?? 'temporal';
    if (path === 'temporal' || path === 'guides') {
        add('dilatedDepth', rw, rh, 'r32float', true);
        add('dilatedMotion', rw, rh, 'rgba16float');
        add('masks', rw, rh, 'rgba8unorm');
    }
    if (path === 'guides') return result;
    add('output', dw, dh, 'rgba16float');
    add('exposure', 1, 1, config.exposureMode === 'provided' ? 'rgba32float' : 'rgba16float', true);
    add('dummy', 1, 1, 'r8unorm', false, 4);
    if (path === 'spatial') add('easuOutput', dw, dh, 'rgba16float');
    if (path === 'temporal') {
        add('history', dw, dh, 'rgba16float', true);
        add('locks', dw, dh, 'rgba16float', true);
        add('reactiveGenerated', rw, rh, 'rgba8unorm');
        add('shadingLumaHistory', rw, rh, 'r32float', true);
        add('shadingSignal', Math.ceil(rw / 2), Math.ceil(rh / 2), 'r32float');
        add('shadingBlockMemory', Math.ceil(rw / 4), Math.ceil(rh / 4) + Math.ceil(rh / 8), 'rgba32uint', true, 14);
    }
    return result;
}
