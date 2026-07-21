# Post-parity work plan (2026-07-21)

Outcome of the parity program: no candidate bundle adopted (see
[PARITY-DECISIONS.md](PARITY-DECISIONS.md) and the consumer-facing
[/PARITY.md](../../PARITY.md)). Four items survive as adoption-worthy. Ordered by
value-per-risk; each is a self-contained session with its own GPU verification.

Every item follows the same gate: `npm test && npm run typecheck && npm run lint`,
then an A/B timing + capture run
(`node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 --warmup 240 --samples 300 --variant <A> --comparison <B>`,
plus `--mode capture --scenarios Q0,Q1,Q3 --reloads 1 --allow-differences --review-all`).
≥5% repeatable = actionable, <3% = noise; any visual regression rejects.

## 1. RCAS input-range investigation (potential free ~2× RCAS)

Measured fact: RCAS ran 47% cheaper consuming the resolver candidate's history than
production's (0.105 → 0.056 ms, repeatable, noise ≤1%). Hypothesis: production
accumulate emits ALU-hostile values (denormals/extremes, plausibly from the exposure
divide-back or the invertible-tonemap inversion).

- Dump/histogram production vs resolver history texels on an identical frame (small
  CDP harness or a debug view) to find the range difference.
- If confirmed, add a cheap clamp/flush at the end of `accumulate.ts` (or fix the
  divide-back ordering) and A/B `rcas` per-pass time: production vs patched production.
- Files: `src/shaders/accumulate.ts`, possibly `src/shaders/rcas.ts`.
- Risk: low — a clamp cannot regress correctness if bounds are chosen above the
  invertible-tonemap output range.

## 2. Host pre-exposure correction (correctness for HDR apps)

`DispatchInputs.preExposureTexture` exists but production ignores it. Port the
candidate's `DeltaPreExposure()` semantics: track previous/current host pre-exposure,
ratio-correct reprojected history into the current domain before blending, keep host
pre-exposure in the output (unlike conditioning exposure, which is divided out).

- Source: the exposure/host handling in `src/shaders/candidateTemporal.ts` (exposure
  pass) and its accumulate-side history correction — measured ~free there.
- Wire into production `luminancePyramid.ts` (1×1 frame-info texel already exists) and
  `accumulate.ts`; thread the dispatch input through `Upscaler.dispatch`.
- Validate with the Q9 exposure-transition scenario: step + ramp host pre-exposure and
  confirm no pumping/trails, and that output brightness is unchanged for
  pre-exposure = 1.
- Risk: medium — touches the accumulate blend; keep behind a flag until Q9 passes.

## 3. AMD disocclusion constant in the fused reconstruct pass

Replace the guessed `DEPTH_SEPARATION_SCALE` / `DEPTH_SIMILARITY_FLOOR` in
`src/shaders/reconstruct.ts` with AMD's viewport/depth-scaled formulation
(`1.37e-05 * halfViewportWidth * maxDepth` shape — implemented in
`src/shaders/candidateInputs.ts`, depth-clip section). Keep the fused single-pass
structure (measured faster than the source's scatter + separate pass).

- Validate with Q3 (object-motion disocclusion) captures + the Disocclusion debug
  view: thin stable silhouette outlines, no full-frame flashing, accumulation-age
  resets confined to trails.
- Risk: low-medium — threshold semantics change; the debug views make regressions
  obvious.

## 4. Phase-5 SPD session: coarse-mip shading-change detector

The roadmap item in [/CLAUDE.md](../../CLAUDE.md) ("True SPD luminance mip chain +
shading-change coarse mip"). Start from the GPU-proven candidate implementation —
`SHADING_CHANGE_SPD` + 3-mip resolve in `src/shaders/candidateTemporal.ts` — not from
scratch. Extract the detector alone; do **not** bring the surrounding resolver (+76%
measured).

- Known perf issues to fix on extraction (from the code audit): hoist the per-tap
  1×1 `frameInfo` reloads out of the reduction loops; drop the write-only luma-pyramid
  mips unless a consumer lands.
- Wire its output into the existing `FLAG_SHADING_CHANGE` aging path in
  `accumulate.ts`, replacing the 3×3-neighborhood mean; keep the lock-suppression
  behavior exactly (locks must NOT break on shading change — regression documented in
  CLAUDE.md).
- Validate: `DebugView.ShadingChange` black on a still scene, lights up under an
  animated light; high-frequency content under heavy motion should show fewer false
  positives than production (this is the whole point — capture both).
- Risk: highest of the four — dedicated session with GPU tuning time, per the roadmap.

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.
- T&C as a distinct softer channel — revisit only on user demand with real content.
