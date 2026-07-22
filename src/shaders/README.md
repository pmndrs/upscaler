# WGSL passes

Every pass is a WGSL compute module assembled from shared chunks (`common.ts` + pass body) by `wgsl.ts` — WGSL has no `#include`, so chunks are TS strings deduplicated by the assembler. All passes bind the same 96-byte `FsrConstants` UBO at `@group(0) @binding(0)` (layout mirrored by `internal/ConstantsBuffer.ts`), run as 8×8 workgroups, and write storage textures. Entry point is always `main`.

## Conventions

- **Coordinate space** — texel coordinates and UVs are top-left origin. Motion vectors arrive from three's `velocity` node as NDC deltas (`current − previous`) and are converted to UV deltas with `motionScale = (0.5, −0.5)`; reprojection is `prevUV = uv − motion`.
- **Jitter** — applied via `camera.setViewOffset`, so a render texel at index `i` holds scene content from unjittered position `i + jitter`. The accumulate pass measures kernel distances against `srcPos = uv·renderSize − 0.5 − jitter`.
- **Depth** — supports three's standard and reversed WebGPU depth conventions (flag bit + `linearizeDepth`, derived from `Matrix4.makePerspective`). Comparisons happen on positive view-space distances.
- **Color and exposure domains** — the local temporal pipeline multiplies input by the
  selected local conditioning exposure (auto, fixed, or external), then accumulates in
  _invertible-tonemap space_ (`c / (1 + max(c))`). Before RCAS it inverse-tonemaps, divides
  by the current local exposure, and returns to the caller's linear/HDR domain. Tone
  mapping and output encoding are integration concerns outside the upscaler. FSR Upscaler
  3.1.5 also keeps three exposure concepts separate: the host's input `preExposure`,
  `DeltaPreExposure()` for moving reprojected history into the current host pre-exposure
  domain, and internal/app `Exposure()` for conditioning. It removes only `Exposure()`
  before storage/output, so the result remains in the same color and host pre-exposure
  domain as the caller's input.

## FSR1 spatial fallback

`easu.ts` is the library's separate spatial fallback, not a stage in the FSR 3.1.5
temporal graph. **Current status — Source-aligned FSR1 port:** its 12-tap EASU
implementation retains the reference edge analysis, anisotropic Lanczos reconstruction,
tap placement, and deringing.

The WebGPU port uses native WGSL division and `inverseSqrt`, plus per-tap `textureLoad`
calls, instead of AMD's approximation helpers and packed gathers. Those are implementation
and profiling differences, not known algorithm gaps. The local path also assumes an
exact-sized input resource and leaves the input color domain unchanged. **Next action —
Keep / Benchmark:** keep EASU as the documented FSR1 fallback;
benchmark the math/load variants before changing them, and generalize viewport or output
handling only when an integration requires it.

## Temporal pipeline vs. FSR Upscaler 3.1.5

This audit is pinned to AMD FidelityFX SDK
[commit `60f4ea81909200d8542eca14dccb2628b763a9a3`](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/commit/60f4ea81909200d8542eca14dccb2628b763a9a3),
whose `ffx_fsr3upscaler.h` declares **FSR Upscaler 3.1.5**. SDK package tag `v2.3.0`
points to that commit, but `2.3.0` is the package version, not the upscaler algorithm
version. Temporal comparisons below use only the FSR3-named implementation. RCAS is the
exception: FSR 3.1.5 directly includes `fsr1/ffx_fsr1.h`, so that shared helper is part of
the authoritative path. The sibling FSR2 temporal resolver is not used as a baseline.

The temporal resolver began as a direct FSR port and retains FSR's pipeline intent,
resource flow, and algorithmic lineage. The current implementation combines necessary
WebGPU/three.js adaptations with custom replacements and stages that are absent relative
to FSR Upscaler 3.1.5. This audit records those differences so the project can converge
where source parity remains the goal; a divergence below is not automatically an accepted
design choice.

### How to read the audit

Each item separates two questions:

- **Current status** describes the implementation today:
  - **Source-aligned** — the reference algorithm is retained with language-level porting.
  - **Adapted port** — the reference behavior remains recognizable, with integration-specific changes.
  - **Diverges** — the reference stage exists locally but differs in material behavior.
  - **Custom replacement** — a local algorithm stands in for the reference stage.
  - **Missing** — no local equivalent currently exists.
- **Next action** describes the recommendation:
  - **Keep** — retain the current implementation.
  - **Benchmark** — compare quality/performance before choosing either implementation.
  - **Target parity** — change the local implementation toward the FSR 3.1.5 behavior.
  - **Target parity selectively** — converge through coordinated work or an optional API.

### Reference pass graph

FSR Upscaler 3.1.5 dispatches:

`prepare inputs` → `luma SPD` → `shading-change SPD` → `shading change` →
`prepare reactivity` → `luma instability` → `accumulate` → optional `RCAS`

### Authored benchmark candidates — not measured or adopted

The remaining audit solutions now exist as three cumulative, internally selected compiled
graphs. They are registered in the benchmark but have deliberately not been run. Their
presence is not evidence of a quality or performance improvement, and none changes the
default production path:

