# Reference quality: scoring output against ground truth

The other meters in this folder measure *stability*: same-jitter-phase frame
differences (`measure-convergence.mjs`), drift lag, ghost frames, exact float
readbacks of a few emitters. They are good at it, but none of them can tell a
stable, correct image from a stable, wrong one: an output that converges to a
blurred or aliased image scores as well as one that converges to the truth.
Comparisons against native render-resolution output don't fix that, because
native output is aliased too.

`scripts/measure-reference-quality.mjs` adds the missing axis. It renders a
ground-truth reference for every measured frame and scores each mode against
it. Everything here is local-only: it needs a real GPU, so it stays out of CI.

## How the reference is made

For each measured frame of a bench scenario:

1. The scenario's exact state for that frame is applied: camera, animated
   objects, lights, and three's pinned `NodeFrame` (frame-scoped uniforms such
   as light intensities only refresh when its `frameId` moves).
2. The input scene renders at **display** resolution `--samples` times (64 by
   default) into a half-float target, the format the upscaler's input uses.
   Each pass gets a different sub-pixel camera offset: Halton (2, 3) points,
   recentred so their mean is exactly zero (a biased mean would shift the
   whole reference by a fraction of a pixel and show up as error on every
   edge).
3. A small measurement-only compute pass sums the passes into an f32 storage
   buffer, which is read back exactly. That gives a box-filtered supersample
   of the display pixel, which for a raster scene is the ground truth. No path
   tracer is needed.

`--scale s` renders each pass at s× display resolution and box-sums s×s
texels per display pixel (so `--samples` must be a multiple of s²). It is for
effects that sub-pixel jitter cannot average because they are anchored to the
render's own pixel grid. Two examples are three's IGN shadow dither (Q12) and
derivative-based mip selection. See "What the reference is" below.

The reference is rendered once per frame and shared by every mode. Each mode
(native at ratio 1, then bilinear, FSR1 spatial and temporal at `--ratio`) then
runs the same frames through the bench pipeline from a deterministic reset,
and its `rgba16float` output is read back exactly. The bench source is not
modified: the script installs a page-side helper over CDP and drives the
bench's private context, like `measure-emitter-retention.mjs` does.

**Identity check.** With `--samples 1` the reference is a single centred
render at display resolution, which is exactly what native mode outputs. The
harness reproduces it bit for bit: PSNR ∞ and SSIM 1 on Q1, Q0 (animated
objects) and Q19 (camera motion), and 124.5 dB on Q12 (shadow-filter
rounding). Re-run this after touching the script:

```bash
node scripts/measure-reference-quality.mjs --scenario Q19 --modes native --samples 1 --frames 150:152
```

## Metrics

Every image, reference and output alike, goes through **one fixed
presentation transform**: negative linear values clamped to 0, then three's
`ACESFilmicToneMapping` at exposure 1, then the sRGB OETF. That is what the
bench canvas shows. The transform is `present()` in `scripts/image-metrics.mjs`,
which mirrors three's TSL nodes, not the older GLSL chunk (the two
`RRTAndODTFit` denominators differ). Every run checks it against a screenshot
of the bench canvas for each mode and records `presentationCheck` in the
summary, including the worst pixel's position and linear value. The clamp came
out of that check. The ACES fit curves back up below zero, so the temporal
path's small negative outputs (RCAS undershoot, about −0.04) presented at up to
29/255 in Node while the canvas showed black. All modes in the baseline now
match the canvas to a mean of ≤ 0.0023/255, with a maximum of 1/255.
The metrics are computed on the unquantized display-encoded values in [0, 1].

| metric | definition | reads |
| --- | --- | --- |
| **PSNR** (dB) | `10·log10(1 / MSE)` over RGB | overall error; higher is better |
| **SSIM** | Wang et al. 2004: Gaussian window (11 taps, σ 1.5), K1 0.01, K2 0.03, data range 1, per RGB channel then averaged; the 5 px border is excluded | structure (edges, texture); 1 is identical |
| **temporal error** (/255) | mean over consecutive pairs of \|Δoutput − Δreference\|, Δ = this frame − last frame | change the true image doesn't make (flicker, shimmer) plus true change the output misses (lag, ghosting) |
| churn (/255) | mean \|Δoutput\| | what the convergence meters see |
| reference churn (/255) | mean \|Δreference\| | the true image's own motion; churn alone can't separate it from flicker |

