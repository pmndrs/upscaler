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
landed as `src/shaders/shadingChange.ts`: one fused half-resolution
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
  alpha resolve can or should fix — left as a follow-up.
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
0.66 % lit before the ramp (the still-scene block speckle Q1/Q12 also show) and
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

## 9. Conditioned-space RCAS overshoot on converged HDR plateaus — DONE (2026-10-03, issue #50)

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

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.
- T&C as a distinct softer channel — revisit only on user demand with real content.
- Conditioning-exposure history correction (beyond host pre-exposure): eased
  adaptation keeps the per-frame mismatch under the shading detector's threshold;
  correcting it changes output for every auto-exposure user. Revisit with evidence.
