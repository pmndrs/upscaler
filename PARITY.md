# @pmndrs/upscaler vs FSR 3.1.5 — design notes

`@pmndrs/upscaler` derives from AMD FidelityFX FSR — FSR1's EASU/RCAS directly, and an
FSR2/3-style temporal resolver written for WebGPU compute. It is **not** byte-for-byte
FSR 3.1.5, and that is a deliberate, *measured* position, not an unfinished port. This
document explains where we match upstream, where we diverge, what we changed outright,
and the evidence behind each choice.

Reference: FidelityFX SDK commit `60f4ea8` (FSR Upscaler 3.1.5). The full per-pass audit
lives in [`src/shaders/README.md`](src/shaders/README.md); raw benchmark evidence in
`bench/results/`; the adoption record in
[`bench/docs/NEXT-STEPS.md`](bench/docs/NEXT-STEPS.md).

## The short version

We implemented the source-style pipeline — the full FSR 3.1.5 pass graph, including
Lanczos2 reconstruction, deringed bicubic history, atomic depth scatter, motion
divergence, SPD-style mip chains, luma instability, and the coordinated source resolver —
as three cumulative candidate graphs inside this repo, GPU-validated them, and A/B
benchmarked them against the production path on deterministic scenes.

**The source-style graphs cost +36% to +76% more GPU compute and produced no visible
quality improvement on our test scenarios.** The differences that exist are sub-4% RMSE
spread across edge detail, with no artifacts, ghosting, or convergence failures on either
side. On a library whose priority order is **performance > quality > realism**, that
result decides the question: the simplified production path ships; the source-parity
graphs remain in-repo as benchmark candidates.

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

### 1. Fused single-pass depth reconstruction & disocclusion

**Upstream:** three stages — "reconstruct previous depth" (an atomic floating-point
scatter into a previous-depth buffer), "dilate depth & motion", and "depth clip"
(disocclusion), with intermediate textures between them. Core WebGPU has no
floating-point storage atomics, so the scatter must be emulated through `u32`
storage-buffer atomics.

**Ours:** one render-resolution dispatch (`reconstruct.ts`). The key observation: depth
clip only ever reads the current pixel's own dilated depth and motion — both already
in-register after the dilate step — plus last frame's dilated depth, which a gather
(read the previous frame's output) provides without any scatter. We kept AMD's
*math* — the viewport/depth-scaled disocclusion tolerance
(`1.37e-5 · halfViewportWidth · maxDepth`) with per-bilinear-tap confidence voting from
`ffx_fsr2_depth_clip.h` — inside our fused structure.

**Measured:** the source-style scatter + separate passes cost +30% (prepareInputs) and
+22% (depthClip) in the structural candidate with no visual difference; the fused pass
runs in 0.035 ms at ratio 2 with disocclusion output validated identical in behavior
(thin stable silhouette outlines, quiet still scenes, age resets confined to
disocclusion trails).

**The price of skipping the scatter, and its fix (2026-07-22):** upstream's scatter
compares each pixel against *same-frame* depth values relocated to their previous
positions, so a continuously-visible surface effectively compares against itself. Our
gather form compares against *last frame's* depth texture, which carries sub-texel
sampling mismatch (bilinear taps, jitter phase). On steep depth gradients — a ground
plane at grazing incidence — neighboring taps differ by tens of view units, far beyond
the ~3-unit tolerance, and the pass shipped with a full-flicker artifact there
(12–14% of disocclusion pixels flipping per jitter phase, found via the temporal-guides
example). Three compensations restore stability at zero measurable cost: reference
per-tap skip semantics (a tap at/behind the current surface contributes nothing and
must not veto the pixel — the original port's running-AND veto was itself a
misreading of upstream), jitter-delta-compensated reprojection, and a separation
tolerance widened by the 3×3 ring's own depth relief (available free from the dilation
loop). All are geometry-derived; no scene-tuned constants were added. Genuine
disocclusion (Q3's fence trails and silhouettes) is unchanged.

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
  coarse scales, each gated by a base + contrast-adaptive floor (scaled by the block's
  coefficient of variation), with disoccluded texels neutralized.

**Measured:** 0.044 ms at ratio 2 vs 0.231 ms for the source-style two-pass candidate
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
- **Viewport/depth-scaled disocclusion.** AMD's threshold formulation, kept inside our
  fused reconstruction pass (see enhancement 1).
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
them visually. A divergence is kept only while that remains true — the candidates stay
in-repo precisely so this can be re-tested as scenes, devices, or the library change.

**3. Scope decisions.** Frame generation is out of scope (browser swapchain limits).
MSAA input is rejected by design — FSR's temporal path *is* the anti-aliaser. The
Transparency & Composition mask is accepted as a dispatch input for API compatibility
but currently maps to the reactive path; upstream's distinct softer T&C channel is
implemented in the structural candidate and will only be promoted with evidence that
the reactive path is insufficient for real content.

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
deferred (perf-only micro-optimizations, the distinct T&C channel, a fused GI/denoise
temporal path) is listed with rationale in the project README and
`bench/docs/NEXT-STEPS.md`.