1. `source-filter-bundle-v1`
   - source-style radial approximate Lanczos2 with adaptive kernel bias for the current
     frame;
   - full 4×4 bicubic Lanczos history reconstruction and deringing;
   - FSR1-style approximate reciprocal/reciprocal-square-root EASU math while retaining the
     source 12-load topology as the WebGPU comparison against the exact production shader;
   - WebGPU-safe reconstructed-depth scatter through `atomic<u32>` storage buffers and an
     explicit pass boundary, followed by viewport/depth-scaled disocclusion;
   - previous/current conditioning plus host pre-exposure state, with history corrected
     into the current domain before filtering. Internal conditioning is removed at output;
     host pre-exposure remains in caller-domain linear/HDR color.
2. `source-structural-bundle-v1`
   - cumulatively includes the filter/reconstruction graph;
   - explicit lower-level motion/depth conventions specialized to three.js defaults;
   - farthest depth, current luma, motion divergence, and configurable source reactive
     generation (component max or vector length, threshold, scale, binary policy);
   - max-dilated application reactivity in the aggressive reset/shading channel;
   - T&C plus motion divergence in a distinct softer rectification channel;
   - render-resolution accumulation/reset state and atomic transient new-lock preparation.
3. `source-spd-resolver-bundle-v1`
   - cumulatively includes both earlier graphs;
   - a single-dispatch luma mip chain and a separate signed-difference shading-change mip
     chain, plus a three-mip shading resolve;
   - persistent four-frame render-resolution luma history/instability;
   - coordinated source-style accumulation, dynamic rectification, ridge locks, and state
     packing. History alpha is lock lifetime here, not the production resolver's sample
     age, so these paths are intentionally separate.

The mip candidates use direct higher-level reductions from the prepared source instead of
AMD's device-wide atomic SPD counter. This is a legal WebGPU single-dispatch solution with
the required mip signals, but it duplicates source reads at coarse levels; benchmark data
must determine whether that trade is acceptable. Reconstructed depth and new-lock scatter
use storage-buffer atomics because portable WebGPU does not expose the floating-point
storage-texture atomics used by native implementations.

`DispatchInputs.preExposureTexture` and
`DispatchInputs.transparencyAndComposition` are the only new source-compatible dispatch
inputs. Both are optional; the production fallback ignores them. All reactive generation
and resolve stages remain in caller-domain color with no internal ACES, transfer function,
or other presentation transform.

### Core recommendation

Do not replace the local resolver wholesale or preserve divergences by default. Build a
controlled A/B harness around `bench/`, test one compatible parity change at a time, and
keep whichever path gives the better measured quality/performance tradeoff.

