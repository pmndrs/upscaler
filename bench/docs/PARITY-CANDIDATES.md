# Parity Candidate Test Guide

## Current status

**Update 2026-07-18:** all three bundles are now **GPU-compiled, validated, rendered,
timed, and captured** (after fixing five defects that had prevented any of them from
surviving `init()` — see PARITY-DECISIONS.md). Measured results and the reproduce
command live in `PARITY-DECISIONS.md`; raw evidence in `bench/results/raw/CANDIDATES/`.
The candidate A/B path is simply `run-benchmark.mjs --smoke --variant <A>
--comparison <B>` — no candidate-specific manifest was needed (the cross-variant
`analyzeAbba` label crash was fixed to compare only shared pass labels).

The production fallback is unchanged and remains the default. No bundle is adopted:
all three cost more compute than production (+36%, +43%, +76% cumulative) without a
demonstrated visual win on the deterministic scenarios.

**Program conclusion (2026-07-21):** four individual behaviors identified through
these bundles were extracted and landed in production in re-derived, cheaper forms —
conditioned-space RCAS, host pre-exposure correction, AMD's disocclusion threshold,
and the multi-scale shading-change detector. Evidence: [NEXT-STEPS.md](NEXT-STEPS.md).
The bundles themselves stay registered as bench variants for future re-testing.

## What is already production behavior

These changes are adopted; they are not part of the unmeasured candidate decision:

- **Linear/HDR output:** internal ACES and sRGB presentation transforms were removed from
  EASU, RCAS, blit, final output, and debug output. The upscaler returns caller-domain
  `rgba16float`; the consuming renderer owns tone mapping and output encoding.
- **RCAS numeric parity:** production RCAS now uses the FSR 3.1.5 lower limiter and the
  corrected denoise luma/range math. RCAS denoise remains opt-in because enabling it by
  default changed high-contrast detail without a demonstrated noisy-input benefit.

The production graph, adopted RCAS math, linear/HDR output contract, and opt-in denoise
policy are the fallback for every candidate below.

## What was authored

The candidates are cumulative and must be tested in this order:

1. `source-filter-bundle-v1`
2. `source-structural-bundle-v1` = filter bundle + structural inputs/reactivity
3. `source-spd-resolver-bundle-v1` = structural bundle + SPD signals/coordinated resolver

This ordering matters. Comparing each bundle only with production would show the total
effect, but adjacent comparisons are needed to attribute the incremental cost and image
change. Later adoption does not have to be all-or-nothing if evidence supports extracting
a compatible stage, but no stage should be transplanted before its dependencies and
state semantics are understood.

### `source-filter-bundle-v1`

**Changes**

- Separates host `preExposure` from internal conditioning exposure, tracks previous and
  current values, and moves reprojected history into the current domain before filtering.
  Internal conditioning is removed at output while host pre-exposure remains.
- Replaces current-frame reconstruction with radial approximate Lanczos2 and adaptive
  kernel bias.
- Replaces history sampling with a deringed 4×4 bicubic Lanczos reconstruction.
- Replaces fused local depth reconstruction with an atomic `u32` nearest-depth scatter,
  an explicit pass boundary, and viewport/depth-scaled disocclusion.
- Selects an FSR1-style EASU shader using approximate reciprocal and reciprocal-square-root
  helpers while preserving the existing 12-load topology.

**Likely problems addressed**

- Exposure adaptation or app pre-exposure changes can otherwise compare current and
  history color in different domains, causing pumping, trails, or incorrect clipping.
- Source-style current/history filters may improve sub-pixel reconstruction, moving-edge
  stability, and history deringing.
- Atomic previous-depth scatter more closely represents reprojected geometry and may
  reduce incorrect disocclusion around moving silhouettes.

**Why these changes are grouped**

They form the smallest source-style reconstruction path that can retain the local
accumulation/lock model. Exposure correction must occur before history filtering, and the
depth result supplies the disocclusion signal used by that filter path.

**Expected tradeoff and fallback**

The 4×4 history filter, atomic scatter, and extra depth pass can cost more GPU time and
bandwidth. Approximate EASU math may reduce ALU cost, but introduces numeric error that
could soften or destabilize spatial edges. Production exact EASU, local reconstruction,
and local exposure/history behavior remain available by selecting no candidate.

EASU is exercised only by the spatial path. The registered bundle metadata currently
selects the temporal path, so a normal temporal candidate run will compile the EASU
pipeline but will not measure its dispatch. A focused spatial manifest/runner is required
before making an EASU claim.

**Evidence needed**

- WebGPU compilation/validation for all supported ratios and odd render sizes.
- Per-pass and compute-sum timing against production, then visual review of convergence,
  camera/object motion, silhouettes, and reset behavior.