Read PSNR/SSIM and temporal error together. A still, converged, blurred
output has temporal error 0 and a poor PSNR. A sharp output that shimmers has
a good PSNR and a high temporal error. Under motion, churn is mostly real
image change. Temporal error is what's left once the reference's own change
is subtracted. Every metric is reported for the whole frame and for each of
the scenario's ROIs (`rois` in `bench/src/benchmark/scenarios.ts`), per
measured window.

**Windows.** A window is a run of consecutive frames. The defaults are one
full ratio-2 jitter cycle (32 frames) after convergence for still scenarios,
and 16 frames inside each motion segment for Q4 and Q19, so each window holds
one kind of motion. `--frames name=start:end,…` overrides them.

**The reference's own error.** `--floor-samples 1024` renders the first frame
again at 1024 spp and scores the 64-spp reference against it. Mode scores
closer to that floor than a few dB can't be ranked. In the baseline the floor
is 56–64 dB, against mode scores of 25–41 dB, so the reference's sampling
error is negligible.

## What the reference is (and what it is not)

The box-filtered display-res supersample is the image a perfectly
anti-aliased native renderer would show. Two choices are built into that
definition and are worth knowing before reading a delta:

- **Texture LOD.** At `--scale 1` the reference samples textures with
  display-res mip selection. The upscaler's input renders at render
  resolution, so it selects mips one level blurrier at ratio 2. Neither the
  bench nor the three adapter applies the negative mip bias that FSR 2's
  integration guidance recommends, `log2(render / display) − 1`, which is −2
  at ratio 2. Raising the reference's own resolution moves the target toward the
  true texture integral. Q1 at `--scale 2` (measured with the `baseline`
  identity's legacy temporal RCAS) gave temporal 26.67 dB against 28.54 at
  scale 1 (−1.9 dB), and native 35.14 against 33.75. So part of the
  gap between temporal and native on textured scenes is mip LOD, not
  reconstruction. That makes it an integration question to measure here, not
  something to fix in the accumulate pass.
- **Screen-anchored noise.** Q12's IGN shadow dither is keyed to the
  fragment's pixel coordinate. Sub-pixel jitter doesn't move that coordinate,
  so a `--scale 1` reference keeps the display-res dither pattern. On Q12 this
  turned out not to matter: `--scale 2` changed native by −0.07 dB and
  temporal by −0.04 dB.

The baseline uses `--scale 1`, so it matches the task's definition (display
resolution, jittered samples) and native's own LOD.

**Not supported:** Q6–Q8 and Q14 (the effect graphs: the reference would skip
GTAO/SSR/SSGI), Q10 (resizes mid-run) and Q11 (host pre-exposure baked into the
MRT output). The script refuses them.

## Baseline (ratio 2, 64 spp, scale 1, `production`)

Measured 2026-11-07 on commit `2020ea2` (Apple M-series, Metal-3, headless
Chrome 156, three r186.1) with the bench identity `production`: production
`RCAS_SHADER` on both the temporal and the FSR1 path, which is what ships and
the script's default. Settings are the canonical capture settings (sharpness
0.8, max accumulation 24, auto-exposure, locks and the shading detector on) at
a 1280×720 display. Native renders at ratio 1. The other three modes render at
640×360. Regenerate the whole table with:

```bash
for s in Q0 Q1 Q4 Q12 Q18 Q19; do
  node scripts/measure-reference-quality.mjs --scenario $s --ratio 2 --floor-samples 1024
done
```

That takes about 12 minutes on an idle GPU. Each run writes
`bench/results/raw/reference-quality/production-<scenario>-2x/summary.json`,
which holds per-frame and per-ROI numbers and records its own command line.
Every run had zero non-finite values and no browser errors. The reference
floor (64 vs 1024 spp) was 57.3 dB (Q0), 57.4 (Q1), 58.0 (Q4), 64.2 (Q12),
58.1 (Q18) and 59.5 (Q19). Windows are the script defaults.

