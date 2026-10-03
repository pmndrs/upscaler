# Paper notes — findings worth writing up

A running tracker of results from this project that are novel or non-obvious
enough to publish (blog series, talk, or a short paper). Each entry: the
claim, where the evidence lives, and what a publication-grade version still
needs. Add to this file whenever a finding clears the bar: *it surprised us,
we measured it, and someone else would hit it too.* Open gaps are tracked as
work in [issue #10](https://github.com/pmndrs/upscaler/issues/10).

Consumer-facing prose for several of these already exists in
[PARITY.md](PARITY.md); this file tracks them *as paper material* — evidence
pointers and gaps, not exposition.

**Raw evidence is local-only.** Everything under `bench/results/raw/` (capture
pairs, timing runs, convergence and alpha-convergence artifacts) is
gitignored — see [`bench/results/.gitignore`](../../bench/results/.gitignore).
Pointers into it below name what a run produced, not files a fresh clone has;
regenerate with the command given next to each pointer. The tracked evidence
is the source, the measurement scripts, and the write-ups in
[`bench/docs/`](../../bench/docs/).

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

**Evidence:** [`src/shaders/shadingChange.ts`](../../src/shaders/shadingChange.ts)
(inline comments record the measured floors); five GPU tuning iterations in
[`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md) (item 4);
[PARITY.md](PARITY.md) enhancement 3. Measured on Q1/Q4/Q9/Q11.

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

**Evidence:** commit `b16274a`; [`src/shaders/reconstruct.ts`](../../src/shaders/reconstruct.ts)
(inline); [PARITY.md](PARITY.md) enhancement 1 ("the price of skipping the
scatter"); flicker metrology in the commit message (example-12 disocclusion
quadrant, before/after); `bench/results/raw/GUIDES-M1/capture-depthfix`
(local-only — regenerate by capturing `examples/12-temporal-guides`'
disocclusion quadrant on a grazing plane).

**Still needs:** an A/B against the true scatter form (the structural
candidate bundle still implements it) on the same grazing-plane scene —
does the repaired gather match the scatter's mask exactly, or only its
stability? Cross-vendor timing for the cost claim.

**Amended 2026-07-24:** repair (a) was itself insufficient — skipping
agreement taps leaves lone straddling taps as the only voters, which
re-disoccludes every *still* silhouette per jitter phase (the previous
dilated-depth field's boundary is texel-quantized, so one bilinear tap
routinely reads the old occluder). The complete repair is (a′): every valid
tap votes, agreement = full confidence, and the **best tap wins** (max
aggregation) — "any tap that recognizes the current surface means same
surface." Genuine trails keep reading ~1 (all taps on the old occluder).
Evidence: NEXT-STEPS §5, Q1 phase-locked churn + Q12 disocclusion-black.

## 6. EMA temporal AA cannot converge if rectification writes back

**Claim:** In a bounded-memory (EMA) temporal accumulator with per-frame
neighborhood rectification, still-scene convergence is impossible whenever
(i) history age is reduced as a function of clip magnitude, or (ii) the
*clipped* history is what gets stored — because the variance box is built
from ONE jitter phase's taps, and on high-frequency content the converged
supersampled mean falls outside some phases' boxes. (i) pins equilibrium
age low (alpha never shrinks); (ii) re-snaps the stored history to each
phase's box regardless of alpha. Measured signature that separates the two
from benign per-phase shimmer: the **same-jitter-phase frame diff** one
period apart (0.182 with both defects, 0.183 with only (ii), 0.005 with
rectification off). The fix that keeps anti-ghosting: gate box width on
stillness × convergence × absence of disocclusion/shading-change/reactivity
signals — rectify fully the moment any signal fires (FSR2's lock relaxation
generalized from thin features to everywhere). Shipped ×9 box width
(`STILL_CLAMP_RELAX = 8` added to the unit box): 0.018 phase-locked, motion
scenarios unchanged.

**Evidence:** [`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md) §5
(full measurement ladder); [`scripts/measure-convergence.mjs`](../../scripts/measure-convergence.mjs)
(the phase-locked metric); `bench/results/raw/convergence/*` (local-only —
regenerate with `node scripts/measure-convergence.mjs --scenario Q1 --ratio 2`
and `--scenario Q12`); consumer cross-validation in
[`GUIDES-HANDOFF-RESPONSE.md`](../archive/temporal-guides/GUIDES-HANDOFF-RESPONSE.md)
report 3 (independent repro + their converging α=1/N counter-example).
Cornell + IGN-dithered Vogel shadow (screen-anchored dither = adversarially
unstable input luminance): 0.024 consecutive.

**Still needs:** a formal fixed-point argument (under what box statistics is
the converged mean a fixed point of clip∘blend?); comparison against FSR2's
actual still behavior on the same scene; sensitivity of the ghosting
trade-off to the relax factor on a scene with sub-detector lighting drift
([#5](https://github.com/pmndrs/upscaler/issues/5)) — measured since, see
entry 7.

**Amended 2026-10-02 (alpha passthrough, PR #18):** defect (ii) is not
specific to color — it applies to *every* channel rectified against a
per-phase neighborhood, including coverage. The first alpha resolve clamped
history to the current phase's 3×3 alpha range on the reasoning that a
coverage edge's jittered taps span 0..1, so the box stays wide. That holds
for edges but not for features thinner than a render texel: some phases see
an all-0 (or all-1) 3×3 and re-snap converged coverage every cycle. Measured
on `examples/15-transparent-canvas` (sub-texel wires over a zero-alpha
background, frozen + still; output texture read back exactly): at ratio 3,
alpha temporal std 7.42 (hard clamp) → 6.93 (color's still-relax applied to
the alpha clamp, shipped) → 5.71 (no clamp, the floor); at ratio 2 the relax
reaches the floor (2.99 vs 2.96). Same-jitter-phase |Δα| ≤ 0.003 in every
run, so what remains is the benign per-phase orbit, not churn. Two further
surprises: the alpha-specific share is a *minority* of the wire shimmer —
color's relative flicker is 1.4–2× alpha's, and turning the shading-change
detector off roughly halves alpha churn at ratio 2, because the detector
fires in render-space blocks along full-contrast sub-texel geometry and ages
color and alpha together; and the relax cannot close the ratio-3 gap because
it requires converged history, which those detector firings keep resetting.
Folded in here rather than as a new entry: the mechanism is (ii), and the
new result is its generality.
Evidence: NEXT-STEPS §6 ("Alpha still-scene convergence"); commit
`24f2415`; [`scripts/measure-alpha-convergence.mjs`](../../scripts/measure-alpha-convergence.mjs);
`bench/results/raw/alpha-convergence/` (local-only — regenerate with
`node scripts/measure-alpha-convergence.mjs --ratio 3`, adding
`--settings '{"detectShadingChanges":false}'` for the detector-off rows).
Still needs: the detector's false positives on sub-texel geometry over an
empty background characterized on their own (a shading-change floor problem,
not an alpha one); the same measurement on a second device.

## 7. The still-scene relax costs drift lag in a step, not a slope

**Claim:** widening the rectification box on still, converged, signal-free
pixels (entry 6's fix, ×(1 + R)) has a price under lighting drift too slow for
a 1-frame shading detector. That price arrives almost entirely with the
*first* useful widening. On a still camera with the sun ramping exponentially
at ~2 %/frame (half the detector's flattest floor, verified silent), the output
lags a held-light reference by these amounts with auto-exposure off:
- R = 0: 5.3 frames;
- R = 4: 9.6 frames (+80 %);
- R = 8 (shipped): 10.5 frames (+10 % more);
- R = 16: 11.1 frames (+5 % more).

Meanwhile, still-scene same-jitter-phase churn keeps falling about 40 % per
doubling (Q1: 0.178 → 0.044 → 0.027 → 0.016).

The mechanism: once the box is a few σ wide it already contains the
per-frame drift on every pixel with real 3×3 variance (texture, edges,
specular), so further widening has nothing left to release. Flat pixels
(σ ≈ 0) stay clamped at any R. The consequence: R is a convergence knob, and
the drift trade-off cannot be tuned out through it. If the lag matters, it
needs a *cumulative* slow-drift gate on the relax, not a smaller R. The lag
reads as a uniform delayed fade, not a spatial ghost: signed error ≈ absolute
error, about 175 ms at 60 fps on R = 8.

**Methods note others would hit:** an auto-exposure that adapts without
re-conditioning history (stored history is re-decoded under the new
exposure) masks 30–45 % of the measured lag on a down-ramp. Measure the clip
with adaptation off, and report both.

**Evidence:** [`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md) §8
(the full relax {0, 4, 8, 16} table, Q9 alongside); scenario **Q15**
`sub-detector-lighting-drift` in
[`bench/src/benchmark/scenarios.ts`](../../bench/src/benchmark/scenarios.ts);
[`scripts/measure-drift-lag.mjs`](../../scripts/measure-drift-lag.mjs) (the
held-light reference + lag-in-frames metric).
`bench/results/raw/drift-lag/*` and `bench/results/raw/convergence/relax*` are
local-only. To regenerate them, edit `STILL_CLAMP_RELAX` in
`src/shaders/accumulate.ts` for each value, then run:
- `node scripts/measure-drift-lag.mjs --scenario Q15 --frames 116:379:2 --label relax<R>-noae --settings '{"autoExposure":false}'`
- the same command without `--settings`, for the auto-exposure-on column;
- `node scripts/measure-convergence.mjs --scenario Q1 --ratio 2 --pairs 40 --label relax<R>` (and `--scenario Q12`).

**Still needs:**
- a second device and ratios other than 2;
- ramp rates closer to the detector floor (the lag scales with rate);
- a multi-pair same-phase metric (the convergence column is one pair);
- a prototype of the slow-drift gate, to show the step can be removed rather
  than traded;
- a small analytic model: box width in σ against per-frame drift in σ, giving
  the R at which the clip stops engaging.

## 8. A contrast-adaptive change gate must read both frames' spread

**Claim:** a temporal change detector that compares two block means
(`1 − min/max`) and widens its noise floor by the block's coefficient of
variation has a hidden one-sided failure if `cv` comes from the current frame
only. Under sub-pixel jitter, a feature thinner than a texel is point-sampled
in or out of a block per phase:
- **The feature appears:** the current block is sparse, `cv` is high, and the
  gate holds.
- **The feature vanishes:** the current block has no spread (`cv = 0`), the
  previous block had the feature, and `relative = 1`. The gate fires at full
  strength.

The detector therefore fires exactly when content *leaves* a block. Pooling the
within-block spread of both frames over their joint mean, while keeping the
between-frame shift out of it, closes the hole at no measurable cost to genuine
lighting steps.

The surprise was the reach. The "baseline" still-scene speckle we had accepted
as inherent since the detector shipped (Q1 0.43 % of the frame, Q12 1.2 %) and
most of its camera-motion false positives (Q4 0.47–0.73 %) were the same
artefact. They fall to 0.02–0.06 %. Q9's light steps keep their response within
2 %.

Two tempting variants were worse:
- `max(cv_cur, cv_prev)` is invariant to multiplicative lighting, yet it left
  residue and lost 7 % on a step;
- a bilinear-tap second moment was quieter on sparse geometry, but cost 3–4 %
  on steps.

**Methods note others would hit:** the fix moved a still-scene churn metric
by 3–24 %, while the debug-view coverage moved 20–70×. The aging was spread
thin. On sparse geometry, judge a detector by its own coverage, not by output
churn alone. Also, a debug view presented untone-mapped is still sRGB-encoded:
threshold the decoded value, not the byte.

**Evidence:** [`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md) §9
(still-scene, genuine-step, drift-lag and alpha tables, rejected variants, the
ratio-3 alignment check); scenario **Q16** `sparse-wires-empty-background` in
[`bench/src/benchmark/scenarios.ts`](../../bench/src/benchmark/scenarios.ts);
[`src/shaders/shadingChange.ts`](../../src/shaders/shadingChange.ts)
(`scaleResponse`). `bench/results/raw/convergence/*`, `drift-lag/*` and
`alpha-convergence/*` are local-only. To regenerate them, for the code before and
after the change, run:
- `node scripts/measure-convergence.mjs --scenario <Q1|Q12|Q16> --ratio <2|3> --pairs <40|73> --shading-frames 32`;
- `node scripts/measure-convergence.mjs --scenario Q9 --settle 56 --shading-frames 32 --pairs 1` (step windows);
- `node scripts/measure-alpha-convergence.mjs --ratio <2|3>`.

**Still needs:**
- a minimal synthetic reproduction (a sub-texel line over black, jittered
  point sampling) with the analytic cv for each case;
- a second device;
- a look at whether FSR 3.1.5's signed-difference pyramid has the same
  asymmetry.

## 9. A variance clip whose epsilon guards the wrong side switches TAA off on achromatic pixels

**Claim:** the common ray form of AABB clipping, `t = min(1, min_i(extent_i /
max(|dir_i|, ε)))`, silently disables temporal accumulation wherever one box
axis has zero extent *and* the history sits exactly on the centre along it.
In YCoCg that is Co/Cg on any exactly achromatic 3×3 — black or empty
backgrounds, white-on-black content, greyscale materials under white light:
0/ε = 0 gives `t = 0`, so history is snapped to the box mean every frame
however wide the luma box is. The output there is the current frame's 3×3
average: no TAA, no reconstruction, and the per-phase jitter pattern shows
through. Playdead's original puts ε on the extents (`v / (e + ε)`), which
leaves a degenerate axis unconstrained; ours had it on the other side. No
chromatic test scene exposes it, which is why it survived every earlier
scenario here.

Measured on Q17 (auto-exposure off): a 1.5 render-px white disc over black,
sampled on every phase, flickered at 0.19 (temporal std / energy) against a
clip-free accumulator's 0.01; with ε on the extents, 0.02. Sub-pixel emitters
over black showed the raw input's on/off flicker (0.3 px: 1.97). The lighting
and convergence reference metrics (Q1, Q12, Q9, Q15) move by under 0.1 %.

The follow-on finding is the more general point: once the clip works on
achromatic pixels, a sub-texel emitter **fades** there, as it already did over
texture, because a miss phase's neighbourhood has σ = 0 and every protection
built as a σ multiplier (locks, still-scene relax) is inert. Three mechanisms
erase it independently: the clip, cross-frame-gather disocclusion and the
block-mean shading detector. An additive miss-phase hold that fixes it is a
switch-off ghost by construction, since a miss and a switch-off are identical
on the frame they happen.

**Evidence:** [`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md) §11 (the
attribution table, the clip-fix and hold-candidate tables, regressions);
scenario **Q17** `subpixel-emitter-retention` in
[`bench/src/benchmark/scenarios.ts`](../../bench/src/benchmark/scenarios.ts);
[`scripts/measure-emitter-retention.mjs`](../../scripts/measure-emitter-retention.mjs)
(output-vs-input-coverage energy, switch-off ghost).
`bench/results/raw/emitters/*` is local-only. Regenerate with
`node scripts/measure-emitter-retention.mjs --label <name> --settings '{"autoExposure":false}'`;
for the before column, set `clipToAABB` in `src/shaders/accumulate.ts` back to
`extents / max(abs(dir), vec3f(1.0e-6))`.

**Still needs:**
- a survey of public TAA/TAAU implementations for the same ε placement;
- a greyscale *lit* scene (white materials, white lights) to show the effect
  beyond black backgrounds;
- the hold re-measured once the disocclusion (#54) and shading-change (#22)
  false positives are gone, to separate what is inherent from what is
  pipeline-specific;
- a second device and ratios other than 2.

## 3. Source-faithful pass graphs measured against fused re-derivations

**Claim:** porting FSR 3.1.5's pass graph faithfully to WebGPU costs
+36% / +43% / +76% GPU compute (filter / structural / SPD-resolver bundles,
cumulative vs production; structural was measured as +6.5% on top of filter)
over a fused re-derivation with no measurable visual win on torture scenes —
because the source graph's structure pays for generality (intermediate
textures, atomic scatters, SPD mip chains) that a renderer-integrated
upscaler can fuse away. Includes the negative results: which upstream
behaviors *were* worth adopting (conditioned-space RCAS −34%, AMD's
disocclusion tolerance, DeltaPreExposure) and which were not.

**Evidence:** the whole parity program —
[`bench/docs/PARITY-DECISIONS.md`](../../bench/docs/PARITY-DECISIONS.md),
[`bench/docs/PARITY-CANDIDATES.md`](../../bench/docs/PARITY-CANDIDATES.md),
[`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md),
[PARITY.md](PARITY.md). Candidate bundles remain runnable
(`node scripts/run-benchmark.mjs --smoke --variant <A> --comparison <B>`).

**Still needs:** cross-device timings (all numbers are one Apple Metal
adapter family); blinded-review grading of the capture pairs. The original
168 pairs per comparison lived under `bench/results/raw/CANDIDATES/`, which
is gitignored — they were never committed and must be **regenerated** before
grading: `node scripts/run-benchmark.mjs --mode capture --smoke --scenarios
Q0,Q1,Q3 --variant rcas-fsr315-limiter --comparison source-filter-bundle-v1`
(and likewise for `source-structural-bundle-v1` /
`source-spd-resolver-bundle-v1`; `rcas-fsr315-limiter` is production with the
per-tap RCAS the bundles also run, the original pairing); each capture
directory gets its own blinded `review.html`. A regenerated set compares against *today's* production —
which has since gained the 2026-07-24 convergence fix and alpha
passthrough — so it is a fresh experiment, not a re-grade of the 2026-07-18
captures.

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

**Result (M6, 2026-07-24):** the external consumer ran its identical SSGI
temporal stack fed by its own private guides pass vs this bundle (guides-only
path). Still-camera stability was **bit-identical** (both arms
1.3984197255291004 — at convergence disocclusion≈0 and velocity≈0 make the
blend independent of guide source); teleport reconvergence 1.275 s vs
1.288 s, inside one 500 ms sampling interval; across-arm meanAbsDiff 0.84,
below the 1.40 within-arm temporal noise. Their verdict: a drop-in
replacement for their private temporal front-end, which is now only the A/B
control. This closes the gap the entry was waiting on — it is now a measured
result, not a design essay. Note what it measures: *no loss* from sharing
the computation, not a quality gain over the private pass.

**Evidence:** the contract as shipped is the `TemporalGuides` type in
[`src/types.ts`](../../src/types.ts) plus `examples/12-temporal-guides`
(raw) and `examples/13-guides-node` (TSL); design history in
[`TEMPORAL-GUIDES-SPEC.md`](../archive/temporal-guides/TEMPORAL-GUIDES-SPEC.md)
(+ [`GUIDES-SPEC-RESPONSE.md`](../archive/temporal-guides/GUIDES-SPEC-RESPONSE.md),
the consumer-side review); implementation merged in PR #1; the M6 A/B is
consumer report 2 in
[`GUIDES-HANDOFF-RESPONSE.md`](../archive/temporal-guides/GUIDES-HANDOFF-RESPONSE.md)
(their demo 17; raw results live in the consumer's repo, not this one).

**Still needs:** the *cost* side of "one computation feeds all" — the ms a
consumer saves by dropping its private pass was not measured; a second
consumer class (denoiser or TAA) fed by the bundle, since M6 is one SSGI
stack; and independent mileage for the linked TSL surface, which is verified
at the package boundary (`scripts/verify-packed-guides.mjs`) but has no
external TSL consumer yet.

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
timing-post-wt; local-only); CLAUDE.md bench caveat;
[`TEMPORAL-GUIDES-SPEC.md`](../archive/temporal-guides/TEMPORAL-GUIDES-SPEC.md)
M1 notes.

**Addendum 2026-10-02 — frame stepping in a measurement harness.** Stepping
frames in a bare `for` loop never advances three's node frame, so the
`velocity` node keeps the camera's last move in every motion vector and
history never settles — a still-scene convergence measurement then reads
non-convergence that the library does not have. Step through
`renderer.setAnimationLoop` instead. Documented in
`scripts/measure-alpha-convergence.mjs` and NEXT-STEPS §6; anyone writing a
headless convergence meter against three's node system would hit it.

**Still needs:** nothing much — this is a workshop/appendix note, but worth
a paragraph wherever the timing methodology is described.

---

*Maintenance: link new entries from the relevant commit messages; when an
entry ships in a writeup, note where.*
