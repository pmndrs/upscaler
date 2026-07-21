# FSR 3.1.5 Parity Decisions

This is the concise decision record for the (concluded) parity experiment program.
Raw evidence remains under `bench/results/raw/`; the post-parity adoptions that came
out of these decisions are recorded with evidence in [NEXT-STEPS.md](NEXT-STEPS.md).

Program facts: pinned FidelityFX SDK source `60f4ea81909200d8542eca14dccb2628b763a9a3`
(FSR Upscaler 3.1.5); local baseline commit `5d6a65e` on `feat-match-fsr3`. The E00
benchmark harness is adopted as a first-pass engineering tool: repeatable changes
≥5% are actionable, <3% is treated as noise, 3–5% is uncertain, and visual
regressions reject a candidate regardless of speed. (Publication-grade fine-margin
acceptance was deferred — long ABBA sequences showed monotonic timing drift on the
test machine that prevents claims near 1.5–2.5% noise limits.)

| Experiment | Candidate | Measured result | Recommendation | User decision | Action |
| --- | --- | --- | --- | --- | --- |
| E01 | FSR 3.1.5 lower limiter | Linear/HDR rerun: total compute median −0.62% (tie); sparse differences remained difficult to see without a heatmap. | Adopt: parity improves without a demonstrated total-cost or quality regression. | Adopt source behavior — 2026-07-17. | Integrated and GPU-verified in the production RCAS shader. |
| E01 | Source denoise luma and center-inclusive range | Linear/HDR rerun found no stable total-compute cost. Corrects green-only luma and the center-excluded range. | Adopt the source math whenever RCAS denoise is enabled. | Adopt source behavior — 2026-07-17. | Integrated and GPU-verified in the production RCAS shader. |
| E01 | Enable temporal RCAS denoise by default | Linear/HDR Q0/Q1 captures changed contrast edges by RMSE 0.55–0.60/255 with maxima 17–33/255; total compute median +2.87% (tie). | Test representative noisy temporal inputs before changing the default; this remains quality policy rather than math-only parity. | Pending explicit default-policy decision. | Keep current opt-in default until the noisy-input review. |
| E03 | Remove internal ACES/sRGB presentation | All output paths now write caller-domain `rgba16float`; temporal, spatial, bilinear, and depth-debug paths compiled and rendered on WebGPU. | Adopt unconditionally: FSR must not own tone mapping or output encoding. | Must remove — 2026-07-17. | Integrated. Bench/examples apply renderer presentation after the upscaler. |
| E05–E07, E15 | `source-filter-bundle-v1` | GPU-validated + measured 2026-07-18 (after 2 compile fixes): **+35–36% total compute** vs production at ratio 2 (accumulate +47%; exposure/RCAS tied; noise floor ≤1.7%). Q0/Q1/Q3 captures artifact-free; steady-state diff vs production grows to RMSE ~10/255. | Do not adopt wholesale — the source reconstruction/history filtering costs ~⅓ more compute with no demonstrated visual win on the bench scenes. Cherry-pick pieces (exposure-domain correction, AMD depth-separation constant) individually. | Pending. | Candidate GPU-verified and benchmarked; production unchanged. |
| E04, E08–E10 | `source-structural-bundle-v1` | GPU-validated + measured 2026-07-18: **+6.2–6.9% over the filter bundle** (prepareInputs +30%, depthClip +22%, accumulate/RCAS tied; noise floor ≤2%). Output near-identical to filter bundle (its prepared accumulation/newLocks outputs are currently unconsumed). | Cheap increment, but mostly inert until a consumer exists; evaluate only together with the resolver or after wiring its prepared state into an accumulate path. | Pending. | Candidate GPU-verified and benchmarked; production unchanged. |
| E11–E14 | `source-spd-resolver-bundle-v1` | GPU-validated + measured 2026-07-18 (after 3 compile/validation fixes + a `/0.5`→`/20.0` velocity-normalization correction): **+75–78% total compute** vs production (accumulate +38%; RCAS **−47%**, see note). Q0/Q1/Q3 artifact-free, no disocclusion trails; steady-state diff vs production RMSE ~4.6/255 — closer than the filter bundle's ~10/255. | Too expensive to adopt as-is. Two leads worth extracting: (1) why its history makes RCAS 47% cheaper (production history may contain value ranges that are ALU-hostile); (2) its coarse-mip shading detector is the long-planned SPD design, now GPU-proven (since landed in re-derived fused form — NEXT-STEPS item 4). | Pending. | Candidate GPU-verified and benchmarked; production unchanged. |

## E01 evidence

- Reproducible comparison: `npm run bench:compare:rcas`
- Verified linear/HDR report: `bench/results/raw/E01/rcas-comparison-linear-hdr/index.html`
- Reopen report:

  ```bash
  npm run bench:compare:rcas -- --reuse bench/results/raw/E01/rcas-comparison-linear-hdr
  ```

## Candidate-bundle evidence (2026-07-18)

Timing (ratio 2, 1920×1080 display, Apple Metal-3, headless Chrome 150, ABBA blocks,
240 warmup + 300 samples per run, `--smoke`):

| Comparison | compute-sum A → B | Δ per block | Verdict (≥5% actionable / <3% noise) |
| --- | --- | --- | --- |
| production → filter bundle | 0.627 → 0.852 ms | +35.2…+36.1% | Actionable regression |
| filter → structural bundle | 0.850 → 0.906 ms | +6.2…+6.9% | Actionable regression (small) |
| production → resolver bundle | 0.627 → 1.104 ms | +75.2…+77.6% | Actionable regression |

Per-pass: filter's cost is entirely `accumulate` (+47%); structural's is `prepareInputs`
(+30%) + `depthClip` (+22%) + the added `prepareReactivity` dispatch; the resolver adds
its SPD/instability passes and a heavier accumulate (+38%) while making `rcas` 47%
cheaper (input-content-dependent ALU — unexplained, worth investigation).

Quality (Q0/Q1/Q3 captures, 168 blinded pairs per comparison, `review.html` in each
capture directory under `bench/results/raw/CANDIDATES/`): no artifacts, ghost trails, or
convergence failures spotted in any bundle; differences are sub-4% RMSE distributed over
edges/grid detail. Blinded human review remains open before any adoption decision.

Five defects were fixed before the bundles would compile/run at all (they had never
touched a GPU): WGSL has no `isInf()`; `external` is a reserved keyword; `r8unorm` is
not a core storage-texture format (3 shaders + 4 allocations → `r32float`); the resolver
accumulate declared an unused sampler binding (auto-layout drops it → bind-group failure);
and its history velocity falloff used `/0.5` where every sibling uses `/20.0`.
Reproduce: `node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 --warmup 240 --samples 300 --variant <A> --comparison <B>`.