| scenario | window (frames) | mode | PSNR dB | SSIM | temporal error /255 | churn /255 | ref. churn /255 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Q0 | animated (120–151) | native | 33.83 | 0.9818 | 0.074 | 0.209 | 0.197 |
| Q0 | animated (120–151) | bilinear | 25.94 | 0.8796 | 0.132 | 0.217 | 0.197 |
| Q0 | animated (120–151) | spatial | 27.37 | 0.9115 | 0.173 | 0.270 | 0.197 |
| Q0 | animated (120–151) | temporal | 27.73 | 0.9223 | 0.320 | 0.348 | 0.197 |
| Q1 | still (180–211) | native | 33.75 | 0.9817 | 0.000 | 0.000 | 0.000 |
| Q1 | still (180–211) | bilinear | 25.86 | 0.8801 | 0.000 | 0.000 | 0.000 |
| Q1 | still (180–211) | spatial | 27.28 | 0.9116 | 0.000 | 0.000 | 0.000 |
| Q1 | still (180–211) | temporal | 28.55 | 0.9340 | 0.118 | 0.118 | 0.000 |
| Q4 | orbit (88–103) | native | 33.48 | 0.9810 | 1.539 | 3.264 | 3.058 |
| Q4 | orbit (88–103) | bilinear | 25.68 | 0.8792 | 3.172 | 2.331 | 3.058 |
| Q4 | orbit (88–103) | spatial | 27.22 | 0.9126 | 3.180 | 3.270 | 3.058 |
| Q4 | orbit (88–103) | temporal | 26.22 | 0.8838 | 3.144 | 2.646 | 3.058 |
| Q4 | translate (200–215) | native | 32.42 | 0.9771 | 2.843 | 13.871 | 13.469 |
| Q4 | translate (200–215) | bilinear | 25.18 | 0.8625 | 8.416 | 11.231 | 13.469 |
| Q4 | translate (200–215) | spatial | 26.35 | 0.8980 | 7.441 | 13.626 | 13.469 |
| Q4 | translate (200–215) | temporal | 24.22 | 0.8260 | 9.920 | 11.324 | 13.469 |
| Q4 | orbit-2 (320–335) | native | 31.90 | 0.9788 | 2.746 | 11.675 | 11.273 |
| Q4 | orbit-2 (320–335) | bilinear | 24.74 | 0.8502 | 7.853 | 9.473 | 11.273 |
| Q4 | orbit-2 (320–335) | spatial | 26.13 | 0.8968 | 6.675 | 11.695 | 11.273 |
| Q4 | orbit-2 (320–335) | temporal | 24.86 | 0.8475 | 8.104 | 9.872 | 11.273 |
| Q4 | hold (440–455) | native | 33.07 | 0.9829 | 0.000 | 0.000 | 0.000 |
| Q4 | hold (440–455) | bilinear | 25.09 | 0.8596 | 0.000 | 0.000 | 0.000 |
| Q4 | hold (440–455) | spatial | 26.83 | 0.9073 | 0.000 | 0.000 | 0.000 |
| Q4 | hold (440–455) | temporal | 27.69 | 0.9226 | 0.132 | 0.132 | 0.000 |
| Q12 | still (180–211) | native | 37.02 | 0.9944 | 0.000 | 0.000 | 0.000 |
| Q12 | still (180–211) | bilinear | 35.86 | 0.9913 | 0.000 | 0.000 | 0.000 |
| Q12 | still (180–211) | spatial | 36.63 | 0.9924 | 0.000 | 0.000 | 0.000 |
| Q12 | still (180–211) | temporal | 38.57 | 0.9947 | 0.022 | 0.022 | 0.000 |
| Q18 | still (180–211) | native | 22.11 | 0.9620 | 0.000 | 0.000 | 0.000 |
| Q18 | still (180–211) | bilinear | 16.42 | 0.7968 | 0.000 | 0.000 | 0.000 |
| Q18 | still (180–211) | spatial | 16.46 | 0.8305 | 0.000 | 0.000 | 0.000 |
| Q18 | still (180–211) | temporal | 20.89 | 0.8939 | 2.445 | 2.445 | 0.000 |
| Q19 | still (96–111) | native | 34.67 | 0.9866 | 0.000 | 0.000 | 0.000 |
| Q19 | still (96–111) | bilinear | 24.31 | 0.8573 | 0.000 | 0.000 | 0.000 |
| Q19 | still (96–111) | spatial | 25.75 | 0.8972 | 0.000 | 0.000 | 0.000 |
| Q19 | still (96–111) | temporal | 26.37 | 0.9130 | 0.115 | 0.115 | 0.000 |
| Q19 | dolly-back (150–165) | native | 34.40 | 0.9861 | 1.947 | 11.106 | 10.817 |
| Q19 | dolly-back (150–165) | bilinear | 23.54 | 0.8256 | 9.003 | 8.238 | 10.817 |
| Q19 | dolly-back (150–165) | spatial | 24.78 | 0.8703 | 7.931 | 9.903 | 10.817 |
| Q19 | dolly-back (150–165) | temporal | 24.62 | 0.8543 | 8.273 | 9.426 | 10.817 |
| Q19 | orbit-left (390–405) | native | 33.68 | 0.9841 | 2.251 | 13.775 | 13.760 |
| Q19 | orbit-left (390–405) | bilinear | 24.00 | 0.8519 | 9.351 | 12.351 | 13.760 |
| Q19 | orbit-left (390–405) | spatial | 25.50 | 0.8975 | 7.518 | 14.421 | 13.760 |
| Q19 | orbit-left (390–405) | temporal | 23.81 | 0.8395 | 9.877 | 12.836 | 13.760 |
| Q19 | slide (630–645) | native | 34.82 | 0.9865 | 1.826 | 11.599 | 11.276 |
| Q19 | slide (630–645) | bilinear | 24.40 | 0.8585 | 7.963 | 9.121 | 11.276 |
| Q19 | slide (630–645) | spatial | 25.84 | 0.8971 | 6.897 | 10.906 | 11.276 |
| Q19 | slide (630–645) | temporal | 25.07 | 0.8711 | 7.835 | 9.805 | 11.276 |
| Q19 | scene-recede (750–765) | native | 34.52 | 0.9861 | 1.908 | 10.884 | 10.562 |
| Q19 | scene-recede (750–765) | bilinear | 23.89 | 0.8273 | 8.698 | 7.944 | 10.562 |
| Q19 | scene-recede (750–765) | spatial | 25.15 | 0.8721 | 7.658 | 9.624 | 10.562 |
| Q19 | scene-recede (750–765) | temporal | 24.99 | 0.8603 | 7.808 | 9.033 | 10.562 |
| Q19 | dolly-back-fast (962–977) | native | 34.69 | 0.9868 | 2.159 | 18.784 | 18.829 |
| Q19 | dolly-back-fast (962–977) | bilinear | 23.76 | 0.8332 | 11.831 | 17.501 | 18.829 |
| Q19 | dolly-back-fast (962–977) | spatial | 25.06 | 0.8766 | 9.882 | 19.206 | 18.829 |
| Q19 | dolly-back-fast (962–977) | temporal | 25.04 | 0.8705 | 10.131 | 18.482 | 18.829 |

