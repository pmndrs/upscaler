import GUI from 'lil-gui';

import { FSRDebugView, FSRQualityMode } from 'three-fsr3';

import type { BenchMode } from './BenchPipeline';

/** UI-owned state; the main loop reads it and reacts to change callbacks. */
export interface BenchState {
    mode: BenchMode;
    quality: FSRQualityMode;
    sharpness: number;
    maxAccumulation: number;
    exposure: number;
    autoExposure: boolean;
    lockThinFeatures: boolean;
    debugView: FSRDebugView;
    animate: boolean;
    autoOrbit: boolean;
}

/**
 * Builds the lil-gui control panel.
 * @param state - Mutable bench state the panel edits in place
 * @param onPipelineChange - Called when a change requires a pipeline rebuild
 * @param onResetHistory - Called when the user asks to drop temporal history
 * @returns The GUI instance (for disposal)
 */
export function createBenchUI(
    state: BenchState,
    onPipelineChange: () => void,
    onResetHistory: () => void,
): GUI {
    const gui = new GUI({ title: 'FSR3 Bench' });

    gui.add(state, 'mode', {
        'Native (full res)': 'native',
        'Bilinear upscale': 'bilinear',
        'FSR1 spatial (EASU+RCAS)': 'fsr1-spatial',
        'FSR3 temporal': 'fsr3-temporal',
    }).onChange(onPipelineChange);

    gui.add(state, 'quality', {
        'Native AA (1.0x)': FSRQualityMode.NativeAA,
        'Quality (1.5x)': FSRQualityMode.Quality,
        'Balanced (1.7x)': FSRQualityMode.Balanced,
        'Performance (2.0x)': FSRQualityMode.Performance,
        'Ultra Performance (3.0x)': FSRQualityMode.UltraPerformance,
    }).onChange(onPipelineChange);

    const tuning = gui.addFolder('Tuning');
    tuning.add(state, 'sharpness', 0, 1, 0.05);
    tuning.add(state, 'maxAccumulation', 4, 32, 1);
    tuning.add(state, 'exposure', 0.25, 4, 0.05);
    tuning.add(state, 'autoExposure').name('auto exposure');
    tuning.add(state, 'lockThinFeatures').name('lock thin features');

    const debug = gui.addFolder('Debug');
    debug.add(state, 'debugView', {
        Off: FSRDebugView.None,
        'Motion vectors': FSRDebugView.MotionVectors,
        Disocclusion: FSRDebugView.Disocclusion,
        Depth: FSRDebugView.Depth,
        'Accumulation age': FSRDebugView.AccumulationAge,
        Locks: FSRDebugView.Locks,
        Exposure: FSRDebugView.Exposure,
    });
    debug.add({ resetHistory: onResetHistory }, 'resetHistory').name('Reset history');

    const sceneFolder = gui.addFolder('Scene');
    sceneFolder.add(state, 'animate');
    sceneFolder.add(state, 'autoOrbit').name('auto orbit');

    return gui;
}
