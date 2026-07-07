# FSR3 test bench

```bash
npm run dev   # http://localhost:5199 (WebGPU browser required)
```

An aliasing-hostile scene — thin-line grid floor, torus knots with hot speculars, a picket fence, orbiting spheres, an emissive HDR hotspot — rendered at reduced resolution and upscaled to the canvas. Every mode (including native) funnels through the same render target and WGSL display transform so comparisons are honest.

## What to compare

| Mode              | What it shows                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **Native**        | Ground truth at full resolution (no AA — note the shimmer!)                                           |
| **Bilinear**      | The naive baseline: soft, crawling edges                                                              |
| **FSR1 spatial**  | Sharper edges from a single frame — but it can't invent detail, and shimmer remains                   |
| **FSR3 temporal** | Reconstructed detail _and_ anti-aliasing; watch the fence and grid lines resolve as frames accumulate |

Suggested tour:

1. Start on **FSR3 temporal / Performance (2×)** with auto-orbit on — the scene renders 1/4 the pixels of native. Pause the orbit and watch thin lines converge.
2. Flip to **Bilinear** at the same quality to see what the temporal pass is reconstructing.
3. Try **Ultra Performance (3×)** — 1/9 the pixels; edges hold up, fine texture detail softens (this is where FSR3's locks, Phase 3, would help).
4. Set quality to **Native AA (1.0×)** on the temporal path — that's pure TAA mode, the fair comparison against `Native`'s shimmer.
5. Open **Debug ▸ Motion vectors / Disocclusion** while the spheres orbit to sanity-check the inputs.

The overlay reports render vs display resolution, jitter phase count, FPS, and — on GPUs exposing `timestamp-query` — per-pass GPU milliseconds, which is the number to watch when comparing upscale cost against the saved raster time.

## Files

- `src/main.ts` — boot, UI state, stats, main loop
- `src/BenchPipeline.ts` — render target + MRT velocity wiring, upscaler dispatch, presentation quad (the integration reference for real apps)
- `src/BenchScene.ts` — the torture-test scene
- `src/BenchUI.ts` — lil-gui panel
