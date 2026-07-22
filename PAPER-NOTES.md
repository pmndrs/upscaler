# Paper notes — findings worth writing up

A running tracker of results from this project that are novel or non-obvious
enough to publish (blog series, talk, or a short paper). Each entry: the
claim, where the evidence lives, and what a publication-grade version still
needs. Add to this file whenever a finding clears the bar: *it surprised us,
we measured it, and someone else would hit it too.*

Consumer-facing prose for several of these already exists in
[PARITY.md](PARITY.md); this file tracks them *as paper material* — evidence
pointers and gaps, not exposition.

---

## 1. Per-texel relative-difference metrics are biased under sub-pixel jitter

**Claim:** any temporal change detector built on per-texel relative
differences (`1 − min/max`, signed ratios) carries a *coherent* bias on
high-frequency content under sub-pixel jitter: the darker side of any alias
residue always yields the larger ratio, so the mean of per-texel ratios
floors at ~0.07–0.10 on a perfectly still scene — averaging cannot cancel a
one-sided error. Taking the ratio **of block means** (average first, compare
second) is unbiased; the still-scene floor drops to ~0. Additionally, 2×2
block means are unrescuable at any threshold (thin features still swing
them); 4×4 is the smallest stable scale.

**Evidence:** `src/shaders/shadingChange.ts` (inline comments record the
measured floors); five GPU tuning iterations in
`bench/docs/NEXT-STEPS.md` (item 4); PARITY.md §3. Measured on Q1/Q4/Q9/Q11.

**Still needs:** a minimal synthetic reproduction (checkerboard + jitter, no
upscaler) showing the bias analytically and numerically; comparison against
FSR 3.1.5's own signed-difference pyramid on the same input.

## 2. The price of skipping the scatter — and geometry-derived repairs

**Claim:** FSR2/3's "reconstruct previous depth" scatter is not just a
performance choice — it is what makes disocclusion testing *self-referencing*
(a visible surface compares against its own same-frame depth). Replacing it
with a cross-frame gather (−22–30% pass cost) silently converts the test
into a cross-frame comparison that inherits sub-texel sampling error, which
on steep depth gradients (grazing-incidence planes) exceeds the
viewport/depth-scaled tolerance by an order of magnitude → per-jitter-phase
disocclusion flicker (measured: 12–14% of mask pixels flipping >32/255 per
frame). Three compensations restore stability at zero cost and with zero
scene-tuned constants: (a) reference per-tap skip semantics (no veto), (b)
jitter-delta-compensated reprojection, (c) a separation tolerance widened by
the 3×3 dilation ring's own depth relief — data the fused pass already holds
in-register. The gather + repairs form retains the scatter's stability at
the gather's cost.

**Evidence:** commit `b16274a`; `src/shaders/reconstruct.ts` (inline);
PARITY.md §1 ("the price of skipping the scatter"); flicker metrology in the
commit message (example-12 disocclusion quadrant, before/after);
`bench/results/raw/GUIDES-M1/capture-depthfix`.

**Still needs:** an A/B against the true scatter form (the structural
candidate bundle still implements it) on the same grazing-plane scene —
does the repaired gather match the scatter's mask exactly, or only its
stability? Cross-vendor timing for the cost claim.

## 3. Source-faithful pass graphs measured against fused re-derivations

**Claim:** porting FSR 3.1.5's pass graph faithfully to WebGPU costs
+36% / +43% / +76% GPU compute (filter / structural / SPD-resolver bundles)
over a fused re-derivation with no measurable visual win on torture scenes —
because the source graph's structure pays for generality (intermediate
textures, atomic scatters, SPD mip chains) that a renderer-integrated
upscaler can fuse away. Includes the negative results: which upstream
behaviors *were* worth adopting (conditioned-space RCAS −34%, AMD's
disocclusion tolerance, DeltaPreExposure) and which were not.

**Evidence:** the whole parity program — `bench/docs/PARITY-DECISIONS.md`,
`bench/docs/PARITY-CANDIDATES.md`, `bench/docs/NEXT-STEPS.md`, PARITY.md.
Candidate bundles remain runnable
(`node scripts/run-benchmark.mjs --smoke --variant <A> --comparison <B>`).

**Still needs:** cross-device timings (all numbers are one Apple Metal
adapter family); blinded-review grading of the capture pairs (168 pairs
exist under `bench/results/raw/CANDIDATES/`, ungraded).

## 4. Temporal guides: frame properties vs upscaler properties

**Claim (systems/architecture):** dilated motion, dilated depth,
disocclusion, and history validity are *frame* properties that every
temporal consumer (upscaler, SSGI temporal pass, SVGF-class denoiser, TAA)
re-derives privately today. Publishing them as a contracted bundle — with
the split the data actually dictates (early = signal-agnostic geometry,
late = beauty-color-dependent) — lets one computation feed all consumers.
The interesting boundary result: lock/instability state *cannot* be an
early product (it derives from final color by construction), so the correct
contract is previous-frame priors, which is also exactly what
history-rejection consumers want.

**Evidence:** `TEMPORAL-GUIDES-SPEC.md` (+ `GUIDES-SPEC-RESPONSE.md`, the
consumer-side review); implementation on branch `feat-temporal-guides`
(M1/M2 commits); the acceptance A/B (guides-fed SSGI temporal vs private
logic) will live in the consumer repo's demo-10 lab.

**Still needs:** the consumer lab's measured win (quality and/or ms) —
without it this is a design essay, not a result.

## 5. Methodology: GPU power-state contamination in headless benchmarking

**Claim (smaller, methods note):** headless-Chrome WebGPU timing runs are
valid A/B *within* an environment but absolute numbers are hostage to GPU
DVFS: the same workload read a uniform ~3× slower launched from a cold
scratchpad worktree (CPU-bound frame delivery keeps the GPU at low clocks).
Uniform inflation across all passes is the diagnostic signature separating
environment from code. Complements the existing finding (recorded in
PARITY-DECISIONS) that long ABBA sequences show monotonic drift that
forbids fine-margin claims.

**Evidence:** `bench/results/raw/GUIDES-M1/` (timing vs timing-pre/pre2 vs
timing-post-wt); CLAUDE.md bench caveat; TEMPORAL-GUIDES-SPEC.md M1 notes.

**Still needs:** nothing much — this is a workshop/appendix note, but worth
a paragraph wherever the timing methodology is described.

---

*Maintenance: link new entries from the relevant commit messages; when an
entry ships in a writeup, note where.*