The table records numbers, not causes. What it shows:

- **Still scenes: temporal beats every other ratio-2 mode.** On Q1 it is
  +1.27 dB over FSR1 and +2.69 dB over bilinear. On Q18's chart it is
  +4.43 dB over FSR1 (bars ROI: 16.4 against 11.8). It still trails native,
  which has 4× the pixels, by 1.2 dB (Q18) to 8.3 dB (Q19 still), except on
  Q12, where it passes native (38.57 against 37.02). Q12's shadow dither and
  aliasing are noise that accumulation averages out and native keeps.
- **In motion, temporal falls behind FSR1 spatial in every window.** The gap
  is −1.00 dB on Q4 orbit, −2.13 on Q4 translate, −1.27 on Q4 orbit-2, −1.69
  on Q19 orbit-left, −0.77 on Q19 slide, −0.16 on Q19 dolly-back and −0.16 on
  Q19 scene-recede. The fast dolly is effectively a tie (−0.01). On Q4
  translate and Q19 orbit-left temporal is even below bilinear. Temporal error
  agrees in every motion window except Q4's slow first orbit (3.14 against
  3.18): temporal's is above FSR1's, e.g. Q4 translate 9.92 against 7.44.
  LPIPS and both VDPs agree on the one window measured perceptually (below).
  The stability meters can't see this, because temporal's churn under motion
  is below both FSR1's and the reference's own in every motion window. The
  scale-2 sensitivity check and the missing mip bias (see "What the reference
  is") account for part of the still-scene gap to native. They do not explain
  why motion falls below FSR1, which renders at the same resolution.
- **On a still camera only temporal churns.** Temporal's churn equals its
  temporal error there, 0.12–0.13/255 on Q1, Q4 hold and Q19 still. That is
  the residual jitter shimmer the convergence meter tracks, and the reference
  has none. Q18's unresolvable bars are the exception at 2.45/255 (bars ROI
  7.3/255): on a still camera the aliasing moiré never converges.
