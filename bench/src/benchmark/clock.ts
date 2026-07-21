/**
 * Integer-frame clock used by every automated E00 scenario.
 */
export class BenchmarkClock {
    private _frame = 0;

    get frame(): number {
        return this._frame;
    }

    get time(): number {
        return this._frame / 60;
    }

    /** Returns the current frame and advances exactly once. */
    step(): number {
        return this._frame++;
    }

    /** Restores recorded frame zero without consulting wall time. */
    reset(): void {
        this._frame = 0;
    }

    /**
     * Positions the clock at an exact integer frame.
     * @param frame - Zero-based frame index
     */
    seek(frame: number): void {
        if (!Number.isInteger(frame) || frame < 0)
            throw new Error(`Benchmark frame must be a non-negative integer: ${frame}`);
        this._frame = frame;
    }
}
