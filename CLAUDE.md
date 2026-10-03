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
`docs/research/PARITY.md`; evidence + decisions in `bench/docs/PARITY-DECISIONS.md` /
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

# Releasing (docs/releasing.md). Merges to main NEVER publish. Releases need no
# local step: Actions → Publish to npm → Run workflow (version: auto | patch |
# minor | major | X.Y.Z, optional preid), or a vX.Y.Z tag on main (e.g. Releases →
# Draft a new release). Both run .github/workflows/publish.yml. Optional local path:
npm run release -- --dry-run   # next version from Conventional Commits + included commits
npm run release                # gate → `npm version` commit + annotated tag (local only)
# Agents: NEVER push a v* tag, run/dispatch the publish workflow, or pass
# `npm run release -- --push` unless the maintainer explicitly asks.

# How to run/read a benchmark, the Q0-Q16 scenario catalogue, and the device
# setup: bench/docs/BENCHMARKING.md

# Still-scene convergence meter (GPU, headless Chrome + CDP): consecutive +
# same-jitter-phase frame diffs plus debug-view PNGs on a deterministic
# scenario. Q12 = cornell + point-light shadow dither (consumer report 3 repro).
node scripts/measure-convergence.mjs --scenario Q12 --ratio 2

# The same for ALPHA: drives examples/15-transparent-canvas frozen + still and
# reads the output texture back (exact alpha, no compositing). --settings merges
# RuntimeSettings, e.g. '{"detectShadingChanges":false}' to isolate the detector.
node scripts/measure-alpha-convergence.mjs --ratio 3
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on push/PR. No GPU in CI, so tests are deliberately GPU-free (pure math + shader-string structure). **Keep it that way** — don't add tests that need a device to CI; they'll hang or fail.

---

## Repo layout

```
src/
  index.ts             — public exports
  Upscaler.ts      — THE low-level API + pass orchestration (start here)
  UpscalePass.ts          — high-level public drop-in (MRT/jitter/present recipe; ex-UpscalePresenter)
  UpscalerNode.ts          — the same recipe as a TSL node: upscale(scene, camera) for RenderPipeline graphs
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
docs/                  — maintained consumer/contributor docs (index: docs/README.md);
  research/            — live research (PARITY.md, PAPER-NOTES.md)
  archive/             — historical specs/handoffs/plans, NOT normative
```

Read `Upscaler.ts` and `bench/src/BenchPipeline.ts` together first — the second is the canonical example of how the first is meant to be driven. `examples/shared/UpscalePresenter.ts` is the same recipe packaged as a reusable helper; `examples/06-screenspace-gi` is the reference for feeding FSR3 the output of a TSL post-processing graph (GTAO/SSR/SSGI) rendered at reduced resolution.

---

## Architecture (the load-bearing decisions)

- **Raw WebGPU on three's device.** We grab `renderer.backend.device` and dispatch our own compute passes on our own `GPUCommandEncoder`, submitted **between** three's scene render and the presentation draw. Queue ordering guarantees correctness with zero explicit sync. Not TSL — deliberately, so the WGSL reads like AMD's originals and we control performance.
- **three internals we depend on** (all in `internal/threeWebGPU.ts`, verified against **three r184**, re-verified on **r186.1** 2026-10-02):
  - `renderer.backend.device` → the `GPUDevice`
  - `renderer.backend.get(texture).texture` → the raw `GPUTexture` behind a three texture
  - These are **private**. `threeWebGPU.ts` throws loudly if the shape changes. **If you bump three, re-verify these two accessors first** — they're the most likely thing to break on upgrade.