- **Animated objects (Q0)** add flicker. Temporal error is 0.320 for temporal
  against 0.173 for FSR1 and 0.074 for native, mostly on the fence and sphere
  ROI (0.730).

### Production vs legacy temporal RCAS

The first pass of this baseline ran the `baseline` identity. That identity
keeps the frozen `RCAS_LEGACY_SHADER` on the temporal path so older captures
stay comparable (BENCHMARKING.md, "Which RCAS each mode runs"). Its FSR1, native
and bilinear columns are identical to the table above (FSR1 to 1e-6 dB, since
both identities run production RCAS there), so only temporal differs:

| scenario | window | temporal PSNR legacy → production | SSIM legacy → production | temporal error legacy → production | production temporal − FSR1 (dB) |
| --- | --- | --- | --- | --- | ---: |
| Q0 | animated | 27.74 → 27.73 | 0.9215 → 0.9223 | 0.311 → 0.320 | +0.36 |
| Q1 | still | 28.54 → 28.55 | 0.9331 → 0.9340 | 0.114 → 0.118 | +1.26 |
| Q4 | orbit | 26.24 → 26.22 | 0.8835 → 0.8838 | 3.143 → 3.144 | −1.00 |
| Q4 | translate | 24.26 → 24.22 | 0.8265 → 0.8260 | 9.897 → 9.920 | −2.13 |
| Q4 | orbit-2 | 24.89 → 24.86 | 0.8473 → 0.8475 | 8.108 → 8.104 | −1.27 |
| Q4 | hold | 27.68 → 27.69 | 0.9220 → 0.9226 | 0.128 → 0.132 | +0.86 |
| Q12 | still | 37.90 → 38.57 | 0.9941 → 0.9947 | 0.020 → 0.022 | +1.94 |
| Q18 | still | 20.71 → 20.89 | 0.8899 → 0.8939 | 2.425 → 2.445 | +4.43 |
| Q19 | still | 26.38 → 26.37 | 0.9122 → 0.9130 | 0.113 → 0.115 | +0.62 |
| Q19 | dolly-back | 24.64 → 24.62 | 0.8539 → 0.8543 | 8.283 → 8.273 | −0.16 |
| Q19 | orbit-left | 23.84 → 23.81 | 0.8394 → 0.8395 | 9.880 → 9.877 | −1.69 |
| Q19 | slide | 25.08 → 25.07 | 0.8706 → 0.8711 | 7.856 → 7.835 | −0.77 |
| Q19 | scene-recede | 25.02 → 24.99 | 0.8600 → 0.8603 | 7.815 → 7.808 | −0.16 |
| Q19 | dolly-back-fast | 25.07 → 25.04 | 0.8700 → 0.8705 | 10.158 → 10.131 | −0.01 |

Production RCAS lifts the high-contrast still scenes (Q12 +0.67 dB, Q18
+0.18 dB) and moves every motion window by 0.04 dB or less. The motion gap to
FSR1 is not an RCAS effect. Under legacy RCAS the fast dolly read +0.01 (a
tie) instead of −0.01. Regenerate the legacy columns with `--variant baseline`
(the label defaults to the variant id).

## Why temporal trails FSR1 in motion (diagnosis, 2026-11-10)

The baseline shows temporal behind FSR1 spatial on every Q4/Q19 motion window
(−0.01 to −2.13 dB), while it leads on every still one. This section ranks
the causes. Every number below is full-frame PSNR at ratio 2 with the
`production` identity, on the worst segments: Q4 translate (200–215, mean
motion 1.66 render px/frame), Q19 orbit-left (390–405, 1.77 px/frame) and
Q4's slow first orbit (88–103, 0.31 px/frame). A positive number is dB
recovered toward FSR1.

### Ranking

