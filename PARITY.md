# Why @pmndrs/upscaler is not a line-for-line FSR 3.1.5 port

`@pmndrs/upscaler` derives from AMD FidelityFX FSR — FSR1's EASU/RCAS directly, and an
FSR2/3-style temporal resolver written for WebGPU compute. It is **not** byte-for-byte
FSR 3.1.5, and that is a deliberate, *measured* position, not an unfinished port. This
document explains where we match upstream, where we diverge, and the evidence behind
each choice.

Reference: FidelityFX SDK commit `60f4ea8` (FSR Upscaler 3.1.5). The full per-pass audit
lives in [`src/shaders/README.md`](src/shaders/README.md); raw benchmark evidence in
`bench/results/`.

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

## Where we match upstream (adopted parity)

- **RCAS numeric math.** The production sharpener uses FSR 3.1.5's lower limiter and the
  corrected denoise luma/range math, adopted after A/B measurement showed parity was
  free (E01). Denoise is opt-in pending evidence on representative noisy content.
  (One deliberate divergence in the *load domain*: the temporal path sharpens the
  accumulated history's conditioned tonemap-space texels and inverts the conditioning
  once on the result, instead of upstream's exposed-linear per-tap domain — measured
  34% cheaper on the RCAS pass with capture-verified visually identical output,
  including an HDR stress scenario.)
- **Host pre-exposure (`DeltaPreExposure`).** The `preExposureTexture` dispatch input is
  honored end-to-end: reprojected history is ratio-corrected across a host pre-exposure
  change, auto-exposure meters host-invariantly, and the host factor is preserved in
  the output — upstream's contract. Validated with a dedicated step+ramp scenario
  (Q11): no history invalidation, no brightness pumping, and byte-identical output when
  the input is absent.
- **Viewport/depth-scaled disocclusion.** The disocclusion threshold uses AMD's
  formulation (`ffx_fsr2_depth_clip.h`'s per-tap confidence with the
  `1.37e-5 · halfViewportWidth · maxDepth` tolerance) instead of the earlier fixed
  relative-threshold guess — kept inside our faster fused reconstruction pass.
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

**2. Measured cost without measured benefit.** The fused single-pass depth
reconstruction/disocclusion, the 3×3-neighborhood shading detector, and the compact
accumulate pass are simplifications that survived because the source alternatives cost
+36–76% GPU time and the deterministic quality scenarios (static convergence, camera
motion, object-motion disocclusion) could not distinguish them visually. A divergence
is kept only while that remains true — the candidates stay in-repo precisely so this
can be re-tested as scenes, devices, or the library change.

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

## Open items we do intend to converge

All four post-parity adoption items landed on 2026-07-21: the RCAS cost
investigation (resolved as the conditioned-space load domain, −34% on the pass),
host pre-exposure correction, the AMD disocclusion constant, and the multi-scale
shading-change detector (the source's coarse-mip design, re-derived as a single
fused pass — 0.044 ms vs the source-style candidate's 0.231 ms, with measurably
fewer false positives than the old 3×3 heuristic on high-frequency content under
motion). Details and evidence: `bench/docs/NEXT-STEPS.md`.
