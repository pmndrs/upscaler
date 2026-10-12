# @pmndrs/upscaler — Examples

Standalone, single-purpose demos of the upscaler, from a minimal starter to an
advanced integration. The gallery includes [17 — raw WebGPU](17-core-webgpu/main.ts)
and 13 Babylon examples (18–30): an analytic Frame Graph reference and twelve
mesh demos covering reconstruction, alpha, effects and shared temporal guides.

The gallery groups examples by engine: **Three.js** (16 examples and four
showcases), **Babylon.js** (13 examples, 18–30), and **Raw WebGPU** (example 17). Category links at the
top jump directly to each group.

The Three.js examples below range from a minimal starter to an
expensive screen-space effect rendered small and upscaled. WebGPU-only — open in
Chrome/Edge 113+.

```bash
npm install
npm run examples     # http://localhost:5300  (landing page links every demo)
```

The library is consumed straight from `../src` (aliased as `@pmndrs/upscaler`), so
shader/pipeline edits hot-reload here just like in the bench.

## GitHub Pages

The gallery is built by the existing Pages workflow on pushes to `main` and manual
runs. Its URL remains [pmndrs.github.io/upscaler](https://pmndrs.github.io/upscaler/).
The workflow uses `PAGES_BASE=/upscaler/`; local development uses `/`.


## Showcases

Bigger scenes built to be looked at — what the upscaler buys you, made visible —
listed first on the landing page. Their directories use an `sN-` prefix instead of a
number so they sort apart from the single-purpose demos.

| # | Showcase | Shows |
|---|----------|-------|
| S1 | **Reinvest the savings** (`s1-reinvest`) | The same GPU budget spent two ways, wiped by the mouse: upscaled from a reduced render scale with SSGI + SSR, vs native resolution with plain forward lighting. Each side's GPU ms is measured live (three's per-pass timestamps, attributed per side and read as a timeline, each side timed in isolation), and auto-balance bisects the render scale for the finest one whose effects + upscale fit inside native's cost. |
| S2 | **Raymarched fractal** (`s2-fractal`) | A fullscreen raymarched Mandelbox where every pixel runs a long distance-estimator march (up to 256 steps plus normal, AO and soft-shadow marches), so a 2–3× render scale buys back most of the frame — with measured raymarch/upscale GPU ms and a one-click native comparison. The raymarcher supplies its own hardware depth and camera-reprojection motion vectors and marches the jittered projection, so the temporal path works without a single mesh. |
| S3 | **How low can you go** (`s3-how-low`) | One log slider takes the render resolution from native to 1/8 per axis (1.6% of the pixels). The wipe is FSR temporal vs bilinear *from the same render resolution* (or vs native), so the difference is reconstruction, not render size; a nearest-neighbour loupe shows both sides pixel for pixel. Pause the orbit to watch it converge, and see where it stops holding up. |
| S4 | **Watch it converge** (`s4-convergence`) | An interactive explainer on the real temporal pipeline, paused by default: step frames, flip between the jittered input, the output and every debug buffer of the *same* frame (read from `upscaler.guides`), watch the Halton jitter fill a pixel, and compare input vs output in a magnifier. A narrated walk through one frame, in dispatch order. |

## The demos

