# Post-parity adoption record (2026-07-21) — all items landed

Outcome of the parity program: no candidate bundle adopted wholesale (see
[PARITY-DECISIONS.md](PARITY-DECISIONS.md) and the consumer-facing
[`PARITY.md`](../../docs/research/PARITY.md)). Four items survived as adoption-worthy, and
**all four landed on 2026-07-21** — this document is the evidence record for
each. Nothing from the parity program remains open. Items 5+ are later
consumer-reported defects recorded in the same format.

Every item follows the same gate: `npm test && npm run typecheck && npm run lint`,
then an A/B timing + capture run
(`node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 --warmup 240 --samples 300 --variant <A> --comparison <B>`,
plus `--mode capture --scenarios Q0,Q1,Q3 --reloads 1 --allow-differences --review-all`).
≥5% repeatable = actionable, <3% = noise; any visual regression rejects.

## 1. RCAS input-range investigation — DONE (adopted: conditioned-space sharpening)

The measured "resolver history made RCAS 47% cheaper" was **not** a value-range
effect — production history texels are bounded [0,1). Reading the wiring showed the
cost: with `FLAG_INPUT_REINHARD`, production RCAS paid a 1×1 exposure load + a
`tonemapInvert` division + an exposure division **per tap** (5 taps/pixel); the
resolver ran with the flag off (plain loads).

- Two isolating variants were built and ABBA-timed (warm blocks, ratio 2):
  `rcas-hoisted-exposure-v1` (identical math, hoisted exposure) → **−20% RCAS**;
  `rcas-tonemap-space-v1` (sharpen the bounded tonemapped texels, invert once)
  → **−34% RCAS** (0.103 → 0.068 ms), −5.7% total pipeline compute.
- Captures Q0/Q1/Q3 + Q9 HDR stress: full-frame RMSE ≤ 1.8/255, HDR-bulb ROI
  ≤ 9/255 max — visually indistinguishable, no overshoot.
- **Adopted** as production `RCAS_SHADER`. The per-tap form is frozen as
  `RCAS_PER_TAP_SHADER` behind the `rcas-fsr315-limiter` / `rcas-fsr315-numeric`
  bench identities; the timing variants remain in the registry for re-testing.

## 2. Host pre-exposure correction — DONE (DeltaPreExposure semantics)

- Pyramid publishes host pre-exposure in the exposure texel's `.b` (1.0 when no
  `preExposureTexture` is supplied) and **meters host-invariantly** — auto-exposure
  must not chase a step the app already metered (found on GPU: without this, the
  conditioning re-adapts for ~2s after a host step and the drift reads as a
  full-screen shading change on flat regions).
- Accumulate ratio-corrects reprojected history in linear space when the host value
  changed (binding 11 = previous frame's exposure texel). Self-gating: identity
  without the input.
- Validated on the new **Q11 host-pre-exposure scenario** (bench drives the scene
  MRT color and `preExposureTexture` together; manifest updated): 2.5× step + ramp
  leaves the shading detector at baseline, never resets accumulation age, and output
  brightness tracks the drive. No-input captures are **byte-identical** pre/post.

## 3. AMD disocclusion constant — DONE (in the fused reconstruct pass)

- `DEPTH_SEPARATION_SCALE`/`DEPTH_SIMILARITY_FLOOR` guesses replaced by AMD's
  per-bilinear-tap confidence voting with the viewport/depth-scaled tolerance
  (`1.37e-5 · halfViewportWidth · max(depth)`), lifted from the GPU-verified
  candidate port. Fused single-pass structure kept (the source's atomic scatter +
  separate pass measured +30%/+22% with no visual win).
- Q3 validation: thin stable silhouette outlines, still scenes near-black, age
  resets confined to trails; finals shift RMSE ≤ 1.1/255; reconstruct pass time
  unchanged (0.035 ms at ratio 2).

## 4. Multi-scale shading-change detector — DONE

The long-standing roadmap item (the source's SPD coarse-mip detector concept)
landed as `packages/core/src/shaders/shadingChange.ts`: one fused half-resolution
dispatch (an 8×8 workgroup covers a 16×16 render tile, so the 4×4/8×8 reductions are
workgroup-local) that maintains a 1-frame luma history, compares jitter-aligned
block-mean luma per scale with base + contrast-scaled noise floors, neutralizes
disoccluded texels, and feeds accumulate's `FLAG_SHADING_CHANGE` aging path (binding
12). Locks kept their self-referential break — untouched, per the documented trap.

Five GPU tuning iterations were needed (all evidence in
`bench/results/raw/E00/pre-spd-reference` + `post-spd-v*`):
1. The candidate's mean-of-per-texel-signed-ratios floored at ~0.10 still-scene
   response — the relative-difference metric weights the darker side of alias
   residue, a coherent bias signed averaging cannot cancel.
2. Jitter-delta-aligned bilinear reprojection helped but did not fix it.
3. Ratio-of-block-means (average first) collapsed the floor.
4. Disocclusion neutralization + coefficient-of-variation-scaled floors fixed
   moving-silhouette false fires.
5. Dropping the 2×2 scale (thin features flicker at that scale regardless) hit the
   full acceptance matrix: still scene at the old detector's baseline (Q1 ≈ 2 vs
   1.1), **fewer** false positives under camera motion on high-frequency content
   (Q4 worst 3.6 vs old 4.9), light steps fire as clean single-frame spikes (Q9:
   137/255 vs old 84 with a 20-frame decay tail), host pre-exposure steps quiet
   (Q11), finals within 1.6/255 RMSE of the old detector.

Cost: **0.044 ms** at ratio 2 (the candidate's two-pass form measured 0.231 ms;
5× cheaper), zero when `settings.detectShadingChanges` is off. Slow ramps
deliberately do not fire (the 1-frame comparison sees only the per-frame delta;
blend + variance clip track ramps — verified no lag/ghosting on Q9 ramp finals).
§8 later measured the lag against a held-light reference: the output does trail a
sub-detector ramp, by about 5 frames with the still relax off and about 10 at the
shipped ×8. That is a delayed fade, not a spatial ghost, which is why the finals
looked clean.

## 5. Still-scene convergence defect — DONE (2026-07-24, consumer report 3)

The first full-pipeline consumer (ssgiDev demo 16, GUIDES-HANDOFF-RESPONSE
report 3) observed visible still-camera output jitter, flickering
`Disocclusion` silhouettes, and a never-settling rolling `AccumulationAge` —
at every ratio including NativeAA, immune to every exposed knob. Reproduced
in OUR bench (Q1, capture mode — no consumer code): sustained
consecutive-frame meanAbsDiff **0.211** after 3 s settle, and — decisive —
**same-jitter-phase** diff 0.182 one period apart, so history itself churned
aperiodically, not just the benign per-phase pattern. Metrology tool:
`scripts/measure-convergence.mjs` (CDP, deterministic capture API,
consecutive + phase-locked diffs, debug-view PNGs). Three stacked defects:

1. **Reconstruct depth-clip vote starved of agreement** (`reconstruct.ts`).
   Only positive-separation taps voted OR carried weight, so at a still
   silhouette one bilinear tap straddling the previous frame's dilated-depth
   quantization (boundary lands up to a texel away per phase) became the sole
   voter → disocclusion 1.0 at edges, re-flipping with jitter phase. Fix:
   every valid tap votes (taps at/behind the surface = confidence 1) and the
   **best tap wins** (max, not weighted mean) — any tap recognizing the
   current surface means same surface; a genuine trail has every tap on the
   old occluder and still reads ~1. This supersedes the 2026-07-22 "skip,
   never veto" semantics (skipping still let lone outliers decide).
2. **Clip-magnitude history aging** (`accumulate.ts`, removed). Aging
   `sampleCount` by `clipAmount` put convergence out of reach wherever the
   converged mean sat outside one jitter phase's variance box (any contrasty
   edge; normalized by `extents` it also fired on numerically-tiny deviations
   on flat walls) — equilibrium age stayed low, alpha stayed high, the age
   view rolled forever. FSR2 never ages on rectification strength; stale
   shading is the clip's + shading detector's job.
3. **Clip write-back re-snapping converged history** (`accumulate.ts`).
   With 1+2 fixed, phase-locked diff was STILL 0.183: the blend stores the
   *clipped* history, so each phase's box re-snaps the buffer regardless of
   alpha (clip fully disabled: 0.005). Fix: `STILL_CLAMP_RELAX` — widen the
   box ×9 only at full stillness (<0.05 render-texel motion) × converged
   history × no disocclusion/shading-change/reactivity; any signal restores
   full rectification. The locks mechanism generalized softly to everywhere.

Q1 ratio 2 ladder (consecutive / phase-locked meanAbsDiff, 0–255): pre
0.211/0.182 → fix 1+2: 0.182/0.183 → +relax ×4: 0.116/0.038 → **+relax ×8:
0.112/0.018** (shipped) → rectification off (floor): 0.109/0.005. NativeAA
ratio 1: 0.081/0.003. New **Q12 cornell-still-convergence** (enclosed box,
IGN-dithered Vogel point-light shadows — the consumer's screen-anchored-
dither aggravator, camera per their repro pose): **0.024/0.012**, disocclusion
view fully black, age saturated (consumer's cornell measured 0.19–0.76; their
converging SVGF reference is 0.039). No-regression: Q3 disocclusion shows the
documented thin trailing crescents only, final ghost-free; Q4 mid-orbit final
clean (the relax fades out above 0.5 texel/frame motion). Runs under
`bench/results/raw/convergence/` (pre-fix / post-fix / exp-noclip /
exp-still8 / post-fix2 labels).

## 6. Alpha (RGBA) passthrough — DONE (2026-08-25, issue #15)