| # | cause | measured contribution | how |
| --- | --- | --- | --- |
| 1 | **Accumulation length under motion.** Every frame of history is a Catmull-Rom resample of the last, so at the full 24-frame setting a moving pixel's value is a long chain of resamples. The loss sits on thin high-contrast features (the floor's grid lines, fence edges, silhouettes) in both frequency bands. | **+2.58 / +1.72 / +1.58 dB** with a global `maxAccumulation` 2 (24.22 → 26.80, 23.81 → 25.53, 26.22 → 27.80) | `maxAccumulation` sweep 1 / 2 / 4 / 8 / 24 |
| 2 | Single-frame upsample quality: Lanczos2 with dering versus EASU | −0.02 / −0.31 dB (`maxAccumulation` 1 against FSR1); this bounds what is left once #1 is fixed | `maxAccumulation` 1 |
| 3 | Auto-exposure | +0.28 / −0.10 dB when off, mixed sign | `autoExposure: false` |
| 4 | Luminance locks | +0.09 / 0.00 / +0.11 dB when off | `lockThinFeatures: false` |
| 5 | Disocclusion, young history, screen-border band | 0.07 / 0.09 dB combined (error attribution, below); disoccluded 1.4 / 1.7 % of pixels, young (< 4 frames) 3.8 / 4.8 % | `analyze-reference-error.mjs` |
| 6 | Shading-change detector | 0.00 / 0.00 dB | `detectShadingChanges: false` |
| 7 | Input texture sharpness (negative mip bias; the mip-bias A/B on branch `claude/hopeful-lamport-58ad44`, setting `inputMipBias`) | the gap changes by +0.09 (Q4 translate) and −0.26 dB (Q19 orbit-left) at bias −1 | measured on the legacy-RCAS identity; not a driver |
| — | Harness alignment | none: every mode peaks at reference offset 0 (temporal 24.22 dB at 0 against 19.27 / 19.13 at −1 / +1) | `--reference-offset −1 / 0 / 1` |

**Why #1 and not the others.** The history under motion is mature, not young
or rejected: the mean age is 21.7 / 21.4 of 24 frames, and the disoccluded,
young and border classes together account for under 0.1 dB of the deficit.
Locks and the shading detector are near-neutral. The signed temporal-minus-FSR1
error map (`diff-temporal-spatial-f0200.png`) is red almost only along thin
lines and edges. The deficit shows in both bands (σ 2 px): low 31.78 against
36.23 dB and high 25.69 against 27.18 on Q4 translate, i.e. thin lines lose
contrast, not just sharpness. Fetching history bilinearly instead of with
Catmull-Rom costs another 0.55 / 0.90 dB (23.67 / 22.91), so the resampling
filter is on the critical path. Shortening the chain helps for the same
reason.

**Why not a global cap.** `maxAccumulation` 4 everywhere keeps still-scene
PSNR (Q1 28.47 against 28.55) but multiplies still-scene temporal error by 6
(0.118 → 0.706/255): visible shimmer. The cap has to depend on motion.

### Candidate fix: motion-adaptive accumulation cap (prototype, not shipped)

`bench/src/candidates/shaders/accumulateVariants.ts` rewrites only the blend
of production `ACCUMULATE_SHADER`. The effective `maxAccumulation` falls from
the setting to `cap` as the pixel's motion rises from `lo` to `hi` render
px/frame:
`motionCap = mix(maxAccumulation, cap, smoothstep(lo, hi, motionTexels))`.
It is wired through the bench-only `_accumulateShader` option, and the
production shader and defaults are untouched. Identities, all on production
RCAS:

- `accumulate-motion-cap2-v1`: cap 2, ramp 0.5 → 1.5 px/frame.
- `accumulate-motion-cap4-v1`: cap 4, ramp 0.5 → 1.5 px/frame.
- `accumulate-motion-cap2-early-v1`: cap 2, ramp 0.05 → 0.5 px/frame. This
  is the still-scene relax's own fade (`STILL_MOTION_LO/HI`), so the cap
  engages exactly where the relax stops.

PSNR in dB, with the difference to FSR1 in parentheses:

