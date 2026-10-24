import { afterEach, expect, test, vi } from 'vitest';
import { Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { MomentsPass, UpscalerNotReadyError } from './index';

afterEach(() => vi.restoreAllMocks());

test('MomentsPass reports migration once and never touches GPU state before initialization', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderer = { get backend() { throw new Error('Premature GPU access'); } };
    const moments = new MomentsPass({ renderer: renderer as unknown as WebGPURenderer });
    const error = new UpscalerNotReadyError('MomentsPass');
    expect(error.code).toBe('UPSCALER_NOT_READY');
    expect(error.surface).toBe('MomentsPass');
    expect(error.reason).toBe('preparing');
    expect(() => moments.dispatch({ source: new Texture() })).toThrow(UpscalerNotReadyError);
    expect(() => moments.dispatch({ source: new Texture() })).toThrow('await MomentsPass.init()');
    expect(warn).toHaveBeenCalledTimes(1);
});
