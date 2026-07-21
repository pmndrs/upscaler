# Post-parity work plan (2026-07-21)

Outcome of the parity program: no candidate bundle adopted (see
[PARITY-DECISIONS.md](PARITY-DECISIONS.md) and the consumer-facing
[/PARITY.md](../../PARITY.md)). Four items survived as adoption-worthy.
**Items 1–3 landed on 2026-07-21** (same-day session; evidence below). Item 4
remains open as its own dedicated session.

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

## 4. Phase-5 SPD session: coarse-mip shading-change detector — DONE

The roadmap item landed as `src/shaders/shadingChange.ts`: one fused half-resolution
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

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.
- T&C as a distinct softer channel — revisit only on user demand with real content.
- Conditioning-exposure history correction (beyond host pre-exposure): eased
  adaptation keeps the per-frame mismatch under the shading detector's threshold;
  correcting it changes output for every auto-exposure user. Revisit with evidence.
