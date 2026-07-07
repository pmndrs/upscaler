import type GUI from 'lil-gui';

/**
 * Adds a continuous "render scale" slider (upscale ratio 1.0×–3.0×) so a demo
 * can sweep the base render resolution instead of being pinned to one preset.
 * `1.0×` renders at display resolution (native AA); `2.0×` renders at 50% per
 * axis (a quarter of the pixels); `3.0×` at 33% per axis.
 *
 * @param gui - The lil-gui instance (or folder)
 * @param state - An object with a numeric `ratio` field to bind
 * @param onChange - Called after the ratio changes (reconfigure the pipeline)
 */
export function addRenderScale(gui: GUI, state: { ratio: number }, onChange: () => void): void {
    gui.add(state, 'ratio', 1.0, 3.0, 0.05)
        .name('render scale ×')
        .onChange(onChange);
}

/** Base render size as a per-axis percentage of display, e.g. `2.0 → "50%"`. */
export function basePercent(ratio: number): string {
    return `${Math.round(100 / ratio)}%/axis`;
}