Start with domain and math mismatches that fit the current graph, then compare filters,
then add structural parity as separately configured pipeline variants. Keep a local
divergence only when measurements demonstrate a performance advantage or a verified
WebGPU/three.js constraint justifies it. The full experiment sequence and decision rules
are in [Parity evaluation plan](#parity-evaluation-plan).

### Audit

#### RCAS bounds and denoise (`rcas.ts`)

- **Current status:** Numeric parity adopted; implementation strategy still differs.
- **Local implementation:** Applies
  `lowerLimiterMultiplier = saturate(eL / min(neighbor lumas))`, uses
  `L = 0.5R + G + 0.5B`, and includes the center in the denoise range. Denoise remains a
  runtime policy and currently defaults off. Lobe math uses native WGSL division, and
  dispatch is one pixel per invocation in 8×8 workgroups.
- **FSR 3.1.5 behavior:** Applies the green-weighted lower limiter. Denoise uses
  `L = 0.5R + G + 0.5B`, includes the center in the denoise min/max, and is enabled by the
  temporal RCAS pass. Center RGB remains excluded from `mn4`, `mx4`, and `hitMax`. The
  source uses high-precision reciprocals for the lobe bounds, an approximate-medium
  reciprocal for final normalization, and quad-remapped 16×16 coverage.
- **Why it differs / evidence confidence — Measured:** E01 found the source limiter and
  denoise math effectively tied in total compute and visually safe. The user adopted both
  on 2026-07-17. Native final normalization and local dispatch remain unmeasured
  implementation choices.

**Decision:** **Adopted.** The production shader now uses the source lower limiter and
denoise luma/range. Re-evaluate the temporal denoise default after the linear/HDR-domain
conversion on representative noisy content. Separately benchmark native versus
approximate-medium final normalization and 8×8 per-pixel dispatch versus quad-remapped
coverage only if RCAS performance becomes material.

#### RCAS load domain (temporal path)

- **Current status:** Deliberate divergence, measured (2026-07-21, NEXT-STEPS item 1).
- **Local implementation:** Sharpens the accumulate history's conditioned tonemap-space
  texels directly (bounded [0,1), the range the limiter math assumes) and inverts the
  conditioning once on the result.
- **FSR 3.1.5 behavior:** Sharpens in exposed linear space (applies `Exposure()` per
  load, reverses it after).
- **Why it differs / evidence — Measured:** The per-tap inversion form (five
  `tonemapInvert` divisions + five 1×1 exposure loads per pixel) measured RCAS at
  0.103 ms; the conditioned-space form measures 0.068 ms (**−34%**, repeatable, warm
  ABBA blocks). Captures on Q0/Q1/Q3/Q9 including the HDR-bulb ROI show RMSE ≤ 1.8/255
  full-frame and ≤ 9/255 max on the brightest content — visually indistinguishable, no
  overshoot. The prior per-tap shader is kept as `RCAS_PER_TAP_SHADER` for the frozen
  `rcas-fsr315-limiter` benchmark identity.

#### RCAS color domain

- **Current status:** Source-aligned output/color domain.
- **Local implementation:** Inverse-tonemaps, divides by the current local exposure, and
  filters in the caller's linear/HDR domain. It applies no presentation transform.
- **FSR 3.1.5 behavior:** Filters color conditioned by `Exposure()`, reverses
  `Exposure()`, and applies no presentation transform. Host `preExposure` remains, so
  linear HDR input remains linear HDR output.
- **Why it differs / evidence confidence — Resolved:** The fixed per-tap ACES+sRGB transform
  was an integration-layer policy inside the upscaler and had no source or platform
  justification. The user required its removal on 2026-07-17.

**Decision:** **Adopted.** RCAS and the `rgba16float` output stay in the caller's
linear/HDR domain. Benchmarks and examples apply their chosen renderer presentation only
when drawing to the screen; library users may instead continue linear post-processing.

#### Reconstruction and disocclusion (`reconstruct.ts`)

- **Current status:** Hybrid — fused pass structure kept (measured faster), AMD's
  threshold formulation adopted (2026-07-21, NEXT-STEPS item 3), plus the
  2026-07-22 cross-frame stability fix (below).
- **Local implementation:** One fused render-resolution pass: nearest-depth dilation,
  then per-bilinear-tap disocclusion voting against last frame's dilated depth using
  AMD's viewport/depth-scaled tolerance
  (`1.37e-5 · halfViewportWidth · max(depth)` — `ffx_fsr2_depth_clip.h`
  `ComputeDepthClip`, taken from the GPU-verified candidate port). Because the
  comparison is cross-frame (no same-frame scatter), three stabilizers apply
  (2026-07-22): taps at/behind the current surface are *skipped*, never allowed
  to veto the pixel (matches the reference's per-tap semantics); the reprojection
  is jitter-delta-compensated (same derivation as `shadingChange.ts`); and the
  tolerance is widened by the 3×3 ring's own depth relief (free from the dilation
  loop), so a slope's legitimate per-texel depth change is not read as
  separation. Without these, grazing-incidence planes (a ground plane near the
  horizon) flickered fully disoccluded per jitter phase — measured 12–14% of
  disocclusion-view pixels flipping >32/255 per frame in example 12, ~1.5%
  (moving-content baseline) after.
- **FSR 3.1.5 behavior:** Scatters nearest current depth into previous-frame positions
  with atomics, then evaluates reconstructed samples with the same viewport- and
  depth-scaled thresholds in a separate pass.
- **Evidence — Measured:** The atomic scatter + separate depth-clip pass was benchmarked
  in the structural candidate: +30% prepareInputs and +22% depthClip with no visible
  win on Q3 (see PARITY-DECISIONS). The fused pass with AMD's thresholds shows the
  expected debug signature (thin stable silhouette outlines, near-black still scenes,
  age resets confined to trails) and shifts finals by RMSE ≤ 1.1/255 versus the old
  fixed-threshold guess. Reconstruct pass time unchanged (0.035 ms at ratio 2).
  The remaining divergence from source is scatter coverage semantics only.

#### Farthest depth and motion divergence

- **Current status:** Missing.
- **Local implementation:** Provides neither farthest depth nor motion-divergence state.
- **FSR 3.1.5 behavior:** Prepares farthest depth and motion divergence for confidence,
  reactivity, and later temporal decisions.
- **Why it differs / evidence confidence — Unclear:** The local graph is reduced to color,
  nearest depth, motion, and one reactive input. No verified platform or performance reason
  for omitting these signals has been recorded.

**Keep the local path**

- **Pros:** Avoids the additional resources, calculations, and graph coupling.
- **Cons:** Later stages cannot use source confidence signals near depth or motion
  discontinuities. Any performance advantage remains unmeasured.

**Adopt FSR parity**

- **Pros:** Supplies the data expected by source reactivity and temporal-confidence logic.
  May improve difficult motion and silhouette cases.
- **Cons:** Expands the prepare-inputs graph and resource set. Benefits cannot be isolated
  fully until downstream consumers also exist.

**Next action:** **Target parity selectively.** Add both signals in the structural
prepare-inputs variant, then evaluate them with reconstructed-depth and reactivity parity
rather than as disconnected accumulation constants.

#### Motion, depth, and integration conventions

- **Current status:** Adapted port with a legitimate three.js integration tradeoff.
- **Local implementation:** Expects render-resolution, jitter-free NDC velocity in
  current-minus-previous form, applies `motionScale = (0.5, -0.5)`, and derives finite
  camera plus standard/reversed-depth behavior from three.
- **FSR 3.1.5 behavior:** Supports configurable motion scale, render- or
  display-resolution vectors, jitter cancellation, infinite depth, and dynamic render
  size.
- **Why it differs / evidence confidence — Verified:** The adapter is matched to three's
  velocity node and renderer conventions. That makes the common path simple and correct,
  but does not cover all valid external inputs.

**Keep the local path**

- **Pros:** Minimal setup for three users and a known convention for the built-in velocity
  node. Avoids exposing source-level integration complexity in the common API.
- **Cons:** External velocity/depth resources can use incompatible scale, sign, jitter,
  resolution, or depth conventions.

**Adopt FSR parity**

- **Pros:** Enables correct integration of externally authored resources and broader camera
  configurations.
- **Cons:** More configuration increases misuse risk. Replacing the three-specific defaults
  would make the primary integration less convenient without improving its correctness.

**Next action:** **Target parity selectively.** Keep the three adapter unchanged and
prototype a lower-level configurable dispatch path for external motion/depth inputs,
including explicit scale, resolution, jitter, and depth conventions.

#### Reactive and T&C handling

- **Current status:** Custom replacement with missing source inputs.
- **Local implementation:** Samples one reactive mask directly in accumulation and strongly
  reduces history and lock influence.
- **FSR 3.1.5 behavior:** Folds max-dilated application reactive into the
  shading-change/accumulation-reset channel. It samples T&C separately, combines it with
  motion divergence, and stores that result in the reactive channel consumed by lock and
  rectification behavior.
- **Why it differs / evidence confidence — Likely:** One mask avoids T&C resources and
  simplifies the public integration. This is a plausible platform/API rationale, not
  measured evidence or proof that the divergence was intended.

**Keep the local path**

- **Pros:** Simple authoring and resource binding. Existing transparency integrations need
  only one mask.
- **Cons:** Raw reactive lacks source dilation/reset coupling. T&C and motion divergence
  cannot contribute with their distinct source behavior.

**Adopt FSR parity**

- **Pros:** Restores spatial coverage and coordinated temporal reset behavior. Supports
  softer T&C influence instead of incorrectly aliasing it to aggressive reactive handling.
- **Cons:** Adds resources, pass work, and API complexity. The total cost and benefit need
  representative transparency measurements.

**Next action:** **Target parity selectively.** Implement prepare-reactivity in a distinct
graph variant first. Add public T&C configuration only after its core behavior is present
and validated on `examples/05-transparency`.

#### Reactive generation (`generateReactive.ts`)

- **Current status:** Adapted port with fixed policy.
- **Local implementation:** Uses component-max opaque-versus-final color difference with
  fixed threshold, scale, and cap.
- **FSR 3.1.5 behavior:** Selects component-max or vector-length difference, supports
  optional tone-map/inverse-tone-map transforms, and configures scale, threshold, and
  binary output.
- **Why it differs / evidence confidence — Likely:** Fixed settings keep the helper and API
  compact. No benchmark or platform requirement shows that the reduced policy is
  preferable.

**Keep the local path**

- **Pros:** Small API surface and predictable existing masks. Avoids configuration that
  most integrations may not need.
- **Cons:** Coverage varies from source behavior by color direction and HDR domain, and the
  fixed policy cannot be tuned for different content.

**Adopt FSR parity**

- **Pros:** Allows source-equivalent mask generation and content-specific tuning. Makes HDR
  and binary-mask behavior explicit.
- **Cons:** More controls can be misconfigured. Optional transforms add shader work when
  enabled; the cost is unmeasured.

**Next action:** **Target parity selectively.** Add bench-only generation controls and
compare mask captures plus temporal artifacts on `examples/05-transparency`; retain the
current policy as a convenience preset if it remains competitive.

#### Current-frame upsample (`accumulate.ts`)

- **Current status:** Custom replacement.
- **Local implementation:** Jitter-positions an analytic separable Lanczos2 kernel over a 3×3
  footprint.
- **FSR 3.1.5 behavior:** Uses a radial approximate Lanczos2 kernel with adaptive bias.
- **Why it differs / evidence confidence — Unclear:** The local kernel has an observably
  compact footprint, but no evidence establishes why it replaced the direct-port behavior
  or whether performance motivated the divergence.

**Keep the local path**

- **Pros:** Straightforward implementation with a bounded footprint and analytic kernel math.
- **Cons:** Sharpness, ringing, and subpixel response differ from the source. Compactness
  does not itself prove better GPU performance.

**Adopt FSR parity**

- **Pros:** Restores source reconstruction behavior and adaptive bias across scale ratios.
- **Cons:** Different math and sampling may increase or decrease GPU cost depending on the
  device; that must be measured.

**Next action:** **Benchmark.** Precompile local and source-style kernels, compare fixed
visual captures on `examples/04-aliasing-torture`, and measure equivalent workloads in
`bench/` at every supported scale.

#### History reconstruction (`accumulate.ts`)

- **Current status:** Custom replacement.
- **Local implementation:** Uses five-fetch Catmull-Rom history sampling.
- **FSR 3.1.5 behavior:** Uses custom bicubic Lanczos reconstruction.
- **Why it differs / evidence confidence — Likely:** Five fetches plausibly reduce texture
  sampling work, but no local measurement demonstrates a performance advantage or
  acceptable quality tradeoff.

**Keep the local path**

- **Pros:** Uses a small known fetch count and preserves current history appearance.
- **Cons:** Blur, ringing, and rejection input can differ from the source. The expected
  sampling savings have not been measured.

**Adopt FSR parity**

- **Pros:** Aligns history reconstruction with the source resolver and may improve temporal
  detail or stability.
- **Cons:** Could increase sampling/instruction cost and may expose different ringing. Both
  effects require A/B evidence.

**Next action:** **Benchmark.** Compare precompiled filters under camera motion,
disocclusion, and thin-feature stress; report per-pass distributions and upscaler
compute-pass sum, not fetch count alone.

#### Accumulation model (`accumulate.ts`)

- **Current status:** Custom replacement.
- **Local implementation:** Stores a capped display-resolution sample counter in history
  alpha and derives blending around that counter.
- **FSR 3.1.5 behavior:** Uses render-resolution-informed, motion-dependent history/current
  weights and stores lock lifetime in history alpha.
- **Why it differs / evidence confidence — Unclear:** The local state and weights are
  internally coupled, but no verified rationale explains replacing the source model.
  Since this began as a direct port, the replacement should not be treated as accepted
  solely because it exists.

**Keep the local path**

- **Pros:** Already integrated with local locks, rectification, and debug views. Avoids a
  coordinated resource/state rewrite.
- **Cons:** Convergence and motion response differ from the source, and isolated tuning
  cannot recover source behavior safely.

**Adopt FSR parity**

- **Pros:** Restores the source's coordinated weighting and render-resolution confidence
  model.
- **Cons:** Requires accumulation, locks, luma instability, rectification, and packing to
  change together. Cost and quality cannot be attributed to one sub-change.

**Next action:** **Target parity selectively.** Build a coordinated resolver variant after
its input signals exist; compare the complete local and parity models rather than mixing
incompatible alpha/state semantics.

#### Rectification (`accumulate.ts`)

- **Current status:** Custom replacement.
- **Local implementation:** Uses an unweighted fixed-gamma YCoCg box, widened strongly by
  custom locks.
- **FSR 3.1.5 behavior:** Uses a weighted, dynamically scaled box driven by motion, depth,
  accumulation, reactivity, shading, locks, and luma instability.
- **Why it differs / evidence confidence — Unclear:** The local variance clip is compact,
  but no measured performance rationale or evidence of intentional acceptance is recorded.

**Keep the local path**

- **Pros:** Fewer dependent source signals and simpler tuning/debugging.
- **Cons:** Can over-clamp or over-protect history where source bounds adapt to scene
  conditions.

**Adopt FSR parity**

- **Pros:** Makes history bounds respond to the same confidence signals as the source,
  potentially improving stability/detail balance.
- **Cons:** Adds dependencies and coordinated tuning. Evaluating it before the required
  source signals exist would produce a misleading result.

**Next action:** **Target parity selectively.** Implement it only in the coordinated
resolver variant, with debug visualization for every signal that scales the box.

#### Exposure history

- **Current status:** Host pre-exposure parity adopted (2026-07-21, NEXT-STEPS item 2);
  conditioning-exposure drift remains uncorrected by design.
- **Local implementation:** The pyramid publishes the app's `preExposureTexture` value
  in the 1×1 exposure texel's `.b` (1.0 when absent) and meters auto-exposure
  host-invariantly (divides host out of the measured average, as FSR2 divides
  pre-exposure out of every input load). Accumulate reads the previous frame's texel and
  ratio-corrects reprojected history in linear space across a host change — FSR3's
  `DeltaPreExposure()`. Host pre-exposure stays in the output (caller domain);
  conditioning exposure is still divided out.
- **FSR 3.1.5 behavior:** Same contract: `DeltaPreExposure()` corrects history,
  `Exposure()` is removed before output, host `preExposure` is preserved.
- **Evidence — Measured (scenario Q11, host-pre-exposure step + ramp):** With the
  correction, a 2.5× host step leaves the shading-change detector at baseline
  (mean 1.19 vs quiet 1.44), never resets accumulation age (165.5 vs a 131.4 reset
  without it), and output brightness tracks the drive in a single frame. Without a
  `preExposureTexture` both texels publish 1.0 and captures are **byte-identical** to
  the pre-change build — the correction is free for existing users.
- **Still divergent:** Conditioning (auto/fixed/external) exposure changes are not
  ratio-corrected; adaptation is eased slowly (`ADAPT_SPEED`) so the per-frame mismatch
  stays below the shading detector's threshold. Correcting it would change output for
  all auto-exposure users and needs its own captures — revisit only with evidence of
  pumping on real content.

#### Locks

- **Current status:** Custom replacement.
- **Local implementation:** Detects display-resolution peakiness/contrast, writes separate
  RGBA16F lock ping-pong textures, and applies custom luma-break and history-boost behavior.
- **FSR 3.1.5 behavior:** Creates locks from render-resolution ridge patterns, carries
  lifetime in history alpha, and uses different decay and break signals.
- **Why it differs / evidence confidence — Unclear:** The local system addresses
  thin-feature stability, but no verified reason shows why source lock semantics were
  replaced or that the memory/quality tradeoff is preferable.

**Keep the local path**

- **Pros:** Already protects some thin features and has dedicated debug visibility. It is
  compatible with the current local accumulation model.
- **Cons:** Coverage, persistence, memory traffic, and rectification coupling differ
  materially; permissive locks can preserve stale history.

**Adopt FSR parity**

- **Pros:** Restores source ridge detection and lock lifetime semantics within the intended
  resolver.
- **Cons:** Cannot be transplanted independently because source history alpha has a
  different meaning. The net resource/performance result needs whole-resolver measurement.

**Next action:** **Target parity selectively.** Keep local locks for the current resolver,
and replace them only inside the coordinated parity resolver tested on
`examples/04-aliasing-torture`.

#### Shading change

- **Current status:** Multi-scale detector adopted (2026-07-21, NEXT-STEPS item 4),
  in a fused form.
- **Local implementation:** `shadingChange.ts` — one half-resolution dispatch whose
  8×8 workgroup covers a 16×16 render tile, so 4×4 and 8×8 block reductions are
  workgroup-local. Current and jitter-aligned reprojected previous luma are averaged
  per block and the *means* are compared per scale, gated by a base + contrast-scaled
  (coefficient-of-variation) noise floor; disoccluded texels are neutralized. The
  strongest gated scale is the response consumed by accumulate's `SHADING_AGE` path.
  The pass also maintains the 1-frame luma history it compares against.
- **FSR 3.1.5 behavior:** Builds a signed-difference SPD from corrected
  current/previous luma over multiple mips, in two passes with dedicated mip
  resources.
- **Evidence — Measured (five GPU tuning iterations, 2026-07-21):** The source-style
  mean-of-per-texel-signed-ratios was implemented first and floored at ~0.10 mean
  response on a still jittered scene (the ratio metric weights the darker side of any
  alias residue — a coherent bias signed averaging cannot cancel); block-mean ratios
  with adaptive floors and coarse-scales-only resolve grade cleanly: still scene at
  the old detector's baseline, camera-orbit false positives *below* the old 3×3
  heuristic (Q4 worst 3.6 vs 4.9), light steps fire as clean single-frame spikes
  (137/255 vs the old 84 with a 20-frame decay tail), and a host pre-exposure step
  stays quiet. Finals differ ≤ 1.6/255 RMSE. Cost: 0.044 ms at ratio 2 (the
  candidate's two-pass form measured 0.231 ms), zero when
  `settings.detectShadingChanges` is off — the pass is simply not dispatched.

#### Luma instability

- **Current status:** Missing.
- **Local implementation:** Has no equivalent persistent signal; custom locks overlap with
  only some symptoms.
- **FSR 3.1.5 behavior:** Maintains a separate four-frame render-resolution luma history to
  protect recurring subpixel luminance.
- **Why it differs / evidence confidence — Unclear:** No verified platform or performance
  rationale is recorded. Local locks are not behaviorally equivalent evidence.

**Keep the local path**

- **Pros:** Avoids the four-frame luma-history resource and processing.
- **Cons:** Recurring subpixel luma may be rectified or accumulated incorrectly even with
  locks enabled. Any savings are unmeasured.

**Adopt FSR parity**

- **Pros:** Restores the source signal used to protect temporally unstable luminance.
- **Cons:** Adds state and bandwidth and only has full meaning when source rectification
  and accumulation consume it.

**Next action:** **Target parity selectively.** Implement and evaluate this signal with the
SPD and coordinated resolver variants, not as a standalone toggle in the local blend.

#### Luma and exposure analysis (`luminancePyramid.ts`)

- **Current status:** Custom scalar replacement; despite its filename, it is not a pyramid.
- **Local implementation:** Serially samples a fixed 32×32 grid and reduces it to one
  log-average exposure value.
- **FSR 3.1.5 behavior:** Prepare-inputs writes current luma and farthest depth. Luma SPD
  writes `FrameInfo`, stored coarse log-luma/luma, and half-resolution farthest depth.
  Shading-change SPD is a separate signed-difference pyramid.
- **Why it differs / evidence confidence — Rationale unclear; structural effect
  verified:** The scalar path avoids SPD resources and work. It is also serial and
  undersampled, and cannot feed source spatial luma/depth signals. No evidence establishes
  that performance motivated the replacement, and avoided work does not establish a
  measured speedup.

**Keep the local path**

- **Pros:** Minimal resource graph for basic exposure metering and no SPD allocation.
- **Cons:** Fixed sparse sampling can miss content, serial reduction may be inefficient,
  and one scalar cannot support source shading/reactivity signals.

**Adopt FSR parity**

- **Pros:** Supplies spatial luma/depth data and the frame state expected by later source
  stages.
- **Cons:** Adds resources and dispatch work. If only scalar exposure is needed, full SPD
  may not provide enough quality value to justify its cost.

**Next action:** **Target parity selectively.** Keep scalar metering available for the
local resolver while building luma SPD for the parity graph; compare exposure stability,
source-signal quality, resource footprint, per-pass distributions, and upscaler
compute-pass sum.

#### State packing

- **Current status:** Custom replacement coupled to the local resolver.
- **Local implementation:** Stores sample count in history alpha and uses two RGBA16F
  textures for lock state.
- **FSR 3.1.5 behavior:** Uses presentation-resolution RGBA16F history with lock lifetime
  in alpha, render-resolution ping-ponged R8 accumulation, render-resolution RGBA16F
  four-frame luma history, and transient presentation-resolution R8 new locks.
- **Why it differs / evidence confidence — Unclear:** Each layout follows its resolver's
  data flow. No measured memory/bandwidth rationale establishes that local packing is
  better, and repacking alone would not restore source behavior.

**Keep the local path**

- **Pros:** Matches current alpha semantics and lock implementation without migration.
- **Cons:** Uses materially different memory and bandwidth, including large lock textures;
  its relative cost is unknown.

**Adopt FSR parity**

- **Pros:** Aligns resources with source accumulation, locks, and luma instability and may
  reduce some state sizes.
- **Cons:** Adds other source resources and changes lifetimes/resolutions. Format-level
  comparisons outside the complete graph would be misleading.

**Next action:** **Benchmark.** Derive packing from each complete resolver variant, then
measure memory footprint, per-pass distributions, and upscaler compute-pass sum; do not add
public packing flags. Use a separate frame-level profiler if total frame GPU time is
required.

#### Output (`rcas.ts`, `blit.ts`)

- **Current status:** Source-aligned output ownership.
- **Local implementation:** Writes caller-domain color to `rgba16float` with no tone
  mapping, gamut conversion, or transfer function.
- **FSR 3.1.5 behavior:** Removes internal/app `Exposure()` while preserving host
  `preExposure`, returning the caller's input color/pre-exposure domain and leaving
  presentation to integration.
- **Why it differs / evidence confidence — Resolved:** The former fixed ACES+sRGB output
  was misplaced presentation policy. It was removed by user decision on 2026-07-17.

**Decision:** **Adopted.** The library always exposes linear/HDR output. Integrations own
the final transform; the examples choose three's ACES filmic tone mapping and sRGB output
only as an example presentation policy.

#### Raw WGSL and three.js integration

- **Current status:** Adapted port and required platform integration.
- **Local implementation:** Runs hand-written WGSL directly on three's WebGPU device and
  returns a three texture.
- **FSR 3.1.5 behavior:** Uses the FidelityFX host/backend abstraction around the source
  shaders and resources.
- **Why it differs / evidence confidence — Verified:** The library targets WebGPU and
  three.js directly. Browsers do not expose the native FidelityFX backend contract, so this
  adaptation is necessary. This is comparable to frame generation remaining out of scope
  because browser swapchain pacing is unavailable.

**Keep the local path**

- **Pros:** Fits the supported platform, keeps WGSL inspectable, and integrates with three
  textures and command ordering.
- **Cons:** Depends on private three backend access and requires local responsibility for
  bindings, resource layouts, validation, and GPU compatibility.

**Adopt FSR parity**

- **Pros:** Algorithm/resource semantics can still be matched within WGSL.
- **Cons:** Adopting the native FidelityFX host/backend packaging is not directly available
  in this WebGPU/three environment and would not remove the need for an adapter.

**Next action:** **Keep.** Retain raw WGSL and the three adapter, while validating every
parity experiment on a real WebGPU device and keeping algorithm differences separate from
platform glue.

### Parity evaluation plan

#### Principle

Choose the quality/performance Pareto result. Source parity is a hypothesis to test, not an
end by itself.

Parity is preferred when it improves quality without unacceptable measured performance or
platform cost. If a local divergence remains, document the measured performance or
verified platform justification here rather than inferring intent from the implementation.

#### Canonical harness

- Use `bench/` for controlled scene, timing, resolution, and presentation comparisons.
- Use `examples/04-aliasing-torture` as a visual fixture for reconstruction, history,
  locks, luma instability, and rectification stress.
- Use `examples/05-transparency` as a visual fixture for reactive generation, dilation,
  T&C, and motion-divergence interactions.
- Keep authoritative GPU timing in `bench/`; the specialized examples do not currently
  provide equivalent timing coverage.

#### Experiment architecture

- Keep experimental controls bench-only and unexported until a decision is made. Do not
  add provisional controls to public `RuntimeSettings` or exported types.
- Small math changes may use runtime flags for rapid visual A/B.
- Final performance comparisons must use separate precompiled local/parity pipelines.
  Dynamic branches can bias instruction count, register pressure, and timing.
- Resource or pass-graph changes require distinct pipeline variants and reconfiguration,
  not one runtime branch.
- Split-screen is useful for visual comparison, but its timings are invalid because both
  variants share the frame workload.

Not every recommendation can be implemented as “one flag”: math variants can use temporary
runtime flags, while structural changes need separate resource graphs and pipelines.

#### Stage experiments

1. **Harden measurements first.** Add a deterministic camera/frame sequence, fixed
   timestep and resolution, clear stale timer labels, collect distributions, and disable
   debug views for timing.
2. **Math and domain fixes.** Evaluate exposure-history correction, RCAS math/defaults, and
   reactive generation/dilation.
3. **Reconstruction filters.** Compare the current-frame kernel and history filter.
4. **Structural input/reactivity.** Compare reconstructed-depth scatter, farthest depth,
   motion divergence, and T&C.
5. **Temporal stability graph.** Add luma SPD, shading-change SPD, and luma instability.
6. **Coordinated resolver variant.** Evaluate accumulation, rectification, locks, and state
   packing as one compatible model.
7. **Output domain — adopted.** Keep the upscaler linear/HDR and apply presentation only
   in the consuming renderer or post-processing graph.

#### Measurement protocol

- Authoritative GPU timing requires an adapter with WebGPU `timestamp-query` support.
  Record the GPU, adapter, browser/version, physical resolution, and DPR with every result.
  If timestamp queries are unavailable, report GPU timing as unavailable; FPS is not a
  substitute.
- Treat the current `GpuTimer` output as a spot-check, not authoritative statistics. It
  exposes only the latest asynchronous result map, can retain stale values while readback
  is pending, and does not currently collect distributions.
- Before comparing variants, add fresh-sample identifiers, clear removed pass labels on
  graph changes, and store per-frame samples for each pass.
- Fix physical resolution, DPR, timestep, seeded scene state, and camera path. Disable or
  fix exposure adaptation unless exposure behavior is the variable under test.
- Reset history and jitter so variants begin from identical state.
- Use 240 warm-up frames, then collect 600 fresh timer samples per block.
- Test 1× Native AA, 1.5× Quality, 2× Performance, and 3× Ultra Performance.
- Run four alternating ABBA repetitions to reduce order and thermal bias.
- Run one variant per timing block.
- Report median and p95 per pass plus the **upscaler compute-pass sum**. Do not call that
  sum total frame GPU time: it excludes scene rendering, presentation, and other graph
  overhead. Treat FPS as secondary.
- Capture the same post-reset frames for both variants.
- Use debug views and fixed captures for quality evidence. Add image-difference or FLIP
  analysis later if visual decisions remain ambiguous.

#### Decision rule

- Before each experiment, declare its artifact gates and numeric median/p95 GPU budget.
- Adopt parity only when it passes the visual gates and stays within that declared budget.
- Keep local behavior only when it demonstrates a measured performance or platform
  advantage and introduces no fixture regression.
- If each path wins different scenes, keep them as explicit variants or iterate on a
  hybrid. Do not average away a visible regression; record the evidence and rationale in
  this README.

## Operational notes

### Custom thin-feature locks

The local lock heuristic is intended to reduce thin-feature dimming and shimmer from
rectification. `accumulate.ts` keeps display-resolution lock state (r = lifetime,
g = locked luma), reprojects it with motion, and derives candidates from neighborhood
`peakiness × contrast`. A lock widens the local rectification box
(`LOCK_CLAMP_RELAX`) and increases history influence (`LOCK_HISTORY_BOOST`).

This is custom behavior, not FSR 3.1.5's ridge-pattern lock system. It can preserve detail
or preserve stale history depending on content and tuning. Toggle
`settings.lockThinFeatures` (`FLAG_LOCKS`) and inspect `DebugView.Locks`. Tune cautiously:
more permissive locks can increase trails; stricter locks can reduce their intended effect.

### Local exposure conditioning

`luminancePyramid.ts` reduces a fixed 32×32 scene sample grid to one log-average value,
maps it to an auto-exposure target, clamps that target, and eases toward it. Fixed
`settings.exposure` and external `exposureTexture` values are selected as supplied rather
than passed through the auto-target clamp. This local conditioning `exposure` should not be
conflated with FSR's caller-provided host `preExposure`. `accumulate.ts` applies the local
factor before the invertible tonemap; `rcas.ts` or `blit.ts` later divides by the current
factor before linear/HDR output.

This conditions the local accumulation range, but it does not guarantee unchanged final
brightness. In particular, stored history is not corrected when exposure changes, so
adaptation can cause pumping or trails. Toggle `settings.autoExposure`
(`FLAG_AUTO_EXPOSURE`); with it off, `settings.exposure` follows the same local path.
Passing `dispatch({ exposureTexture })` overrides both values with the texture's red
channel, but still feeds this local conditioning/history path. It is not a way to
declare AMD-style host `preExposure`; using it as one will divide that factor back out
during output and will not provide `DeltaPreExposure()` history correction.
`DebugView.Exposure` visualizes clamped exposed luma, not the selected exposure scalar.

### Shading-change detector

`shadingChange.ts` compares block-mean luma (4×4 and 8×8 render blocks) against the
previous frame's jitter-aligned reprojected luma; where a scale's mean moved beyond its
noise floor, non-locked history is aged by `SHADING_AGE` in `accumulate.ts`; locked
pixels suppress this aging (locks must never break on shading change — see CLAUDE.md).
Ghosting after a lighting change → lower the `SHADING_FLOOR_*` constants (top of
`shadingChange.ts`); flat steadily-lit surfaces shimmering → raise them, or raise
`SHADING_FLOOR_CV` if the noise sits on textured regions.

Toggle `settings.detectShadingChanges` (`FLAG_SHADING_CHANGE`) and inspect
`DebugView.ShadingChange`. When off, the pass is not dispatched at all.

### Reactive masks

Pass a render-resolution red-channel mask in `[0, 1]` as `dispatch({ reactive })`.
Locally, stronger values suppress lock formation, sharply reduce accumulation, and bias
the blend toward the current frame. If no mask is supplied, a 1×1 zero texture is bound and
the shader branch is flag-gated; this avoids the full reactive behavior but is not a
literal guarantee of zero overhead.

Alternatively, pass `dispatch({ reactiveOpaqueColor })` with an opaque-only render and
`generateReactive.ts` will derive a mask using a fixed component-max color difference,
threshold, scale, and cap. `examples/05-transparency` demonstrates both inputs. Render the
opaque pass with the same jitter as the final frame or high-contrast edges can produce
false reactivity from subpixel misalignment. Unlike the FSR 3.1.5 helper, the local API
does not select component-max versus vector-length difference, optional tone-map/
inverse-tone-map transforms, or binary output value. It also does not reproduce the full
prepare-reactivity, T&C, or motion-divergence behavior.

## Debugging

Set `settings.debugView` (`DebugView`) to render pipeline internals instead of the final image: motion vectors, disocclusion mask, linearized depth, accumulation age, locks, auto-exposed luminance, or the shading-change factor. When integrating a new scene, check in this order:

1. **Motion vectors** — a static scene with a moving camera should produce smooth
   gradients and no per-object noise. Per-object flashing often points to previous-model
   tracking or a bypassed `velocity` node.

2. **Disocclusion** — should outline moving silhouettes, thin and stable. Full-screen
   flashing often points to incorrect depth linearization flags or a reversed-depth
   mismatch.

3. **Accumulation age** — should trend toward white when still and reset along
   disocclusion trails. Whitening time depends on frame rate and `maxAccumulation`.

4. **Locks** — should usually concentrate on thin high-contrast features and remain low on
   flat surfaces. Locks everywhere suggests permissive thresholds and trail risk; nothing
   lit suggests the heuristic is not engaging.

5. **Exposure** — shows clamped exposed luma, not the exposure scalar. Under auto
   exposure, the metered geometric-mean reference should trend toward mid-grey; individual
   pixels are not expected to. All-black or all-white can indicate view saturation,
   invalid luma input, or a metering-range mismatch, but does not show that a fixed or
   external exposure value was clamped.

6. **Shading change** — should remain mostly dark on a static, steadily lit scene and
   respond temporarily to changed lighting or materials. Broad response while still
   suggests `SHADING_LO` is too low; no response to an obvious change suggests it may be
   too high.

7. **Reactivity** — shows the mask as accumulation sees it: white where transparents or
   particles were flagged, black on opaque geometry. If it is unexpectedly misaligned or
   empty, check its resolution, authoring pass, and whether it was set before `dispatch`.
