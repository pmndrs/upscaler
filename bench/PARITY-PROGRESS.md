# FSR 3.1.5 Parity Progress

## Program Purpose

This ledger tracks controlled experiments that compare the local WebGPU upscaler with FidelityFX FSR 3.1.5. Source behavior is the design target; a local simplification is retained only when evidence shows that parity is unavailable, materially slower, or worse for this library on the web platform.

- Pinned FidelityFX SDK source: `60f4ea81909200d8542eca14dccb2628b763a9a3`
- Initial local baseline: `5d6a65e5681e5e95590f3e9a11ce75e43354ca13` (`5d6a65e`)
- Baseline branch: `feat-match-fsr3`
- Baseline unit result: `npm test` passed `54/54`

## Experiment State Machine

Only the controller changes experiment state:

`declared → implementing → static verification → GPU verification → task review → decision → documented`

An experiment may move backward only to `implementing` for a consolidated fix round. A terminal blocker is recorded without pretending that later gates passed. Dependent experiments begin only from an adopted and documented integration state.

## Strict Status Contract

Every implementation or review handoff must use exactly one status:

- `PASS`: the assigned scope is complete and every required gate available to that task passed.
- `FAIL`: the task ran, but an implementation, verification, or evidence gate failed.
- `BLOCKED`: the assigned scope cannot proceed because of an external, environment, capability, or dependency blocker.
- `SCOPE_BLOCKED`: completion requires a write, redesign, or investigation outside the immutable manifest.
- `USER_DECISION_REQUIRED`: evidence exposes a product, API, quality, performance, or scope trade-off that only the user may decide.

A report must also include `changed_files`, `commands`, `artifacts`, `gates`, and `concerns`. `PASS` is invalid if required evidence or gate results are absent. Agents must not reinterpret a blocker as permission to broaden scope.

## Blocker Taxonomy

- `scope`: a required file or change is outside the exact allowlist; report `SCOPE_BLOCKED`.
- `dependency`: a prerequisite experiment is not adopted and documented; report `BLOCKED`.
- `tooling`: a command, browser, or local tool fails independently of the implementation; retry once, then report `BLOCKED`.
- `capability`: required WebGPU features, especially `timestamp-query`, are unavailable; report `BLOCKED` and preserve environment evidence.
- `validation`: WGSL compilation, WebGPU validation, uncaught runtime errors, device loss, or static verification fails; report `FAIL`.
- `evidence`: required captures, fresh timing samples, adapter metadata, or review records cannot be produced; report `BLOCKED`.
- `product-decision`: valid evidence leaves a public API, default, or quality/performance trade-off unresolved; report `USER_DECISION_REQUIRED`.

The controller may assign one bounded read-only investigation for a blocker. That investigation cannot modify integration state, expand an allowlist, or redesign the experiment.

## Fix-Round Limit

Each experiment allows at most two consolidated fix rounds after its initial implementation. A round addresses one controller-approved batch of critical or important findings. After round two, the controller must redesign the manifest, retain the baseline, record a blocker, or escalate to the user.

## Documentation Ownership

- The controller owns this ledger, immutable manifests, state transitions, decisions, and cross-experiment dependencies.
- Concise measured results, recommendations, user votes, and resulting actions are tracked in `bench/PARITY-DECISIONS.md`.
- Implementers own only files explicitly listed in their manifest and may not edit manifests or this ledger.
- Reviewers and research agents are read-only unless a separate exact allowlist says otherwise.
- Implementation agents whose exact allowlists share any path are serialized. The controller must finish or stop the active writer before starting another overlapping writer.
- Parallel work is limited to independent, read-only research, review, or artifact analysis with no shared mutable state.
- The controller updates `src/shaders/README.md` only after an experiment decision and updates public documentation only for shipped behavior.
- Raw captures and timing artifacts follow `bench/results/README.md` once the harness creates it; manifests remain versioned records.
- No agent may commit, branch, create a worktree, or add files to an allowlist without explicit controller authorization.

## Experiment Index

| ID | Experiment | State | Fix rounds | Manifest | Decision |
| --- | --- | ---: | ---: | --- | --- |
| E00 | Harness Foundation | `adopted` | 2 of 2 — maximum reached; controller redesign 4 | `bench/results/experiments/e00-harness.json` | Directional baseline established; publication-grade acceptance deferred |
| E01 | RCAS numeric parity | `documented` | 0 of 2 | Directional first pass | Source limiter and denoise math adopted; denoise default remains separate |
| E03 | Linear/HDR output domain | `documented` | 0 of 2 | Directional integration | Internal ACES/sRGB removed by user decision |
| E04–E07, E15 | Source reconstruction/filter bundle | `GPU verification + measured` | 1 of 2 | Cumulative authored candidate | +35–36% compute vs production; visually clean; not adopted (see PARITY-DECISIONS.md) |
| E08–E10 | Structural inputs/reactivity bundle | `GPU verification + measured` | 1 of 2 | Cumulative authored candidate | +6.2–6.9% over filter bundle; largely inert outputs; not adopted |
| E11–E14 | SPD temporal resolver/state bundle | `GPU verification + measured` | 1 of 2 | Cumulative authored candidate | +75–78% compute vs production; visually clean; not adopted; RCAS −47% anomaly worth study |

