# @pmndrs/upscaler vs FSR 3.1.5 — design notes

`@pmndrs/upscaler` derives from AMD FidelityFX FSR — FSR1's EASU/RCAS directly, and an
FSR2/3-style temporal resolver written for WebGPU compute. It is **not** byte-for-byte
FSR 3.1.5, and that is a deliberate, *measured* position, not an unfinished port. This
document explains where we match upstream, where we diverge, what we changed outright,
and the evidence behind each choice.

Reference: FidelityFX SDK commit `60f4ea8` (FSR Upscaler 3.1.5). The full per-pass audit
lives in [`packages/core/src/shaders/README.md`](../../packages/core/src/shaders/README.md); raw benchmark evidence in
`bench/results/`; the adoption record in
[`bench/docs/NEXT-STEPS.md`](../../bench/docs/NEXT-STEPS.md).

## The short version

We implemented the source-style pipeline — the full FSR 3.1.5 pass graph, including
Lanczos2 reconstruction, deringed bicubic history, atomic depth scatter, motion
divergence, SPD-style mip chains, luma instability, and the coordinated source resolver —
as three cumulative candidate graphs inside this repo, GPU-validated them, and A/B
benchmarked them against the production path on deterministic scenes. Those graphs are
now frozen as bench-owned snapshots under `bench/src/candidates/`; neither their WGSL nor
their orchestration is included in the published library.

**The source-style graphs cost +36% to +76% more GPU compute and produced no visible
quality improvement on our test scenarios.** The differences that exist are sub-4% RMSE
spread across edge detail, with no artifacts, ghosting, or convergence failures on either
side. On a library whose priority order is **performance > quality > realism**, that
result decides the question: the simplified production path ships; the source-parity
graphs remain in-repo only as frozen benchmark snapshots.

| Comparison (ratio 2, 1920×1080 display, Apple Metal, ABBA timing) | GPU compute | Δ |
| --- | --- | --- |
| production → source filter/reconstruction graph | 0.63 → 0.85 ms | **+36%** |
| … → + structural inputs/reactivity | 0.85 → 0.91 ms | **+6.5%** |
| production → full source SPD/resolver graph | 0.63 → 1.10 ms | **+76%** |

Every delta was repeatable across four interleaved A/B blocks with noise floors ≤ 2%.
Reproduce with:
`node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 --warmup 240 --samples 300 --variant rcas-fsr315-limiter --comparison <candidate>`.

The program then fed back: four upstream behaviors *were* worth having, and each was
adopted — but re-derived into cheaper forms rather than transplanted (next section).

## What we changed — enhancements beyond a port

These are the places where this implementation deliberately does something *different*
from FSR 3.1.5 and has measurements showing the difference is an improvement on this
platform. Each was validated on GPU with the deterministic capture harness (byte-level
RMSE gates) in addition to timing.

### 1. Depth reconstruction & disocclusion — the scatter, re-derived

**Upstream:** three stages — "reconstruct previous depth" (an atomic floating-point
scatter into a previous-depth buffer), "dilate depth & motion", and "depth clip"
(disocclusion), with intermediate textures between them. Core WebGPU has no
floating-point storage atomics, so the scatter must be emulated through `u32`
storage-buffer atomics.

