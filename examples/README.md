# @pmndrs/upscaler — Examples

Standalone, single-purpose demos of the upscaler, from a minimal starter to an
expensive screen-space effect rendered small and upscaled. WebGPU-only — open in
Chrome/Edge 113+.

```bash
npm install
npm run examples     # http://localhost:5300  (landing page links every demo)
```

The library is consumed straight from `../src` (aliased as `@pmndrs/upscaler`), so
shader/pipeline edits hot-reload here just like in the bench.

## The demos

| # | Demo | Shows |
|---|------|-------|
| 01 | **Hello FSR3** (`01-hello`) | The minimal temporal upscale — one model, no UI. The copy-paste starting point. |
| 02 | **FSR1 vs FSR3** (`02-fsr1-vs-fsr3`) | Switch bilinear → spatial → temporal and toggle features (sharpen, quality, debug views) to see what each tier buys. |
| 03 | **Split compare** (`03-split-compare`) | Native vs FSR3, same scene and instant, wiped by the mouse. |
| 04 | **Aliasing torture** (`04-aliasing-torture`) | A chain-link fence + moiré floor under a moving camera — where naive upscaling shimmers and temporal holds. |
| 05 | **Transparency & particles** (`05-transparency`) | The honest limitation: particles/transparents ghost (no depth/motion) — the acceptance test for a future reactive mask. |
| 06 | **Screen-space effects** (`06-screenspace-gi`) | GTAO / SSR / SSGI rendered at reduced resolution, then upscaled by FSR3. |

Every interactive demo has a **render scale ×** slider (1.0×–3.0×) that sweeps the
base render resolution, with the resulting size + base % shown in the HUD.

## Planned

- **07 · DPR budget** (`07-dpr`) — the mobile win, made explicit. Simulate a device
  pixel ratio (e.g. a phone at DPR 1.5–3) and compare **native render at that DPR**
  vs **FSR: render at a lower effective resolution, present at the DPR output**.
  Show total pixels rendered *and* GPU ms for both sides so the saving is a number,
  not a vibe (e.g. present at DPR 1.5 but render as if DPR 1.0 or lower). Builds on
  `03-split-compare` + the render-scale control, and adds **scene-render GPU timing**
  (see below) so the net cost — scene + upscale — is visible next to native.

## Measuring performance

The library already ships real per-pass GPU timing via WebGPU **`timestamp-query`**
([`src/internal/GpuTimer.ts`](../src/internal/GpuTimer.ts)) — `upscaler.gpuTimings`
is a per-pass map of GPU milliseconds (dilate / depth-clip / accumulate / rcas / …),
surfaced in the bench and `02` HUDs. This is the hard-to-get measurement; a scene
inspector can't give you per-GPU-pass times. Notes for the DPR demo:

- It times only the **FSR passes**. To show the upscale win you also need the
  **scene-render** GPU time — three's `WebGPURenderer` exposes its own GPU
  timestamps (`renderer.trackTimestamp` / `renderer.info.render.timestamp`, resolved
  via `renderer.resolveTimestampsAsync()`); combine that with `gpuTimings` for a
  scene + upscale total to compare against a native render.
- GPU times are noisy frame-to-frame — average over ~30 frames (the bench already
  accumulates) and let it warm up before reading.
- `timestamp-query` may be absent on some mobile browsers; `GpuTimer` no-ops
  gracefully, so the demo must tolerate an empty timing map.
- The three-devtools inspector is useful for draw-call counts / scene-graph / memory
  sanity, but it is *not* a substitute for `timestamp-query` GPU-pass timing.

## How they're built

Every demo drives the library through [`shared/UpscalePresenter.ts`](shared/UpscalePresenter.ts),
which encapsulates the whole integration recipe (jitter-free velocity, MRT output
count matched to the render-target attachment count, float depth, the
linear/HDR output, and renderer-owned presentation). New demos should reuse it rather than re-deriving the
wiring — the one exception is `06`, which drives the raw `Upscaler` directly
so it can feed FSR3 the output of a TSL pass graph.

### The `06` pattern (TSL effect graph → FSR3)

FSR3 is a raw compute pipeline that owns the final present, while three's
`ao()` / `ssr()` / `ssgi()` are TSL nodes that produce textures. So `06`:

1. builds a `pass(scene, camera)` G-buffer (`output`, `normalView`, `velocity`,
   plus `metalness`/`roughness` for SSR or `diffuseColor` for SSGI),
2. `setResolutionScale(1/ratio)` so the whole graph renders at FSR3's render
   resolution,
3. composites the chosen effect (spatially denoised — **no TRAA/TAAU**, so FSR3
   stays the sole temporal resolver and doubles as the effect's denoiser),
4. renders that composite into a low-res color target, and
5. hands color + the pass's depth + velocity to `upscaler.dispatch()`, which
   upscales to display resolution.

Because the pass graph compiles asynchronously, `06` waits (via an `isBacked()`
check) until the depth/velocity GPU textures exist before the first dispatch.