- Controlled exposure steps and ramps that distinguish internal conditioning changes
  from host pre-exposure changes.
- A separate spatial EASU comparison using edge/detail captures and numeric differences.

### `source-structural-bundle-v1`

**Changes**

- Includes all of `source-filter-bundle-v1`.
- Prepares farthest depth and current luma alongside nearest depth/motion.
- Adds motion divergence to identify unreliable reprojection.
- Adds configurable source-style opaque-versus-final reactive generation.
- Max-dilates application reactivity into the aggressive history-reset/shading channel.
- Keeps Transparency & Composition (T&C) plus motion divergence in a distinct, softer
  rectification channel instead of treating them as fully reactive.
- Adds render-resolution accumulation/reset state and atomic transient new-lock
  preparation.

**Likely problems addressed**

- The current generated reactive mask has fixed policy and one aggressive meaning;
  source-style controls should better classify transparent or composition changes.
- Treating T&C exactly like reactive content would discard too much history. The softer
  channel should reduce ghosting without forcing every transparent pixel to current color.
- Farthest depth and motion divergence provide context for depth boundaries and
  inconsistent motion that simple nearest-depth disocclusion misses.
- Prepared accumulation and new-lock state coordinate resets before display-resolution
  accumulation.

**Why these changes are grouped**

These signals share the prepare-inputs and prepare-reactivity resource graph. Testing one
without its consumers would pay structural cost without evaluating the behavior it was
added to drive, while mixing them into the local mask channels would make attribution and
fallback semantics ambiguous.

**Expected tradeoff and fallback**

Expect extra textures/buffers, an additional prepare-reactivity dispatch, atomic lock
scatter, and more source reads. The likely quality upside is less transparency ghosting,
better silhouette handling, and more selective history distrust; the main quality risks
are over-resetting, noisy masks, flicker, and locks appearing on ordinary edges. The
filter candidate and production graph remain lower-cost fallbacks.

**Evidence needed**

- Incremental timing versus `source-filter-bundle-v1`, including `prepareInputs`,
  `depthClip`, and `prepareReactivity`.
- Q5 transparency captures with manual/application reactive input, generated reactive
  input, and T&C input reviewed separately.
- Reactivity, disocclusion, accumulation-age, locks, and motion-vector debug views to
  verify channel meaning and alignment.
- Moving-geometry and camera-motion review for farthest-depth and motion-divergence
  behavior, including false positives on stable opaque surfaces.

### `source-spd-resolver-bundle-v1`

**Changes**

- Includes all of `source-structural-bundle-v1`.
- Adds a luma mip chain carrying spatial luma/depth information and frame exposure state.
- Adds a signed current/history luma-difference mip chain and three-mip shading-change
  resolve.
- Adds persistent render-resolution four-frame luma history and instability.
- Replaces the local resolver with coordinated source-style current/history
  reconstruction, dynamic rectification, accumulation weighting, ridge locks, and state
  packing.
- Stores lock lifetime in history alpha. Production stores normalized sample age there,
  so the two histories are intentionally incompatible and must reset when switching.

**Likely problems addressed**

- Coarse luma context should make shading-change detection less sensitive to local
  high-frequency detail than the current 3×3 heuristic.
- Four-frame instability can preserve valid recurring detail that a one-frame comparison
  might clip, while still rejecting unstable history.
- Coordinating accumulation, rectification, locks, and prepared state avoids combining
  signals designed for different state models.

**Why these changes are grouped**

The mip signals, instability history, lock lifetime, accumulation value, and rectification
weights are mutually dependent. Testing them as independent toggles would produce invalid
state combinations. This bundle is the only candidate whose history alpha has source-style
lock semantics.

**Expected tradeoff and fallback**

This is the highest-cost and highest-risk candidate: it adds luma/shading dispatches,
history resources, and coarse reductions before a more complex resolver. The WebGPU-safe
mip implementation directly rereads the prepared source at higher levels instead of using
AMD's device-wide atomic SPD counter; that is portable but may duplicate substantial work.
Potential benefits are steadier lighting transitions, better detail retention, and more
coherent locks. Risks include false shading changes, excess history retention, flicker,
ghosting, incorrect reset state, and enough cost to outweigh fidelity gains. The
structural bundle and production graph remain fallbacks.

**Evidence needed**

- Incremental timing versus `source-structural-bundle-v1` for `lumaSpd`, `shadingSpd`,
  `shadingResolve`, `lumaInstability`, and `accumulate`, plus total compute.
- Exposure-transition, lighting-change, static-convergence, motion, cut, reset, and resize
  captures with history reset confirmed at every boundary.