| scenario | window | FSR1 | production temporal | cap 2 | cap 4 | cap 2 early | temporal error: production → cap 2 → cap 4 → cap 2 early |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Q0 | animated | 27.37 | 27.73 (+0.36) | 27.84 (+0.47) | 27.81 (+0.44) | 28.07 (+0.70) | 0.320 → 0.297 → 0.303 → 0.273 |
| Q1 | still | 27.28 | 28.55 (+1.26) | 28.55 (+1.26) | 28.55 (+1.26) | 28.55 (+1.26) | 0.118 → 0.118 → 0.118 → 0.118 |
| Q4 | orbit | 27.22 | 26.22 (−1.00) | 26.25 (−0.97) | 26.25 (−0.97) | 27.30 (+0.09) | 3.144 → 3.137 → 3.137 → 3.056 |
| Q4 | translate | 26.35 | 24.22 (−2.13) | 26.18 (−0.17) | 25.83 (−0.51) | 26.76 (+0.42) | 9.920 → 7.472 → 7.830 → 7.217 |
| Q4 | orbit-2 | 26.13 | 24.86 (−1.27) | 26.08 (−0.04) | 25.97 (−0.16) | 26.63 (+0.50) | 8.104 → 7.082 → 7.051 → 6.811 |
| Q4 | hold | 26.83 | 27.69 (+0.86) | 27.77 (+0.95) | 27.76 (+0.93) | 27.79 (+0.96) | 0.132 → 0.131 → 0.132 → 0.131 |
| Q12 | still | 36.63 | 38.57 (+1.94) | 38.57 (+1.94) | 38.57 (+1.94) | 38.57 (+1.94) | 0.022 → 0.022 → 0.022 → 0.022 |
| Q18 | still | 16.46 | 20.89 (+4.43) | 20.89 (+4.43) | 20.89 (+4.43) | 20.89 (+4.43) | 2.445 → 2.445 → 2.445 → 2.445 |
| Q19 | still | 25.75 | 26.37 (+0.62) | 26.37 (+0.62) | 26.37 (+0.62) | 26.37 (+0.62) | 0.115 → 0.115 → 0.115 → 0.115 |
| Q19 | dolly-back | 24.78 | 24.62 (−0.16) | 24.84 (+0.06) | 24.83 (+0.05) | 25.03 (+0.25) | 8.273 → 8.119 → 8.077 → 8.040 |
| Q19 | orbit-left | 25.50 | 23.81 (−1.69) | 24.99 (−0.51) | 24.85 (−0.65) | 25.51 (+0.01) | 9.877 → 8.255 → 8.393 → 7.873 |
| Q19 | slide | 25.84 | 25.07 (−0.77) | 25.65 (−0.19) | 25.58 (−0.26) | 26.06 (+0.22) | 7.835 → 7.096 → 7.176 → 6.856 |
| Q19 | scene-recede | 25.15 | 24.99 (−0.16) | 25.21 (+0.06) | 25.23 (+0.08) | 25.52 (+0.37) | 7.808 → 7.643 → 7.588 → 7.619 |
| Q19 | dolly-back-fast | 25.06 | 25.04 (−0.01) | 25.32 (+0.27) | 25.36 (+0.30) | 25.32 (+0.27) | 10.131 → 9.807 → 9.738 → 9.826 |

- **`accumulate-motion-cap2-early-v1` closes the motion gap.** Temporal goes
  from −0.01…−2.13 dB below FSR1 to +0.01…+0.50 dB above it on all 8 motion
  windows. Temporal error falls in every motion window, e.g. Q4 translate
  9.92 → 7.22. Every still window (Q1, Q12, Q18, Q19 still, Q4 hold) is
  unchanged to 0.01 dB with identical temporal error, because their motion
  vectors are zero. Animated objects (Q0) gain +0.34 dB.
- **The later ramp (0.5 → 1.5) misses slow motion.** Q4's first orbit, at
  0.31 px/frame, stays at −0.97. Cap 4 lands within 0.4 dB of cap 2: it is
  behind on the fastest lateral motion (Q4 translate 25.83 against 26.18)
  and slightly ahead on scene-recede and the fast dolly.
- **Holdout check (scenarios not used to choose the constants).** On Q2, the
  slow aliasing dolly at 0.29 px/frame, temporal goes from −1.43 to
  −0.46 dB against FSR1 (25.96 → 26.93; temporal error 3.28 → 3.10). On Q3,
  object motion, it goes from +0.29 to +0.75.
- **Not measured:** GPU cost (one `smoothstep` and `mix` per pixel, so
  expected to be negligible but not timed), ratio 3, and the effect-graph
  scenarios (Q6–Q8, Q14), which this harness doesn't support. Before
  adoption: an ABBA timing run, ratio 3, and an interactive look at slow pans
  for aliasing crawl. A 2-frame history under motion has less temporal AA to
  give, although every motion window here already shows lower temporal error.

### Reproduce