E00 covers only the deterministic Phase 1 benchmark foundation and baseline-versus-baseline acceptance machinery. It does not authorize parity shader algorithm changes. Fix rounds 1 and 2 were controller-authorized pre-harness contract corrections; no harness implementation had begun when they were issued. Controller redesign 1 froze the readiness reset contract against installed three `0.185.1`. Controller redesign 2 closed the post-implementation acceptance boundary: immutable A/B roles, exact reviewer-record coverage, noise-first retry classification, fixed timing-pass identities, unique timing sequences, and explicit page teardown. Controller redesign 3 corrected two acceptance-analysis defects exposed by authoritative execution: E00 aggregate timing acceptance uses the compute-sum noise floor while noisy passes are ineligible for individual claims, and E00 visual acceptance uses a representative Q0/Q1/Q10 matrix instead of pre-running the full domain-experiment Cartesian product. Every selected tuple still receives all 45 numerical reload comparisons; human review samples 120 blinded pairs and records all declared ROI bounds. Controller redesign 4 followed the fresh task review: run and review evidence is now bound to one manifest plus complete working-tree digest, review persistence includes the evidence and ordered-record identity, review-only validates the authoritative numerical capture before accepting grades, and user-owned CDP targets are closed and awaited.

The earlier timing and capture artifacts passed their numerical gates but were produced under superseded manifest digests and cannot close E00. They remain diagnostic evidence only. Revision 4 static verification passed with lint, typecheck, 83 tests, build, runner syntax, and diff whitespace. Q2-Q9 reduced WebGPU smokes passed, as did the user-owned CDP target-cleanup smoke.

Revision 4 authoritative timing is blocked at ratio 1 after its one permitted cold-browser retry: a concentrated GPU slowdown affected roughly 100 frames in one 600-frame block, producing compute-sum p95 noise near 50 percent. The bound authoritative capture completed all 264 tuples and 11,880 pairs but failed 61 pairs across five localized Q0 tuples; differences cluster on the moving torus-knot highlight and one derived accumulation-age region. Two focused five-reload reruns of the failed tuples passed, confirming intermittence but not authorizing replacement of the complete failed set.

A clean-boot revision 4 timing rerun reproduced monotonic drift across the long ABBA sequence: endpoint A runs rose from roughly 0.78 ms to 0.96–1.08 ms while adjacent B runs stayed closer. This prevents publication-grade claims near the strict 1.5–2.5 percent noise limits, but does not prevent the harness from identifying substantial directional shader changes. Per user direction, E00 is adopted as a first-pass engineering tool: repeatable changes of at least 5 percent are actionable, changes below 3 percent are treated as tied/noise, and 3–5 percent remains uncertain. Visual regressions still reject candidates regardless of speed. Formal cross-platform and fine-margin acceptance is deferred until a candidate survives the shader-parity program.

E01's first pass compiled the FSR 3.1.5 lower limiter and source denoise luma/range as an isolated RCAS shader. The user adopted both math changes on 2026-07-17. They are now in the production RCAS pipeline; the prior implementation remains benchmark-only. A fresh linear/HDR rerun kept total compute within the practical noise band and retained only sparse lower-limiter differences. Enabling source denoise by default also remained within noise but changed high-contrast detail across the frame: Q0/Q1 RMSE was about 0.55–0.60/255 with maxima of 17–33/255. Denoise therefore stays opt-in until a targeted noisy-input fixture shows that the broad sharpening reduction is beneficial.

`npm run bench:compare:rcas` reproduces the focused comparison end to end, generates short directional timing summaries plus blinded visual reviews, serves the report locally, and opens it in the default browser. The current reference is `bench/results/raw/E01/rcas-comparison-linear-hdr/index.html`; reopen it without GPU work using `npm run bench:compare:rcas -- --reuse bench/results/raw/E01/rcas-comparison-linear-hdr`.

E03 removed the internal Narkowicz ACES approximation and sRGB encoding from EASU, RCAS, and blit. Final and debug output now use `rgba16float`, and the public texture remains in the caller's linear/HDR domain. The benchmark and examples choose three's ACES filmic tone mapping plus sRGB only when presenting to screen. Static verification passed lint, typecheck, 86 tests, build, and diff whitespace. Real WebGPU verification rendered temporal, spatial, bilinear, and depth-debug paths without validation failure.

## Authored source-style candidates

Three cumulative internal candidates are now authored for later A/B work. This is
implementation state only: no benchmark, browser GPU validation, visual review, timing
claim, or adoption decision has been made.

See `bench/PARITY-CANDIDATES.md` for the candidate hypotheses, cumulative dependencies,
fallbacks, and the performance-first test matrix required before any adoption decision.

- `source-filter-bundle-v1` replaces current/history reconstruction, EASU implementation
  math, and fused depth reconstruction with source-style radial approximate Lanczos2,
  bicubic Lanczos history, approximate EASU helpers, atomic reconstructed-depth scatter,
  and viewport/depth-scaled disocclusion. It also corrects history across changing
  conditioning and host pre-exposure domains while retaining the local accumulation state.
- `source-structural-bundle-v1` cumulatively adds configurable source reactive generation,
  farthest depth/current luma preparation, motion divergence, max-dilated application
  reactivity with reset coupling, a distinct softer T&C channel, render-resolution
  accumulation state, and atomic new-lock preparation.
- `source-spd-resolver-bundle-v1` cumulatively adds luma and signed-difference mip chains,
  multi-mip shading change, persistent four-frame luma instability, and one coordinated
  source-style accumulation/rectification/lock/state model. History alpha stores lock
  lifetime in this candidate and is not compatible with the production sample-age alpha.

The production graph remains the fallback and default. RCAS keeps the adopted source
limiter/math, linear/HDR output remains unchanged, and temporal RCAS denoise remains
opt-in. Candidate timing labels and shader/resource identities are registered, but should
not be interpreted as measured evidence until the later benchmark program runs.

The bounded GPU-free verification pass completed with 156 tests, typecheck, lint, and the
library/declaration build passing. This advances the authored candidates only to static
verification; WebGPU compilation, validation, captures, timings, review, and adoption
remain pending.