- Shading-change, locks, accumulation-age, exposure, and final debug review that checks
  signal meaning rather than only final-image similarity.
- Multi-frame metrics for convergence, temporal variance/flicker, disocclusion trails,
  thin-feature retention, and ghost persistence.

## Static audit corrections

The post-authoring audit changed candidate-only code to correct likely defects before GPU
work:

- restored accumulation-state growth in the structural path;
- seeded all four luma-history slots after reset or offscreen reprojection;
- computed reconstruction weights from unclamped tap positions at image borders;
- rounded odd-size SPD allocations so every written mip has sufficient extent;
- compile-time-specialized farthest-depth/current-luma preparation and motion divergence
  so `source-filter-bundle-v1` does not silently execute structural work;
- kept benchmark-only constructor hooks out of the public constructor declaration;
- aligned T&C documentation and benchmark metadata with the implemented dispatch inputs.

GPU-free checks previously passed after those fixes, but static checks cannot prove WGSL
device compilation, binding validity, image quality, timing, or cross-adapter behavior.

## Later test matrix

Test in project priority order: **performance > quality > realism**.

### 1. Performance gate

Measure both total and incremental cost:

- production → `source-filter-bundle-v1`;
- `source-filter-bundle-v1` → `source-structural-bundle-v1`;
- `source-structural-bundle-v1` → `source-spd-resolver-bundle-v1`;
- production → each candidate as a total-cost check.

Use ratios `1`, `1.5`, `2`, and `3`; fixed dimensions, timestep, seeded scene state,
camera path, reset state, and presentation domain; and fresh per-frame timestamp-query
samples. Record every pass median/p95, compute-sum median/p95, missing samples, adapter,
browser/backend, shader keys, and resource graph.

Interpret repeated measurements using the established practical thresholds:

- **below 3%:** tied/noise;
- **3–5%:** uncertain; rerun before a decision;
- **at least 5%:** actionable when repeatable.

A visual regression rejects a candidate regardless of speed. A performance loss of at
least 5% requires a clear, repeatable quality benefit to remain under consideration.

### 2. Quality gate

Prioritize the existing deterministic scenarios:

- **Q0 input/debug validation:** compile/binding sanity and every candidate debug view.
- **Q1 static convergence:** thin-feature retention, lock growth, convergence, flicker.
- **Q2 slow aliasing dolly / Q4 camera-motion hold:** reconstruction stability and trails.
- **Q3 object-motion disocclusion:** atomic depth, motion divergence, silhouette ghosts.
- **Q5 seeded transparency/reactivity:** generated/application reactive masks and softer
  T&C behavior.
- **Q9 exposure transition:** conditioning/pre-exposure correction, pumping, and shading
  response.
- **Q10 reset/cut/resize:** state packing, reset seeding, and resource recreation.

Review final output plus motion vectors, disocclusion, accumulation age, locks, exposure,
shading change, and reactivity where each scenario defines them. Preserve blinded captures,
ROI max-absolute error and RMSE, frame-exact comparisons, and reviewer notes. Numerical
similarity is supporting evidence; temporal artifacts and visible regressions decide the
quality gate.

Add focused odd-width/odd-height cases to validate candidate mip allocation; no existing
Q0–Q10 scenario supplies that coverage.

Run a separate spatial EASU matrix because the temporal matrix does not dispatch EASU.
Compare edge sharpness, ringing, flat-field stability, small text/grid detail, and GPU cost
between exact production math and the approximate candidate.

### 3. Realism/coverage gate

Only after performance and deterministic quality survive, expand to Q6–Q8 screen-space
effects, representative HDR scenes, noisy GI/reflections, transparency-heavy content,
multiple adapters/browsers, and long camera paths. This gate checks whether a source-style
gain generalizes; it must not rescue a candidate that already failed deterministic
performance or visual review.

## Existing harness entry points and missing work

Verified existing package entry points:

- `npm run bench` starts the interactive Vite bench.
- `npm run bench:run` and `npm run bench:capture` execute the immutable E00 harness.
- `npm run bench:compare:rcas` is the focused E01 RCAS comparison.

The browser configuration recognizes `variant` and `comparison` selectors with these exact
candidate IDs, ratios `1`, `1.5`, `2`, and `3`, and scenarios `Q0` through `Q10`.
Candidate timing labels and resource identities are registered.

There is **no focused candidate command or immutable candidate manifest yet**.
`bench:run`/`bench:capture` enforce E00's baseline roles for authoritative non-smoke runs,
and `bench:compare:rcas` covers RCAS only. Before collecting decision evidence, author
candidate manifests plus runner/report orchestration for cumulative and adjacent A/B
comparisons, including a separate spatial EASU comparison. Do not treat an interactive
selection or smoke run as adoption evidence.
