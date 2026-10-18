//* Jitter diagram — a 2×2 block of render pixels with the display-pixel
//* subgrid, the sample point of every phase so far, and the current one.
// Coordinates are render pixels with y pointing down (texel space): the camera
// view offset (jx, jy) makes render texel i hold the scene at i + 0.5 + j, so
// that is where each dot sits (packages/core/src/shaders/README.md, "Jitter").

const BLOCK = 2; // render pixels per side

/** What the diagram draws for one frame. */
export interface JitterDiagramState {
    /** Upscale ratio (display / render, per axis). */
    ratio: number;
    /** The full phase cycle, `[-0.5, 0.5]²` render px (the exported Halton sequence). */
    cycle: ReadonlyArray<readonly [number, number]>;
    /** Jitters actually applied since the last reset, oldest first (at most one cycle). */
    trail: ReadonlyArray<readonly [number, number]>;
}

/**
 * Draws the jitter diagram into a 2D canvas.
 *
 * @param canvas - Target canvas (its CSS size is read; the backing store is
 *   resized to match the device pixel ratio)
 * @param state - Ratio, phase cycle and the applied-jitter trail
 */
export function drawJitterDiagram(canvas: HTMLCanvasElement, state: JitterDiagramState): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = 10;
    const size = Math.min(cssW, cssH) - pad * 2;
    const cell = size / BLOCK; // CSS px per render pixel
    const ox = (cssW - size) / 2;
    const oy = (cssH - size) / 2;
    const toX = (rx: number): number => ox + rx * cell;
    const toY = (ry: number): number => oy + ry * cell;

    //* Display cells that have received at least one sample this cycle
    // A display pixel's history can only resolve detail once a jittered sample
    // has landed inside it — the reason the cycle is 8·ratio² long.
    const dispPerSide = Math.round(BLOCK * state.ratio);
    const dispCell = 1 / state.ratio; // render px per display px
    const hits = new Array<number>(dispPerSide * dispPerSide).fill(0);
    for (const [jx, jy] of state.trail) {
        for (let py = 0; py < BLOCK; py++) {
            for (let px = 0; px < BLOCK; px++) {
                const dx = Math.floor((px + 0.5 + jx) / dispCell);
                const dy = Math.floor((py + 0.5 + jy) / dispCell);
                if (dx >= 0 && dy >= 0 && dx < dispPerSide && dy < dispPerSide) hits[dy * dispPerSide + dx]++;
            }
        }
    }
    for (let dy = 0; dy < dispPerSide; dy++) {
        for (let dx = 0; dx < dispPerSide; dx++) {
            const n = hits[dy * dispPerSide + dx];
            ctx.fillStyle = n > 0 ? `rgba(125, 211, 252, ${Math.min(0.08 + n * 0.05, 0.3)})` : 'rgba(255,255,255,0.02)';
            ctx.fillRect(toX(dx * dispCell), toY(dy * dispCell), dispCell * cell, dispCell * cell);
        }
    }

    //* Display-pixel subgrid (thin) and render-pixel grid (thick)
    ctx.strokeStyle = 'rgba(207, 216, 227, 0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= dispPerSide; i++) {
        const r = i * dispCell;
        line(ctx, toX(r), toY(0), toX(r), toY(BLOCK));
        line(ctx, toX(0), toY(r), toX(BLOCK), toY(r));
    }
    ctx.strokeStyle = 'rgba(207, 216, 227, 0.75)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= BLOCK; i++) {
        line(ctx, toX(i), toY(0), toX(i), toY(BLOCK));
        line(ctx, toX(0), toY(i), toX(BLOCK), toY(i));
    }

    //* Upcoming phases of the cycle (hollow), then the trail (filled, fading)
    for (let py = 0; py < BLOCK; py++) {
        for (let px = 0; px < BLOCK; px++) {
            ctx.strokeStyle = 'rgba(207, 216, 227, 0.18)';
            ctx.lineWidth = 1;
            for (const [jx, jy] of state.cycle) {
                ctx.beginPath();
                ctx.arc(toX(px + 0.5 + jx), toY(py + 0.5 + jy), 2, 0, Math.PI * 2);
                ctx.stroke();
            }
            const n = state.trail.length;
            state.trail.forEach(([jx, jy], i) => {
                const age = n - 1 - i; // 0 = current
                if (age === 0) return;
                ctx.fillStyle = `rgba(245, 158, 11, ${0.25 + 0.6 * (1 - age / Math.max(n, 1))})`;
                ctx.beginPath();
                ctx.arc(toX(px + 0.5 + jx), toY(py + 0.5 + jy), 2.6, 0, Math.PI * 2);
                ctx.fill();
            });
        }
    }

    //* Current phase — offset arrow from each pixel center to its sample
    const current = state.trail[state.trail.length - 1];
    if (current) {
        const [jx, jy] = current;
        for (let py = 0; py < BLOCK; py++) {
            for (let px = 0; px < BLOCK; px++) {
                const cx = toX(px + 0.5);
                const cy = toY(py + 0.5);
                const sx = toX(px + 0.5 + jx);
                const sy = toY(py + 0.5 + jy);
                ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
                ctx.lineWidth = 1.5;
                line(ctx, cx, cy, sx, sy);
                ctx.fillStyle = 'rgba(207, 216, 227, 0.6)';
                ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
                ctx.fillStyle = '#22d3ee';
                ctx.beginPath();
                ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
}