| # | Demo | Shows |
|---|------|-------|
| 01 | **Hello FSR3** (`01-hello`) | The minimal temporal upscale — one model, no UI. The copy-paste starting point. |
| 02 | **FSR1 vs FSR3** (`02-fsr1-vs-fsr3`) | Switch bilinear → spatial → temporal and toggle features (sharpen, quality, debug views) to see what each tier buys. |
| 03 | **Split compare** (`03-split-compare`) | Native vs FSR3, same scene and instant, wiped by the mouse. |
| 04 | **Aliasing torture** (`04-aliasing-torture`) | A chain-link fence + moiré floor under a moving camera — where naive upscaling shimmers and temporal holds. |
| 05 | **Transparency & particles** (`05-transparency`) | Particles/transparents have no reliable depth or motion, so they ghost — fixed by the reactive mask, authored by hand (coverage) or auto-generated from an opaque-only render. The reactive mask's acceptance demo. |
| 06 | **Screen-space effects** (`06-screenspace-gi`) | GTAO / SSR / SSGI rendered at reduced resolution, then upscaled — the raw-`Upscaler` reference for imperative effect pipelines. |
| 07 | **TSL node** (`07-tsl-node`) | The whole upscaler as one line: `post.outputNode = upscaleScene(scene, camera)`. |
| 08 | **TSL compose** (`08-tsl-compose`) | The node composed with other TSL effects (`.mul(vignette)`) in the same post graph. |
| 09 | **Kitchen sink** (`09-kitchen-sink`) | The composable `upscale()` node driving a full SSGI+SSR stack rendered small, in one post graph, with jitter A/B. |
| 10 | **SSGI denoise** (`10-ssgi-denoise`) | Experimental documentation, not a feature: why a second temporal denoiser in front of FSR3 can't work (jitter-blind history rejection). SSGI runs with `useTemporalFiltering = false` on every path (06/09 keep the rotating pattern on since #58); the baseline is the static-pattern `DenoiseNode` recipe. The `spatial` option still re-rolls its à-trous kernel every frame, so thin features boil under it — see issue #17 / bench Q14. |
| 11 | **Reactive mask (node)** (`11-node-reactive`) | The reactive mask through the composable node — an in-graph coverage pass, toggleable to A/B ghost trails. |
| 12 | **Temporal guides** (`12-temporal-guides`) | The upscaler as a data-products provider: the split `dispatchGuides()`/`dispatchUpscale()` frame, guide textures sampled live (raw driver). |
| 13 | **Guides node** (`13-guides-node`) | The same split frame, declaratively: `temporalGuides()` publishes the bundle into the graph, a toy effect consumes disocclusion pre-upscale, `upscale({ guides })` shares one computation. |
| 14 | **Path tracer · alpha** (`14-pathtracer-alpha`) | A transparent canvas over page content: `three-gpu-pathtracer`'s WebGPU renderer accumulates at half resolution with a zero-alpha background, and the FSR1 spatial path upscales coverage along with color (issue #15). Needs network — model/HDRI and the Draco decoder are streamed. |
| 15 | **Transparent canvas** (`15-transparent-canvas`) | Alpha on the *temporal* path — coverage reconstructed from jitter, not interpolated. The acceptance demo for temporal RGBA; toggles temporal/spatial on sub-texel wires. |
| 16 | **Spatial node** (`16-spatial-node`) | `upscaleSpatial(color)`, the color-only FSR1 node, in a `RenderPipeline`: fed by an in-graph reduced-res `pass()` or an externally filled `texture()`. RCAS sharpness / `rcasDenoise` controls, an input-grain slider for the denoise to act on, and HDR neon (well above 1.0) to show RCAS sharpening highlight edges in conditioned space (#30). |

Most interactive demos have a **render scale ×** slider (1.0×–3.0×) that sweeps the
base render resolution, with the resulting size + base % shown in the HUD.

## Babylon demos

All Babylon demos target 9.29.x and use native Frame Graph allocations and history
rotation. Shared host code is in `shared/babylon`; its resource, depth, movement,
exposure and split-frame contracts are documented in
[Babylon Frame Graph](../docs/babylon-framegraph.md).

| # | Demo | Shows |
| --- | --- | --- |
| 18 | [Analytic Frame Graph](18-babylon-framegraph/main.ts) | External exposure, explicit motion, reactive mask and bilinear fallback |
| 19 | [Hello Babylon](19-babylon-hello/main.ts) | Mesh inputs, linear depth, motion and reconstruction |
| 20 | [Aliasing torture](20-babylon-aliasing/main.ts) | Thin geometry, convergence and camera/object motion |
| 21 | [Native / temporal](21-babylon-compare/main.ts) | Unjittered native reference with a movable divider |
| 22 | [Transparency](22-babylon-transparency/main.ts) | Alpha-blended meshes and a derived reactive mask |
| 23 | [Spatial / temporal](23-babylon-spatial-temporal/main.ts) | EASU + RCAS compared with temporal reconstruction |
| 24 | [Composition](24-babylon-compose/main.ts) | A post-upscale vignette preserving alpha |
| 25 | [Authored reactive mask](25-babylon-reactive-mask/main.ts) | Geometry coverage tested against opaque depth |
| 26 | [Transparent canvas](26-babylon-transparent-canvas/main.ts) | Reconstructed silhouette alpha over HTML |
| 27 | [Screen-space effects](27-babylon-screen-effects/main.ts) | Native SSAO or SSR before upscale |
| 28 | [Effect stack](28-babylon-effect-stack/main.ts) | SSAO, SSR and HDR bloom toggled independently |
| 29 | [Temporal guides](29-babylon-temporal-guides/main.ts) | Actual dilated depth, motion and disocclusion textures |
| 30 | [Shared guides](30-babylon-guides-compose/main.ts) | A color consumer between guides and final upscale |

The SSAO/SSR pages adapt the screen-space pipeline examples; SSAO is ambient
occlusion and does not reproduce Three's diffuse SSGI. The SSGI denoiser and path
tracer remain Three-only. The four showcases also remain Three-only.

`npm run verify:babylon-examples:gpu` checks the twelve mesh demos on a production
site build, including controls, odd dimensions, NativeAA and alias optimization.
It requires a WebGPU device and stays outside the GPU-free CI test suite.

## Planned

- **DPR budget** — the mobile win, made explicit. Simulate a device
  pixel ratio (e.g. a phone at DPR 1.5–3) and compare **native render at that DPR**
  vs **FSR: render at a lower effective resolution, present at the DPR output**.
  Show total pixels rendered *and* GPU ms for both sides so the saving is a number,
  not a vibe (e.g. present at DPR 1.5 but render as if DPR 1.0 or lower). Builds on
  `03-split-compare` + the render-scale control, and adds **scene-render GPU timing**
  (see below) so the net cost — scene + upscale — is visible next to native.

## Measuring performance

The library already ships real per-pass GPU timing via WebGPU **`timestamp-query`**
([`src/internal/GpuTimer.ts`](../src/internal/GpuTimer.ts)) — `upscaler.gpuTimings`
is a per-pass map of GPU milliseconds (reconstruct / exposure / shadingChange / accumulate / rcas / …),
surfaced in the bench and `02` HUDs. It's **off by default** (it costs GPU time
every frame), so a demo that reads it opts in with `gpuTiming: true` — the examples
that show timings do. This is the hard-to-get measurement; a scene inspector can't
give you per-GPU-pass times. Notes for the DPR demo:

