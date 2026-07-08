# three-fsr3 — Claude Code Instructions & Handoff

FSR1 spatial + FSR2/3-style **temporal** upscaling for three.js `WebGPURenderer`, as hand-written **WGSL compute passes**. WebGPU-only, TypeScript, no TSL, no WebGL fallback. Extracted from the homefig monorepo into this standalone repo (`DennisSmolek/fsr3`).

---

## ⚠️ READ FIRST: current status

**The pipeline now runs correctly on a real GPU** (verified 2026-07-07 on Apple Metal-3
via headless Chrome + CDP). All four bench modes — native, bilinear, FSR1 spatial, FSR3
temporal — render correctly, and all four debug views (motion vectors, disocclusion,
depth, accumulation age) are validated. First-GPU-boot surfaced exactly two bugs, both
now fixed (see "landmines defused" #7–#8 below).

Still true: the unit tests are GPU-free (pure math + shader-string structure); the
fidelity/tuning of the temporal path (accumulation, disocclusion thresholds, motion
convention) is correct enough to render cleanly but **not tuned** — the "landmines still
live" section remains the guide for visual regressions.

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
  FSR3Upscaler.ts      — THE public API + pass orchestration (start here)
  types.ts             — FSRQualityMode, FSRDebugView, config/settings/dispatch types
  math/                — halton, jitter sequencing, resolution presets (all unit-tested)
  shaders/
    common.ts          — shared WGSL chunks: FsrConstants UBO, color/depth/tonemap helpers, FLAG_* bits
    wgsl.ts            — assembleShader() dedup concatenator (WGSL has no #include)
    blit / easu / rcas / dilate / depthClip / accumulate / luminancePyramid / debug .ts  — the passes
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
  shared/FSRPresenter.ts — reusable driver: the BenchPipeline recipe as a helper (every demo but 06 uses it)
  shared/boot.ts, props.ts — WebGPU bootstrap + shared scene props
  01-hello … 06-screenspace-gi — six single-purpose demos (see examples/README.md)
```

Read `FSR3Upscaler.ts` and `bench/src/BenchPipeline.ts` together first — the second is the canonical example of how the first is meant to be driven. `examples/shared/FSRPresenter.ts` is the same recipe packaged as a reusable helper; `examples/06-screenspace-gi` is the reference for feeding FSR3 the output of a TSL post-processing graph (GTAO/SSR/SSGI) rendered at reduced resolution.

---

## Architecture (the load-bearing decisions)

- **Raw WebGPU on three's device.** We grab `renderer.backend.device` and dispatch our own compute passes on our own `GPUCommandEncoder`, submitted **between** three's scene render and the presentation draw. Queue ordering guarantees correctness with zero explicit sync. Not TSL — deliberately, so the WGSL reads like AMD's originals and we control performance.
- **three internals we depend on** (all in `internal/threeWebGPU.ts`, verified against **three r184**):
  - `renderer.backend.device` → the `GPUDevice`
  - `renderer.backend.get(texture).texture` → the raw `GPUTexture` behind a three texture
  - These are **private**. `threeWebGPU.ts` throws loudly if the shape changes. **If you bump three, re-verify these two accessors first** — they're the most likely thing to break on upgrade.
- **Output is a three `StorageTexture`** — the upscaler writes into it, the caller samples it like any texture. Presenting is ordinary three code (a fullscreen quad).
- **One shared 256-byte constants UBO** (`ConstantsBuffer` ↔ `WGSL_CONSTANTS` in `common.ts`), bound at `@group(0) @binding(0)` in every pass, written once per frame. **The two layouts must stay byte-for-byte in sync** — f32/u32 indices in `ConstantsBuffer.ts` map to documented byte offsets in the WGSL struct. If you add/reorder a field, change **both** or everything silently corrupts.
- **Color spaces:** temporal accumulation happens in invertible-tonemap space (`c/(1+max(c))`, FSR2's firefly guard); EASU/RCAS run display-referred; every path exits through one shared ACES+sRGB `displayTransform`. That's why the present quad must NOT re-tonemap (see landmines).
- **Jitter/velocity:** projection is jittered via `camera.setViewOffset` (same as three's TRAA). Motion vectors must be **jitter-free**, so the scene's `velocity` node gets `upscaler.unjitteredProjectionMatrix` (a stable Matrix4 instance whose contents refresh each `beginFrame`).

---

## Landmines already defused (don't re-break these)

These were discovered by reading three's source; they're non-obvious and easy to regress:

1. **MRT routes by texture `.name`.** `renderer.setMRT(mrt({ output, velocity }))` matches attachments to render-target textures *by name*. The RT's `textures[0].name` / `[1].name` **must** be `'output'` / `'velocity'`. See `BenchPipeline.configure`.
2. **`StorageTexture` defaults `generateMipmaps = true`** → three allocates a mip chain and the storage view breaks. The output texture sets `generateMipmaps = false`, and storage views are pinned to `{ baseMipLevel: 0, mipLevelCount: 1 }` (`_outputView()`). Keep both.
3. **Combined depth-stencil formats need a depth-only view** (`{ aspect: 'depth-only' }`) to bind as `texture_depth_2d`. `_encodeTemporal` branches on `format.includes('stencil')`.
4. **Reversed depth:** we read `renderer.reversedDepthBuffer` and set a flag; `linearizeDepth` in `common.ts` handles both conventions + ortho. If depth debug view is full-screen-flashing, this flag is the suspect.
5. **Present quad setup:** `NoToneMapping` + `LinearSRGBColorSpace` on the renderer, and `depthTest/depthWrite/fog = false` on the quad material. The FSR output is already display-referred sRGB; re-encoding double-applies the transform.
6. **Bench Vite needs `build.target: 'esnext'`** — `main.ts` uses top-level `await renderer.init()`.
7. **MRT output count must match the RT attachment count.** Rendering the scene into a `count: 2` `RenderTarget` while `setMRT(null)` (or an MRT without the velocity output) leaves **color attachment 0 unwritten → black output**. This is why non-temporal bench modes were black on first GPU boot. Fix: size the RT to the mode (temporal → `count: 2` + `mrt({ output, velocity })`; everything else → `count: 1` + `mrt({ output })`). See `BenchPipeline.configure`/`render`. **Any integration (incl. examples / `FSRPresenter`) must keep these two counts in lockstep.**
8. **WGSL parses `a < b, c > d` as a template argument list.** `select(d < bestDepth, d > bestDepth, reversed)` failed to compile (`parsed as template list`). Wrap comparisons that put `<` … `>` in one expression in parentheses: `select((d < bestDepth), (d > bestDepth), reversed)`. Watch for this whenever a shader compares with both `<` and `>` nearby.
9. **WGSL reserves more keywords than you expect.** `target` is reserved (also `filter`, `sampler_state`, `enum`, `typedef`, `mat`, …) — a `let target = …` fails with `'target' is a reserved keyword`, and the whole pipeline then cascades into `Invalid ComputePipeline` / `Invalid BindGroup` warnings that hide the one real error. When a new pass invalidates the whole `fsr3` command buffer, grep the console for `reserved keyword` / `parsing WGSL` first. (`luminancePyramid.ts` hit this on first GPU boot — `target` → `targetExposure`.) The structural unit tests can't catch this; only a real device parse does.

---

## Landmines still live (unverified — prime suspects when it misbehaves)

- **Motion vector sign/scale.** `motionScale = (0.5, -0.5)` converts the `velocity` node's NDC delta to a UV delta, and reprojection is `prevUV = uv - motion`. **Corroborated against three's own `TAAUNode`** (2026-07-08), which uses the identical `velocity.xy * vec2(0.5, -0.5)` scale and `historyUV = uv - offset` reprojection, plus the same `setViewOffset` jitter in render-pixel units — so this is no longer a guess. Still the first thing to re-check if history smears or tears under camera motion; **Motion Vectors debug view is your friend.**
- **Accumulation tuning.** Catmull-Rom history filter, YCoCg variance-clip gamma (`CLIP_GAMMA = 1.0`), disocclusion/clip weight falloffs, **and the luminance-lock constants (`LOCK_*`)** in `accumulate.ts` are sensible defaults, not tuned. Ghosting → tighten (lower `LOCK_CLAMP_RELAX`/`LOCK_HISTORY_BOOST`, raise the peak/contrast thresholds); instability/shimmer or thin features dimming → loosen. Use `FSRDebugView.Locks` to see where locks form.
- **Shading-change constants** (`accumulate.ts`: `SHADING_LO/HI/AGE`) are conservative defaults. If stable, steadily-lit surfaces shimmer or fail to converge, `SHADING_LO` is too low (it's aging history that didn't change) — raise it; if a genuine lighting change ghosts its old shading, lower it. `FSRDebugView.ShadingChange` should be black on a still scene — check it before suspecting the accumulate blend. The detector reuses the 3×3 neighborhood mean, not a coarse pyramid mip, so it can false-positive on very high-frequency content under heavy motion; that's the Phase-5 SPD-mip refinement.
- **Auto-exposure constants** (`luminancePyramid.ts`: `EXPOSURE_KEY`, `EXPOSURE_MIN/MAX`, `ADAPT_SPEED`) are defaults. Because exposure is divided back out before display, the *visible* effect is subtle (better accumulation stability, not a brightness change). If a scene pulses in brightness, `ADAPT_SPEED` is the suspect; if the image goes flat/washed on a very bright or dark scene, check the min/max clamp. `FSRDebugView.Exposure` should read near mid-grey — verify there before suspecting the accumulate math.
- **Depth separation threshold** in `depthClip.ts` (`DEPTH_SEPARATION_SCALE`, `DEPTH_SIMILARITY_FLOOR`) is a guess. Too aggressive = history thrown away everywhere (no convergence); too slack = ghost trails behind moving objects.
- **`timestamp-query`** may be absent; `GpuTimer` no-ops gracefully, but confirm the GPU-ms readout actually appears where supported.

---

## Debugging protocol (visual)

`settings.debugView` (`FSRDebugView`) renders pipeline internals instead of the final image. When something's wrong, check **in this order** — each rules out an upstream stage:

1. **Motion vectors** — static scene + moving camera should be smooth gradients, no per-object noise. Per-object flashing ⇒ previous model matrices not tracked (velocity node bypassed, or MRT not wired).
2. **Disocclusion** — thin, stable outlines around moving silhouettes. Full-screen flashing ⇒ depth linearization / reversed-depth flag wrong.
3. **Accumulation age** — should saturate to white within ~1s when still, reset along disocclusion trails. Never whitening ⇒ history not persisting (ping-pong or reset logic).
4. **Locks** — lights up on thin high-contrast features (grid lines, wire/fence edges, specular silhouettes), black on flat surfaces. All-black ⇒ thresholds too high (thin features dim); lit everywhere ⇒ too low (ghosting).
5. **Exposure** — exposed scene luma should read near mid-grey everywhere. All-black/all-white ⇒ exposure pinned at its min/max clamp.
6. **Shading change** — black on a static steadily-lit scene; lights up on surfaces whose shading actually changes (moving specular, animating light). Lit everywhere while still ⇒ `SHADING_LO` too low.
7. **Reactivity** — the caller's reactive mask (white on flagged transparents/particles, black on opaque). Empty/misaligned ⇒ the mask isn't authored/passed right.

Full guide in `src/shaders/README.md`.

---

## Roadmap (what "finished" looks like)

Phases 0–2 are **written and GPU-verified** (bench renders all paths correctly; six
standalone examples ship in `examples/`). The examples double as the validation harness
for the remaining phases: prove luma-stability locks on `04-aliasing-torture`, the
reactive mask on `05-transparency` (its explicit acceptance test), the RCAS-denoise
variant on `06-screenspace-gi`, and expose new toggles in `02-fsr1-vs-fsr3`. Remaining:

- **Phase 3 — fidelity to real FSR3:**
  - ~~**Luminance-stability locks**~~ — **done & GPU-verified.** Persistent display-res lock buffer in `accumulate.ts` (r = lifetime, g = locked luma), reprojected through motion; detects thin luminance outliers, grows a lock while present, breaks on disocclusion/shading change, then widens the rectification AABB + boosts history for locked pixels. Toggle `settings.lockThinFeatures` (`FLAG_LOCKS`); inspect via `FSRDebugView.Locks`. Tuning constants (top of `accumulate.ts`) are defaults, not final — tighten if thin features ghost, loosen if they still dim.
  - ~~**Luminance pyramid + auto-exposure**~~ — **done.** `luminancePyramid.ts` reduces the scene to a single log-average luminance (one-workgroup 32×32-tap reduction, not yet an SPD mip chain) → a pre-exposure eased over time (eye-adaptation). `accumulate.ts` pre-exposes the input before the invertible tonemap; `rcas.ts`/`blit.ts` divide it back out before display — so HDR scenes of very different brightness accumulate in the same well-conditioned range **without changing final brightness**. This also fixed a latent bug: the temporal path previously baked in `settings.exposure` and never divided it out. Toggle `settings.autoExposure` (`FLAG_AUTO_EXPOSURE`); inspect via `FSRDebugView.Exposure`. Constants (top of `luminancePyramid.ts`: key/min/max/adapt-speed) are defaults. The SPD mip chain is deferred until the shading-change detector needs the intermediate mips.
  - ~~**Shading-change detector**~~ — **done & GPU-verified.** `accumulate.ts` compares the reprojected history luma to the current 3×3 neighborhood mean, normalized by the neighborhood's own variance; a coherent disagreement the variance can't explain reads as a genuine shading change (light turning on, animated material) and ages **non-locked** history so it re-converges. A lock fully suppresses the aging — and note the detector must NOT drive lock-breaking: a thin bright feature's history always disagrees with the background-dominated neighborhood mean, so feeding `shadingChange` into the lock-break would break every lock (regression caught in GPU verification 2026-07-08; locks keep their own self-referential break term). Toggle `settings.detectShadingChanges` (`FLAG_SHADING_CHANGE`); inspect via `FSRDebugView.ShadingChange` (packed into the locks buffer's `.b`). **Simplification:** uses the neighborhood mean, not a dedicated coarse pyramid mip — a true SPD mip (steadier on high-frequency content) is deferred to Phase 5. Constants `SHADING_LO/HI/AGE` (top of `accumulate.ts`) are conservative defaults.
  - ~~**Reactive-mask input**~~ — **done & GPU-verified.** Optional `dispatch({ reactive })` render-res mask (red = reactivity); flagged pixels suppress locks, keep near-zero accumulation, and snap to the current frame (`REACTIVE_STRENGTH` in `accumulate.ts`). No mask → a 1×1 zero texture is bound and `FLAG_REACTIVE` stays off (zero cost). `FSRPresenter.setReactiveMask()` threads it through; `examples/05-transparency` authors one by rendering the transparents' coverage and is the acceptance demo. Inspect via `FSRDebugView.Reactivity`. **Authoring helpers** (auto-generating the mask) remain Phase 4.
- **Phase 4 — API & ecosystem:** reactive-mask authoring helpers; a `postprocessing`/TSL node wrapper for drop-in use; **RCAS denoise variant** toggle (pairs with three's SSR denoiser for noisy GI/SSR inputs — this was one of Dennis's original asks); MSAA-input support.
- **Phase 5 — performance:** `textureGather` tap packing (EASU/RCAS currently use per-tap `textureLoad`); f16 arithmetic (`shader-f16`); merge dilate+depth-clip into one pass; bind-group caching (currently rebuilt per dispatch — fine but wasteful); half-res luma analysis.

Frame generation (the other half of "FSR3") is **out of scope** — it needs swapchain frame pacing browsers don't expose.

---

## Conventions

Follow the existing style:
- **Comments explain "why," not "what."** Use `//*` for Title-Case section headers inside larger functions/classes, plain `//` for sub-notes. Don't narrate self-evident code.
- **Full TSDoc** (`@param`/`@returns`) on every exported function and the public class; exported types get a doc block.
- WGSL passes: keep the shared-chunk + `assembleShader()` pattern; every pass binds the constants UBO at binding 0, uses 8×8 workgroups, guards against grid overrun (`if (any(vec2f(gid.xy) >= C.<size>)) { return; }`), entry point `main`. The `shaders.test.ts` structural tests enforce most of this — run them after editing any shader.
- Keep new CI tests GPU-free.

## Provenance / license

MIT (`LICENSE`). The EASU/RCAS WGSL derives from AMD's MIT-licensed FidelityFX (`ffx_fsr1.h`); AMD's copyright notice is in `LICENSE`. Preserve it. When porting more FidelityFX stages (Phase 3), keep the "faithful port vs. simplification" table in `src/shaders/README.md` honest.
