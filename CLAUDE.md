# @pmndrs/upscaler — Claude Code Instructions & Handoff

FSR1 spatial + FSR2/3-style **temporal** upscaling for three.js `WebGPURenderer`, as hand-written **WGSL compute passes**. WebGPU-only, TypeScript, no TSL, no WebGL fallback. Extracted from the homefig monorepo into this standalone repo (`pmndrs/upscaler`).

---

## ⚠️ READ FIRST: current status

**The pipeline now runs correctly on a real GPU** (verified 2026-07-07 on Apple Metal-3
via headless Chrome + CDP). All four bench modes — native, bilinear, FSR1 spatial, FSR3
temporal — render correctly, and all four debug views (motion vectors, disocclusion,
depth, accumulation age) are validated. First-GPU-boot surfaced exactly two bugs, both
now fixed (see "landmines defused" #7–#8 below).

**Renamed to `@pmndrs/upscaler`** (2026-07-10, for the move to the Poimandres org):
every public `FSR3*`/`fsr3*` identifier dropped the AMD product mark — `Upscaler`,
`UpscalePass`, `UpscalerNode`, `upscale()`/`upscaleScene()`/`upscaleSpatial()`,
`QualityMode`/`DebugView`, `UpscalerConfig`/`DispatchInputs`/`RuntimeSettings`/`UpscalePath`.
**Attribution stays** — `LICENSE` keeps AMD's MIT notice, the README credits FidelityFX
FSR (nominative fair use), and internal WGSL port names (`FsrEasuF`, `FsrConstants`,
`FLAG_*`) are kept verbatim for provenance. Re-verified on GPU the same day (bench all
modes + examples 01/05/07/09) under the new names; the reactive-on-node + external-exposure
features shipped this session are GPU-clean too.

Still true: the unit tests are GPU-free (pure math + shader-string structure); the
fidelity/tuning of the temporal path (accumulation, disocclusion thresholds, motion
convention) is correct enough to render cleanly but **not tuned** — the "landmines still
live" section remains the guide for visual regressions.

**Parity program concluded (2026-07-21):** the three source-style FSR 3.1.5 candidate
graphs were GPU-verified and A/B-benchmarked against production — **+36% / +6.5% /
+76% GPU compute with no visual win**; none adopted. Consumer-facing rationale in
`PARITY.md` (root); evidence + decisions in `bench/docs/PARITY-DECISIONS.md` /
`PARITY-CANDIDATES.md`. **Post-parity
items 1–3 landed the same day** (see `bench/docs/NEXT-STEPS.md` for evidence):
(1) RCAS now sharpens in conditioned tonemap space, inverting once — **−34% RCAS,
−5.7% total** with capture-identical output; the old form is frozen as
`RCAS_PER_TAP_SHADER` under the `rcas-fsr315-limiter` bench identity. (2) Host
pre-exposure (`preExposureTexture`) is honored end-to-end — DeltaPreExposure history
correction + host-invariant auto-exposure metering, validated on the new **Q11**
scenario, byte-identical when absent. (3) The reconstruct pass uses AMD's
viewport/depth-scaled disocclusion (per-tap confidence voting) inside the fused
single pass. **Item 4 (the multi-scale shading-change detector) landed the same session**: the
3×3-neighborhood shading heuristic is replaced by `shadingChange.ts` — a fused
multi-scale block-mean detector (0.044 ms, 5× cheaper than the candidate's
two-pass form, measurably fewer false positives under motion; five GPU tuning
iterations documented in NEXT-STEPS). Nothing from the parity program remains
open. Candidate
A/B runs: `node scripts/run-benchmark.mjs --smoke --variant <A> --comparison <B>`
(see `--help`).

If you touch shaders/passes, re-verify on a real GPU. A dependency-free way to do it
headlessly (no Playwright): launch Chrome with `--headless=new --enable-unsafe-webgpu
--remote-debugging-port=N`, drive it over the DevTools Protocol (Node 22 has a native
`WebSocket`), collect `Log.entryAdded` (WGSL validation errors surface here) +
`Runtime.consoleAPICalled`, and `Page.captureScreenshot`. lil-gui dropdowns are real
`<select>` elements you can set + dispatch `change` on to flip modes/debug views.

```bash
npm install
npm run dev        # http://localhost:5199 — open in Chrome/Edge 113+ (real WebGPU)
```

When something breaks after an edit, expect failures in this order of likelihood:
1. **WGSL validation errors** at pipeline creation (binding types, storage formats, struct layout). The browser console prints exact line/column — these are quick.
2. **Bind-group / layout mismatches** — a pass's `createBindGroup` entry order must match its WGSL `@binding` order.
3. **Visual wrongness** even when it runs: black output, garbage history, smearing, wrong colors. Use the debug views (below) to localize before touching shader math.

Don't trust "it builds" as "it works." Drive the real bench.

Bench caveat (measured 2026-07-21): benchmark runs launched from a scratchpad
**git worktree** read ~3× slower absolute GPU times, uniformly across all passes
(the GPU never leaves its low power state — likely cold-vite frame delivery).
A/B comparisons *within* that environment are valid; never compare worktree
absolutes against repo-run records. Also: a `node_modules` **symlink** in a
worktree isn't matched by the root `.gitignore`'s `node_modules/` pattern
(trailing slash ≠ symlink) and crashes the benchmark's working-tree digest —
`.git/info/exclude` carries a slash-less `node_modules` entry for this.

---

## Commands

```bash
npm run dev        # interactive bench (Vite, port 5199)
npm run examples   # standalone example gallery (Vite, port 5300)
npm test           # vitest — jitter math, quality presets, WGSL module assembly
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # library build → dist/ (vite lib + tsc declarations)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on push/PR. No GPU in CI, so tests are deliberately GPU-free (pure math + shader-string structure). **Keep it that way** — don't add tests that need a device to CI; they'll hang or fail.

---

## Repo layout

```
src/
  index.ts             — public exports
  Upscaler.ts      — THE low-level API + pass orchestration (start here)
  UpscalePass.ts          — high-level public drop-in (MRT/jitter/present recipe; ex-UpscalePresenter)
  UpscalerNode.ts          — the same recipe as a TSL node: upscale(scene, camera) for PostProcessing graphs
  types.ts             — QualityMode, DebugView, config/settings/dispatch types
  math/                — halton, jitter sequencing, resolution presets (all unit-tested)
  shaders/
    common.ts          — shared WGSL chunks: FsrConstants UBO, color/depth/tonemap helpers, FLAG_* bits
    wgsl.ts            — assembleShader() dedup concatenator (WGSL has no #include)
    blit / easu / rcas / reconstruct / shadingChange / accumulate / luminancePyramid / generateReactive / debug .ts  — the passes
    README.md          — per-pass fidelity vs FidelityFX reference + debugging guide
  internal/
    threeWebGPU.ts     — getDevice() / getGPUTexture(): the three-internals bridge
    ConstantsBuffer.ts — CPU writer for the FsrConstants UBO (layout MUST match common.ts)
    ComputePass.ts     — thin compute-pipeline + bind-group wrapper
    GpuTimer.ts        — timestamp-query profiler (degrades to no-op)
bench/                 — Vite test bench (own vite.config.ts, own tsconfig include)
  src/main.ts          — boot, UI state, stats, render loop
  src/BenchPipeline.ts — render target + velocity MRT wiring, dispatch, present quad (THE integration reference)
  src/BenchScene.ts    — aliasing-torture scene
  src/BenchUI.ts       — lil-gui panel
examples/              — standalone example gallery (own vite.config.ts, port 5300)
  shared/UpscalePresenter.ts — reusable driver: the BenchPipeline recipe as a helper (every demo but 06 uses it)
  shared/boot.ts, props.ts — WebGPU bootstrap + shared scene props
  01-hello … 09-kitchen-sink — single-purpose demos (see examples/README.md).
                         07/08 = the upscaleScene() node; 09 = the composable upscale()
                         node driving a full SSGI+SSR stack in one post graph.
```

Read `Upscaler.ts` and `bench/src/BenchPipeline.ts` together first — the second is the canonical example of how the first is meant to be driven. `examples/shared/UpscalePresenter.ts` is the same recipe packaged as a reusable helper; `examples/06-screenspace-gi` is the reference for feeding FSR3 the output of a TSL post-processing graph (GTAO/SSR/SSGI) rendered at reduced resolution.

---

## Architecture (the load-bearing decisions)

- **Raw WebGPU on three's device.** We grab `renderer.backend.device` and dispatch our own compute passes on our own `GPUCommandEncoder`, submitted **between** three's scene render and the presentation draw. Queue ordering guarantees correctness with zero explicit sync. Not TSL — deliberately, so the WGSL reads like AMD's originals and we control performance.
- **three internals we depend on** (all in `internal/threeWebGPU.ts`, verified against **three r184**):
  - `renderer.backend.device` → the `GPUDevice`
  - `renderer.backend.get(texture).texture` → the raw `GPUTexture` behind a three texture
  - These are **private**. `threeWebGPU.ts` throws loudly if the shape changes. **If you bump three, re-verify these two accessors first** — they're the most likely thing to break on upgrade.
- **Output is a three `StorageTexture`** — the upscaler writes into it, the caller samples it like any texture. Presenting is ordinary three code (a fullscreen quad).
- **One shared 256-byte constants UBO** (`ConstantsBuffer` ↔ `WGSL_CONSTANTS` in `common.ts`), bound at `@group(0) @binding(0)` in every pass, written once per frame. **The two layouts must stay byte-for-byte in sync** — f32/u32 indices in `ConstantsBuffer.ts` map to documented byte offsets in the WGSL struct. If you add/reorder a field, change **both** or everything silently corrupts.
- **Color spaces:** temporal accumulation happens in invertible-tonemap space (`c/(1+max(c))`, FSR2's firefly guard), then RCAS/blit reverse that conditioning and write `rgba16float` in the caller's linear/HDR domain. The upscaler never applies ACES, an output transfer function, or another presentation transform. EASU leaves its caller-provided input domain unchanged. Presentation belongs to the consuming renderer/post graph.
- **Jitter/velocity:** projection is jittered via `camera.setViewOffset` (same as three's TRAA). Motion vectors must be **jitter-free**, so the scene's `velocity` node gets `upscaler.unjitteredProjectionMatrix` (a stable Matrix4 instance whose contents refresh each `beginFrame`).

---

## Landmines already defused (don't re-break these)

These were discovered by reading three's source; they're non-obvious and easy to regress:

1. **MRT routes by texture `.name`.** `renderer.setMRT(mrt({ output, velocity }))` matches attachments to render-target textures *by name*. The RT's `textures[0].name` / `[1].name` **must** be `'output'` / `'velocity'`. See `BenchPipeline.configure`.
2. **`StorageTexture` defaults `generateMipmaps = true`** → three allocates a mip chain and the storage view breaks. The output texture sets `generateMipmaps = false`, and storage views are pinned to `{ baseMipLevel: 0, mipLevelCount: 1 }` (`_outputView()`). Keep both.
3. **Combined depth-stencil formats need a depth-only view** (`{ aspect: 'depth-only' }`) to bind as `texture_depth_2d`. `_encodeTemporal` branches on `format.includes('stencil')`.
4. **Reversed depth:** we read `renderer.reversedDepthBuffer` and set a flag; `linearizeDepth` in `common.ts` handles both conventions + ortho. If depth debug view is full-screen-flashing, this flag is the suspect.
5. **Present quad setup:** `depthTest/depthWrite/fog = false` on the quad material. The FSR output is linear/HDR, so the renderer's normal output transform should run when presenting to screen. The examples choose `ACESFilmicToneMapping` + `SRGBColorSpace`; library users own that policy.
6. **Bench Vite needs `build.target: 'esnext'`** — `main.ts` uses top-level `await renderer.init()`.
7. **MRT output count must match the RT attachment count.** Rendering the scene into a `count: 2` `RenderTarget` while `setMRT(null)` (or an MRT without the velocity output) leaves **color attachment 0 unwritten → black output**. This is why non-temporal bench modes were black on first GPU boot. Fix: size the RT to the mode (temporal → `count: 2` + `mrt({ output, velocity })`; everything else → `count: 1` + `mrt({ output })`). See `BenchPipeline.configure`/`render`. **Any integration (incl. examples / `UpscalePresenter`) must keep these two counts in lockstep.**
8. **WGSL parses `a < b, c > d` as a template argument list.** `select(d < bestDepth, d > bestDepth, reversed)` failed to compile (`parsed as template list`). Wrap comparisons that put `<` … `>` in one expression in parentheses: `select((d < bestDepth), (d > bestDepth), reversed)`. Watch for this whenever a shader compares with both `<` and `>` nearby.
9. **WGSL reserves more keywords than you expect.** `target` is reserved (also `filter`, `sampler_state`, `enum`, `typedef`, `mat`, …) — a `let target = …` fails with `'target' is a reserved keyword`, and the whole pipeline then cascades into `Invalid ComputePipeline` / `Invalid BindGroup` warnings that hide the one real error. When a new pass invalidates the whole `upscale` command buffer, grep the console for `reserved keyword` / `parsing WGSL` first. (`luminancePyramid.ts` hit this on first GPU boot — `target` → `targetExposure`.) The structural unit tests can't catch this; only a real device parse does.

---

## Landmines still live (unverified — prime suspects when it misbehaves)

- **Motion vector sign/scale.** `motionScale = (0.5, -0.5)` converts the `velocity` node's NDC delta to a UV delta, and reprojection is `prevUV = uv - motion`. **Corroborated against three's own `TAAUNode`** (2026-07-08), which uses the identical `velocity.xy * vec2(0.5, -0.5)` scale and `historyUV = uv - offset` reprojection, plus the same `setViewOffset` jitter in render-pixel units — so this is no longer a guess. Still the first thing to re-check if history smears or tears under camera motion; **Motion Vectors debug view is your friend.**
- **Accumulation tuning.** Catmull-Rom history filter, YCoCg variance-clip gamma (`CLIP_GAMMA = 1.0`), disocclusion/clip weight falloffs, **and the luminance-lock constants (`LOCK_*`)** in `accumulate.ts` are sensible defaults, not tuned. Ghosting → tighten (lower `LOCK_CLAMP_RELAX`/`LOCK_HISTORY_BOOST`, raise the peak/contrast thresholds); instability/shimmer or thin features dimming → loosen. Use `DebugView.Locks` to see where locks form.
- **Shading-change tuning** (`shadingChange.ts`: `SHADING_FLOOR_MID/COARSE/CV`; `accumulate.ts`: `SHADING_AGE`) — GPU-tuned on Q1/Q4/Q9/Q11 (2026-07-21) but still constants, not laws. Ghosting after a genuine lighting change → lower the floors; flat steadily-lit surfaces shimmering → raise them (raise `SHADING_FLOOR_CV` if the noise sits on textured regions). `DebugView.ShadingChange` should be near-black on a still scene — check it before suspecting the accumulate blend. Slow ramps deliberately don't fire (1-frame comparison; the blend tracks ramps — verified no lag on Q9).
- **Auto-exposure constants** (`luminancePyramid.ts`: `EXPOSURE_KEY`, `EXPOSURE_MIN/MAX`, `ADAPT_SPEED`) are defaults. Because exposure is divided back out before display, the *visible* effect is subtle (better accumulation stability, not a brightness change). If a scene pulses in brightness, `ADAPT_SPEED` is the suspect; if the image goes flat/washed on a very bright or dark scene, check the min/max clamp. `DebugView.Exposure` should read near mid-grey — verify there before suspecting the accumulate math.
- ~~**Depth separation threshold** in `reconstruct.ts` is a guess~~ — **resolved 2026-07-21**: replaced by AMD's viewport/depth-scaled formulation (`1.37e-5 · halfViewportWidth · maxDepth`, per-bilinear-tap confidence voting from `ffx_fsr2_depth_clip.h`), GPU-validated on Q3 (thin stable outlines, still scenes quiet, age resets confined to trails). **Amended 2026-07-22** (grazing-plane flicker found via example 12): taps at/behind the current surface are skipped, never vetoing the pixel (the ported running-AND veto was a misreading of upstream — the candidate shaders still carry it, frozen as evidence); reprojection is jitter-delta-compensated; tolerance is widened by the dilation ring's own depth relief (cross-frame gather must absorb one-texel slope mismatch that upstream's same-frame scatter sidesteps). Still no scene-tuned constants. If grazing-angle disocclusion flickers again, re-measure with the example-12 disocclusion quadrant diff before touching constants.
- **`timestamp-query`** may be absent; `GpuTimer` no-ops gracefully, but confirm the GPU-ms readout actually appears where supported.

---

## Debugging protocol (visual)

`settings.debugView` (`DebugView`) renders pipeline internals instead of the final image. When something's wrong, check **in this order** — each rules out an upstream stage:

1. **Motion vectors** — static scene + moving camera should be smooth gradients, no per-object noise. Per-object flashing ⇒ previous model matrices not tracked (velocity node bypassed, or MRT not wired).
2. **Disocclusion** — thin, stable outlines around moving silhouettes. Full-screen flashing ⇒ depth linearization / reversed-depth flag wrong.
3. **Accumulation age** — should saturate to white within ~1s when still, reset along disocclusion trails. Never whitening ⇒ history not persisting (ping-pong or reset logic).
4. **Locks** — lights up on thin high-contrast features (grid lines, wire/fence edges, specular silhouettes), black on flat surfaces. All-black ⇒ thresholds too high (thin features dim); lit everywhere ⇒ too low (ghosting).
5. **Exposure** — exposed scene luma should read near mid-grey everywhere. All-black/all-white ⇒ exposure pinned at its min/max clamp.
6. **Shading change** — black on a static steadily-lit scene; fires as clean single-frame spikes on light steps (moving specular, animating light). Lit everywhere while still ⇒ `SHADING_FLOOR_*` too low (see `shadingChange.ts`).
7. **Reactivity** — the caller's reactive mask (white on flagged transparents/particles, black on opaque). Empty/misaligned ⇒ the mask isn't authored/passed right.

Full guide in `src/shaders/README.md`.

---

## Feature status (all shipped & GPU-verified)

The pipeline is feature-complete. This section records each feature's mechanism and its
traps — the "why" a future change must not break. The examples double as the validation
harness: locks on `04-aliasing-torture`, the reactive mask on `05-transparency` (its
explicit acceptance test), RCAS denoise on `06-screenspace-gi`.

**Temporal fidelity:**
- **Luminance-stability locks.** Persistent display-res lock buffer in `accumulate.ts` (r = lifetime, g = locked luma), reprojected through motion; detects thin luminance outliers, grows a lock while present, breaks on disocclusion/shading change, then widens the rectification AABB + boosts history for locked pixels. Toggle `settings.lockThinFeatures` (`FLAG_LOCKS`); inspect via `DebugView.Locks`. Tuning constants (top of `accumulate.ts`) are defaults, not final — tighten if thin features ghost, loosen if they still dim.
- **Auto-exposure.** `luminancePyramid.ts` reduces the scene to a single log-average luminance (one-workgroup 32×32-tap reduction; no mip chain — nothing consumes intermediate mips) → a pre-exposure eased over time (eye-adaptation). `accumulate.ts` pre-exposes the input before the invertible tonemap; `rcas.ts`/`blit.ts` divide it back out before display — so HDR scenes of very different brightness accumulate in the same well-conditioned range **without changing final brightness**. Toggle `settings.autoExposure` (`FLAG_AUTO_EXPOSURE`); inspect via `DebugView.Exposure`. Constants (top of `luminancePyramid.ts`: key/min/max/adapt-speed) are defaults.
  - **External exposure input.** An app that meters its own exposure feeds it via `dispatch({ exposureTexture })` (value in the red texel, any float format); it overrides both auto and fixed exposure and is still divided back out before display (conditions accumulation, not brightness). Wired as binding 5 of the pyramid pass behind `FLAG_EXTERNAL_EXPOSURE` (the 1024 bit) and funnelled through the same single `select`, so downstream passes are untouched and `avgLum` stays our own measurement for the shading detector. Bound to the reactive dummy as a placeholder when absent. Also on the composable node as `options.exposureTexture` (mirrors FSR3's `exposure` dispatch resource).
  - **Host pre-exposure (`preExposureTexture`).** DeltaPreExposure history correction + host-invariant auto-exposure metering (auto-exposure must not chase a step the app already metered — skipping this reads as a ~2s full-screen false shading change). Validated on the Q11 bench scenario; byte-identical output when the input is absent.
- **Shading-change detector** (multi-scale form, 2026-07-21). `shadingChange.ts` (one fused half-res dispatch) compares jitter-aligned block-mean luma at 4×4/8×8 render scales against a 1-frame luma history, with contrast-adaptive noise floors and disocclusion neutralization; the response ages **non-locked** history via accumulate's `SHADING_AGE` path so changed surfaces re-converge. Costs 0.044 ms at ratio 2; zero when off (pass not dispatched). A lock fully suppresses the aging — and note the detector must NOT drive lock-breaking: a thin bright feature's history always disagrees with its block mean, so feeding `shadingChange` into the lock-break would break every lock (regression caught in GPU verification 2026-07-08; locks keep their own self-referential break term). Toggle `settings.detectShadingChanges` (`FLAG_SHADING_CHANGE`); inspect via `DebugView.ShadingChange` (packed into the locks buffer's `.b`).
- **Reactive-mask input.** Optional `dispatch({ reactive })` render-res mask (red = reactivity); flagged pixels suppress locks, keep near-zero accumulation, and snap to the current frame (`REACTIVE_STRENGTH` in `accumulate.ts`). No mask → a 1×1 zero texture is bound and `FLAG_REACTIVE` stays off (zero cost). `UpscalePresenter.setReactiveMask()` threads it through; `examples/05-transparency` authors one by rendering the transparents' coverage and is the acceptance demo. Inspect via `DebugView.Reactivity`. **Node parity:** `upscale()` / `UpscalerNode` take `options.reactive` and `options.reactiveOpaqueColor` texture nodes (registered as graph deps so the opaque buffer renders in-pipeline, jittered, aligned with color). No dedicated node demo — it reuses the GPU-verified reactive dispatch (example 05, imperative) + the proven graph-dep mechanism (examples 07/09), so worst case on a plumbing miss is a silent no-op, not a crash.
- **Reactive-mask authoring helper.** `dispatch({ reactiveOpaqueColor })` auto-generates the mask from the opaque-vs-final color diff (`generateReactive.ts`, FSR2's `GenerateReactiveMask`); no explicit `reactive` mask needed. `UpscalePresenter.setReactiveOpaqueColor()` threads it; `examples/05-transparency` offers manual-coverage vs auto-diff. Caveat: jitter the opaque pass like the final or high-contrast edges leave faint reactivity (sub-pixel misalignment).
- **RCAS denoise variant.** `rcas.ts` has FSR1's `FSR_RCAS_DENOISE` path (attenuate the sharpening lobe on lone luma outliers so grain from noisy inputs isn't amplified), gated by `settings.rcasDenoise` (`FLAG_RCAS_DENOISE`, off by default). Pairs with an upstream spatial denoiser; `examples/06-screenspace-gi` toggles it on for the reduced-res SSR/GI.

**Public surfaces** (both GPU-verified):
- **`UpscalePass`** (`src/UpscalePass.ts`) — the imperative drop-in (graduated from `UpscalePresenter`, which is now a re-export shim). Bakes in the MRT/jitter/velocity/present recipe. Covers renderer-agnostic / non-graph use.
- **TSL nodes** (`src/UpscalerNode.ts`, native TSL, no pmndrs dep) — "the future" surface. **One node, one code path** — modelled on three's own `FSR1Node` / `TAAUNode`:
  - **`upscale(color, depth, velocity, camera, options)`** (`UpscalerNode`) — the composable node, consumes reduced-res texture nodes and outputs the upscaled result. **The key mechanism** (this is what a first attempt got wrong and rendered black): the inputs must be *graph dependencies* so three renders them in-graph, in dependency order, before this node's `updateBefore`. three discovers child nodes by walking the node's **own non-`_`-prefixed** properties (`Node._getChildren`) — our fields are `_`-prefixed, so `setup()` registers the inputs explicitly into `builder.getNodeProperties(this)` (exactly as `FSR1Node` does with `properties.textureNode`). With that, jitter (applied via the `onBeforeRenderPipeline` hook, like `TAAUNode`) lands because the inputs render *inside* the post render. The factory `convertToTexture`s the color (a no-op for texture/pass nodes, which is why reduced-res pass outputs keep their size — the caller controls input resolution). `UpscalerConfig` has `renderWidth`/`renderHeight` so the node matches an externally-sized input exactly.
  - **`upscaleScene(scene, camera, options)`** — a thin convenience, **not** a separate class: it builds `pass(scene, camera)` with a `{ output, velocity }` MRT at `1/ratio` and hands the texture nodes to `upscale(...)` — the same shape as three's `taau(pass.getTextureNode('output'), …)`. So the scene renders in-graph as an FSR3 input, jitter and all. `post.outputNode = upscaleScene(scene, camera)`. Examples `07-tsl-node`, `08-tsl-compose` (`.mul(vignette)`); the full SSGI/SSR stack is `09-kitchen-sink`.
  - **`upscaleSpatial(color, options)`** — color-only **spatial** (FSR1/EASU) node for inputs with no motion data: no depth/velocity/camera, no history, no reconstruction. A thin facade over `path: 'spatial'` with a stand-in camera (EASU reprojects nothing; `_writeConstants` still stages `near`/`far`, which the shader ignores, so any finite values keep NaN out of the UBO). It exists so the "I only have a color texture" case has a clean door instead of `upscale(color, null, null, camera, { path: 'spatial' })` — and so defaulting the *temporal* node to jitter-on isn't a trap.
  - **Jitter default = ON for temporal** (`UpscalerConfig.jitter`, `UpscalerNodeOptions.jitter`): jitter buys *reconstruction* (detail beyond render res) but only if the input is re-rendered under the jittered projection each frame. Because a composable node's inputs are graph dependencies three renders *in-pipeline* — after this node's `onBeforeRenderPipeline` jitter hook offsets the camera — the offset **does** land on them, so **both** `upscale()` and `upscaleScene()` default jitter **on** (this is how real FSR/DLSS run). Opt **out** (`{ jitter: false }`) only when the input is *not* re-rendered in-graph — an externally-filled `texture()`, or a noisy GI/RT buffer you want reprojected/denoised but not reconstructed (the raw `Upscaler` / example 06 is usually the better fit there). Jitter-off stays a full temporal upscale (reproject + accumulate + denoise), just no sub-pixel offset. When off, `beginFrame` no-ops `setViewOffset`, jitter constants stay zero, and the node skips the hook + velocity compensation. A temporal node that never receives depth+velocity `console.warn`s once. `09-kitchen-sink` toggles jitter on the same in-graph pipeline to A/B it.
  - Color path (both): the node emits linear/HDR color. When it is the final graph node, three's RenderPipeline applies the renderer's configured tone mapping and output color space; otherwise it can feed later linear post-processing. **Note:** three renamed `PostProcessing` → `RenderPipeline` (deprecation warning only).
  - The composable node *does* render its inputs in-graph, so an SSGI-in-a-graph pipeline jitters correctly and there's no owning-render/consuming-inputs split. An imperative pipeline that composites *outside* the post render (its own RT loop) still wants the raw `Upscaler` — `examples/06-screenspace-gi` stays on it as the imperative reference.
- **Temporal guides (experimental, branch `feat-temporal-guides`).** The production
  working set is published as `upscaler.guides` (`TemporalGuides` — dilated
  motion/depth, disocclusion, reactive, shading change, exposure, locks, history)
  and the frame can be driven split: `dispatchGuides({depth, velocity})` right
  after the G-buffer (geometry guides only — reconstruct is the whole early
  stage), then `dispatchUpscale({color, …})`; `path: 'guides'` runs the early
  stage alone with no output texture. Contracts + program plan:
  `TEMPORAL-GUIDES-SPEC.md` (root); consumer M0 review: `GUIDES-SPEC-RESPONSE.md`.
  **Mechanisms a change must not break:** (1) guide textures are allocated via
  `_createSharedTexture` — a three `StorageTexture` + `initTexture()`, with the
  raw handle fetched back through `getGPUTexture()`; passes bind the raw handle,
  consumers sample the three texture, and the two must stay the same allocation.
  r32float products are pinned `NearestFilter` (non-filterable format — a linear
  sampler on them is a WebGPU validation error). (2) Ping-ponged products resolve
  through `_latestDepthWrite`/`_latestHistoryWrite` (set at encode time), NOT the
  frame-end-flipped `_depthIndex`/`_historyIndex` — the getters must be correct
  both mid-frame (between the split dispatches) and after the frame. (3) The
  monolithic `dispatch()` stays one submit (`_encodeGuides` + `_encodeLate` on one
  encoder) — GPU-verified byte-identical (Q0 captures) and perf-neutral (−2.7%,
  within noise) against the pre-split pipeline; keep it that way. (4) A split
  frame is two submits, so `GpuTimer` merges per-label results instead of
  replacing the map. (5) Frame-end bookkeeping (index flips, `_frameIndex`,
  `_pendingReset`) happens exactly once per frame: in `dispatch()`, in
  `dispatchUpscale()`, or — guides path only — in `dispatchGuides()`.
  `examples/12-temporal-guides` is the live reference + headless-verification
  target (it exposes `window.__guidesExample` — including `MomentsPass` and
  `THREE` — for the CDP harness). Also in this program: reactive is
  merge-not-overwrite (`generateReactive` max-merges an incoming mask;
  passing `guides.reactive` back while `reactiveOpaqueColor` is set throws —
  the generator writes that texture), and `MomentsPass`/`shaders/moments.ts`
  is a standalone signal-agnostic statistics primitive with **zero coupling**
  to the pipeline (its `FLAG_MOMENTS_YCOCG` bit is declared locally in
  moments.ts, deliberately NOT in `WGSL_CONSTANTS` — adding anything to the
  shared chunk re-fingerprints every shader).
- **MSAA input — rejected by design.** FSR's temporal path *is* the anti-aliaser (Native AA mode is exactly that), so the correct input is an aliased, single-sample, jittered render with MSAA **off** — MSAA is redundant with FSR's own AA, costs perf, and a multisampled texture can't even bind to the compute passes. (Stacking a *temporal* AA — TAA/`traa` — before FSR is worse still: double-jitter smear; example 06 already drops `traa` for this reason.) `Upscaler` warns once if handed a multisampled input (`_checkMsaa`).

**Performance structure:** dilate + depth-clip are fused into the single `reconstruct.ts` dispatch (GPU-verified disocclusion unchanged); the shading detector is one fused workgroup-local reduction instead of the source's SPD mip chain + resolve pair. The measured story of these divergences from FSR 3.1.5 — and the four upstream behaviors adopted in re-derived form — is `PARITY.md` (root) with evidence in `bench/docs/NEXT-STEPS.md`.

**Paper material:** findings that clear the "surprised us + measured + others would hit it" bar are tracked in `PAPER-NOTES.md` (root) — claim, evidence pointers, and what a publication-grade version still needs. Add new entries there as they land; don't let them live only in commit messages.

## Deferred / out of scope

- **Transparency & Composition (T&C) mask** — deliberately deferred (assessed 2026-07-10). FSR2/3 takes a second render-res mask alongside reactive, but it is *not* a clean parallel: in FSR2 the T&C mask has a distinct-but-overlapping effect (a softer history-distrust than reactive, it widens the rectification AABB and interacts with locks) that is genuinely tuned. Adding it means new tuning constants and touching the accumulate blend/lock path, and our reactive mask (+ auto-generate) already covers the common three.js transparency case (example 05's whole point). Shipping it as a second channel that behaves identically to reactive would be misleading; shipping the *real* distinct behavior needs core tuning we shouldn't ride onto other work. Revisit if a user actually authors T&C masks and the reactive path proves insufficient.
- **Perf-only micro-optimizations (no quality gain, correctness risk):** `textureGather` tap packing (EASU/RCAS currently use per-tap `textureLoad` — but these are the AMD-faithful ports; changing their sampling risks subtle artifacts); f16 arithmetic (`shader-f16`, needs feature detection + fallback, precision risk); bind-group caching (rebuilt per dispatch — "fine but wasteful," but caching adds stale-view-on-resize risk to the core); half-res luma analysis. None gain image quality; each adds risk to a core path the project deliberately protects — do them only when perf is the actual bottleneck.
- **Future project — fused GI/denoise temporal path.** Denoising very noisy screen-space inputs (SSGI especially) can't be solved by stacking a *separate* temporal denoiser before FSR3: any second temporal resolver reprojects by velocity, which is jitter-free, so it can't see FSR3's sub-pixel jitter — it rejects the misaligned history (noise survives) and cancels the jitter variance FSR3 needs (aliasing returns). Verified 2026-07-10 with three r185's `recurrentDenoise`/`temporalReproject` in `examples/10-ssgi-denoise` (kept as **experimental documentation**, not a library feature). Spatial-only denoise + FSR3-owns-temporal avoids the conflict but inherits the third-party à-trous kernel's halos/step-lines/update-cadence skipping. The real fix is to **fuse GI history into FSR3's own accumulation** — reprojected with *our* motion vectors, sampled at *our* jitter, with GI-appropriate variance handling (not the AA-tuned clip). This is genuine R&D that touches the core accumulate pass, so it's a deliberate future effort, not a quick add. Priority remains the FSR3 upscaler itself; don't spend core complexity bending upstream nodes to it.
- **Frame generation** (the other half of "FSR3") — needs swapchain frame pacing browsers don't expose.

---

## Conventions

Follow the existing style:
- **Comments explain "why," not "what."** Use `//*` for Title-Case section headers inside larger functions/classes, plain `//` for sub-notes. Don't narrate self-evident code.
- **Full TSDoc** (`@param`/`@returns`) on every exported function and the public class; exported types get a doc block.
- WGSL passes: keep the shared-chunk + `assembleShader()` pattern; every pass binds the constants UBO at binding 0, uses 8×8 workgroups, guards against grid overrun (`if (any(vec2f(gid.xy) >= C.<size>)) { return; }`), entry point `main`. The `shaders.test.ts` structural tests enforce most of this — run them after editing any shader.
- Keep new CI tests GPU-free.

## Provenance / license

MIT (`LICENSE`). The EASU/RCAS WGSL derives from AMD's MIT-licensed FidelityFX (`ffx_fsr1.h`); AMD's copyright notice is in `LICENSE`. Preserve it. If more FidelityFX stages are ever ported, keep the "faithful port vs. simplification" table in `src/shaders/README.md` honest.