- It times only the **FSR passes**. To show the upscale win you also need the
  **scene-render** GPU time — three's `WebGPURenderer` exposes its own GPU
  timestamps (`renderer.trackTimestamp` / `renderer.info.render.timestamp`, resolved
  via `renderer.resolveTimestampsAsync()`; `bootRenderer({ trackTimestamp: true })`
  turns it on); combine that with `gpuTimings` for a scene + upscale total to
  compare against a native render.
- GPU times are noisy frame-to-frame — average over ~30 frames (the bench already
  accumulates) and let it warm up before reading.
- `timestamp-query` may be absent on some mobile browsers; `GpuTimer` no-ops
  gracefully, so the demo must tolerate an empty timing map.
- The three-devtools inspector is useful for draw-call counts / scene-graph / memory
  sanity, but it is *not* a substitute for `timestamp-query` GPU-pass timing.

## How they're built

Demos `01`–`05` drive the library through [`shared/UpscalePresenter.ts`](shared/UpscalePresenter.ts),
now a re-export of the library's `UpscalePass` (`15` imports `UpscalePass` directly),
which encapsulates the whole imperative integration recipe (jitter-free velocity,
MRT output count matched to the render-target attachment count, float depth, the
linear/HDR output, and renderer-owned presentation). `06` and `12` drive the raw
`Upscaler` directly (an external effect graph and the split guides frame).
`14` uses the path tracer's optional `FSRUpscaler` with our injected class and awaits its spatial driver.
`07`–`11`, `13` and `16` are the TSL-node surface — no presenter at all, the node owns
the recipe inside the post graph. New imperative demos should reuse the presenter
rather than re-deriving the wiring; new graph demos should start from `07`.
The integration guides these demos illustrate live in [`docs/`](../docs/README.md).

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

### The `14` pattern (transparent canvas)

Alpha survives every path, so a transparent canvas composites over the page.
Three things have to line up:

1. A transparent canvas — `new WebGPURenderer({ alpha: true })`, which is three's
   default (the swap chain goes to `'premultiplied'` and clears to alpha 0) — and
   `scene.background = null`, so the render leaves the background at alpha 0. Every
   other example paints `scene.background`, which is what keeps it opaque.
2. The input the upscaler is handed must actually carry that alpha — for `14` that
   is the path tracer's own RGBA accumulation target.
3. The present must keep it. `14` uses the path tracer's alpha-preserving output
   quad for the returned FSR texture. For imperative integrations,
   `UpscalePass.present()` already does this (its quad is
   `transparent: true` + `NoBlending` — a full-screen present is an overwrite, and
   an opaque material would resolve alpha to 1); a hand-rolled present quad needs
   the same two flags. The TSL nodes need nothing special.

`14` also pins the path tracer's size (`synchronizeRenderSize` and `dynamicLowRes`
off) because both resize the accumulation target behind the caller's back, while the
upscaler is configured for one fixed render resolution.

Its assets are pinned to a **commit**, not a branch. The rover model was re-compressed
upstream (meshopt → Draco) mid-development, which broke a `main`-branch URL without any
change on our side; a commit URL is immutable, so the example keeps needing exactly the
decoder it ships with. Both `DRACOLoader` and `MeshoptDecoder` are attached anyway, so
re-pointing `MODEL_URL` at another model in that data set needs no code change.

Raw and presenter examples configure first and await `init()` before their animation loop. TSL factories stay synchronous and render their input while pipelines prepare.

Example 14 uses a pinned upstream development commit and the optional FSR adapter. See [current path-tracer integration](../docs/pathtracer-current.md) for readiness, ownership and lifecycle evidence.