**Ours (since 2026-10-05, issue #67):** two dispatches (`reconstruct.ts`). The first
dilates and scatters this frame's linear depth into each pixel's previous-position
footprint (`atomicMin` on the f32 bits, which order like the floats for positive
depths). The second is the depth clip with AMD's viewport/depth-scaled tolerance
(`1.37e-5 · halfViewportWidth · maxDepth`, per-bilinear-tap voting from
`ffx_fsr2_depth_clip.h`). Two re-derivations make it cheaper than upstream's three
stages: the scatter rides in the dilation pass, and the two scatter buffers ping-pong
so each depth-clip texel empties its own slot of next frame's buffer — no clear pass.
Two measured divergences from upstream's vote are kept from the earlier form: the
tolerance is widened by the 3×3 depth relief (grazing planes), and the best tap wins.

**Measured (issue #67, `bench/docs/NEXT-STEPS.md` §15):** the scatter costs ~0.012 ms
per frame at ratio 2 (+30 µs in a worktree, ~2% of upscaler compute). Nearly all of it
is the pass split itself; the atomics are close to free, and folding the clear into the
depth clip removed a 24 µs pass. In return:

- **Camera and object motion along the view axis cancel.** The fused cross-frame form
  this replaced compared this frame's depth with last frame's — two different cameras —
  so a dolly-out disoccluded 97% of a frontal wall, and any object receding from a still
  camera lost its history. Interior disocclusion on bench Q19: dolly-back 1.03% → 0.33%,
  scene receding under a still camera 1.31% → 0.24%.
- **Still scenes read exactly zero** (0.029% → 0.000%): the cross-frame form's sub-texel
  sampling residue is gone. Q1/Q12 convergence unchanged or slightly better.
- **Genuine reveals behind moving silhouettes are found.** Q3's rotating knots and
  Q19's lateral slide now get continuous trailing outlines; the cross-frame best-tap
  vote let ~1 px/frame reveals through (one tap always landed on the old background).
- **Sub-pixel floating emitters no longer false-disocclude** on jitter miss phases
  (issue #54: 7–34% of frames → 0%).

**Tolerance and vote, measured against upstream (#79).** Upstream's
`fHalfViewportWidth` is in fact `length(RenderSize())`, the full diagonal, multiplied by a
`Kfov` FOV factor, so our tolerance is ≈2.8× tighter than upstream's. Loosening it to
upstream's measured only 3–6% fewer disoccluded pixels in motion (it needs the FOV in the
constants buffer, so it waits for the next constants change). Upstream's weighted-mean
vote and `EvaluateSurface` surface check were also measured in place of our best-tap vote
and relief widening: they ring both sides of every moving silhouette, 2–8× the
disocclusion, so ours stay (`bench/docs/NEXT-STEPS.md` §15).

A camera-matrix compensation of the cross-frame compare was also built and measured
(~0 µs): it fixes camera motion but not object motion, and needs far-plane texels
excluded. It stays as the `reconstruct-camera-v1` bench identity.

**History (2026-07-18 → 10-05):** the parity program measured the source-style scatter at
+30% (prepareInputs) / +22% (depthClip) *per pass* inside a larger candidate bundle
(+0.056 ms for that whole bundle step) and kept a fused cross-frame gather. That gather
needed three stabilizers for sub-texel sampling mismatch (no-veto best-tap vote,
jitter-delta-compensated reprojection, relief-widened tolerance) and was still not
camera-invariant — the #67 finding.

### 2. RCAS in conditioned tonemap space

**Upstream:** RCAS sharpens exposed linear texels; each of the 5 taps is loaded in the
working color domain.

**Ours:** the temporal path's history is already stored in invertible-tonemap space
(`c/(1+max(c))`, FSR2's own conditioning). Production RCAS sharpens those bounded
conditioned texels directly and inverts the conditioning + exposure **once on the
result** instead of per tap. Tonemap inversion and exposure division are exactly the
per-tap ALU that made the flag-on form expensive; hoisting them out of the tap loop is
free because RCAS's ratio-based limiter is scale-invariant enough that the sharpening
decision is unchanged in practice.

**Measured:** −34% on the RCAS pass (0.103 → 0.068 ms), −5.7% total pipeline compute;
captures across Q0/Q1/Q3 plus an HDR-bulb stress scenario show full-frame RMSE
≤ 1.8/255 and HDR ROI maxima ≤ 9/255 — visually identical, no overshoot. The per-tap
form is frozen in the bench registry (`rcas-fsr315-limiter`) so the comparison stays
reproducible.

**Correction (2026-10-02/03, issues #32 and #50):** those were 8-bit captures, and ACES
saturates everything above ~4, so they could not see HDR overshoot. GPU readbacks of
the rgba16float output showed ~1000× fireflies on isolated peaks and ~2× overshoot on
converged HDR plateau edges. The conditioned limiter bounds the result below
conditioned 1, which is linear infinity. The single inversion is now capped at the
conditioned lobe applied in linear space against the darkest ring tap. On ordinary
content the cap is bit-exact outside a few hundred to ~2.7k pixels per 1280×720 frame. It costs ~+4–5%
RCAS, so most of the −34% win stands (`bench/docs/NEXT-STEPS.md` §12).

### 3. Fused multi-scale shading-change detector

The most substantial re-derivation, and the one with a genuinely new result.

**Upstream:** a two-pass design — an SPD (single-pass downsampler) builds a
signed luma-difference mip chain, then the resolve reads multiple mips to detect
shading changes. The per-texel metric is a relative difference
(`1 − min/max`) averaged over each mip footprint.

**Ours:** one fused half-resolution dispatch (`shadingChange.ts`). An 8×8 workgroup with
a 2×2 render block per thread covers exactly one 16×16 render tile, so every reduction
scale (4×4, 8×8) is workgroup-shared-memory-local — no mip textures, no second pass, no
per-tap re-loads of the 1×1 frame-info texels.

Two findings from GPU tuning (five documented iterations):

- **Per-texel relative differences carry a coherent bias under jitter.** On
  high-frequency content, sub-pixel jitter leaves alias residue between the current
  frame and the reprojected previous frame. The relative-difference metric is
  asymmetric — the darker side of any residue always yields the larger ratio — so the
  *mean of per-texel ratios* floors at ~0.10 on a completely still scene and no amount
  of averaging cancels it. Averaging the *luma first* and taking the ratio of block
  means is unbiased: block-mean luma is stable under jitter, so genuine shading changes
  move the means while alias flicker does not.
- **The finest (2×2) scale is unrescuable.** 2×2 means of a thin feature still swing
  under sub-pixel jitter regardless of the noise floor; a genuinely changing small
  feature still moves its containing 4×4 mean. The response therefore uses only the
  coarse scales, each gated by a base + contrast-adaptive floor (scaled by the
  coefficient of variation pooled over both frames' blocks, since #52), with
  disoccluded texels neutralized. Since #58 the previous luma is taken per texel as
  the closest value in its reprojected bilinear footprint's tap range, so a difference
  that jitter alone explains reads 0.
- **One frame of history is not enough past the render Nyquist.** Fine line pairs and a
  Siemens star centre alias into moiré larger than a block, so a whole block mean flips
  between values on successive jitter phases with no change in the scene. Each block
  now remembers its last 8 means and a mean inside their range is not a change (the
  idea of FSR 3.1's luma-instability pass, at block scale), unless this frame's jump is
  larger than the jumps the memory holds, which keeps a step right after a ramp
  detectable. Still-scene firing on the resolution-chart scenario fell from 3.3% to
  0.12% of the frame with light steps unchanged within 1% (`bench/docs/NEXT-STEPS.md`
  §14).

**Measured (2026-07-21; #52's pooled spread and #58's footprint clamp were not
re-timed):** 0.044 ms at ratio 2 vs 0.231 ms for the source-style two-pass candidate
(5× cheaper; zero when disabled — the pass isn't dispatched). Quality beats both
alternatives: still-scene response at the old inline heuristic's baseline, *fewer*
false positives than that heuristic under camera motion on high-frequency content
(worst-case 3.6 vs 4.9 on the torture scene), and light steps register as clean
single-frame spikes (137/255) where the old detector produced a weaker response (84)
with a ~20-frame decay tail.

### 4. Single-workgroup exposure reduction with host-invariant metering

**Upstream:** auto-exposure reads the coarsest mip of the SPD luminance pyramid.

**Ours:** no consumer needs the intermediate mips (the shading-change detector above
does its own fused reduction), so exposure is a single 8×8-workgroup log-average
reduction (`luminancePyramid.ts`) — one tiny dispatch instead of a device-wide
pyramid. Two upstream behaviors are preserved exactly: `DeltaPreExposure` history
correction (reprojected history is ratio-corrected across a host pre-exposure change),
and host-invariant metering — auto-exposure divides the host's pre-exposure out of the
scene luma before adapting, so it never chases a step the application already metered.
Skipping that second part reads as a full-screen false shading change for ~2 s after a
host exposure step; we found this on GPU and it is now covered by a dedicated
step+ramp scenario (Q11), with byte-identical output when no pre-exposure input is
supplied.

## Where we match upstream (adopted parity)

- **RCAS numeric math.** The production sharpener uses FSR 3.1.5's lower limiter and the
  corrected denoise luma/range math, adopted after A/B measurement showed parity was
  free (E01). Denoise is opt-in pending evidence on representative noisy content.
  (The load domain diverges — see enhancement 2 above.)
- **Host pre-exposure (`DeltaPreExposure`).** The `preExposureTexture` dispatch input is
  honored end-to-end with upstream's contract (see enhancement 4).
- **Viewport/depth-scaled disocclusion against a reconstructed previous depth.** AMD's
  threshold formulation and same-frame scatter structure (see enhancement 1).
- **Color and exposure domains.** Like upstream, the upscaler applies no tone mapping or
  output encoding — input and output are the caller's linear/HDR domain, and internal
  conditioning exposure is divided back out before output. An earlier internal ACES/sRGB
  transform was removed for source alignment (E03).
- **Core temporal semantics.** Jittered projection (Halton), jitter-free motion vectors,
  `prevUV = uv − motion` reprojection, invertible-tonemap accumulation with FSR2's
  firefly guard, YCoCg variance clipping, disocclusion-driven history rejection,
  luminance-stability locks, auto-exposure conditioning, reactive masks (explicit and
  auto-generated from opaque-vs-final diff, FSR2-style) — the algorithmic lineage is
  FSR's throughout.
- **EASU (spatial path).** The 12-tap edge analysis, anisotropic Lanczos kernel, tap
  placement, and deringing follow `ffx_fsr1.h`; only language-level details differ
  (native WGSL division/`inverseSqrt` instead of AMD's approximation helpers).

## Where we diverge, and why

**1. Platform constraints (WebGPU is not Vulkan/DX12).** Core WebGPU has no
floating-point storage-texture atomics (source depth scatter), no device-wide atomic
counter for single-pass downsampling (source SPD), no guaranteed f16 arithmetic, and no
swapchain pacing control (which rules out FSR3 frame generation entirely). The candidate
graphs prove these can be *emulated* — storage-buffer atomics, direct mip re-reads — but
the emulations are part of why the source graphs measure slower here.

**2. Measured cost without measured benefit.** The compact accumulate pass (bilinear-free
Lanczos2 upsample + Catmull-Rom history, no deringed bicubic) survived because the
source alternative cost +47% on accumulate and the deterministic quality scenarios
(static convergence, camera motion, object-motion disocclusion) could not distinguish
them visually. A divergence is kept only while that remains true — the frozen bench
snapshots stay in-repo precisely so this can be re-tested as scenes, devices, or the
library change without shipping candidate code to consumers.

**3. Scope decisions.** Frame generation is out of scope (browser swapchain limits).
MSAA input is rejected by design — FSR's temporal path *is* the anti-aliaser. The
distinct softer Transparency & Composition channel exists only in the frozen structural
benchmark candidate. Production `DispatchInputs` has no T&C option, and the production
resolver neither maps nor consumes that channel. It will only be promoted with evidence
that the reactive path is insufficient for real content.

## Honest limits of the evidence

Current measurements are one adapter family (Apple Metal), one upscale ratio class, and
synthetic torture scenes over short deterministic sequences. The source graphs'
theoretical advantages target harder content — exposure ramps, transparency-heavy
scenes, noisy GI inputs, extreme motion — that the decisive runs did not exercise. The
benchmark harness (`npm run bench`, `scripts/run-benchmark.mjs`) exists so any of these
claims can be re-tested; a repeatable ≥5% result is treated as actionable, <3% as noise.

## Status

The parity program is concluded. Every adoption-worthy behavior it identified landed on
2026-07-21 — the four items above. Nothing from the program remains open; what remains
deferred is listed with rationale elsewhere: perf-only micro-optimizations in the
project README, the distinct T&C channel under "Explicitly not planned" in
`bench/docs/NEXT-STEPS.md`, and a fused GI/denoise temporal path in
[#7](https://github.com/pmndrs/upscaler/issues/7).