- **Output is a three `StorageTexture`** — the upscaler writes into it, the caller samples it like any texture. Presenting is ordinary three code (a fullscreen quad).
- **One shared 256-byte constants UBO** (`ConstantsBuffer` ↔ `WGSL_CONSTANTS` in `common.ts`), bound at `@group(0) @binding(0)` in every pass, written once per frame. **The two layouts must stay byte-for-byte in sync** — f32/u32 indices in `ConstantsBuffer.ts` map to documented byte offsets in the WGSL struct. If you add/reorder a field, change **both** or everything silently corrupts.
- **Color spaces:** temporal accumulation happens in invertible-tonemap space (`c/(1+max(c))`, FSR2's firefly guard), then RCAS/blit reverse that conditioning and write `rgba16float` in the caller's linear/HDR domain. The upscaler never applies ACES, an output transfer function, or another presentation transform. EASU leaves its caller-provided input domain unchanged. Presentation belongs to the consuming renderer/post graph. **Spatial RCAS conditions too:** FSR1's limiter assumes [0,1], so on EASU's linear/HDR output `hitMax` disabled sharpening wherever the cross ring straddled 1.0 (and divides 0/0 on a flat 1.0 ring). Production RCAS conditions the spatial taps with the same invertible tonemap, then inverts once, anchored on the linear center and capped at linear RCAS's max gain. Raw input is unbounded, and without those two guards it clips at ~1000 and turns isolated peaks into ~1000× fireflies. See `src/shaders/README.md` → "RCAS load domain (spatial path)". **Temporal RCAS shares the gain cap (issue #32, 2026-10-02).** Pre-exposure does not bound a peaky history (first frame, reset, disocclusion, a sub-pixel emitter that only rasterizes on some jitter phases). The uncapped single inversion turned these into fireflies: 1754 from a lone 16 on the first frame, and 316 / 423 on converged Q1 / Q2 highlights whose neighbours read ~5 / ~11. The cap is `inv(max5)/exposure · maxGain`, inverting the conditioned tap max once. Pixels under the cap stay bit-exact. 8-bit captures can't see this regression (everything above ~4 saturates white under ACES), so read back the rgba16float output.
- **Jitter/velocity:** projection is jittered through the camera's view offset (same mechanism as three's TRAA). Motion vectors must be **jitter-free**, so the scene's `velocity` node gets `upscaler.unjitteredProjectionMatrix` (a stable Matrix4 instance whose contents refresh each `beginFrame`). **The jitter composes with an app-set view offset** (tiled/multi-screen: `math/viewOffset.ts` scales it by `view.width / renderWidth` so it stays one render pixel) and `endFrame` restores the pre-frame `camera.view` exactly — never `clearViewOffset()` unconditionally, and never `setViewOffset()` (it also overwrites a perspective camera's `aspect`). The unjittered matrix keeps the app's offset. (three's own TRAA/TAAU still clobber an app offset.)

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