Consumer report (gkjohnson, [#15](https://github.com/pmndrs/upscaler/issues/15)):
the upscaler forces `vec4f(pix, 1.0)` in `easu.ts`/`rcas.ts`, so a transparent
canvas over page content comes back fully opaque. Not the transparency the T&C
mask ([#6](https://github.com/pmndrs/upscaler/issues/6)) is about — that one is
partially-transparent *objects* in the scene; this is the alpha of the final
buffer. #6 remains deferred and untouched.

Reproduced and fixed:

- **Where alpha lives.** The history texture's `.a` is the accumulation age, and
  moving it would change the age's reprojection filter (Catmull-Rom → bilinear) on
  the most convergence-sensitive path. So the resolved alpha goes in the **locks
  texture's spare `.a`** (previously written as a literal `0.0`), and RCAS/blit read
  it through a new binding (rcas 4, blit 5). On the bilinear and spatial paths that
  binding is the color input itself, so one branch-free code path covers all three.
- **Cost.** Zero extra fetch while locks are on: the lock path already samples
  `locksIn` at `prevUV`, and that fetch is now hoisted so alpha shares it. EASU's
  12 taps widen from `vec3f` to `vec4f`.
- **Alpha rectification** is the local 3×3 alpha range, not the variance AABB. At a
  coverage edge the jittered taps span 0..1, so the box is wide and history
  accumulates; on a flat region the box collapses and stale alpha cannot ghost.
  **Amended 2026-10-02 (PR #18 review):** the clamp now takes item 5's still-scene
  relax — `mix(clamp(h, min, max), h, stillRelax / STILL_CLAMP_RELAX)` — because a
  feature thinner than a render texel *does* have the per-phase churn the first draft
  said coverage lacked (see "Alpha still-scene convergence" below).
- **Unconditional — no option (decided in the PR #18 review).** The first draft
  shipped an `alpha` constructor option defaulting to `renderer.alpha`, with
  RGB-only builds of EASU / accumulate / RCAS / blit byte-identical to the
  pre-alpha shaders. Review (gkjohnson, then the maintainer) found the default
  backwards in practice: three's `WebGPURenderer` defaults to `alpha: true`
  (`Renderer.js`, r184–r186), so the RGBA builds already ran for nearly everyone
  and the opaque builds only ran on an explicit `alpha: false`. With alpha-1
  inputs the RGBA builds produce identical RGB and alpha exactly 1 (EASU's dering
  clamp and accumulate's alpha box collapse to [1, 1], `mix(1, 1, w)` stores 1.0
  in rgba16float, RCAS passes the center alpha, blit samples a constant 1), so the
  option bought only the ~33 µs below at the price of a second code path, an API
  surface, a linked-guides mismatch warning, and a bind-group footgun (the bench's
  `_rcasShader` overrides declared the alpha binding while the opaque `Upscaler`
  did not bind it). Removed along with the `alpha-rgba-v1` / `alpha-opaque-v1`
  bench identities and `npm run bench:alpha`; the table below is kept as the
  measured cost of carrying alpha. three's own `FSR1Node` makes the same call.

Cost — interleaved ABBA, `--variant alpha-rgba-v1 --comparison alpha-opaque-v1`
(identities since retired; see above), 300 samples/block, both sides then-current
production on the production RCAS shader:

| ratio | compute-sum (opaque → RGBA) | delta | accumulate | rcas |
| --- | --- | --- | --- | --- |
| 1 | 0.8887 → 0.9206 ms | +3.6% | +3.3% | +26.7% |
| 2 | 0.6427 → 0.6753 ms | **+5.1%** | +3.4% | +27.2% |
| 3 | 0.6006 → 0.6337 ms | +5.5% | +3.3% | +27.5% |

The absolute cost is **flat at ~33 µs** (+14.6 µs accumulate, +18.1 µs rcas):
both passes are display-resolution, so it does not scale with the ratio. The
percentage only moves because the rest of the frame gets cheaper as the ratio
rises. Noise floors: 0.3–0.4% on compute-sum and accumulate (delta is 10–15×
that, solidly real); 9.7% on rcas, where the delta is ~2.8× the floor.

**RCAS is the surprise: +27%.** Production RCAS is the cheap conditioned-space
form at 0.067 ms (NEXT-STEPS item 1), so one extra display-resolution texture
load is a large *relative* addition even though it is small in absolute terms. On
the temporal path that load genuinely hits a second texture (the locks buffer);
on the spatial path `alphaSource` is the color input itself and should be
cache-warm, which this temporal-path benchmark does not measure.

**Correction to an earlier measurement.** A first pass reported +2.6% total. That
run compared two *separate* invocations (not interleaved) and, more importantly,
used the default bench variant — which resolves to `RCAS_LEGACY_SHADER`, the
heavy per-tap form. Against that baseline the same absolute load is a small
relative cost, which understated the real figure. The table above supersedes it.

**Reproducing it.** The A/B pair was retired with the option, so this table can no
longer be re-run as-is; reproducing it would mean restoring the opaque builds on a
scratch branch. Device setup for mobile runs (CDP forward + `adb reverse` for the
bench port, and why `timestamp-query` is often missing on phones) lives in
`bench/docs/BENCHMARKING.md`. The cost is ALU and register pressure, exactly what
diverges between desktop and a mobile tiler, so do not assume ~33 µs transfers.

**Open alternative, not taken.** Putting alpha in the history texture's `.a` and
moving the accumulation age into the locks buffer would make RCAS's alpha free
(it would read the texture it already loads), removing ~18 µs of the 33 µs. It
was rejected to keep the age on its exact Catmull-Rom reprojection rather than
bilinear. The +27% figure is new evidence that this trade deserves a second look
— but only behind `scripts/measure-convergence.mjs` on Q1/Q12, since it changes
the most convergence-sensitive path in the pipeline. Do not do it casually.

GPU verification (headless Chrome + CDP, Apple Metal-3, 2026-08-25):

- **Spatial:** new `examples/14-pathtracer-alpha` — `three-gpu-pathtracer`'s WebGPU
  branch accumulating an RGBA buffer at half resolution behind a transparent canvas.
  Page content reads through the render at display resolution; forcing alpha back to
  1.0 in the same scene reproduces the reported fully-opaque canvas exactly.
- **Temporal:** transparent-canvas scene (torus knot + a thin bar), still and under
  camera motion. Silhouette pixels measured as a clean 2-pixel ramp from the page
  color into the object; no halo, no alpha trail under motion.
- **Surfaces:** raw `Upscaler`, `UpscalePass`, and `upscaleScene()` all composite.
  `UpscalePass`'s present quad needed `transparent: true` + `NoBlending` — an opaque
  material resolves alpha to 1, and a full-screen present is an overwrite, not a
  composite.
- **No regressions:** examples 01/02/03/05/09/12/13 re-captured unchanged; locks and
  accumulation-age debug views unchanged.

Frozen-identity note: the alpha-source binding was added to **every** RCAS form, so
`rcasPerTap` (and `easuSourceApprox`, which derives from `EASU_SHADER`) re-fingerprint.
Their A/B pairings stay valid — candidate and baseline gained the same plumbing — and
the new fingerprints are recorded in the two shader tests. Removing the option did not
change a byte of any RGBA shader (all eight exported EASU/RCAS/blit/accumulate strings
compared identical before/after), so every production fingerprint is unchanged by it.

**Alpha still-scene convergence (review nit, measured 2026-10-02).** The concern:
the alpha history was hard-clamped to the current phase's 3×3 alpha range with no
lock protection and no `STILL_CLAMP_RELAX`, so a feature thinner than a render texel
gets jitter phases whose 3×3 is all-0 (or all-1) and re-snaps the converged coverage
every cycle — convergence rule 2's failure, for alpha. New meter
`scripts/measure-alpha-convergence.mjs` drives `examples/15-transparent-canvas`
(sub-texel wires + knot over a zero-alpha background) with the animation frozen and
the camera still, steps frames through three's animation loop, reads the
rgba16float output texture back from the GPU, and reports per-pixel churn over two
jitter cycles. Coverage pixels (temporal-mean alpha in (0.02, 0.98) or any per-frame
swing > 0.02), 960×540, sharpness 0.8, settle 300–400; `cons` / `std` are mean
consecutive |Δα| and per-pixel temporal std-dev on the 0–255 scale, `rel` is std/mean
for alpha | for display-mapped luma (premultiplied by coverage here, so shared
coverage flicker shows equally in both):

| ratio | shading detector | alpha clamp | α cons | α std | α rel | luma rel | pixels with α swing > 0.25 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | on (default) | hard (as reviewed) | 2.877 | 3.197 | 0.033 | 0.064 | 303 |
| 2 | on | **still-relaxed (adopted)** | 2.761 | 2.986 | 0.032 | 0.063 | 301 |
| 2 | on | none (floor) | 2.747 | 2.963 | 0.032 | 0.064 | 301 |
| 3 | on | hard | 5.006 | 7.416 | 0.105 | 0.150 | 2052 |
| 3 | on | **still-relaxed** | 4.853 | 6.933 | 0.099 | 0.148 | 2026 |
| 3 | on | none | 4.268 | 5.706 | 0.072 | 0.148 | 1922 |
| 2 | off | hard | 1.562 | 1.938 | 0.018 | 0.041 | 2 |
| 2 | off | still-relaxed | 1.478 | 1.726 | 0.017 | 0.041 | 0 |
| 3 | off | hard | 3.719 | 6.632 | 0.094 | 0.133 | 1716 |
| 3 | off | still-relaxed | 3.479 | 5.713 | 0.084 | 0.131 | 1691 |
| 3 | off | none | 2.979 | 4.679 | 0.058 | 0.131 | 1594 |

Same-jitter-phase |Δα| was ≤ 0.003 in every run: the output is a settled periodic
orbit, so all of the churn is the per-phase pattern. Reading it:

- **The mechanism is real but a minority share.** Removing the clamp entirely (the
  floor) cuts alpha churn 5% at ratio 2 and 15–23% at ratio 3, where the wires
  (~0.66 render px) are genuinely sub-texel.
- **Most of the wire shimmer is shared with color, not alpha-specific.** Color's
  relative flicker is 1.4–2× alpha's in every configuration, and turning the
  shading-change detector off roughly halves alpha churn at ratio 2: the
  accumulation-age and shading-change debug views show the detector firing in
  render-space blocks along the still wires (full-contrast sub-texel geometry over an
  empty background), ageing color and alpha history together. That is the color
  path's live "shading-change tuning" landmine on this content, not something the
  alpha resolve can or should fix — left as a follow-up. **Fixed in §9** (issue #22): a
  one-sided contrast floor; with it, the detector-on rows equal the detector-off rows.
- **Adopted the still-scene relax** (the color path's own rule-2 signal): it reaches
  the floor at ratio 2 and closes about a third (detector on) to half (detector off)
  of the gap at ratio 3. It cannot close all of it because `stillRelax` requires
  converged history, which the shading detector keeps resetting on those wires.
  Motion, disocclusion, shading change and reactivity all fold into `stillRelax`, so
  everywhere the color box is at full rectification the alpha clamp is too —
  behavior under motion is unchanged. An opaque input still resolves to alpha
  exactly 1 (every term of the mix is 1). Color is untouched: Q1 2x 0.112 and Q12 2x
  0.026 consecutive (recorded 0.112 / 0.024), `measure-convergence.mjs` after the
  change. Re-measured after rebasing onto three r186.1: Q1 0.114, Q12 0.026, and the
  adopted rows above reproduce within 0.001 (ratio 2: 2.760 / 2.985; ratio 3: 4.854 /
  6.934).

Reproduce: `node scripts/measure-alpha-convergence.mjs --ratio 3 [--settings
'{"detectShadingChanges":false}']`; artifacts (summary JSON, alpha-mean and
alpha-range PNGs, the six worst pixels traced over a cycle) land under
`bench/results/raw/alpha-convergence/`. Footgun the meter documents: stepping frames
in a bare `for` loop never advances three's node frame, so the velocity node keeps
the camera's last move in every motion vector and history never settles — step
through `renderer.setAnimationLoop` instead.

**Behaviour change for consumers.** 0.2 wrote alpha 1.0 everywhere. With a default
`WebGPURenderer` (`alpha: true`, clear alpha 0) and no `scene.background` / opaque clear
color, empty regions are now transparent through `UpscalePass` and the TSL nodes —
matching three without the upscaler. Set `scene.background` or an opaque clear color
(or `alpha: false` on the renderer) for the old look. A post graph that scales the
upscaled `vec4` by a scalar now scales alpha too — example 08's `.mul(vignette)` faded
its frame edges to transparent over the page until the vignette became
`vec4(vec3(v), 1)` (caught by rendering every opaque example over a magenta page).
Flagged as a breaking change in the release notes (README "Alpha" carries the migration
note).

## 7. Thin-feature locks under noisy SSGI — MEASURED, configuration not core (2026-10-02, issue #17)

Maintainer report ([#17](https://github.com/pmndrs/upscaler/issues/17), original repro
lost): 1px wireframe lines over an SSGI-lit scene boil with a still camera; jitter-tied
(`jitter: false` removes it); `DebugView.ShadingChange` and `Locks` busy along the
lines, but toggling `lockThinFeatures` / `detectShadingChanges` changes nothing visible.
Proposed mechanism: noise makes the lock's own break term (`lockShading`) fire every
frame, so locks never mature. Config: `upscale()` node, ratio 2, SSGI with
`useTemporalFiltering` on, GI denoised by `recurrentDenoise({ accumulate: false })`.

**Repro: new bench scenario Q14 `ssgi-thin-feature-locks`.** An open-fronted coloured
box (strong diffuse bounce) holding three `wireframe: true` meshes (a 16×12 lattice
over the back wall, an icosphere, a knot), no shadow-casting light, still camera.
Subruns: `off` (no SSGI — clean control, same geometry), `static` (SSGI static pattern
+ spatial `recurrentDenoise` — the issue's denoiser), `rotating` (same, SSGI's default
rotating pattern — the issue's SSGI setting), `builtin` (static pattern +
`DenoiseNode` — the 06/09 recipe). `measure-convergence.mjs` gained `--subrun` and
`--settings` (capture-setting overrides) for the A/Bs below.

> **Note (2026-10-05):** "the 06/09 recipe" in this section means the
> static-pattern + `DenoiseNode` recipe, which examples 06/09 used when it was
> measured. Since #58 (2026-10-03) examples 06/09 keep SSGI's rotating pattern on
> (with `DenoiseNode`); the `builtin` subrun is unchanged, still the static pattern.

**Wire-mask metrics** (ratio 2, 1280×720, settle 240, 97 frames; 0–255 scale). The
mask is the 16 042 display pixels where the lock lifetime averages > 0.3 on the
clean `off` control — "the thin features locks are meant for". `cons` = mean
consecutive-frame |Δ|, `phase` = same jitter phase one period (32) apart, `std` =
per-pixel temporal luma std-dev, `locks` / `sc` = mean `Locks` / `ShadingChange`
debug value over 32 frames on the mask:

| subrun | variant | cons | phase | std | locks | sc |
| --- | --- | --- | --- | --- | --- | --- |
| off | default | 0.465 | 0.041 | 0.70 | 0.71 | 0.0004 |
| off | locks off | 0.877 | 0.002 | 1.21 | 0 | 0.0004 |
| static | **default (issue's denoiser, static SSGI)** | 1.162 | 1.826 | 2.05 | 0.47 | 0.0040 |
| static | locks off | 1.772 | 2.422 | 2.93 | 0 | 0.0040 |
| static | shading change off | 1.161 | 1.822 | 2.05 | 0.47 | 0 |
| static | lock break (`lockShading`) removed* | 1.153 | 1.796 | 2.03 | 0.48 | 0.0040 |
| static | rectification off* | 1.160 | 1.801 | 2.03 | 0.47 | 0.0040 |
| static | `maxAccumulation` 64 | 0.446 | 0.831 | 0.91 | 0.47 | 0.0041 |
| static | jitter off* | 0.307 | 2.047 | 1.45 | 0.29 | 0.0004 |
| rotating | **default (issue config)** | 1.207 | 3.513 | 3.07 | 0.53 | 0.0059 |
| rotating | locks off | 1.931 | 5.373 | 4.55 | 0 | 0.0059 |
| rotating | shading change off | 1.206 | 3.508 | 3.06 | 0.53 | 0 |
| builtin | **default (06/09 recipe)** | 0.684 | 0.029 | 0.93 | 0.52 | 0.0037 |
| builtin | locks off | 1.107 | 0.0004 | 1.46 | 0 | 0.0037 |

\* Local shader / resolver edits, not committed (rectification off = clip extents
×1000; jitter off = `jitter: false` in the bench resolver's `configure`).

Full-frame `measure-convergence.mjs --pairs 40` (consecutive / phase-locked): off
0.052/0.002, static 0.341/0.897, rotating 0.393/1.535, builtin 0.183/0.004; static
with locks off 0.415/1.021, shading change off 0.337/0.893, `maxAccumulation` 64
0.147/0.473. The bench edits regress nothing: Q1 0.115/0.022, Q12 0.024/0.001
(recorded 0.112/0.018 and 0.024/0.012).

Reading it, hypothesis by hypothesis:

- **Locks do engage.** Mean lifetime on the wires is 0.47 (rotating: 0.53) against
  0.71 on the clean control. Turning them off raises wire churn by about half
  (cons 1.16 → 1.77, std 2.05 → 2.93) in every SSGI subrun. So the toggle is not a
  no-op; it is the difference between bad and worse.
- **The lock break is not what limits them.** Removing `lockShading` entirely moves
  lock life 0.471 → 0.476 and churn by under 1%. Under noise the 3×3 contrast that
  scales the break threshold grows with it. What lock life is limited by is detection:
  some phases do not see the wire as a peak against a noisy neighbourhood, so it decays.
- **Shading change is a non-factor here** (triage hypothesis (a)). The detector reads
  0.004 on the wires, and turning it off changes nothing to three decimals. The 8×8 and
  4×4 block means average the noise away. #22's false positives (sub-texel wires over an
  *empty* background) are a different case, and do not reproduce over a lit wall.
- **Rectification is a non-factor.** With the clip effectively disabled the numbers
  are unchanged, so this is *not* convergence rule 2's re-snap (§5). The noisy
  neighbourhood box is already wide enough that history passes untouched.
- **The boil is input temporal noise at the accumulation floor.** It scales with
  `maxAccumulation`: 64 cuts wire std by 56%. The source is the denoiser.
  `recurrentDenoise` with `accumulate: false` keeps no history, but it re-rolls its
  à-trous kernel rotation every frame (`_noiseIndex = frame.frameId`, an aperiodic R²
  index into `bindAnalyticNoise`). Every frame is a new noise draw, so the output can
  only average it down. With `DenoiseNode` (fixed index) on the static pattern, the same
  wires converge to the clean periodic orbit (same-phase 0.029 vs the control's 0.041).
  The per-phase churn left over is the benign jitter pattern.
- **SSGI's rotating pattern doubles it** (triage hypothesis (b), confirmed): same-phase
  1.83 → 3.51, std 2.05 → 3.07, on top of the denoiser's noise.
- **"Jitter-tied" is half the story.** With jitter off, frame-to-frame boil drops 74%
  (cons 1.16 → 0.31), which matches the report. Same-phase drift *rises*, though, to
  2.05, and std stays at 1.45. The denoiser noise is still there. Without jitter it
  surfaces as slow wander instead of boil. Jitter amplifies the frame-to-frame swing
  because the screen-anchored GI pattern lands on a different scene point each phase,
  and partial wire coverage mixes in the noisy wall behind.
- **A reactive mask is the wrong tool** (hypothesis (c), from code, not GPU-measured).
  Reactivity zeroes `lockLife` and drives the blend weight to ≥ 0.9, so a reactive wire
  would show the raw per-frame noise. That is the opposite of what's wanted.

**Decision: no core change.** Every core gate the issue suspected measures as a
non-factor, and the gate that does matter (locks) already helps. The fix is in the
input: SSGI `useTemporalFiltering = false`, and a denoiser that does not re-roll per
frame (`DenoiseNode`, the 06/09 recipe). If an integration must keep per-frame-noisy GI,
raising `maxAccumulation` trades responsiveness for noise. The principled end state is
still the fused GI-history path ([#7](https://github.com/pmndrs/upscaler/issues/7)).
Q14 is its natural acceptance scenario: `static` should approach `builtin`.

> **Note (2026-10-05):** as above, "the 06/09 recipe" here is the static-pattern +
> `DenoiseNode` recipe 06/09 used at the time. #58 later moved examples 06/09 to
> SSGI's rotating pattern (see CLAUDE.md, "SSGI rotating pattern"); this decision
> was measured before that change and is recorded as it stood.

Reproduce: `node scripts/measure-convergence.mjs --scenario Q14 --subrun static
--pairs 40 [--settings '{"lockThinFeatures":false}']`. The wire-mask probe
(mask derivation + debug-view averaging) was a scratch CDP script. Its method is
described above, so it can be rebuilt on the bench capture API.

## 8. `STILL_CLAMP_RELAX` under sub-detector lighting drift — MEASURED, constant kept (2026-10-02, issue #5)

Item 5's still-scene relax widens the variance box ×(1 + `STILL_CLAMP_RELAX`) on
pixels that are still, converged and signal-free. Every signal we have (motion,
disocclusion, shading change, reactivity) restores full rectification at once, so
the exposure is narrow: **a lighting change too slow for the shading detector,
on a still camera, on converged history.** Nothing measured that gap before:
Q9's step fires the detector, and Q3/Q4 move.

**Method.** New scenario **Q15 `sub-detector-lighting-drift`**. The camera is still
at the base pose. The sun ramps 8 → 2 over 120–188, holds, ramps 2 → 8 over
240–308, then holds. The ramps are exponential at a constant ~2.03 %/frame
change of the sun term. That is half the detector's flattest floor
(`SHADING_FLOOR_COARSE = 0.04`, before the contrast term). There is no step, so
history is still-converged when each ramp starts. New meter
`scripts/measure-drift-lag.mjs` plays the ramp and, at the same frames and jitter
phases, compares against a **held-light reference**: the same scenario with the
sun frozen at that frame's intensity for every frame 0..f. That reference is the
image an accumulator with no lag would show. Before a ramp starts the two runs
are byte-identical, so the error there is exactly 0. Metrics are on the
presented canvas (0–255):
- mean |Δ| RGB;
- signed Δluma (positive means stale brightness);
- the share of pixels more than 4/255 off;
- **lag in frames**: how many frames earlier the reference had the ramp's
  brightness, averaged over the middle of each ramp.

A third pass replays the ramp through `DebugView.ShadingChange` to confirm the
detector stayed silent. The relax is a WGSL constant, so each value is a
separate run with the source edited.

Settings and environment:
- ratio 2, 1280×720, frames sampled every 2;
- Apple Metal-3, headless Chrome over CDP;
- run from a git worktree, which is fine because nothing here is timing.

Relax 0 was measured with the `alphaRelax` guard that now ships. See the trap below.

**The detector really is silent.** On Q15 the shading-change view sits at
0.66 % lit before the ramp (the still-scene block speckle Q1/Q12 also show — most
of it was §9's one-sided contrast gate, since fixed) and
peaks at 0.97 % during both ramps. Q9's 8 → 2 ramp is *mostly* sub-detector too:
0.68 % before, 1.42 % at its last frames. It is linear, though, so the per-frame
relative change climbs from 1.3 % to 5 % and crosses the 4 % floor at the tail.
It is also bracketed by steps (60, and 2 → 3.2 at 180) that fire at 72 % / 65 %
of pixels, which is why Q15 exists rather than reusing Q9.

**Auto-exposure confounds the measurement, so the clip is isolated with it off.**
The adapting exposure re-decodes history that was conditioned under the
previous exposure. There is no conditioning-exposure history correction (see
"not planned" below). On a down-ramp, the exposure rising decodes the stale-bright
history darker, which partly cancels the lag. With auto-exposure on, Q15 lag reads
30–45 % lower, and Q9 shows a slow signed drift after its steps that has nothing
to do with the clip. The meter takes `--settings '{"autoExposure":false}'` for this
reason. Both are recorded below. Convergence is measured with the canonical capture
settings (auto-exposure on), as in item 5.

| `STILL_CLAMP_RELAX` | Q15 lag, frames, down / up (AE off) | Q15 peak \|Δ\| down / up (AE off) | Q15 lag, frames (AE on) | Q9 ramp lag / peak (AE off) | Q1 consecutive / phase-locked | Q12 consecutive / phase-locked |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (off) | 5.3 / 4.8 | 5.1 / 5.4 | 3.8 / 4.4 | 4.3 / 6.2 | 0.197 / 0.178 | 0.039 / 0.050 |
| 4 | 9.6 / 8.6 | 8.4 / 8.9 | 5.5 / 6.9 | 7.1 / 10.8 | 0.122 / 0.044 | 0.026 / 0.030 |
| **8 (shipped)** | **10.5 / 9.1** | **9.3 / 9.5** | **5.9 / 7.3** | **7.7 / 12.4** | **0.115 / 0.027** | **0.026 / 0.030** |
| 16 | 11.1 / 9.3 | 9.9 / 9.8 | 6.3 / 7.6 | 8.1 / 13.5 | 0.111 / 0.016 | 0.025 / 0.030 |

Convergence columns come from `measure-convergence.mjs --pairs 40`: settle 180,
then the mean of 40 consecutive pairs, plus one same-phase pair 32 frames apart.
The phase-locked figure is a single pair. At ×8 it reads 0.027 here against the
0.018 recorded in item 5. Relax 0 reproduces item 5's pre-relax 0.18.

Reading it:

- **The drift cost is a step, not a slope.** Turning the relax on (0 → 4) nearly
  doubles the lag: +80 % lag frames, +65 % peak error. After that the curve is
  flat: 4 → 8 adds +10 % and 8 → 16 adds +5 %. The cause is the size of the
  per-frame drift. On every pixel with real 3×3 variance (texture, edges,
  specular), a ×5 box is already wide enough that the clip stops catching it,
  so further widening has little left to release. On flat surfaces σ ≈ 0 keeps
  even the ×17 box tight. That is why the error concentrates in the lit-knots ROI
  (14/255 at ×8) and the grid floor (8/255), not everywhere.
- **The convergence benefit keeps paying past ×4.** On Q1, phase-locked churn falls
  roughly 40 % per doubling: 0.044 → 0.027 → 0.016. Consecutive churn and Q12
  flatten after ×4.
- **The lag is a delayed fade, not a ghost.** The signed error is about equal to
  the absolute error, so the whole frame is uniformly a little too bright on the
  way down and too dark on the way up. There is no spatial trail. At ×8, 2 %/frame
  and 60 fps the output trails the lighting by about 10 frames (≈ 175 ms).
  Relax 0 still trails by about 5 frames: that part is the EMA itself, which the
  ×1 clip only partly catches. After the ramp stops, ×8 needs about 60 frames to
  get back to 1/255 (relax 0: 0.8 at +60).
- **Recommendation: keep 8.** There is no knee in 4–16 to retune to. Dropping to 4
  buys back about 10 % of the lag and gives up about 40 % of Q1's phase-locked
  convergence. Dropping to 0 reintroduces item 5's defect. The lag that matters
  arrives with *any* useful relax, so the fix, if one is ever needed, is the
  issue's second option: **gate the relax on a slow-drift term.** For example, a
  persistent per-block luma reference that is refreshed only when history
  converges, compared against the current block mean. That catches the
  *cumulative* change the 1-frame detector cannot see, and its floor can be set
  in total change rather than per-frame change. Not built. A ~175 ms fade lag on
  a deliberately slow ramp is not visible as ghosting, and it is a new detector
  with its own tuning.

**Trap found on the way, now guarded: `STILL_CLAMP_RELAX = 0` divided by zero.** The
alpha resolve computed `alphaRelax = stillRelax / STILL_CLAMP_RELAX` (item 6). At 0 that
is 0/0 = NaN in the alpha clamp. On Metal the canvas still composited opaque, but WGSL
leaves the result undefined. The divisor is now `max(STILL_CLAMP_RELAX, 1e-6)`, which
folds to the constant for any positive value, so setting 0 is a valid "relax off".
Production output is unchanged: Q0 (final + reactivity), Q1 (f23, f119), Q5, Q9 f64,
Q12, Q13 and Q15 f154 captures are byte-identical before and after the change. The
accumulate fingerprint moved to `63dbdfad`. Q1 at relax 0 with the guard reads
0.197 / 0.178, the same as the relax-0 row above.

Reproduce, with the bench on 5199 or `--url`; edit `STILL_CLAMP_RELAX` per run:

```bash
node scripts/measure-drift-lag.mjs --scenario Q15 --frames 116:379:2 --label relax8-noae \
  --settings '{"autoExposure":false}'
node scripts/measure-drift-lag.mjs --scenario Q9 --frames 56:239:2 --label relax8-noae \
  --settings '{"autoExposure":false}'
node scripts/measure-convergence.mjs --scenario Q1 --ratio 2 --pairs 40 --label relax8
```

Artifacts land under `bench/results/raw/drift-lag/` and `bench/results/raw/convergence/`
(git-ignored): per-frame rows per ROI, detector lit fractions, and PNGs at `--keep`
frames.

## 9. Shading-change false positives on sparse geometry — DONE (2026-10-03, issue #22)

Report ([#22](https://github.com/pmndrs/upscaler/issues/22), found in §6's alpha
work): on `examples/15-transparent-canvas`, `DebugView.ShadingChange` fires in
render-space blocks along full-contrast sub-texel wires over an empty background,
with a still camera. That ages non-locked history, so the wires never fully
converge. Turning the detector off halved alpha churn at ratio 2.

**Cause: the contrast floor was one-sided.** `scaleResponse` gates the relative
difference of two block means (`1 − min/max`) with a floor of
`base + SHADING_FLOOR_CV · cv`. The comparison is symmetric, but `cv` came from the
**current frame only**. A wire thinner than a render texel is point-sampled: in a
given jitter phase it lands in a texel or misses it. A near-vertical wire either
crosses every row of a 4×4 block or none of them. Two cases follow:
- **The wire appears.** The current block holds m lit texels of N, so
  cv ≈ √(N/m − 1), about 1.7 at m = 4. The floor rises to about 0.69 and the block
  stays quiet. The `cv` term exists for exactly this.
- **The wire vanishes.** The current block is all black: cv = 0, so only the base
  floor (0.08) applies. The previous frame had the wire, so `relative` = 1 and the
  block fires at full strength.

So the detector fired exactly when content left a block. It was a false positive
every time the jitter phase missed a wire.

**Fix: the floor reads both frames' spread.** The block now also sums the
reprojected previous luma² (`tileSums` grows from `vec3f` to `vec4f`). `cv` is the
pooled within-frame standard deviation over the joint mean:
`sqrt((var_cur + var_prev) / 2) / ((mean_cur + mean_prev) / 2)`. The between-frame
shift stays out of the spread, so a genuine change on a flat surface does not raise
its own floor. Nothing else changed: the constants, the scales, disocclusion
neutralization and accumulate's `SHADING_AGE` consumption are all as before.

**Repro: new scenario Q16 `sparse-wires-empty-background`.** Three fans of bars
over an opaque black background, still camera, plus a solid knot as a full-coverage
control:
- near-vertical, near-horizontal and diagonal, so both block axes are covered;
- 0.012 / 0.018 / 0.024 units wide, which is about 0.5 / 0.8 / 1.05 render px at
  ratio 2 and 0.35 / 0.5 / 0.7 at ratio 3 (1280×720).

The fans' light steps to a quarter at frame 300. That is a genuine change on exactly
this content, for `measure-drift-lag.mjs`.

`measure-convergence.mjs` gained two outputs:
- `--shading-frames N` replays the settle frame onward through the shading-change
  view and reports the share of pixels whose response v > 0.1 (`firing`, which ages
  history by ≥ 7.5 %) and v > 0.5 (`strong`).
- A content-mask churn: consecutive and same-phase diffs over pixels brighter than
  40/255 in the settle frame. On Q16 the full-frame mean is mostly black.

Debug views have presented untone-mapped since #45, so the meter sRGB-decodes the
red byte back to v. Lit fractions here are therefore not comparable to §8's, which
were ACES-mapped bytes > 10.

Settings and environment:
- Apple Metal-3, headless Chrome over CDP, run from a git worktree. Nothing here
  is timing.
- Settle 180. Consecutive diff averaged over 40 pairs at ratio 2 and 73 at ratio 3
  (one full jitter period: 32 and 72 phases).
- Same-phase: one pair, one period apart.
- `firing` / `strong`: averaged over frames 180–211.

**Still scenes (pre → post):**

| scenario | ratio | consecutive | content-mask consecutive | same-phase | firing (v > 0.1) | strong (v > 0.5) |
| --- | --- | --- | --- | --- | --- | --- |
| Q16 | 2 | 0.0254 → **0.0220** (detector off: 0.0219) | 0.490 → 0.482 | 0.0029 → 0.0029 | 2.41 % → **0.042 %** | 2.20 % → 0 |
| Q16 | 3 | 0.0391 → **0.0345** (detector off: 0.0344) | 0.989 → 0.988 | 0.0040 → 0.0040 | 4.47 % → **0.066 %** | 3.88 % → 0.001 % |
| Q1 | 2 | 0.1148 → 0.1109 | 0.175 → 0.172 | 0.0267 → 0.0268 | 0.43 % → 0.018 % | 0.29 % → 0 |
| Q1 | 3 | 0.1311 → 0.1262 | 0.197 → 0.193 | 0.0608 → 0.0608 | 0.53 % → 0.019 % | 0.41 % → 0.0005 % |
| Q12 | 2 | 0.0255 → 0.0222 | 0.044 → 0.040 | 0.0300 → 0.0301 | 1.19 % → 0 | 0.67 % → 0 |
| Q12 | 3 | 0.0619 → **0.0470** | 0.103 → 0.084 | 0.0139 → 0.0141 | 1.82 % → 0.060 % | 1.40 % → 0 |

**Genuine detections and slow ramps (ratio 2), per-frame `firing` / `strong` / mean v:**

| event | pre | post |
| --- | --- | --- |
| Q9 f60, light step 3.2 → 8 | 64.46 % / 58.47 % / 0.582 | 64.06 % / 57.33 % / 0.572 |
| Q9 f180, step 2 → 3.2 after the ramp | 53.25 % / 41.09 % / 0.417 | 53.62 % / 41.42 % / 0.420 |
| Q9 ramp f121–179 (must stay quiet), max per frame | 0.83 % / 0.44 % | 0.04 % / 0 |
| Q11 host pre-exposure f56–185 (must stay quiet), max | 0.55 % / 0.35 % | 0.06 % / 0 |
| Q15 sub-detector ramps f116–315 (must stay quiet), max | 0.64 % / 0.44 % | 0.06 % / 0 |
| Q4 orbit f100–139 (motion false positives), mean / max | 0.47 % / 0.67 % | 0.016 % / 0.042 % |
| Q4 orbit f340–379, mean / max | 0.73 % / 1.03 % | 0.045 % / 0.15 % |
| Q16 f300, the fans' light ÷ 4 | 4.12 % / 3.62 % on a 2.3–2.5 % false-positive floor | 2.37 % / 1.54 % on a ~0 % floor |

The step responses are unchanged within about 2 %, and both still fire as clean
single-frame spikes (f59 and f61 read ~0). Every "must stay quiet" window got
quieter.

**Q15 drift lag is unchanged.** `measure-drift-lag.mjs --scenario Q15 --frames
116:379:4 --settings '{"autoExposure":false}'`, lag averaged over frames 136–188 and
256–308:
- pre: 10.21 / 8.81 frames, peak |Δ| 9.31 / 9.53;
- post: 10.23 / 8.83 frames, peak 9.34 / 9.55;
- tail |Δ| at f312 / f340 / f368 / f376 identical to 0.02.

§8 recorded 10.5 / 9.1 with its own averaging window at a 2-frame step.

**Example 15 alpha** (`measure-alpha-convergence.mjs`, §6's metrics on coverage
pixels):

| ratio | variant | α cons | α std | α rel | luma rel | α swing > 0.25 px |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | pre (§6's adopted row) | 2.761 | 2.986 | 0.032 | 0.063 | 301 |
| 2 | **post** | **1.478** | **1.726** | **0.017** | **0.041** | **0** |
| 2 | detector off | 1.478 | 1.725 | 0.017 | 0.041 | 0 |
| 3 | pre | 4.857 | 6.936 | 0.099 | 0.148 | 2026 |
| 3 | **post** | **3.483** | **5.717** | **0.084** | **0.131** | **1691** |
| 3 | detector off | 3.481 | 5.715 | 0.084 | 0.131 | 1691 |

On the issue's own repro, the detector now costs nothing. Same-phase alpha is ≤ 0.011
in every run: the orbit stays periodic.

**The one trade: the wire fans re-converge a little slower after a genuine sparse
change.** `measure-drift-lag.mjs --scenario Q16 --frames 296:356:2` (auto-exposure
off) sums the |Δ| against the held-light reference over f300–356, per ROI:

| ratio | full | upright fan | level fan | slant fan + knot |
| --- | --- | --- | --- | --- |
| 2, pre → post | 18.68 → 19.37 | 27.86 → 31.34 | 34.09 → 39.94 | 53.99 → 48.70 |
| 3, pre → post | 12.14 → 11.56 | 10.72 → 12.37 | 10.38 → 11.75 | 57.42 → 50.32 |

The fans' integrated error rises 12–17 %. The knot's ROI falls 10–12 %. On the
fans, the error at f300 is within about 0.1/255 either way, and both versions decay
to ≤ 0.6/255 by f356.

The mechanism is not lost detection. A quarter-intensity step on a block that holds
the wire in both frames is under the `cv` floor before and after the fix (relative
0.75 against a floor of about 0.7–0.9 at the 4×4 scale). Before the fix, the
constant false fires kept the fans permanently part-aged. Their short effective
history happened to answer the real step sooner too. Now they are converged like the
rest of the frame, and they lag like §8's sub-detector case: a delayed fade
(signed ≈ absolute), not a ghost. The always-on aging is what convergence rule 2
forbids paying for that.

**Two variants were measured and rejected:**
- **Second moment over the bilinear taps** (`Σ wᵢ lᵢ²`, not the squared blend).
  Interpolation halves a sub-texel feature across two texels and so understates its
  sparsity. This silenced Q16 completely (0.000 / 0.002 %), but cost the genuine
  steps 3–4 % of mean response (Q9 f60 0.565, f180 0.399) by inflating the spread on
  textured content.
- **`max(cv_cur, cv_prev)`.** Each frame's cv is invariant under a multiplicative
  lighting change, which made this attractive. It left a residual on Q16
  (0.16 % / 0.43 %, all v < 0.5) and lost 7 % on Q9 f180 (0.387).

The shipped pooled form is the only one of the three with no measurable cost on the
steps.

**Is jitter-aligned block placement aligned at ratio 3? Yes.** The blocks are fixed
4×4 / 8×8 render-texel tiles. Only the per-texel reprojection is jitter-aligned
(`+ (jitter − jitterPrev) / renderSize`). The jitter is a sub-texel offset in
render px at every ratio, so no ratio-dependent term is missing. Checked on GPU with
the fix in, `firing` on still Q1 at ratio 2 / ratio 3, and Q16 at ratio 3:

| jitter-delta term | Q1 r2 | Q1 r3 | Q16 r3 |
| --- | --- | --- | --- |
| as shipped | 0.018 % | 0.019 % | 0.066 % |
| removed | 0.028 % | 0.083 % | 0.53 % |
| sign flipped | 3.07 % | 3.37 % | 0.46 % |

The term is correctly signed. It does more work at ratio 3 than at 2, because ratio
3 has 72 phases, so consecutive deltas are larger on average.

**Side finding, not addressed: disocclusion flickers on the same wires.**
`DebugView.Disocclusion` on still Q16 shows dashes along the fans. A sub-texel wire
missing from this phase's depth looks like an old occluder that went away, so the
reconstruct pass's best-tap vote reads disocclusion there. This is `reconstruct.ts`
territory (cf. §5 defect 1) and out of scope here. It is the likely reason the wire
pixels themselves still read a low accumulation age after this fix, while the
blocks around them no longer do.

**Cost: not timed.** No ABBA run was made. The change is one extra f32 per thread in
workgroup memory (768 → 1024 B), one multiply and one mix per texel, and a few ALU
ops in the resolve, in a pass that measured 0.044 ms at ratio 2.

Fingerprint: `shadingChange` `41ed97fa` → `061f55cd`. No other shader changed.

Reproduce, with the bench on 5199 or `--url`. For the pre column, check out
`packages/core/src/shaders/shadingChange.ts` from before this change:

```bash
node scripts/measure-convergence.mjs --scenario Q16 --ratio 2 --pairs 40 --shading-frames 32 \
  --views final,accumulation-age,shading-change,locks,disocclusion
node scripts/measure-convergence.mjs --scenario Q16 --ratio 3 --pairs 73 --shading-frames 32
node scripts/measure-convergence.mjs --scenario Q9 --settle 56 --shading-frames 32 --pairs 1
node scripts/measure-drift-lag.mjs --scenario Q16 --frames 296:356:2 --settings '{"autoExposure":false}'
node scripts/measure-alpha-convergence.mjs --ratio 2
```

The per-frame `firing` / `strong` / mean v series land in `summary.json`
(`shadingChange.perFrame`) under `bench/results/raw/convergence/`, which is
git-ignored.

## 10. Auto-exposure ceiling on dark scenes — DONE (2026-10-03, issue #49): `EXPOSURE_MAX` 80 → 8

PR #48's probe found that a dark scene saturates temporal history near linear
12.5. On a mostly-black frame the log-average sits at its 1e-4 floor, so
auto-exposure pins at `EXPOSURE_MAX`. At 80 that broke HDR highlights in three ways.

**The arithmetic.** The temporal path stores `x / (1 + x)` of the pre-exposed color
`x = L · exposure` in an rgba16float history.

- **Hard ceiling, from `tonemapInvert`.** It clamps the stored value at 0.999, so
  nothing resolves above `0.999 / 0.001 / exposure = 999 / exposure`. That is 12.49
  at exposure 80. The f16 grid alone would allow 2047 / exposure, since the last
  value below 1 is `1 − 2⁻¹¹`. So the clamp sets the ceiling, not storage.
- **f16 quantization below the ceiling.** In [0.5, 1) the f16 step is 2⁻¹¹, so a
  stored plateau moves in relative steps of about `(1 + x) / 2048`: 4 % at x = 80,
  16 % at x = 320. At exposure 80 a 4.0 plateau reads 3.645, which is the
  `1 − 7·2⁻¹¹` level.
- **Tonemap compression, the one that dominates for small lights.** History blends
  in that space. A highlight with x ≫ 1 stores ≈ 1 whatever its brightness. A
  sub-pixel emitter rasterizes on only some jitter phases (the variance clip
  removes it on the rest), so it accumulates to roughly its coverage fraction
  and decodes to the same value for 0.25 and 64. This is FSR2's firefly guard
  working as designed, but its scale is 1 / exposure. At exposure 80 everything
  above ~0.05 linear counts as a firefly.

**Method.** New probe page `bench/exposure-ceiling.html`, driven by new meter
`scripts/measure-exposure-ceiling.mjs`.

- **Scene.** Emissive squares at 0.25 / 1 / 4 / 16 / 64 linear, in three sizes:
  - 16 render px plateaus, which have native = level at the centre;
  - 3 render px squares;
  - 0.5 render px emitters off the render grid, which have native energy = level.

  They sit on a flat background, black or 0.005 for a night scene.
- **Path.** Temporal, 512² display, ratio 2, sharpness 0.8, still orthographic
  camera.
- **Readback.** The rgba16float output is read back exactly. Centre values and
  window energies are averaged over the last 32 frames (one jitter cycle).
- **Emulating caps.** A fixed `settings.exposure` is exactly what auto-exposure
  produces when it pins at a cap of that value. So each row below is a candidate
  `EXPOSURE_MAX`, run without editing the shader.
- **Metering.** The page also mirrors the luminance pyramid's 32×32 bilinear taps on
  the render-res input, to show what a highlight-keyed exposure would see.

Environment: Apple Metal-3, headless Chrome over CDP, run from a git worktree.

Black background (auto-exposure pins at the cap):

| exposure (= cap) | 16 px plateau 1 / 4 / 16 / 64 | 3 px centre 64 | sub-px energy 0.25 / 1 / 64 (native 0.25 / 1 / 64) |
| --- | --- | --- | --- |
| **80 (old)** | 0.972 / **3.645** / **12.5** / **12.5** | 6.65 | **0.018 / 0.019 / 0.019** |
| 32 | 0.984 / 3.969 / 16.0 / 31.2 | 16.6 | 0.042 / 0.047 / 0.048 |
| 16 | 0.995 / 3.937 / 15.9 / 62.4 | 33.2 | 0.074 / 0.090 / 0.097 |
| **8 (new)** | 0.998 / 3.937 / 15.9 / **63.9** | 54.7 | 0.120 / 0.168 / 0.193 |
| 4 | 0.999 / 3.980 / 15.7 / 63.7 | 54.7 | 0.175 / 0.297 / 0.385 |
| 2 | 0.999 / 3.990 / 15.7 / 63.5 | 54.7 | 0.227 / 0.482 / 0.766 |
| 1 | 1.000 / 3.994 / 15.9 / 63.0 | 54.7 | 0.267 / 0.701 / 1.519 |
| mid-grey scene (0.18, auto, exposure 0.94) | 0.999 / 3.998 / 15.9 / 62.9 | 54.9 | 0.094 / 0.719 / 2.002 (native 0.07 / 0.82 / 63.8 above grey) |

- **The 3 px centre is ~55 at every exposure ≤ 8 and in the mid-grey scene.** That
  value is the temporal path's own response to a 3-pixel square, not an exposure
  effect.
- **Night scene, background 0.005.** Main meters an exposure of 31.6 here (not even
  pinned), so the ceiling is 31.6:
  - **main:** plateaus 16 → 12.9 and 64 → 31.6; sub-pixel energies 0.051–0.060 for
    every level;
  - **cap 8:** plateaus 15.9 / 63.9; sub-pixel energies 0.128 / 0.182 / 0.201.
- **Blit path (sharpness 0) has the same ceiling.** Exposure 80 reads 12.5 /
  12.5; cap 8 reads 15.9 / 63.9.
- **No NaN or Inf** appeared in any run.

**Options weighed.**

- **Lower `EXPOSURE_MAX` — adopted, at 8.**
  - **Bench scenes are untouched.** Every bench scene meters below the cap (auto
    exposure on Q0/Q1/Q2/Q9/Q11 is 2.0–3.3; Q12 is 6.6–6.8). So their target is
    never clamped, and 28 rgba16float output captures read back bit-for-bit
    identical to main: Q0/Q2/Q9/Q11/Q12 at f0, f23, f59, f119 and f239, and Q1 at
    f0, f23 and f239. That covers Q11's host pre-exposure step (host 2.5 at f119)
    and Q9's lighting step.
  - **Every downstream pass is unchanged too.** The shading-change detector
    (it reads the conditioning `.r`, not `avgLum`), locks, accumulation age and
    `DebugView.Exposure` all read that same texel. `measure-convergence.mjs` on Q1
    and Q12 gives identical figures (0.1144 / 0.0258).
  - **Why 8.** It is the smallest power of two above Q12's 6.8. It lifts the
    dark-scene ceiling to ~125 linear and puts a 64 lamp at x = 512.
- **Key exposure to highlights — rejected.** The probe mirrors the 32×32
  metering taps. On a frame of only 3 px squares and sub-pixel emitters, the
  brightest tap reads **0.000** on every jitter phase. Small lamps are exactly the
  #32/#49 case, and a highlight-keyed exposure would never see them. Metering every
  pixel needs a full-resolution reduction, which is a new pass. The 16 px plateaus
  are caught at 512², but at bench resolution the tap spacing is 20 × 11 render
  px. A light near that size would wink in and out of the meter as the camera
  moves, and the exposure would pump.
- **Clamp so metered highlights stay below a knee — rejected**, for the same
  metering blind spot. It would also change Q1, where highlights already sit
  around x ≈ 64.
- **Leave it and document `exposureTexture` — kept as the escape hatch only.** The
  ceiling was reachable with no exposure input at all, so leaving it would ship a
  12.5 ceiling to every dark scene.

**What the cap costs.** A dim scene whose log-average is below 0.18 / 8 = 0.0225
now conditions darker than mid-grey. Its conditioned key becomes `8 · average`
instead of 0.18. To emulate that, `measure-convergence.mjs` ran Q1 and Q12 with a
fixed exposure below their metered value: Q1 at 3.2, 0.72 and 0.16; Q12 at 6.7,
1.5 and 0.33. Those are keys of 0.18, 0.04 and 0.009. The mean of the `Locks`
view's red channel is on 0–255.

| | key 0.18 | key 0.04 (≈ average 0.005 under cap 8) | key 0.009 (≈ average 0.001) |
| --- | --- | --- | --- |
| Q1 consecutive churn | 0.114 | 0.117 (+3 %) | 0.125 (+10 %) |
| Q1 `Locks` mean | 18.5 | 10.1 | 1.8 |
| Q12 consecutive churn | 0.019 | 0.021 | 0.022 |

- **Locks are the cost.** `LOCK_CONTRAST_LO/HI` are absolute in conditioned luma, so
  dim thin features lock less.
- **Churn barely moves.** The variance clip is scale-invariant in the near-linear
  part of the tonemap.
- **The trade.** That is the price of the ~10× headroom. An app that wants its dark
  scene conditioned near mid-grey and has no highlights to protect can pass a
  higher fixed `exposure` or an `exposureTexture`. Neither goes through the auto
  clamp.

**Known and not changed:**
- **Highlight compression is inherent.** Sub-pixel highlights are still compressed
  at every exposure (1.5 of 64 even at exposure 1). Storing linear history, as
  FSR2 does, would remove the near-1 quantization, but that is an `accumulate.ts`
  change, not an exposure one.
- **Bright scenes keep a 999 / exposure ceiling.** It is ~1000 linear at exposure 1.

Reproduce, with the bench on 5199 or `--url`:

```bash
node scripts/measure-exposure-ceiling.mjs --label cap8-black            # auto + fixed sweep
node scripts/measure-exposure-ceiling.mjs --label night --background 0.005 --exposures auto,31.6
node scripts/measure-exposure-ceiling.mjs --label small --hide large --exposures auto
node scripts/measure-convergence.mjs --scenario Q1 --label key04 \
  --settings '{"autoExposure":false,"exposure":0.72}' --views final,locks
```

Artifacts land under `bench/results/raw/exposure-ceiling/` and
`bench/results/raw/convergence/` (git-ignored).

## 11. Sub-pixel emitters under the variance clip — one bug FIXED, the drop-out MEASURED (2026-10-03, issue #51)

Issue [#51](https://github.com/pmndrs/upscaler/issues/51): an emitter smaller than one
render pixel rasterizes only on the jitter phases whose sample lands on it. On every
other phase its 3×3 neighbourhood holds no trace of it, so the history is pulled toward
the background and the emitter flickers or fades instead of converging to its coverage.

**Repro: new bench scenario Q17 `subpixel-emitter-retention`.** Still camera, square-on
to a field of unlit discs (constant radiance 1 and 4) of 0.3 / 0.5 / 0.7 / 1.0 / 1.5
render-px diameter at golden-ratio sub-pixel offsets, plus two 0.5 px lines per block
for a points-vs-lines comparison. There are four blocks:
- left over an empty **black** background, right over a low-contrast **textured** backdrop;
- top **floating** (the background is far behind, so a miss phase is also a depth edge),
  bottom **decal** (a backdrop plane 0.002 behind the discs, no depth edge — like a glint or
  a light painted on a surface).

New meter `scripts/measure-emitter-retention.mjs` reads back, per frame, the upscaler
output (display res, linear) and the jittered input (render res, linear). For each
emitter window it integrates luma energy minus an emitters-hidden run. The reference is
the input itself: mean input energy × the display/render area ratio is what an ideal
accumulator converges to. It reports `retention` (output / reference; 1 = converged to
coverage), `flicker` (temporal std / reference), hit rate, lock / disocclusion /
shading-change activity, and a **switch-off ghost**: the emitters are hidden after the
measured frames and it counts frames until the output stays under 10 % of its lit level.

Settings: ratio 2, 1280×720, settle 180, 64 frames (two jitter periods), Apple Metal-3,
headless Chrome over CDP, run from a git worktree (no timing here). Auto-exposure is
**off** for the attribution (`--settings '{"autoExposure":false}'`): with it on, the
mostly-black frame pins exposure at `EXPOSURE_MAX` and every emitter reads ~2 % retention
whatever else changes — that is [#49](https://github.com/pmndrs/upscaler/issues/49)'s
saturation, and it masks everything below. Radiance-1 rows only below; radiance 4 behaves
the same at lower retention (the invertible tonemap averages in conditioned space, an
energy bias by design that this item does not touch). Even the ideal accumulator keeps only
~0.5–0.6 of a radiance-1 sub-pixel emitter's linear energy for the same reason, so read
retention against the "ideal" row, not against 1.

**Attribution (floating emitters, AE off).** Each mechanism was switched off locally in
`accumulate.ts` (clip: no `clipToAABB`; disocclusion: the mask read as 0) or by setting
(`detectShadingChanges: false`). Retention / flicker:

| variant | black 0.5 px | black 1 px | black line | textured 0.5 px | textured 1 px | textured line |
| --- | --- | --- | --- | --- | --- | --- |
| production | 0.54 / 1.13 | 0.53 / 0.27 | 0.63 / 0.63 | 0.14 / 0.14 | 0.23 / 0.11 | 0.20 / 0.19 |
| clip only (no disocclusion, no shading change) | 0.53 / 1.09 | 0.53 / 0.27 | 0.60 / 0.60 | 0.46 / 0.06 | 0.35 / 0.03 | 0.26 / 0.03 |
| disocclusion only (no clip, no shading change) | 0.22 / 0.19 | 0.39 / 0.11 | 0.34 / 0.18 | 0.26 / 0.15 | 0.42 / 0.09 | 0.40 / 0.16 |
| ideal (none of the three) | 0.52 / 0.06 | 0.62 / 0.02 | 0.62 / 0.03 | 0.48 / 0.06 | 0.59 / 0.02 | 0.64 / 0.03 |

Reading it:

- **Three mechanisms, each sufficient on its own over black.** The variance clip, the
  disocclusion mask and the shading-change detector each erase a sub-pixel emitter's
  history on miss phases; removing any one leaves the others to do it.
- **Disocclusion is the largest single fader for floating emitters.** It fires on 7–34 %
  of frames — exactly the hit→miss transitions — because the reconstruct pass compares
  against the *previous frame's* dilated depth, where the emitter's depth still sits. It
  resets age, kills the lock and zeroes the still relax. Alone it costs 30–60 % of the
  ideal retention. Decal emitters (no depth edge) show 0 % disocclusion. This is the
  cross-frame-gather divergence from FSR's same-frame scatter (CLAUDE.md, "depth separation"
  landmine), filed as [#54](https://github.com/pmndrs/upscaler/issues/54) for
  `reconstruct.ts`; the same dashes show on #22's thin bars.
  **Resolved by §15 (2026-10-05):** the same-frame scatter reads 0 % disocclusion on
  every emitter group.
- **Shading change fires on 12–65 % of frames over black** (block means swing with the
  jitter phase) — [#22](https://github.com/pmndrs/upscaler/issues/22). Over texture it
  stays under 17 % on the discs.
- **Over texture with no depth edge (decal), the clip is the binding mechanism.**
  Production retention there is 0.17–0.23 against an ideal of ~0.5–0.6.
- **Locks do not engage on points.** Lock life averages 0.04 / 0.10 / 0.23 on 0.3 / 0.5 /
  0.7 px discs and 0.14 on a black-background line (a 1.5 px disc, hit every phase, holds
  1.0). Two reasons, both in `accumulate.ts`: the lock's break term
  (`lockShading`, |curY − lockedLuma| against the 3×3 contrast) fires on every miss
  phase, because curY is then the background and over black contrast is 0; and even a
  live lock cannot protect, because its widening multiplies σ, which is exactly 0 on a
  flat miss neighbourhood. `STILL_CLAMP_RELAX` is inert for the same reason.

**And a separate bug: over black, there was no accumulation at all.** In the production row
the black-background emitters show the *raw* input's mean and flicker (0.3 px flicker 1.97
= on/off), and even the 1.5 px disc that is hit every phase flickers at 0.19 against the
ideal's 0.01. `clipToAABB` divided `extents / max(|dir|, 1e-6)`. On an axis where both are
exactly 0 — Co and Cg in any exactly achromatic 3×3: black or empty backgrounds,
white-on-black content, greyscale materials under white light — that is 0/1e-6 = 0, so
`t = 0` and history snapped to the box mean on every frame however wide the luma box was.
The output there was the current frame's 3×3 average. **Fixed** by putting the epsilon on
the extents too (Playdead's form): `(extents + 1e-6) / max(|dir|, 1e-6)`.

| Q17, AE off (retention / flicker) | black decal 0.5 px | black decal 1 px | black decal 1.5 px | black decal line | textured decal 1 px |
| --- | --- | --- | --- | --- | --- |
| before | 0.53 / 1.10 | 0.51 / 0.26 | 0.52 / 0.19 | 0.61 / 0.61 | 0.23 / 0.07 |
| **clip fix (shipped)** | **0.05 / 0.12** | **0.17 / 0.11** | **0.74 / 0.02** | **0.14 / 0.15** | **0.23 / 0.07** |

The trade is honest and deliberate: a resolved feature over black now accumulates
(1.5 px flicker 0.19 → 0.02), and sub-pixel emitters and lines over black stop flickering
at the raw on/off rate but **fade** instead, exactly as they already did over any
chromatic background (compare the unchanged textured column). The fade is the
drop-out #51 describes, now uniform across backgrounds rather than hidden by a bug.

No regression elsewhere, measured with the canonical capture settings unless noted:
- Q1 0.1148 / 0.0267 → 0.1144 / 0.0267 (consecutive / phase-locked, 40 pairs);
- Q12 0.0255 / 0.0300 → 0.0255 / 0.0301;
- Q15 lag (AE off) 9.44 / 8.27 → 9.45 / 8.28 frames, peaks unchanged to 0.01;
- Q9 (AE off) integrated error after the steps and over the ramp within 0.05 %
  (the drift-lag meter's held-light reference).

Captures are not byte-identical: Q3/Q4/Q9/Q15 differ on 0.1–2 % of pixels (≤ 0.35 mean
|Δ| on 0–255), as low-amplitude speckle along locked edges. That is divergence through the
lock thresholds, not a quality shift: the reference-error metrics above do not move. Q3's
disocclusion view is byte-identical. The frozen candidate snapshot
(`bench/src/candidates/shaders/candidateFilters.ts`) carries the same clip and was
deliberately left as is.

**Measured and not shipped: a miss-phase lock hold.** The obvious cure for the fade, built
and measured in `accumulate.ts`:
1. break a lock on a luma change only while its feature is present (an absent feature
   decays at `LOCK_DECAY`);
2. while a live lock's feature is absent on a still pixel, keep its history unrectified,
   additively (`mix(clipped, history, hold)`), not as another σ multiplier;
3. hold the alpha with it.

On top of the clip fix it does what it should where the clip binds (AE off):

| hold candidate (retention / flicker / switch-off ghost frames) | black decal 0.5 px | black decal 1 px | black decal line | textured decal 0.5 px | textured decal 1 px | textured decal line |
| --- | --- | --- | --- | --- | --- | --- |
| clip fix only | 0.05 / 0.12 / 0 | 0.17 / 0.11 / 0 | 0.14 / 0.15 / 0 | 0.17 / 0.08 / 45 | 0.23 / 0.07 / 33 | 0.16 / 0.15 / 2 |
| + hold | 0.20 / 0.08 / 6 | 0.57 / 0.04 / 10 | 0.37 / 0.09 / 11 | 0.32 / 0.06 / 34 | 0.60 / 0.02 / 25 | 0.40 / 0.09 / 16 |

Lock life on 0.5 / 1 px discs rises from 0.10 / 0.67 to 0.68 / 0.98. Q1 (0.114 / 0.027)
and Q12 are unchanged. It is not shipped, for three reasons:
- **It is a ghost by construction.** A miss phase and a switched-off emitter look the
  same on the frame they happen; only waiting tells them apart. A mature lock now holds
  ~9 frames (`LOCK_DECAY` 0.08 down to a 0.3 hold floor) before releasing, so a
  resolved or line feature that switches off lingers 10–17 frames, against 0–2 before.
  Gating the hold on the shading detector cannot help: over black it false-fires on
  the emitters themselves (12–65 %, #22) and erases the gain, and over texture it does
  not reliably fire on a sub-pixel switch-off (the ghost stays 16–33 frames).
- **It stipples Q1.** The sub-pixel slivers of floor between overlapping fence pickets are
  sub-pixel features too. Locks form on them irregularly along their length, so the hold
  draws them as dotted red/white speckle where both the shipped output and a clip-free
  accumulator show a clean picket. A gate on the feature's isolation from its miss
  neighbourhood (|lockedLuma − mean| / 3×3 range) did not separate them: on a miss phase
  the sliver also sits on a flat picket face.
- **It does nothing for the common floating case** until #54 lands: disocclusion kills the
  lock on every hit→miss transition. Over black, #22 has the same effect.

Q9 (AE off) with the hold: integrated error after the step at 60 rises 2 %, after 180 rises
5 % on the lit knots. The decay curve is uniformly higher, with no new trail. Q15 lag rises
under 1 %.

**Re-measured after #52 (§9) and #53 (§10) landed** — the clip fix rebased onto both,
same settings. #52's two-sided `cv` floor took shading change on the emitters to 0 %
of frames everywhere (black included). #53's `EXPOSURE_MAX` 8 lifted the 2 % ceiling, but
auto-exposure still pins at the new cap on this mostly-black frame, so a radiance-1
emitter conditions to 8 and the invertible tonemap's averaging bias still dominates:

| Q17, rebased (retention / flicker) | black decal 0.5 px | black decal 1 px | black decal 1.5 px | black decal line | textured decal 1 px | black floating 0.5 px |
| --- | --- | --- | --- | --- | --- | --- |
| AE off | 0.02 / 0.05 | 0.06 / 0.05 | 0.76 / 0.01 | 0.03 / 0.04 | 0.28 / 0.04 | 0.08 / 0.19 |
| **AE on (canonical)** | **0.005 / 0.01** | **0.01 / 0.01** | **0.28 / 0.005** | **0.007 / 0.008** | **0.12 / 0.02** | **0.02 / 0.04** |

With #52's false fires gone, black-background sub-pixel retention drops further (decal
0.5 px 0.05 → 0.02, AE off): the false fires had been aging history, which raised the
blend weight on hit frames and so let more of each hit through. Over texture it rises
(decal 1 px 0.23 → 0.28). What is left is the clip on the miss phase plus #54's
disocclusion on floating emitters, so the hold below is now the binding question. With AE on, the
resolved 1.5 px disc reads 0.28 against 0.76 with AE off; that gap is conditioning, not
history loss (flicker is 0.005).

**Decision.** Ship the clip fix: it is a real bug, it costs nothing, and it is neutral on
every lighting and convergence metric. Record the hold as the next candidate, to be
re-measured after [#54](https://github.com/pmndrs/upscaler/issues/54) (reconstruct
disocclusion on sub-pixel depth) lands. [#22](https://github.com/pmndrs/upscaler/issues/22)'s
shading-change false positives, the other independent eraser, are gone since #52. When it comes back it needs two answers: a lock-formation rule
that is spatially consistent along sub-pixel slivers (or a hold limited to genuinely
isolated points), and an explicit ghost budget. A hold that bridges a full jitter period
(32 frames at ratio 2) would cover the sparsest emitters (a 0.3 px disc averages ~13
frames between hits) at a 25–30-frame switch-off ghost.

Reproduce (bench on `--url`, defaults to 5199; edit `accumulate.ts` locally for the
attribution variants):

```bash
node scripts/measure-emitter-retention.mjs --label base-noae --settings '{"autoExposure":false}'
node scripts/measure-emitter-retention.mjs --label base          # canonical: #49 dominates
node scripts/measure-convergence.mjs --scenario Q17 --ratio 2 --pairs 40 \
  --views final,disocclusion,locks,accumulation-age,shading-change
node scripts/measure-drift-lag.mjs --scenario Q15 --frames 116:379:2 --settings '{"autoExposure":false}'
node scripts/measure-drift-lag.mjs --scenario Q9 --frames 56:239:2 --settings '{"autoExposure":false}'
```

Artifacts land under `bench/results/raw/emitters/` (summary.json, plus series.json with one
raw per-frame series per group) and `bench/results/raw/convergence/` (git-ignored).

## 12. Conditioned-space RCAS overshoot on converged HDR plateaus — DONE (2026-10-03, issue #50)

Item 1 moved RCAS into conditioned space (`c/(1+max(c))`) and inverts once. The
limiter there keeps the sharpened result below conditioned 1, but conditioned 1 is
linear infinity. Near it, a conditioned step of 0.008 doubles the linear value, so
the limiter bounds nothing in linear terms. #32 capped the inversion at linear RCAS's
maximum gain, `inv(max5)·1/(1 − 4·RCAS_LIMIT·peak)`, which stops ~1000× fireflies.
Up to 4× at sharpness 1 still passes that cap, so converged plateau edges kept
overshooting. Item 1's captures were 8-bit, where ACES saturates everything above
~4, so they could not show it.

**Method.** GPU readbacks of the rgba16float output, Apple Metal-3, headless Chrome
over CDP. The probe was a temporary page, not committed:

- **Scene:** `Upscaler` driven directly at 640×480, ratio 2, with a still orthographic
  camera.
- **Content:** converged plateaus at P = 0.5 / 2 / 8 / 64 on backgrounds 0.05 / 1 /
  P⁄4, each with an axis-aligned square, a diamond, a 1.5-render-px bar and a tilted
  rectangle.
- **Runs:** temporal (120 frames) and spatial, sharpness 0.8 and 1, auto-exposure on
  and off.
- **Reference:** the frozen `RCAS_PER_TAP_SHADER` stands in for linear-space RCAS.
- **Other checks:** a #32 first-frame sub-pixel emitter scene, and bench Q0/Q1/Q2/Q12
  read back at 1280×720 through a temporary uncommitted patch that points the
  `baseline` identity at production `RCAS_SHADER`.

**Reproduced.** At sharpness 1, temporal, exposure 1, main reads 1.98× on every 64
plateau. That is the issue's 127, at convex corners whose ring holds two dark taps.
Linear RCAS reads 1.04× / 1.09× / 1.31× on backgrounds 0.05 / 1 / 16. Linear reads ~64
on dark backgrounds because a ring that straddles 1 makes its `hitMax` positive and
switches the lobe off. That is the #30 defect, so linear RCAS is a reference for the
*bound*, not a target to match. 2 and 8 plateaus read 2.1–2.5×. At the default 0.8,
main reads 1.41–1.59× against 1.03–1.17× for linear. The spatial path behaves the same
way: 1.77–1.91× at sharpness 1 against ~1.30×.

**Fix (`rcas.ts`, production `RCAS_SHADER` only).** Both paths cap the inverted
result at the conditioned lobe applied in linear space against the darkest ring tap:
`eLin + 4·|lobe|·rcpL·max(eLin − max(mnLin, 0), 0)`.

- **Inversions.** Temporal inverts the center and the per-channel ring min once
  each. The inversion is monotone, so the min is at or below every inverted ring tap.
  Spatial has the linear taps already, so it needs no inversion.
- **It replaces the #32 / #30 `maxGain` cap.** With a non-negative ring min, the
  ceiling is at most `eLin / (1 − 4·RCAS_LIMIT·peak)`, so the firefly guarantee holds.
- **Where it binds.** A uniform ring makes it exactly linear RCAS with the same lobe.
  Brighter ring taps loosen it, so it binds on HDR edges and isolated peaks.
- **Unchanged.** The uncapped expression and the spatial anchor are as before.
- **Fingerprint.** `RCAS_SHADER` moves `0addd34e` → `b0405308`. The four frozen RCAS
  forms are byte-identical to main.

| converged plateau, max out/P | main | fix | linear RCAS |
| --- | --- | --- | --- |
| temporal, sharpness 1, P=64 on 0.05 / 1 / 16 | 1.98 / 1.98 / 1.98 | **1.12 / 1.22 / 1.64** | 1.04 / 1.09 / 1.31 |
| temporal, sharpness 1, P=8 on 0.05 / 1 / 2 | 2.12 / 2.12 / 2.12 | 1.62 / 1.82 / 1.79 | 1.25 / 1.34 / 1.33 |
| temporal, sharpness 1, P=2 on 0.05 / 1 / 0.5 | 2.50 / 1.48 / 2.41 | 2.07 / 1.48 / 2.11 | 1.37 / 1.31 / 1.37 |
| temporal, sharpness 0.8, P=64 | 1.41–1.58 | **1.08–1.32** | 1.03–1.15 |
| temporal, sharpness 0.8, P=8 | 1.42–1.59 | 1.36–1.37 | 1.15–1.17 |
| temporal, auto-exposure, sharpness 1, P=64 | 2.06 | 1.42–1.71 | 1.17–1.32 |
| spatial, sharpness 1, P=64 | 1.77–1.81 | 1.59–1.61 | 1.27–1.30 |
| spatial, sharpness 0.8, P=64 | 1.33–1.38 | 1.30–1.33 | 1.13–1.15 |
| P=0.5 (SDR) column, every configuration | — | **byte-identical** | — |

**Re-measured after §9–§11 landed (2026-10-05, same probe).** #55's variance-clip
fix and #53's exposure ceiling change the converged history itself, and linear RCAS
moves with it. With exposure 1, temporal, P=64 on 0.05 / 1 / 16:

- **Sharpness 1:** main 1.98 / 1.98 / 1.98, fix **1.61 / 1.73 / 1.73**, linear
  1.27 / 1.32 / 1.36.
- **Sharpness 0.8:** main 1.48 / 1.45 / 1.38, fix **1.30 / 1.31 / 1.31**, linear
  1.14–1.15.
- **Auto-exposure, sharpness 1:** main 1.83–1.96, fix 1.50–1.73.
- **Spatial:** unchanged.
- **SDR column:** still byte-identical in every configuration.

The bench pixel counts below were taken before §9–§11 and were not re-run.

**What remains.** The residual is what the same lobe produces in linear space
against the darkest neighbour, ~1.6–2.1× at sharpness 1 on moderate-contrast 2–8
plateaus. Tightening it means binding ordinary SDR edges too, because conditioned
sharpening always exceeds linear sharpening with the same lobe (the inversion is
convex). Two tighter bounds were tested on CPU:

- **Ring mean (Jensen) instead of the ring min:** P=8 corner 1.40×, but it changed
  ~49% of random SDR neighbourhoods.
- **Exact linear same-lobe sum:** four inversions, and it changes the same share.

**#32 repro (first frame, sub-pixel emitters 4 / 16 / 64 on black, exposure 1).**
Main reproduces #48's published numbers exactly.

| sharpness | main | fix | linear |
| --- | --- | --- | --- |
| 0.8 | 8.5 / 28.3 / 68.5 | 6.9 / 23.8 / 56.1 | 3.7 / 12.2 / 29.6 |
| 1 | 14.7 / 48.8 / 118 | 9.9 / 34.6 / 79.1 | 3.7 / 12.2 / 29.6 |

- **Converged (f96, sharpness 1):** 64 reads 2.29 / 1.58 / 1.55 (main / fix / linear).
- **Auto-exposure first frame:** 1.57 / 1.28 / 0.98.
- **NaN / Inf / negative output:** none in any probe.

**Real content.** Bench captures at the default settings: sharpness 0.8,
auto-exposure, ratio 2, 1280×720, rgba16float readback, 921,600 px per frame. The
main-vs-main control is byte-identical at every frame.

| capture | changed px | max linear Δ | presented (ACES + sRGB) max / mean Δ |
| --- | --- | --- | --- |
| Q0 f0 / f1 / f23 | 1126 / 2745 / 1849 | 14.8 / 21.3 / 6.0 | 17 / 19 / 22 · ≤ 0.0025 /255 |
| Q1 f59 / f239 (converged still) | 268 / 247 | 10.3 / 10.1 | 5 / 4 · ≤ 0.0002 /255 |
| Q2 f119 / f239 | 285 / 286 | 72.4 / 109.3 | 4 / 9 · ≤ 0.0001 /255 |
| Q12 f119 / f479 | 39 / 35 | 0.04 / 0.06 | 2 / 3 · 0 /255 |

Every other pixel is bit-exact. The Q0 frame maxima fall: 41.2 → 26.7 at f0, 43.8 →
25.0 at f1, 21.1 → 19.1 at f23. Examples at f90 (fake clock, stepped rAF, seeded
`Math.random`; repeat runs are byte-identical) against main:

- **01-hello:** 189 px, ≤ 4/255.
- **07-tsl-node:** 277 px, ≤ 13/255.
- **16-spatial-node:** 797 px, ≤ 6/255, with its live RCAS-ms badge strip masked.

These are near-identical, not byte-identical. The changed pixels are capped
highlights and isolated peaks.

**Cost.** RCAS ms read from timestamp queries, 1920×1080, ratio 2, frame-paired:

- **Pairing.** Both shaders dispatch on the same scene render every frame, in
  alternating order, and the paired ratio's median is taken per 400-frame block.
  Blocks alternate which shader is listed first.
- **Why pairing.** Leg-level ABBA was unusable here. The shared GPU flipped between
  two clock states (A legs read 0.10 or 0.36 ms), giving 30–90% A-vs-A floors. Pairing
  inside a frame cancels that.
- **Environment.** Run from a worktree with other agents on the GPU, so absolute ms
  are not comparable to repo records.

| comparison | paired Δ | block spread |
| --- | --- | --- |
| main vs main (floor) | −0.21% | 0.28% |
| main → fix, temporal, HDR probe scene | **+4.5%** | 2.45% |
| main → fix, temporal, same scene ×1/128 (all SDR) | **+5.3%** | 0.69% |
| main → fix, spatial | +2.9% | 0.42% |
| per-tap → main, temporal | −23.0% | 1.11% |
| per-tap → fix, temporal | **−18.7%** | 1.02% |

About +5 µs at the fast clock (~0.10 ms RCAS). The conditioned-space win against the
per-tap form goes from −23.0% to −18.7% on this machine, so about four fifths of it
survives. Item 1's −34% was measured with a different harness and scene and is not
directly comparable.

**Rejected: renormalise HDR neighbourhoods to a white of 1.** Scale the five taps so
the brightest exposed-linear tap is 1, sharpen, scale back.

- **What it got right.** It is exact for neighbourhoods below 1 by construction, and
  sharpening becomes scale-invariant above 1.
- **Overshoot.** Weaker than the ceiling: P=64 at sharpness 1 went to 1.22 / 1.42 /
  2.04, and P=8 to 1.99–2.12. At white the conditioned limiter itself allows ~2×; a
  1.0 corner on 0.5 sharpens to 1.99 in production today.
- **Pixels moved.** Auto-exposure keys mid-grey at 0.18, so ordinary highlights sit
  above exposed 1, and ~8% of Q0/Q1 pixels moved.
- **Cost.** +8.9% RCAS even with the re-conditioning behind a per-pixel branch. A
  not-taken branch still cost ~7%, likely occupancy. Single-reciprocal,
  scalar-scale and branchless forms were all worse.
- **Q2 f239.** A history texel at ~1 made the clamped neighbourhood max re-condition
  one tap back to ~1, and it inverted to f16 max (65504).

Reproduce: the probes are temporary pages, not committed. The method above is enough
to rebuild them. Drive `Upscaler` with `_rcasShader` set to `RCAS_SHADER` /
`RCAS_PER_TAP_SHADER` / a main copy, `copyTextureToBuffer` the output, and decode the
halves.

## 13. GPU timing overhead — DEFAULT OFF, clean measurement PENDING (2026-10-05, issues #69/#70)

**Shipped:** `gpuTiming` (default **off**) on `Upscaler`, `UpscalePass`, the nodes and
`temporalGuides()`; `upscaler.gpuTiming` toggles at runtime and frees the timer when
off. The default was decided on design grounds, not on a number: nothing in the
pipeline reads `gpuTimings`, so a production app should not pay for it. The bench and
the examples with a timing readout opt in. Same change fixed #69: `gpuTimings` now
holds only the latest frame's passes (per-frame merge, split frames held until the
late submit reads back, `configure()` resets the timer).

**Still owed: a clean overhead number.** The timer can't measure itself, so
`scripts/measure-timer-overhead.mjs` (probe page `bench/timer-overhead.html`) measures
wall-clock throughput with the GPU saturated, on vs off in ABBA blocks with a noise
floor. The only runs so far (2026-10-05, Apple Metal-3, 1080p) were taken while two
other measurement jobs shared the GPU, so they are **indicative, not evidence**:
on was slower in nearly every block, by roughly 0.1–0.2 ms/frame on dispatch-only
runs (temporal ratio 2 ≈ +10–15%), and that cost looked about the same for 1 pass
(bilinear) as for ~6 (temporal) — i.e. mostly a fixed per-frame cost (resolve, copy,
`mapAsync`), not per-pass. Self-disagreement was up to ±30% on some conditions.

To get real numbers, run on an otherwise idle GPU (no other bench/measure jobs, no
other headless Chrome), from the main checkout (worktree absolutes read slow — see
CLAUDE.md):

```bash
# Headline: overhead of today's timer, plus the A/A control (should read ~0%)
node scripts/measure-timer-overhead.mjs --attach-only --frames 200 --blocks 24 --inflight 8 \
  --conditions temporal:2:dispatch,temporal:2:dispatch:none,temporal:2:frame,spatial:2:dispatch,bilinear:2:dispatch

# Where the cost is: per-pass writes only / + resolve+copy / full timer every 8th frame
node scripts/measure-timer-overhead.mjs --attach-only --frames 200 --blocks 24 --inflight 8 \
  --conditions temporal:2:dispatch:writes,temporal:2:dispatch:resolve,temporal:2:dispatch:sampled:8
```

Trust a condition only when the A/A control reads near 0% and its overhead clears the
reported noise floor. Record the result here. If most of the cost proves fixed per
frame, `sampled:N` (time every Nth frame) is the candidate for a cheap always-on
profiling mode; the default stays off either way.

## 14. Shading-change false positives on fine lines — DONE (2026-10-05): per-block memory of 8 means

Report: building the convergence explainer (PR #64, `examples/s4-convergence`), a
sibling agent saw the shading-change view firing on a **still** camera over the finest
line-pair bars and the wires. The accumulation age there never reached white, and
turning the detector off halved the never-converging area (4.6 % → 2.2 % of the stage
at frame 64). That was measured before #58 landed.

**Cause.** Content past the render Nyquist aliases. A line pair near one render pixel
(or a Siemens star's centre) folds into moiré whose period is many pixels, and the
jitter shifts that moiré by a multiple of the jitter itself. So a whole 4×4 or 8×8
block flips between bright and dark from one jitter phase to the next. Inside the
block every texel agrees, so cv ≈ 0 and only the base floor applies. #58's clamp
doesn't catch it either: its range is the four bilinear taps of last frame, and they
flipped together. One previous frame cannot tell this from a light switching. What
gives it away is that the block keeps returning to values it has already taken.

**Repro: new scenario Q18 `fine-line-chart`.** A still camera square-on to an
unmipmapped resolution chart:
- line-pair groups of 6 / 4 / 3 / 2.5 / 2 / 1.75 / 1.5 / 1.25 / 1 / 0.75 render-px
  period at ratio 2 (4 → 0.5 at ratio 3), varying along x and along y;
- a 72-spoke Siemens star (render Nyquist at r ≈ 23 px);
- four flat swatches (the control) and a grey swatch crossed by 0.5 px hairlines.

The light drops to a quarter at frame 300, as in Q16. Each region is a scenario ROI.
`measure-convergence.mjs` now reports `--shading-frames` firing per ROI, plus the mean
accumulation age and the share of pixels younger than half the cap per ROI. The
full-frame young share includes the ~6.5 % page strip the canvas clip picks up below
the headless viewport, so use the ROIs.

Settings: Apple Metal-3, headless Chrome over CDP, run from a git worktree. Settle 180,
`firing` = v > 0.1, averaged over frames 180–211; age at the last pair frame (220 at
ratio 2, 253 at ratio 3).

**Baseline on main (0aa4855, after #58).** Only Q18 fires; #52 and #58 already took the
other still scenes to ~0.

| scenario | ratio | firing | bars (vertical / horizontal) | young bars (v / h) | content consecutive |
| --- | --- | --- | --- | --- | --- |
| Q18 | 2 | **3.30 %** | 10.1 % / 10.4 % | 8.6 % / 8.6 % | 4.60 |
| Q18 | 3 | **5.63 %** | 16.1 % / 19.0 % | 24.4 % / 24.3 % | 9.04 |
| Q18, detector off | 2 / 3 | — | — | 0 % / 0 % | 3.36 / 6.13 |
| Q16 | 2 / 3 | 0 % / 0.002 % | | | |
| Q12 | 2 | 0 % | | | |
| Q1 | 2 / 3 | 0 % / 0.002 % | | | |

The star (0.10 %), swatches (0 %) and hairlines (0 %) are quiet. The firing sits on the
bar groups at 1.5, 1.25, 1 and 0.75 px; the 1 px group flips as one solid block. So #58
did not fix this, and the detector costs Q18 most of its convergence. The age on the
bars stays young exactly where the detector fires, and is fully converged with it off.

**Candidates.** Each keeps per-block memory for the 4×4 and 8×8 blocks: raw block
means without either exposure, as f16, eight to an `rgba32uint` texel, ping-ponged. It
is written by the block's top-left thread, and every thread reads it. The memory only
applies to blocks where nothing moved more than 0.05 render px, nothing is disoccluded
and the frame isn't a reset; such blocks restart their memory. So under motion every
candidate is the frame-pair detector. The memory can only lower the relative
difference, which still goes through the same floors. The shader builder is
`bench/src/candidates/shaders/shadingChangeRange.ts`, and each form is a bench
identity, so all of them can be re-run.

| candidate (`shading-memory-*`) | Q18 r2 / r3 firing | young bars r2 (v / h) | young bars r3 (v / h) | Q9 f60 mean v | Q9 f180 mean v (firing) |
| --- | --- | --- | --- | --- | --- |
| main (frame pair) | 3.30 % / 5.63 % | 8.6 / 8.6 % | 24.4 / 24.3 % | 0.541 | 0.353 (46.5 %) |
| `range8`: inside [min, max] of the last 8 | 0.10 % / 0.19 % | 0 / 3.3 % | 2.3 / 0 % | 0.538 | **0.119 (23.5 %)** |
| `range4` | 0.52 % / 0.84 % | 4.7 / 6.8 % | 10.9 / 9.7 % | 0.539 | 0.323 (43.9 %) |
| `nearest8`: closest single stored mean | 0.81 % / 0.92 % | 6.7 / 6.6 % | 11.8 / 5.0 % | 0.538 | 0.119 (23.5 %) |
| `ema`: running average, weight 0.2 | 2.30 % / 4.13 % | 8.4 / 8.4 % | 17.6 / 15.3 % | 0.541 | 0.297 (42.7 %) |
| **`gated8`: `range8` + jump gate 1.5 (adopted)** | **0.12 % / 0.20 %** | **0 / 3.3 %** | **2.3 / 0 %** | **0.540** | **0.351 (45.8 %)** |
| `gated8-k1`: jump gate 1.0 | 0.75 % / 1.66 % | 7.8 / 8.0 % | 20.1 / 16.3 % | 0.541 | 0.353 (46.4 %) |
| `gated4` | 0.62 % / 0.92 % | 4.7 / 6.8 % | 11.7 / 10.2 % | 0.540 | 0.352 (46.2 %) |

Every candidate leaves Q16, Q12, Q1, Q11 (host pre-exposure, f56–185) and the Q9 ramp
at 0 % firing. Q4's motion windows are unchanged or lower: f100–139 reads 0 %
everywhere, and f340–379 reads 0.003 % mean with 0.014 % max against main's 0.007 % /
0.014 %.

Why each form failed or won:
- **The ungated range swallows a step that follows a ramp.** Q9 ramps the sun 8 → 2
  over f120–179, then steps to 3.2 at f180. The last 8 means span the ramp's tail
  (about 2 → 2.8), so a step to 3.2 lands 12 % past the range instead of 37 % past the
  previous frame, and two thirds of the response goes. `nearest8` fails the same way.
  `range4` loses less, because 4 frames of ramp is a narrower range, but it keeps 5×
  the residue: 4 consecutive Halton phases rarely span a block's whole alias swing.
- **The EMA** sits mid-swing, so a flip still reads about half its size. It cuts only
  ~30 %.
- **The jump gate** separates the two cases. Alias flicker repeats jumps of its own
  size, so the frame's jump from the newest mean is rarely larger than the largest jump
  among 8 stored means. A ramp's jumps are a few percent, so a step after one is far
  larger and the range is not used. At gain 1.0 the newest jump is the largest of 8
  about one time in eight, and a sixth of the false positives come back. Gain 1.5
  keeps all of `range8`'s suppression (0.12 % vs 0.10 %) and all of the Q9 step (0.351
  vs 0.353). Without a ramp before it, a step leaves the gate open but falls outside
  the range anyway: Q9 f60 and Q18 f300 keep their response.

**Genuine steps with the adopted form** (per-frame firing / mean v):

| event | main | adopted |
| --- | --- | --- |
| Q9 f60, sun 3.2 → 8 | 62.41 % / 0.541 | 62.29 % / 0.540 |
| Q9 f180, 2 → 3.2 after the ramp | 46.50 % / 0.353 | 45.76 % / 0.351 |
| Q18 f300, light ÷ 4, ratio 2 (swatches / hairlines / star / bars v, h) | 58.30 % / 0.555 (98.2 / 94.1 / 20.1 / 23.9, 23.2 %) on a 3.4 % floor | 56.36 % / 0.538 (98.2 / 94.1 / 20.1 / 17.6, 17.5 %) on a 0.17 % floor |
| Q18 f300, ratio 3 | 57.85 % / 0.542 on a 5.3–6.7 % floor | 53.74 % / 0.511 on a 0.2–0.3 % floor |
| Q16 f300, light ÷ 4 | 0.81 % / 0.0053 | 0.81 % / 0.0053 |

All of them are still single-frame spikes. On Q18 the bars read less at the step
because main's number was partly its own false-positive floor. With that subtracted
(about 11–19 %), the bars respond about as before.

**Lag after the step** (`measure-drift-lag.mjs --scenario Q18 --frames 296:356:2`,
auto-exposure off, Σ|Δ| over f300–356):
- full frame 120.55 → 122.78 (+1.8 %);
- bars 289.3 / 279.3 → 296.5 / 286.1 (+2.5 %);
- star 221.9 → 222.4; swatches 14.47 → 14.47; hairlines 12.99 → 12.97.

This is §9's trade again. The constant false fires kept the bars part-aged, and the
short history happened to answer the real step sooner. Now the bars are converged like
the rest of the frame. Q15's sub-detector drift is identical row for row (`--frames
116:379:4`), and so is Q16's step lag.

**Q14 `rotating`** (SSGI's 6-frame rotating pattern, the configuration examples 06/09
ship since #58): firing 0.0004 % → 0 %, and output churn and age are identical.

**Cost** (`run-benchmark.mjs --smoke --ratios 1,2,3 --blocks 6 --variant
shading-memory-gated8 --comparison local-baseline-5d6a65e`, worktree):

| ratio | shadingChange main → adopted | Δ | pass noise floor | compute-sum Δ (noise) |
| --- | --- | --- | --- | --- |
| 1 | 0.279 → 0.303 ms | +23.7 µs (+8.5 %) | 12.8 % | +1.2 % (15.8 %) |
| 2 | 0.073 → 0.081 ms | +7.9 µs (+10.9 %) | 8.0 % | +3.2 % (7.1 %) |
| 3 | 0.037 → 0.042 ms | +5.1 µs (+14.0 %) | 8.0 % | −0.6 % (4.7 %) |

The pass delta is only 1–1.75× this environment's noise floor, which is not enough on
its own. But all 18 repetitions point the same way (+5.7 % to +19.4 %), so read it as
about +10 % of a small pass. The whole compute sum doesn't move beyond noise. These are
worktree absolutes (CLAUDE.md bench caveat). In a repo run the pass measured 0.044 ms
at ratio 2, so the memory should cost a few µs there; that hasn't been timed. The cost
is two `rgba32uint` loads per thread, one store per 4×4 and per 8×8 block, and 20 more
workgroup-memory reads in the reductions. The memory is ⌈w/4⌉ × (⌈h/4⌉ + ⌈h/8⌉) × 16 B
× 2, which is 173 KB at 1280×720 render.

**Adopted** in `packages/core/src/shaders/shadingChange.ts` as `SHADING_MEMORY_SLOTS` 8,
`SHADING_MEMORY_JUMP_GAIN` 1.5 and `SHADING_MEMORY_STILL_PX` 0.05, with bindings 9/10.
`Upscaler` always allocates the memory. It also zeroes the memory before the detector
runs again after any temporal frame without it, and the shader treats an all-zero
memory as empty (below). That was GPU-checked: the bench was toggled off for 20 frames
and back on, with no validation errors. Examples 07, 12 and 13 render with a clean
console.

Production reproduces every `gated8` number above to the last digit. The frozen pre-memory
detector is bench identity `shading-frame-pair-v1`, and it reproduces main's numbers
exactly on every row above.

**Fixed in review: an empty memory hid darkening for up to 8 frames.** A zero memory
suppresses nothing on its own first frame: every jump from 0 is 1, and it holds no jumps
to compare against. But that frame used to *push* the current mean m into it, which left
`[m, 0 × 7]`. On the next frame the range was [0, m] and the stored jump was
`relativeDistance(m, 0)` = 1, so the jump gate (≤ 1.5 × 1) could never trip. Any block
that darkened stayed inside the range and was fully suppressed until the zeros aged out.

The memory is zeroed when the detector is re-enabled at runtime. `configure()` is not a
path: it always calls `resetHistory()`, and the reset frame restarts every block. The
fix: `memoryUpdate` treats an all-zero memory as empty and restarts it from the current
mean (`restart || all(words == vec4u(0u))`). For a genuinely black block that restart is
the same memory. The builder's `gated` mode in `shadingChangeRange.ts` keeps the old
push. Production has no bench twin, and the rejected identities were only measured on
mature memory, so none of their numbers depend on it.

`scripts/measure-shading-restart.mjs` reads the signal texture back exactly on Q18 at
ratio 2. The detector was off for 10 frames and back on `lead` frames before the
frame-300 light step. Firing at f300, full frame / flat swatches:

| run | before | after |
| --- | --- | --- |
| mature memory (detector on throughout) | 62.2 % / 98.2 % | 62.2 % / 98.2 % |
| re-enabled 2 frames before | **0 % / 0 %** | 62.9 % / 98.2 % |
| re-enabled 3 frames before | **0 % / 0 %** | 62.5 % / 98.2 % |
| re-enabled 4 frames before | **0 % / 0 %** | 62.4 % / 98.2 % |
| re-enabled 9 frames before (zeros aged out) | 62.2 % / 98.2 % | — |
| `configure()` 2 / 3 / 4 frames before | 63.0 / 63.3 / 62.3 % | identical |

After the fix, re-enabling costs 1–3.5 % false firing on the bars for the first 2–3
frames while the memory refills. That is the frame-pair detector's own level, plus the
luma history going 10 frames stale. Every headline number above re-ran identically: Q18
still, Q9 f60/f180, Q16, Q12, Q1, Q11, Q4 and the Q16/Q18 steps. No WGSL or WebGPU
errors. Fingerprint: `shadingChange` `1868fc72` → `fba11623`.

```bash
node scripts/measure-shading-restart.mjs --scenario Q18 --ratio 2 --lead 3   # also --lead 2, 4, 9
```

**Surprising, out of scope: #58 costs Q16's genuine step.** The step on Q16's sparse
wires now fires on 0.81 % of the frame, against 2.37 % after #52 (§9). The fans
themselves read 0 %, and only the knot's ROI fires. A wire over black has black among
its four bilinear taps, so a quarter-intensity step lands inside the tap range, and
#58's clamp reads it as jitter. Integrated error after the step rose from 19.37 to
22.79 on the full frame; the slant-fan-and-knot ROI went from 48.70 to 71.01. The block
memory doesn't change any of this; it's the same with and without. If it matters, the
fix belongs in the per-texel clamp, for example by not clamping toward a black tap.

Reproduce. The bench is on 5199 by default; this program ran on `--url
http://127.0.0.1:5320 --port 9320`. Add `--variant shading-frame-pair-v1` (or a
`shading-memory-*` identity) for the other columns. Output lands under
`bench/results/raw/` (gitignored).

```bash
node scripts/measure-convergence.mjs --scenario Q18 --ratio 2 --pairs 40 --shading-frames 32 \
  --views final,accumulation-age,shading-change
node scripts/measure-convergence.mjs --scenario Q18 --ratio 3 --pairs 73 --shading-frames 32 \
  --views final,accumulation-age,shading-change
node scripts/measure-convergence.mjs --scenario Q18 --ratio 2 --pairs 40 --views final,accumulation-age \
  --settings '{"detectShadingChanges":false}'
node scripts/measure-convergence.mjs --scenario Q9 --settle 56 --pairs 1 --shading-frames 128 --views final
node scripts/measure-convergence.mjs --scenario Q4 --settle 340 --pairs 1 --shading-frames 40 --views final
node scripts/measure-convergence.mjs --scenario Q18 --settle 296 --pairs 1 --shading-frames 8 --views final
node scripts/measure-drift-lag.mjs --scenario Q18 --frames 296:356:2 --settings '{"autoExposure":false}'
node scripts/run-benchmark.mjs --smoke --ratios 1,2,3 --blocks 6 \
  --variant shading-frame-pair-v1 --comparison local-baseline-5d6a65e
```

The same runs for Q16 (ratios 2 and 3), Q12, Q1 (ratios 2 and 3), Q11 (`--settle 56
--shading-frames 130`), Q4 (`--settle 100`), Q14 `--subrun rotating` and Q15
(`measure-drift-lag.mjs --frames 116:379:4`) complete the matrix. Note that the timing
row's A/B was taken with the candidate identity against the frozen E00 baseline. Since
adoption, `baseline` runs the memory, so time `shading-frame-pair-v1` against it for
the reverse comparison.

## 15. Depth clip against a reconstructed previous depth — DONE (2026-10-05, issue #67)

**Problem.** The fused cross-frame depth clip compared this frame's dilated view depth
with last frame's at the reprojected position. Those depths come from two camera
positions, so a camera moving away from a surface (dolly-out, the receding side of an
orbit) reads as separation: 97% of a frontal wall lost its history on a 0.3-unit
dolly-out; the tolerance is ~0.5% of depth per frame at 960×540. Objects receding from
a still camera trip it too (velocity carries only screen-space xy).

**Options built and measured** (ratio 2, 1920×1080, Apple Metal-3, ABBA vs production;
worktree clocks read ~2.6× slow — see CLAUDE.md — so repo-clock estimates are in
brackets):

| form | reconstruct-stage Δ | camera motion | object depth motion |
| --- | --- | --- | --- |
| cross-frame (pre-#67, `reconstruct-cross-frame-v1`) | — (≈90 µs here, 35 µs at repo clocks) | ✗ | ✗ |
| camera-compensated (`reconstruct-camera-v1`): z row of `prevView · currentWorld` + unprojection in a 32-byte side uniform; far-plane texels excluded | +1.5 µs (noise) | ✓ | ✗ |
| two passes, no scatter (control) | +31 µs [~+12 µs] | ✗ | ✗ |
| scatter, separate clear pass | +41 µs [~+16 µs]: clear 24 µs, atomics ~13 µs, split ~31 µs, clip −23 µs vs the control | ✓ | ✓ |
| **scatter, ping-pong clear (adopted)** | **+30 µs [~+12 µs]: ~2% of upscaler compute, ~0.07% of a 16.7 ms frame** | ✓ | ✓ |

Whole-pipeline totals were noise-dominated (other GPU tenants; noise floor ~50%), but
every per-repetition reconstruct-stage delta kept its sign. The parity program's
"+22–30%" was per pass inside a larger candidate bundle (+0.056 ms for that whole bundle
step). Raw: `bench/results/raw/issue67/` (gitignored; regenerate with
`node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 6 --variant baseline --comparison reconstruct-cross-frame-v1`).
Re-time from the main checkout on a quiet machine before quoting absolutes.

**Quality — Q19** (new: converge, then dolly back/forward 0.1 u/frame, orbit ±0.5°/frame,
slide, scene receding/approaching under a still camera; interior = 8% margin excluded so
the border strip entering view does not dominate). Interior mean disocclusion, %:

| segment | cross-frame | camera | scatter (adopted) |
| --- | --- | --- | --- |
| still | 0.029 | 0.029 | **0.000** |
| dolly back | 1.033 | **0.058** | 0.334 |
| dolly forward | 0.044 | 0.045 | 0.312 |
| orbit L / R | 0.70 / 0.71 | 0.59 / 0.60 | 1.35 / 1.34 |
| slide | 0.098 | 0.098 | 0.645 |
| scene recedes (still camera) | 1.313 | 1.313 | **0.236** |

The scatter's higher dolly-forward / orbit / slide numbers are genuine: continuous
outlines on the trailing side of every post and sphere, where background was revealed.
The cross-frame best-tap vote let ~1 px/frame reveals through (one tap always landed on
the old background). The scatter's residual dolly-back figure is the same kind of
reveal plus the floor/sky horizon. Q19's back wall sits 23.6 units out, under the
tolerance at 0.1 u/frame; a faster dolly would reproduce the issue's 97% wall case.
Regenerate: `node scripts/measure-receding-disocclusion.mjs --variants baseline,reconstruct-cross-frame-v1,reconstruct-camera-v1 --stride 2`.

**The issue's own repro (S4 explainer, converged still frame, one-frame moves through
`window.__s4`; share of render pixels with disocclusion > 0.5, whole frame / interior
with an 8% margin excluded).** Before (from the issue): dolly back 0.3 disoccluded 97% of
the wall, orbit 1° a graded band over ~10% of the frame. After:

| one-frame move | whole frame | interior |
| --- | --- | --- |
| still (converged) | 0.00% | 0.00% |
| dolly back 0.3 | 4.92% | 1.89% |
| dolly back 0.05 | 0.87% | 0.45% |
| dolly forward 0.3 | 0.61% | 0.79% |
| orbit 1° | 2.39% | 2.40% |
| slide 0.1 | 0.74% | 0.52% |

The wall's interior stays black on every move. What lights up is the border strip a
dolly-out brings into view, the panel's outline where background is revealed, and slivers
beside the wires: all genuine. The S4 narration's disocclusion step was rewritten to match.

**Gates.** `measure-convergence.mjs` (40 pairs, `--variant`): Q1 consecutive churn
0.1083 → 0.1076, phase-locked 0.0268 both; Q12 0.0219 / 0.0302 both; shading change 0%
firing on all four runs. Q3 disocclusion now outlines the rotating knots and moving
spheres (the cross-frame form missed most of them); age resets stay confined to trails.
`verify-packed-guides.mjs` GPU smoke passes (split frames, no monolithic fallback).
Q17 / #54 (`measure-emitter-retention.mjs --settings '{"autoExposure":false}' --variant <id>`):
emitter disocclusion 7–34% of frames → 0%; floating emitters over texture roughly double
their retention with lower flicker (0.5 px L1 0.170 → 0.389; 0.7 px L1 flicker
0.147 → 0.041). Over black they now behave like decals (1 px L1 retention 0.228 → 0.060,
flicker 0.134 → 0.049 — the old figure was reset-driven blinking; the clip is the
binding fader over black, §11). Switch-off: floating emitters now fade like decals
(e.g. 1 px L1 22.6 → 38.1 frames to < 10%) — the false disocclusion used to clear them
by accident.

**Follow-up — issue #79 (2026-10-05, idle GPU).**

*Timing.* `node scripts/run-benchmark.mjs --smoke --ratios 1,2,3 --blocks 8 --variant baseline --comparison reconstruct-cross-frame-v1`
on an otherwise idle machine (worktree; raw under `bench/results/raw/issue79/`). Per-pass
medians per repetition; the A/A column is the harness disagreeing with itself:

| ratio | render | cross-frame | scatter | Δ per frame | A/A | ≈ share of upscaler compute |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | 640×360 | 27.3 µs | 33.7 µs | **+6.2 µs** | 0.5 µs | 0.8% |
| 2 | 960×540 | 62.5 µs | 75.8 µs | **+13.3 µs** (first run: +12.6) | 3.3 µs | 1.3% |
| 1 | 1920×1080 | 226 µs | 353 µs | **+133 µs** | 27 µs | 4.7% |

Ratios 2 and 3 confirm the noisy-run estimate. Ratio 1 (NativeAA) costs ~2.5× more than
pixel count predicts; the depth-clip pass alone is 149 µs there against 27 µs at ratio 2.
The two ping-pong scatter buffers are 8.3 MB each at 1080p, so cache spill is the likely
cause — unverified, and the obvious lever if NativeAA cost ever matters. Mobile is still
unmeasured (#4: needs a device).

*Dropping the cross-frame stabilizers.* Bench identities `depth-clip-*`
(`buildDepthClipVariant` in `packages/core/src/shaders/reconstructVariants.ts`) swap only the depth-clip
pass. Upstream's `ComputeDepthClip` (ffx_fsr2_depth_clip.h, read 2026-10-05) differs from
ours in four places: its `fHalfViewportWidth` is `length(RenderSize())` — the **full**
diagonal, so our port's literal half made our tolerance 2× tighter — times
`Kfov = |corner| / |center|` (≈1.38 at the bench's 50° FOV), so **our tolerance is ≈2.8×
upstream's**; it raises the confidence ratio to a power ramping 1 → 3 with render size; it
averages only positive-separation taps (weighted mean); and its `EvaluateSurface` zeroes
disocclusion on a monotonically receding depth column (its grazing-plane answer, where
ours is the relief widening). Q19 at `--stride 1`, interior mean disocclusion % (interior
frame-to-frame flicker %):

| segment | production | no relief | mean vote | upstream tolerance | full upstream |
| --- | --- | --- | --- | --- | --- |
| dolly back | 0.32 (0.54) | 0.38 (0.62) | 2.59 (3.14) | 0.31 (0.52) | 2.30 (2.81) |
| fast dolly back | 0.49 (0.93) | 0.55 (1.01) | 2.49 (3.73) | 0.47 (0.89) | 2.06 (3.14) |
| dolly forward | 0.33 (0.56) | 0.50 (0.74) | 2.68 (3.32) | 0.32 (0.53) | 2.37 (2.90) |
| orbit left | 1.35 (1.84) | 1.51 (2.04) | 3.31 (3.70) | 1.31 (1.78) | 3.20 (3.45) |
| slide | 0.65 (1.24) | 0.68 (1.29) | 2.50 (4.36) | 0.63 (1.20) | 2.29 (4.01) |
| scene recedes | 0.22 (0.37) | 0.28 (0.43) | 2.43 (2.88) | 0.21 (0.35) | 2.03 (2.31) |

Still segments read 0.000% with zero flicker in every variant, and Q1 / Q12 convergence is
identical across all five (0.1077 / 0.0268 and 0.0219 / 0.0302): under the scatter a still
scene never disoccludes, so the still-scene gates no longer separate depth-clip forms —
motion does.

- **Relief widening: kept.** Without it motion disocclusion rises 10–50% (dolly forward
  0.33 → 0.50, scene approach 0.25 → 0.40), on sloped surfaces whose neighbours scatter
  one texel of slope into each other's footprints.
- **Best-tap vote: kept.** The upstream mean vote rings *both* sides of every moving
  silhouette (Q19 slide: full outlines on the knots, spheres and every post), where
  production marks only the trailing side. A foreground edge advancing over background
  has valid history at its reprojected position, so the leading-side ring is false
  rejection: 2–8× the disocclusion and 2–3× the flicker. Upstream's surface check and
  wider tolerance only take a fraction of it back (full upstream ≈ 0.9× the mean vote).
- **Upstream tolerance scale: measured, not adopted.** 3–6% fewer disoccluded pixels and
  slightly less flicker on every motion segment, no regression. Adopting it needs the
  camera's FOV for `Kfov`, which `FsrConstants` doesn't carry (the variant hardcodes the
  bench's 50° as a pipeline override); a constants change re-fingerprints every shader.
  Worth folding into the next change that touches the UBO anyway.

*Fast dolly.* Q19 gained `dolly-back-fast` / `dolly-forward-fast` (0.3 u/frame, frames
960–979 and 1040–1059, after the recorded segments). It reproduces #67's headline case: the
cross-frame identity disoccludes **44.4%** of the interior (80% of pixels young, mean age
0.21); production **0.49%** (mean age 0.75).

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- ~~Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.~~
  Adopted 2026-10-05 (§15): the fused form was not camera-invariant (issue #67).
- T&C as a distinct softer channel — revisit only on user demand with real content.
- Conditioning-exposure history correction (beyond host pre-exposure): eased
  adaptation keeps the per-frame mismatch under the shading detector's threshold;
  correcting it changes output for every auto-exposure user. Revisit with evidence.
