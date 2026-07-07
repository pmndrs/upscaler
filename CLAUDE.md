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
    blit / easu / rcas / dilate / depthClip / accumulate / debug .ts  — the passes
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

---

## Landmines still live (unverified — prime suspects when it misbehaves)

- **Motion vector sign/scale.** `motionScale = (0.5, -0.5)` converts the `velocity` node's NDC delta to a UV delta, and reprojection is `prevUV = uv - motion`. This convention is **reasoned, not tested.** If history smears or the image tears under camera motion, flip signs / check this first. **Motion Vectors debug view is your friend.**
- **Accumulation tuning.** Catmull-Rom history filter, YCoCg variance-clip gamma (`CLIP_GAMMA = 1.0`), disocclusion/clip weight falloffs in `accumulate.ts` are sensible defaults, not tuned. Ghosting → tighten; instability/shimmer → loosen.
- **Depth separation threshold** in `depthClip.ts` (`DEPTH_SEPARATION_SCALE`, `DEPTH_SIMILARITY_FLOOR`) is a guess. Too aggressive = history thrown away everywhere (no convergence); too slack = ghost trails behind moving objects.
- **`timestamp-query`** may be absent; `GpuTimer` no-ops gracefully, but confirm the GPU-ms readout actually appears where supported.

---

## Debugging protocol (visual)

`settings.debugView` (`FSRDebugView`) renders pipeline internals instead of the final image. When something's wrong, check **in this order** — each rules out an upstream stage:

1. **Motion vectors** — static scene + moving camera should be smooth gradients, no per-object noise. Per-object flashing ⇒ previous model matrices not tracked (velocity node bypassed, or MRT not wired).
2. **Disocclusion** — thin, stable outlines around moving silhouettes. Full-screen flashing ⇒ depth linearization / reversed-depth flag wrong.
3. **Accumulation age** — should saturate to white within ~1s when still, reset along disocclusion trails. Never whitening ⇒ history not persisting (ping-pong or reset logic).

Full guide in `src/shaders/README.md`.

---

## Roadmap (what "finished" looks like)

Phases 0–2 are **written and GPU-verified** (bench renders all paths correctly; six
standalone examples ship in `examples/`). The examples double as the validation harness
for the remaining phases: prove luma-stability locks on `04-aliasing-torture`, the
reactive mask on `05-transparency` (its explicit acceptance test), the RCAS-denoise
variant on `06-screenspace-gi`, and expose new toggles in `02-fsr1-vs-fsr3`. Remaining:

- **Phase 3 — fidelity to real FSR3:**
  - **Luminance-stability locks** (highest-value item). FSR tracks per-pixel luma stability over frames and protects locked thin features (wires, fence pickets) from rectification. We currently use Playdead variance clipping — robust but thin sub-pixel features still dim under motion. This is the biggest visible gap.
  - Luminance pyramid (SPD-style downsample) + auto-exposure.
  - Shading-change detector.
  - Reactive-mask input for transparents/particles.
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