10. **three r186 removed `RenderPipeline.context`** (mrdoob/three.js#34025, issue #19). The node's jitter hooks used to assign `renderPipeline.context.onBefore/AfterRenderPipeline`; on r186 that throws in `setup()`. r186's contract: the TSL events `OnBeforeRenderPipeline`/`OnAfterRenderPipeline` (stack nodes — call them **inside `setup()`** or `Stack()` silently drops them) push into per-build callback arrays, and the node that offsets the camera claims `builder.context.renderPipelineState.viewOffsetOwner`. All of it lives in `internal/renderPipelineHooks.ts` (GPU-free tested): events are feature-detected off three's runtime `TSL` object from `three/webgpu` (never a named `three/tsl` import — that's a link error on r184/r185), with the r184/r185 context-slot path kept as a **deprecated fallback that warns once**. Rules a change must keep: (a) **first claimant wins** — if TRAA/TAAU/temporalReproject already owns the view offset, `upscale()` warns once and runs *un*jittered (`_jitterActive=false` → upscaler `jitter:false`, velocity projection released to the owner); never overwrite another node's hooks, never silently drop jitter; (b) callbacks are pushed, not assigned, so a re-setup against the same context data must not register twice (owner identity check → `'installed'`); (c) `_frameOpen` guards begin/end — r186 runs the before-callbacks *before* the material build that registers them, so the first frame after a rebuild gets an `endFrame` with no `beginFrame`; (d) when the node is built outside the pipeline graph (`'none'`, e.g. inside r185 TRAA's private resolve material) it warns and runs unjittered rather than pinning velocity to a never-refreshed matrix. GPU-verified 2026-10-02 on r186.1: examples 07/08/09/10/11/13 show exactly one upscaler callback per array, one begin/end per frame, 32 distinct jitter phases, view offset cleared after each render; a `traa(upscaleScene(...))` harness hits the conflict warning; r185.1 fallback renders with the deprecation warning.

---

## Landmines still live (unverified — prime suspects when it misbehaves)

- **Motion vector sign/scale.** `motionScale = (0.5, -0.5)` converts the `velocity` node's NDC delta to a UV delta, and reprojection is `prevUV = uv - motion`. **Corroborated against three's own `TAAUNode`** (2026-07-08), which uses the identical `velocity.xy * vec2(0.5, -0.5)` scale and `historyUV = uv - offset` reprojection, plus the same `setViewOffset` jitter in render-pixel units — so this is no longer a guess. Still the first thing to re-check if history smears or tears under camera motion; **Motion Vectors debug view is your friend.**
- **Accumulation tuning.** Catmull-Rom history filter, YCoCg variance-clip gamma (`CLIP_GAMMA = 1.0`), disocclusion weight falloffs, **and the luminance-lock constants (`LOCK_*`)** in `accumulate.ts` are sensible defaults, not tuned. Ghosting → tighten (lower `LOCK_CLAMP_RELAX`/`LOCK_HISTORY_BOOST`, raise the peak/contrast thresholds); instability/shimmer or thin features dimming → loosen. Use `DebugView.Locks` to see where locks form. **Two convergence rules learned from consumer report 3 (2026-07-24, NEXT-STEPS §5) — do not re-break:** (1) never age `sampleCount` by clip magnitude (an earlier `clipAmount` aging made still-scene convergence unreachable — rolling age moiré); (2) the blend stores the *clipped* history, so still+converged+quiet pixels get a `STILL_CLAMP_RELAX`(×9) widened box or each jitter phase's variance box re-snaps the buffer forever (phase-locked frame diff 0.18 vs 0.02 shipped). Ghosting on *still* scenes after a missed lighting change → lower `STILL_CLAMP_RELAX` before touching anything else; motion is unaffected (relax fades out above 0.5 texel/frame). **Keep it at 8 (measured 2026-10-02, NEXT-STEPS §8, Q15 + `scripts/measure-drift-lag.mjs`):** under lighting drift too slow for the shading detector, the lag cost is a *step* at 0→4 (Q15 lag 5.3 → 9.6 frames), then nearly flat (+10% to 8, +5% to 16), while Q1 same-phase churn keeps falling. Lowering it buys back little lag and gives up convergence. If drift lag ever matters, gate the relax on a slow-drift term instead of retuning. Setting it to 0 is safe: `alphaRelax` divides by `max(STILL_CLAMP_RELAX, 1e-6)`. Measure drift lag with auto-exposure off, because adapting exposure re-decodes conditioned history and masks 30–45% of the lag.
- **Shading-change tuning** (`shadingChange.ts`: `SHADING_FLOOR_MID/COARSE/CV`; `accumulate.ts`: `SHADING_AGE`) — GPU-tuned on Q1/Q4/Q9/Q11 (2026-07-21) but still constants, not laws. Ghosting after a genuine lighting change → lower the floors; flat steadily-lit surfaces shimmering → raise them (raise `SHADING_FLOOR_CV` if the noise sits on textured regions). `DebugView.ShadingChange` should be near-black on a still scene — check it before suspecting the accumulate blend. Slow ramps deliberately don't fire (1-frame comparison; the blend tracks ramps — verified no lag on Q9). **Keep the `cv` floor two-sided (issue #22, NEXT-STEPS §9, 2026-10-03):** it is the pooled within-block spread of *both* frames over their joint mean. Measured on the current frame alone, a block whose sub-texel content the jitter phase missed read cv = 0 against a previous frame that hit it, and fired at full strength. That was Q16's sparse wires (2.4 % / 4.5 % of the frame firing at ratio 2 / 3 → 0.04 % / 0.07 %), and also most of the "baseline" still-scene speckle on Q1/Q12 (0.43 % → 0.02 %) and Q4's motion false positives (0.47 % → 0.02 %). The genuine Q9 steps fire within 2 %. Two rejected forms: a bilinear-tap second moment costs the steps 3–4 %, and `max(cv_cur, cv_prev)` leaves residue and loses 7 % on Q9 f180. The between-frame shift must stay out of the spread, or a flat surface's real change raises its own floor. Measure with `measure-convergence.mjs --shading-frames 32` (it sRGB-decodes the view). Known trade: sparse fans now converge like everything else, so after a genuine sub-floor step on them they fade ~12–17 % slower in integrated error than when false fires kept them part-aged.
- **Auto-exposure constants** (`luminancePyramid.ts`: `EXPOSURE_KEY`, `EXPOSURE_MIN/MAX`, `ADAPT_SPEED`) are defaults. Because exposure is divided back out before display, the *visible* effect is subtle (better accumulation stability, not a brightness change). If a scene pulses in brightness, `ADAPT_SPEED` is the suspect; if the image goes flat/washed on a very bright or dark scene, check the min/max clamp. `DebugView.Exposure` should read near mid-grey — verify there before suspecting the accumulate math.
- ~~**Depth separation threshold** in `reconstruct.ts` is a guess~~ — **resolved 2026-07-21**: replaced by AMD's viewport/depth-scaled formulation (`1.37e-5 · halfViewportWidth · maxDepth`, per-bilinear-tap confidence voting from `ffx_fsr2_depth_clip.h`), GPU-validated on Q3 (thin stable outlines, still scenes quiet, age resets confined to trails). **Amended 2026-07-22** (grazing-plane flicker found via example 12): reprojection is jitter-delta-compensated; tolerance is widened by the dilation ring's own depth relief (cross-frame gather must absorb one-texel slope mismatch that upstream's same-frame scatter sidesteps). **Amended again 2026-07-24** (still-camera silhouette flicker, consumer report 3): every valid tap votes — taps at/behind the current surface vote full confidence — and the **best tap wins** (max aggregation, not a weighted mean of positive separations only; the 07-22 "skip, never veto" semantics still let one boundary-quantization-straddling tap fully disocclude a still edge every phase). Genuine trails still read ~1 (all taps on the old occluder). Still no scene-tuned constants. Convergence regressions: measure with `scripts/measure-convergence.mjs` (Q1/Q12) before touching anything; evidence in `bench/docs/NEXT-STEPS.md` §5.
- **`timestamp-query`** may be absent; `GpuTimer` no-ops gracefully, but confirm the GPU-ms readout actually appears where supported.
- **`GpuTimer` allocation can fail even with `timestamp-query` present** (OOM on a shared GPU, #31). WebGPU reports that asynchronously and hands back an *invalid* query set — any `timestampWrites`/`resolveQuerySet` against it invalidates the whole `upscale` command buffer → black output. So the timer allocates inside `out-of-memory` + `validation` error scopes and attaches **no** timestamp work until both pop clean (first frame or so is untimed); any allocation or `mapAsync` failure disables it for the instance's lifetime with one `console.warn`. Don't attach timestamp work from anywhere that bypasses `beginFrame`'s ready gate.

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
- **Luminance-stability locks.** Persistent display-res lock buffer in `accumulate.ts` (r = lifetime, g = locked luma, b = shading-change factor, a = resolved caller alpha — see Alpha passthrough below), reprojected through motion; detects thin luminance outliers, grows a lock while present, breaks on disocclusion/shading change, then widens the rectification AABB + boosts history for locked pixels. Toggle `settings.lockThinFeatures` (`FLAG_LOCKS`); inspect via `DebugView.Locks`. Tuning constants (top of `accumulate.ts`) are defaults, not final — tighten if thin features ghost, loosen if they still dim.
- **Auto-exposure.** `luminancePyramid.ts` reduces the scene to a single log-average luminance (one-workgroup 32×32-tap reduction; no mip chain — nothing consumes intermediate mips) → a pre-exposure eased over time (eye-adaptation). `accumulate.ts` pre-exposes the input before the invertible tonemap; `rcas.ts`/`blit.ts` divide it back out before display — so HDR scenes of very different brightness accumulate in the same well-conditioned range **without changing final brightness**. Toggle `settings.autoExposure` (`FLAG_AUTO_EXPOSURE`); inspect via `DebugView.Exposure`. Constants (top of `luminancePyramid.ts`: key/min/max/adapt-speed) are defaults.
  - **External exposure input.** An app that meters its own exposure feeds it via `dispatch({ exposureTexture })` (value in the red texel, any float format); it overrides both auto and fixed exposure and is still divided back out before display (conditions accumulation, not brightness). Wired as binding 5 of the pyramid pass behind `FLAG_EXTERNAL_EXPOSURE` (the 1024 bit) and funnelled through the same single `select`, so downstream passes are untouched and `avgLum` stays our own measurement for the shading detector. Bound to the reactive dummy as a placeholder when absent. Also on the composable node as `options.exposureTexture` (mirrors FSR3's `exposure` dispatch resource).
  - **Host pre-exposure (`preExposureTexture`).** DeltaPreExposure history correction + host-invariant auto-exposure metering (auto-exposure must not chase a step the app already metered — skipping this reads as a ~2s full-screen false shading change). Validated on the Q11 bench scenario; byte-identical output when the input is absent.
- **Shading-change detector** (multi-scale form, 2026-07-21). `shadingChange.ts` (one fused half-res dispatch) compares jitter-aligned block-mean luma at 4×4/8×8 render scales against a 1-frame luma history, with contrast-adaptive noise floors and disocclusion neutralization; the response ages **non-locked** history via accumulate's `SHADING_AGE` path so changed surfaces re-converge. Costs 0.044 ms at ratio 2; zero when off (pass not dispatched). A lock fully suppresses the aging — and note the detector must NOT drive lock-breaking: a thin bright feature's history always disagrees with its block mean, so feeding `shadingChange` into the lock-break would break every lock (regression caught in GPU verification 2026-07-08; locks keep their own self-referential break term). Toggle `settings.detectShadingChanges` (`FLAG_SHADING_CHANGE`); inspect via `DebugView.ShadingChange` (packed into the locks buffer's `.b`).
- **Reactive-mask input.** Optional `dispatch({ reactive })` render-res mask (red = reactivity); flagged pixels suppress locks, keep near-zero accumulation, and snap to the current frame (`REACTIVE_STRENGTH` in `accumulate.ts`). No mask → a 1×1 zero texture is bound and `FLAG_REACTIVE` stays off (zero cost). `UpscalePresenter.setReactiveMask()` threads it through; `examples/05-transparency` authors one by rendering the transparents' coverage and is the acceptance demo. Inspect via `DebugView.Reactivity`. **Node parity:** `upscale()` / `UpscalerNode` take `options.reactive` and `options.reactiveOpaqueColor` texture nodes (registered as graph deps so the opaque buffer renders in-pipeline, jittered, aligned with color). No dedicated node demo — it reuses the GPU-verified reactive dispatch (example 05, imperative) + the proven graph-dep mechanism (examples 07/09), so worst case on a plumbing miss is a silent no-op, not a crash.
- **Reactive-mask authoring helper.** `dispatch({ reactiveOpaqueColor })` auto-generates the mask from the opaque-vs-final color diff (`generateReactive.ts`, FSR2's `GenerateReactiveMask`); no explicit `reactive` mask needed. `UpscalePresenter.setReactiveOpaqueColor()` threads it; `examples/05-transparency` offers manual-coverage vs auto-diff. Caveat: jitter the opaque pass like the final or high-contrast edges leave faint reactivity (sub-pixel misalignment).
- **RCAS denoise variant.** `rcas.ts` has FSR1's `FSR_RCAS_DENOISE` path (attenuate the sharpening lobe on lone luma outliers so grain from noisy inputs isn't amplified), gated by `settings.rcasDenoise` (`FLAG_RCAS_DENOISE`, off by default). Pairs with an upstream spatial denoiser; `examples/06-screenspace-gi` toggles it on for the reduced-res SSR/GI.

**Alpha (RGBA) passthrough** (2026-08-25, issue #15; made unconditional in the PR #18
review). Every path preserves the input's alpha instead of writing 1.0, so a transparent
canvas stays transparent through the upscale. EASU filters RGBA with one kernel; RCAS
sharpens RGB and passes the center tap's alpha; the temporal path resolves alpha with the
accumulate pass's own Lanczos taps and blend weight. **The mechanism to not re-break:** the
history texture's `.a` is the accumulation age, so resolved alpha is stored in the **locks
texture's spare `.a`** (public as `guides.lockStatus.a`) and read by RCAS/blit through a
dedicated binding (rcas 4, blit 5; bound to the color input itself on the bilinear/spatial
paths, so one code path covers all three). This keeps the age on its exact Catmull-Rom
reprojection — the delicate, measured part — and costs no extra fetch while locks are on,
since the lock path already samples `locksIn` at `prevUV`.
**Unconditional — no option, no RGB-only builds** (like three's `FSR1Node`). An earlier
draft had an `alpha` option defaulting to `renderer.alpha` plus byte-identical opaque
builds; since three's `WebGPURenderer` defaults to `alpha: true`, that default selected the
RGBA builds for nearly everyone, and with alpha-1 inputs the RGBA builds already produce
identical RGB and alpha exactly 1 (EASU's dering clamp and accumulate's alpha box pin to
[1, 1], RCAS passes center alpha, blit samples a constant 1). Don't reintroduce a flag for
the ~33 µs it saved. **Every RCAS form declares binding 4** (production, the frozen
`RCAS_PER_TAP_SHADER` / `RCAS_LEGACY_SHADER` bench identities, the load-strategy
experiments), because `_encodeRcas` always binds five entries — an `_rcasShader` override
without it fails bind-group creation; `shaders.test.ts` enforces it.
**Behaviour change vs 0.2:** with a default renderer (`alpha: true`, clear alpha 0) and no
`scene.background`/opaque clear color, empty regions are now transparent through the
upscale (matching three without the upscaler). The examples run on three's default canvas
(`examples/shared/boot.ts` no longer forces `alpha: false`) and every opaque example paints
`scene.background`. Post graphs that scale the upscaled `vec4` by a scalar now scale alpha
too — example 08's vignette multiplies by `vec4(vec3(v), 1)` for that reason (a bare
`.mul(v)` faded its edges to transparent over the page). Measured cost (interleaved ABBA, 2026-08-25, before the option was
removed): **~33 µs flat** — +14.6 µs accumulate, +18.1 µs RCAS — which is +3.6% / +5.1% /
+5.5% of compute at ratio 1 / 2 / 3 (display-res work, so it does not scale with ratio).
Evidence + the rejected history/locks-swap alternative: `bench/docs/NEXT-STEPS.md` §6.
**Alpha rectification** is the local 3×3 alpha range (not a variance AABB), **relaxed by
color's own still-scene signal** — `mix(clamp(h, min, max), h, stillRelax /
max(STILL_CLAMP_RELAX, 1e-6))` — because a sub-texel feature's all-0/all-1 jitter phases would
otherwise re-snap converged coverage every cycle (convergence rule 2, for alpha).
Measured with `scripts/measure-alpha-convergence.mjs` (NEXT-STEPS §6): a minority share
of the still-scene shimmer on example 15's sub-texel wires; most of it is shared with
color (shading-change detector firing along the wires), and color's relative flicker
exceeds alpha's — re-measure there before touching the alpha resolve.
GPU-verified across `UpscalePass`, the TSL nodes, and the raw `Upscaler`; the acceptance
demos are `examples/14-pathtracer-alpha` (spatial) and `examples/15-transparent-canvas`
(temporal). Note `UpscalePass`'s present quad is `transparent: true` + `NoBlending` — an
opaque material resolves alpha to 1, and a full-screen present wants an overwrite, not a
composite.

**Public surfaces** (both GPU-verified):
- **`UpscalePass`** (`src/UpscalePass.ts`) — the imperative drop-in (graduated from `UpscalePresenter`, which is now a re-export shim). Bakes in the MRT/jitter/velocity/present recipe. Covers renderer-agnostic / non-graph use.
- **TSL nodes** (`src/UpscalerNode.ts`, native TSL, no pmndrs dep) — "the future" surface. **One node, one code path** — modelled on three's own `FSR1Node` / `TAAUNode`:
  - **`upscale(color, depth, velocity, camera, options)`** (`UpscalerNode`) — the composable node, consumes reduced-res texture nodes and outputs the upscaled result. **The key mechanism** (this is what a first attempt got wrong and rendered black): the inputs must be *graph dependencies* so three renders them in-graph, in dependency order, before this node's `updateBefore`. three discovers child nodes by walking the node's **own non-`_`-prefixed** properties (`Node._getChildren`) — our fields are `_`-prefixed, so `setup()` registers the inputs explicitly into `builder.getNodeProperties(this)` (exactly as `FSR1Node` does with `properties.textureNode`). With that, jitter (applied via the `onBeforeRenderPipeline` hook, like `TAAUNode`) lands because the inputs render *inside* the post render. The factory `convertToTexture`s the color (a no-op for texture/pass nodes, which is why reduced-res pass outputs keep their size — the caller controls input resolution). `UpscalerConfig` has `renderWidth`/`renderHeight` so the node matches an externally-sized input exactly.
  - **`upscaleScene(scene, camera, options)`** — a thin convenience, **not** a separate class: it builds `pass(scene, camera)` with a `{ output, velocity }` MRT at `1/ratio` and hands the texture nodes to `upscale(...)` — the same shape as three's `taau(pass.getTextureNode('output'), …)`. So the scene renders in-graph as an FSR3 input, jitter and all. `post.outputNode = upscaleScene(scene, camera)`. Examples `07-tsl-node`, `08-tsl-compose` (`.mul(vignette)`); the full SSGI/SSR stack is `09-kitchen-sink`.
  - **`upscaleSpatial(color, options)`** — color-only **spatial** (FSR1/EASU) node for inputs with no motion data: no depth/velocity/camera, no history, no reconstruction. A thin facade over `path: 'spatial'` with a stand-in camera (EASU reprojects nothing; `_writeConstants` still stages `near`/`far`, which the shader ignores, so any finite values keep NaN out of the UBO). It exists so the "I only have a color texture" case has a clean door instead of `upscale(color, null, null, camera, { path: 'spatial' })` — and so defaulting the *temporal* node to jitter-on isn't a trap.
  - **Jitter default = ON for temporal** (`UpscalerConfig.jitter`, `UpscalerNodeOptions.jitter`): jitter buys *reconstruction* (detail beyond render res) but only if the input is re-rendered under the jittered projection each frame. Because a composable node's inputs are graph dependencies three renders *in-pipeline* — after this node's `onBeforeRenderPipeline` jitter hook offsets the camera — the offset **does** land on them, so **both** `upscale()` and `upscaleScene()` default jitter **on** (this is how real FSR/DLSS run). Opt **out** (`{ jitter: false }`) only when the input is *not* re-rendered in-graph — an externally-filled `texture()`, or a noisy GI/RT buffer you want reprojected/denoised but not reconstructed (the raw `Upscaler` / example 06 is usually the better fit there). Jitter-off stays a full temporal upscale (reproject + accumulate + denoise), just no sub-pixel offset. When off, `beginFrame` no-ops `setViewOffset`, jitter constants stay zero, and the node skips the hook + velocity compensation. A temporal node that never receives depth+velocity `console.warn`s once. `09-kitchen-sink` toggles jitter on the same in-graph pipeline to A/B it.
  - Color path (both): the node emits linear/HDR color. When it is the final graph node, three's RenderPipeline applies the renderer's configured tone mapping and output color space; otherwise it can feed later linear post-processing. **Note:** three renamed `PostProcessing` → `RenderPipeline` (deprecation warning only).
  - The composable node *does* render its inputs in-graph, so an SSGI-in-a-graph pipeline jitters correctly and there's no owning-render/consuming-inputs split. An imperative pipeline that composites *outside* the post render (its own RT loop) still wants the raw `Upscaler` — `examples/06-screenspace-gi` stays on it as the imperative reference.
- **Temporal guides (raw contract accepted — M6 PASS 2026-07-24; linked TSL
  package surface accepted 2026-07-29).** The production
  working set is published as `upscaler.guides` (`TemporalGuides` — dilated
  motion/depth, disocclusion, reactive, shading change, exposure, locks, history)
  and the frame can be driven split: `dispatchGuides({depth, velocity})` right
  after the G-buffer (geometry guides only — reconstruct is the whole early
  stage), then `dispatchUpscale({color, …})`; `path: 'guides'` runs the early
  stage alone with no output texture. Maintained contract:
  `docs/temporal-guides.md` (per-field detail on the `TemporalGuides` type);
  program history (spec, consumer M0 review, handoffs) archived under
  `docs/archive/temporal-guides/`.
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
  `THREE` — for the CDP harness). **TSL surface (M4):**
  `temporalGuides(depth, velocity, camera)` (`TemporalGuidesNode.ts`)
  publishes the bundle as texture nodes (`getTextureNode(name)` — stable
  node identity, ping-ponged products re-pointed per frame; a 1×1 nearest
  placeholder pre-configure so r32float format inference never sees a
  filterable stand-in). Standalone = node owns a guides-only upscaler sized
  to its depth input; linked = `upscale(..., { guides })` adopts the node's
  upscaler via `_acquireUpscaler` and runs the split frame in-graph, with
  the upscale node falling back to monolithic `dispatch()` whenever the
  early stage didn't run this frame (`Upscaler.guidesPending` is the
  branch). The guides node must be registered as a graph dep BEFORE the
  color chain so its dispatch precedes effect renders.
  `examples/13-guides-node` is its live reference (exposes
  `window.__guidesNodeExample` + tsl handles for the CDP harness; the
  dispatch-spy probe there proves the pure split path steady-state).
  `scripts/verify-packed-guides.mjs` builds + packs the library, unpacks it in
  an isolated consumer location, builds this same graph against the artifact
  (never the source alias), and on real GPU asserts shared ownership, stable
  guide node identity while ping-pong backings re-point, split early/late
  dispatch, zero monolithic fallback after warmup, and clean WebGPU/WGSL logs.
  The package-boundary smoke graduates the linked TSL API; it is not evidence
  of an independent external TSL integration. CI runs its `--build-only` mode
  and remains GPU-free. Also in this program: reactive is
  merge-not-overwrite (`generateReactive` max-merges an incoming mask;
  passing `guides.reactive` back while `reactiveOpaqueColor` is set throws —
  the generator writes that texture), and `MomentsPass`/`shaders/moments.ts`
  is a standalone signal-agnostic statistics primitive with **zero coupling**
  to the pipeline (its `FLAG_MOMENTS_YCOCG` bit is declared locally in
  moments.ts, deliberately NOT in `WGSL_CONSTANTS` — adding anything to the
  shared chunk re-fingerprints every shader).
- **MSAA input — rejected by design.** FSR's temporal path *is* the anti-aliaser (Native AA mode is exactly that), so the correct input is an aliased, single-sample, jittered render with MSAA **off** — MSAA is redundant with FSR's own AA, costs perf, and a multisampled texture can't even bind to the compute passes. (Stacking a *temporal* AA — TAA/`traa` — before FSR is worse still: double-jitter smear; example 06 already drops `traa` for this reason.) `Upscaler` warns once if handed a multisampled input (`_checkMsaa`).

**Performance structure:** dilate + depth-clip are fused into the single `reconstruct.ts` dispatch (GPU-verified disocclusion unchanged); the shading detector is one fused workgroup-local reduction instead of the source's SPD mip chain + resolve pair. The measured story of these divergences from FSR 3.1.5 — and the four upstream behaviors adopted in re-derived form — is `docs/research/PARITY.md` with evidence in `bench/docs/NEXT-STEPS.md`.

**Paper material:** findings that clear the "surprised us + measured + others would hit it" bar are tracked in `docs/research/PAPER-NOTES.md` — claim, evidence pointers, and what a publication-grade version still needs (open gaps: issue #10). Add new entries there as they land, or amend an existing entry when a finding generalizes it; don't let them live only in commit messages. Evidence under `bench/results/raw/` is gitignored, so pair every raw-output pointer with the command that regenerates it.

## Deferred / out of scope

- **Transparency & Composition (T&C) mask** — deliberately deferred (assessed 2026-07-10). FSR2/3 takes a second render-res mask alongside reactive, but it is *not* a clean parallel: in FSR2 the T&C mask has a distinct-but-overlapping effect (a softer history-distrust than reactive, it widens the rectification AABB and interacts with locks) that is genuinely tuned. Adding it means new tuning constants and touching the accumulate blend/lock path, and our reactive mask (+ auto-generate) already covers the common three.js transparency case (example 05's whole point). Shipping it as a second channel that behaves identically to reactive would be misleading; shipping the *real* distinct behavior needs core tuning we shouldn't ride onto other work. Revisit if a user actually authors T&C masks and the reactive path proves insufficient.
- **Perf-only micro-optimizations (no quality gain, correctness risk):** `textureGather` tap packing (EASU/RCAS currently use per-tap `textureLoad` — but these are the AMD-faithful ports; changing their sampling risks subtle artifacts); f16 arithmetic (`shader-f16`, needs feature detection + fallback, precision risk); bind-group caching (rebuilt per dispatch — "fine but wasteful," but caching adds stale-view-on-resize risk to the core); half-res luma analysis. None gain image quality; each adds risk to a core path the project deliberately protects — do them only when perf is the actual bottleneck.
- **Future project — fused GI/denoise temporal path.** Denoising very noisy screen-space inputs (SSGI especially) can't be solved by stacking a *separate* temporal denoiser before FSR3: any second temporal resolver reprojects by velocity, which is jitter-free, so it can't see FSR3's sub-pixel jitter — it rejects the misaligned history (noise survives) and cancels the jitter variance FSR3 needs (aliasing returns). Verified 2026-07-10 with three r185's `recurrentDenoise`/`temporalReproject` in `examples/10-ssgi-denoise` (kept as **experimental documentation**, not a library feature). Spatial-only denoise + FSR3-owns-temporal avoids the conflict but inherits the third-party à-trous kernel's halos/step-lines/update-cadence skipping. The real fix is to **fuse GI history into FSR3's own accumulation** — reprojected with *our* motion vectors, sampled at *our* jitter, with GI-appropriate variance handling (not the AA-tuned clip). This is genuine R&D that touches the core accumulate pass, so it's a deliberate future effort, not a quick add. Priority remains the FSR3 upscaler itself; don't spend core complexity bending upstream nodes to it. **SSGI rotating pattern (revised 2026-10-03):** three's `SSGINode.useTemporalFiltering` (default **true**) rotates its sample pattern on a 6-frame cycle for a temporal resolver to integrate — and FSR3 is one. Examples 06/09 now keep it **on** (example 10's experimental denoisers stay on the static pattern): it is markedly cleaner than the static no-TRAA pattern, whose fixed diagonal hatch accumulation cannot remove. (2026-08-06 had turned it off for ghost-streaking off moving edges; the shading-change footprint clamp + the viewport-edge disocclusion fix of 2026-10-03 cut the rotation's detector noise from ~2% to ~0.05% of pixels.) Residual cost: ghosting off silhouettes in motion (example 09: a striped band on the wall beside a box at orbit ×1.5, a smear at ×3.5+). Investigated 2026-10-03 and **shelved for the GI work above**: it is SSGI-driven (motion error in the band ~3× with SSGI on vs off), not disocclusion/age (both clean in the band), locks, shading change, SSR or reprojection lag (all ruled out); a motion-scaled clip tightening had no effect (the wall moves < 1 render texel/frame there). Likely mechanisms: SSGI's AO/GI halo moves with the occluder's silhouette, not the surface it lands on, and its screen-anchored noise is dragged by surface reprojection. Single-frame error is tiny (~0.002 luma) — judge fixes by eye or with a temporal metric. **Second landmine (issue #17, measured 2026-10-02 on bench Q14):** `recurrentDenoise({ accumulate: false })` is spatial-only in *history*, but it still re-rolls its à-trous kernel rotation **every frame** (`_noiseIndex = frame.frameId`, aperiodic R² noise) — a temporal noise source FSR3 can only average down to its `maxAccumulation` floor. On 1px wires over SSGI-lit walls that reads as "locks can't engage": the wires boil (same-jitter-phase diff 1.83 vs 0.04 clean) while locks *do* form (mean life 0.47 vs 0.71 clean) and cut churn 34%; shading change, the lock break, and rectification are all measured non-factors (toggling each: ≤1% change). `DenoiseNode` on the static pattern (the 06/09 recipe) converges the same wires to the clean periodic orbit (same-phase 0.03). Don't "fix" this in the lock or shading-change gates; a reactive mask is the wrong tool (it zeroes locks and snaps the blend to the noisy current frame). See `bench/docs/NEXT-STEPS.md` §7.
- **Frame generation** (the other half of "FSR3") — needs swapchain frame pacing browsers don't expose.

---

## Conventions

Follow the existing style:
- **Comments explain "why," not "what."** Use `//*` for Title-Case section headers inside larger functions/classes, plain `//` for sub-notes. Don't narrate self-evident code.
- **Full TSDoc** (`@param`/`@returns`) on every exported function and the public class; exported types get a doc block.
- WGSL passes: keep the shared-chunk + `assembleShader()` pattern; every pass binds the constants UBO at binding 0, uses 8×8 workgroups, guards against grid overrun (`if (any(vec2f(gid.xy) >= C.<size>)) { return; }`), entry point `main`. The `shaders.test.ts` structural tests enforce most of this — run them after editing any shader.
- Keep new CI tests GPU-free.
- **Docs are maintained, not archival.** A change to a public API, an input contract,
  a default, or a guide product updates `docs/` (getting-started, inputs-and-contracts,
  temporal-guides, debugging, compatibility, architecture) in the same change. Source
  comments cite `docs/…`, never `docs/archive/…`, as normative.

## Provenance / license

MIT (`LICENSE`). The EASU/RCAS WGSL derives from AMD's MIT-licensed FidelityFX (`ffx_fsr1.h`); AMD's copyright notice is in `LICENSE`. Preserve it. If more FidelityFX stages are ever ported, keep the "faithful port vs. simplification" table in `src/shaders/README.md` honest.
