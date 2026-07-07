import { generateJitterSequence } from './halton';

/**
 * Computes the jitter phase count for a given upscale ratio, following the
 * FidelityFX SDK formula (`ffxFsr2GetJitterPhaseCount`):
 * `phaseCount = 8 * ratio²`.
 *
 * The intuition: a 2× upscale means each display pixel sees 1/4 of a render
 * pixel's samples per frame, so the sequence must be 4× longer to cover the
 * pixel footprint at display-pixel density.
 *
 * @param upscaleRatio - displaySize / renderSize (per axis, ≥ 1)
 * @returns The number of jitter phases before the sequence repeats
 */
export function getJitterPhaseCount(upscaleRatio: number): number {
    return Math.max(1, Math.round(8 * upscaleRatio * upscaleRatio));
}

/**
 * Cyclic provider of sub-pixel jitter offsets for the temporal upscaler.
 *
 * Offsets are in render-resolution pixel units, centered on zero, and are
 * meant to be applied via `camera.setViewOffset` (the same mechanism three's
 * TRAA node uses) so both perspective and orthographic cameras work.
 */
export class JitterSequence {
    private _sequence: Array<[number, number]>;
    private _index = 0;

    constructor(upscaleRatio: number) {
        this._sequence = generateJitterSequence(getJitterPhaseCount(upscaleRatio));
    }

    /** Number of phases before the sequence repeats. */
    get phaseCount(): number {
        return this._sequence.length;
    }

    /** The current offset in pixels, `[-0.5, 0.5]²`. */
    get current(): [number, number] {
        return this._sequence[this._index % this._sequence.length];
    }

    /** The previous frame's offset in pixels. */
    get previous(): [number, number] {
        const prev = (this._index + this._sequence.length - 1) % this._sequence.length;
        return this._sequence[prev];
    }

    /** Advances to the next jitter phase. */
    advance(): void {
        this._index = (this._index + 1) % this._sequence.length;
    }

    /** Restarts the sequence (e.g. after a history reset). */
    reset(): void {
        this._index = 0;
    }

    /**
     * Rebuilds the sequence for a new upscale ratio.
     * @param upscaleRatio - displaySize / renderSize
     */
    setRatio(upscaleRatio: number): void {
        this._sequence = generateJitterSequence(getJitterPhaseCount(upscaleRatio));
        this._index = 0;
    }
}