```bash
# Alignment: score against the reference one frame early / late
node scripts/measure-reference-quality.mjs --scenario Q4 --frames translate=200:215 --modes native,spatial,temporal --reference-offset -1
# Accumulation sweep (repeat for 1, 4, 8, 24, and on Q19 --frames orbit-left=390:405)
node scripts/measure-reference-quality.mjs --scenario Q4 --frames translate=200:215 --modes temporal --settings '{"maxAccumulation":2}' --label acc2
# Feature toggles: lockThinFeatures / detectShadingChanges / autoExposure
node scripts/measure-reference-quality.mjs --scenario Q4 --frames translate=200:215 --modes temporal --settings '{"lockThinFeatures":false}' --label no-locks
# Where the error lives (writes error-analysis.json and a signed diff PNG)
node scripts/measure-reference-quality.mjs --scenario Q4 --frames translate=200:215 --modes spatial,temporal --save-diagnostics --label diag
node scripts/analyze-reference-error.mjs bench/results/raw/reference-quality/diag-Q4-2x
# Candidates (repeat per scenario: Q0 Q1 Q2 Q3 Q4 Q12 Q18 Q19)
node scripts/measure-reference-quality.mjs --scenario Q4 --modes temporal --variant accumulate-motion-cap2-early-v1
node scripts/measure-reference-quality.mjs --scenario Q4 --frames translate=200:215 --modes temporal --variant accumulate-bilinear-history-v1
```

Every temporal run also records history-age, disocclusion and motion
statistics per window (`guides` in the summary). Note that the history
texture's `.a` is age ÷ `maxAccumulation` (0–1), although
`TemporalGuides.history` and `docs/temporal-guides.md` describe it in
frames. The script converts it to frames.

## Offline perceptual metrics (LPIPS, ColorVideoVDP, FovVideoVDP)

PSNR and SSIM are fast and need no dependencies, but they are not perceptual,
and SSIM is a per-frame image metric. For publication-grade claims the AMD
I3D 2025 evaluation pairs them with LPIPS and a video metric (FovVideoVDP).
Those need PyTorch, so they are a local, optional step: they are not in CI and
not behind any `pnpm` script.

1. Export the frames. `--export-png` writes every measured frame of the
   reference and of each mode as an 8-bit sRGB PNG after the same presentation
   transform:
   `<run>/png/{reference,native,bilinear,spatial,temporal}/fNNNN.png`. That is
   about 1 MB per frame per sequence, so Q19's 96 frames come to about 0.5 GB.

   ```bash
   node scripts/measure-reference-quality.mjs --scenario Q19 --ratio 2 --export-png
   ```

2. Score them in a throwaway virtualenv (verified 2026-11-07 on Python 3.14,
   torch 2.15):

   ```bash
   python3 -m venv .venv-metrics
   .venv-metrics/bin/pip install torch lpips cvvdp pyfvvdp pillow
   .venv-metrics/bin/python scripts/perceptual-metrics.py bench/results/raw/reference-quality/production-Q19-2x
   ```

   `scripts/perceptual-metrics.py` scores LPIPS (AlexNet, per frame, mean per
   window) and treats each window as one 60 Hz video for ColorVideoVDP and
   FovVideoVDP on the `standard_fhd` display model (`--display`, `--fps`). It
   writes `perceptual.json` next to `summary.json`. JOD 10 means
   indistinguishable from the reference. Lower LPIPS is better. The first run
   downloads LPIPS's AlexNet weights (233 MB, into `~/.cache/torch`).

Verification run: Q19's dolly-back window (frames 150–165, ratio 2,
`production`), about 23 s on an M-series Mac. The perceptual metrics rank the modes the same way
PSNR and SSIM do on that window, including temporal trailing FSR1:

| mode | PSNR dB | SSIM | LPIPS | ColorVideoVDP JOD | FovVideoVDP JOD |
| --- | ---: | ---: | ---: | ---: | ---: |
| native | 34.40 | 0.9861 | 0.0165 | 9.620 | 9.508 |
| bilinear | 23.54 | 0.8256 | 0.1729 | 6.521 | 7.719 |
| spatial | 24.78 | 0.8703 | 0.0946 | 7.558 | 8.074 |
| temporal | 24.62 | 0.8543 | 0.1293 | 7.084 | 7.845 |

```bash
node scripts/measure-reference-quality.mjs --scenario Q19 --frames dolly-back=150:165 --export-png --label perceptual-check
.venv-metrics/bin/python scripts/perceptual-metrics.py bench/results/raw/reference-quality/perceptual-check-Q19-2x
```

Perceptual numbers for the full baseline are not recorded yet.
