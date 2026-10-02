# GI history fusion: research spike (issue #7)

Status: **prototype, opt-in, not adopted.** Recommendation: **iterate** (see the end).
Measured 2026-10-03 on Apple Metal-3 through headless Chrome, three r186.1, ratio 2, 1280×720.

This note asks whether accumulating a noisy GI signal *inside* the upscaler beats the
current best practice. That practice is the 06/09 recipe: SSGI on its static pattern,
denoised by `DenoiseNode`, with the upscaler owning all temporal work. The answer
comes from a minimal working prototype, measured on the GPU.

## Problem

Very noisy screen-space GI (SSGI) reaches the upscaler composited into the beauty
color. The upscaler cannot tell that noise from scene detail. Three integrations are
known not to work, and one works with caveats:

- **A second temporal denoiser in front** (`temporalReproject` + `recurrentDenoise`,
  example 10). It reprojects the beauty by jitter-free velocity. It either rejects the
  jittered history, so the noise survives, or it stabilizes away the jitter the
  accumulate pass integrates, so aliasing returns.
- **SSGI's default rotating pattern, composited raw.** The upscaler cannot integrate
  it. The per-frame GI swing widens the variance clip, so silhouettes ghost (CLAUDE.md
  landmine).
- **Spatial-only `recurrentDenoise` (issue #17).** It re-rolls its kernel every
  frame, so the upscaler sees aperiodic noise at its accumulation floor. Thin wires
  boil (`bench/docs/NEXT-STEPS.md` §7).
- **What works: static pattern + `DenoiseNode`.** The input becomes deterministic per
  jitter phase, so the upscaler converges to a clean periodic orbit. The cost is the
  denoiser's spatial artifacts and a single-rotation estimate of the GI.

Issue #7's proposed real fix is to fuse the GI history into the upscaler's own
accumulation. That history would be reprojected with our motion, at our jitter, with
GI-appropriate variance handling.

## Prior art

- **SVGF** (Schied et al., HPG 2017). Demodulate albedo, temporally accumulate the
  *illumination* with per-pixel luminance moments, and use the temporal variance
  (spatial while the history is short) to drive an à-trous filter. Then remodulate
  and run TAA. The demodulation and moments are what this prototype takes from it.
- **A-SVGF** (Schied et al., 2018). Temporal gradients, from re-shading last frame's
  samples, detect lighting changes in noisy signals. That is the principled answer to
  the lag measured below, but it needs control of the GI sampler, which a black-box
  `SSGINode` doesn't give us.
- **NVIDIA NRD (ReBLUR / ReLAX)**. Clamp a slow history to a fast history, sized by
  the fast history's spread. Use "history fix", a spatial fill, while the history is
  short. Use anti-lag that shortens the history when the fast and slow histories
  disagree. The prototype uses the first two. The third was tried and measured as a
  no-op here.
- **FSR2/3's own approach** is not to denoise at all. The reactive mask (and the T&C
  mask) tells accumulate to trust the current frame. That is the wrong tool for noise
  (§7): it zeroes locks and snaps to the noisy frame.
- **Fused denoise + upscale in one network** (the ray-reconstruction approach) is the
  industry end state this issue gestures at. A hand-written WGSL path can only
  approximate it.

## Design options considered

| Option | Shape | Why (not) |
| --- | --- | --- |
| A. Display-res GI history inside `accumulate.ts` | Second history at display res, the same Lanczos taps, its own clip | Closest to the issue's wording, and it puts sub-pixel features at display resolution. It also rewrites the core blend, with #51 editing that file concurrently, and doubles display-res bandwidth. Deferred until B shows whether fusion pays at all. |
| **B. Render-res demodulated GI history in front of accumulate (prototyped)** | New pass `shaders/giFusion.ts`: accumulate `signal` (and AO) with our dilated motion + disocclusion, composite `base·ao + albedo·GI`, and hand the composite to the unchanged late stage | The SVGF-then-TAA split: only the smooth, demodulated term is stabilized, and albedo and direct light keep their per-phase jitter. It is fully fenced (no edit to accumulate) and costs render-res work. |
| C. Beauty + GI mask | The caller passes the composited beauty plus a mask where GI dominates; the accumulate widens or narrows per pixel | Cannot separate noise from albedo detail inside the masked region, so it re-creates the reactive-mask problem. Not built. |

Option B avoids example 10's failure because it never reprojects the beauty. Its
history is the irradiance, which is smooth on any one surface, so integrating it at
render resolution across jitter phases blurs nothing that matters. The exception is a
sub-texel feature (below).

## The prototype

The prototype is opt-in through `upscaler.dispatch({ ..., giFusion: { signal, albedo, occlusion? } })`,
on the raw `Upscaler`'s temporal path. Without it, nothing is compiled, allocated or
dispatched. With it, `color` becomes the *base* lighting, and the pass writes
`color·occlusion + albedo·signal`, which is three's SSGI composite, into a render-res
texture. Every later pass reads that texture instead of `color`. Its pieces, each kept
because a measurement asked for it:

1. **Invertible-tonemap accumulation** (`tonemap`, default on). The first linear
   version showed stable bright speckle: rare bright SSGI samples dominate a linear
   mean. Tonemap space, as accumulate's own history uses, cut the full-frame
   reference distance from 10.3 to 6.3. Off is the `notonemap` row below.
2. **SVGF moments.** Fast `E[l]` and `E[l²]` (α floor 0.2) and fast AO, plus the
   history length. The spatial 3×3 σ stands in while the history is short.
3. **Per-surface depth tag** (`surfaceTolerance`, default 0.03). This is the
   sub-texel trap. Under jitter, a render pixel alternates between a 1 px wire and the
   wall behind it, so a plain history averages their GI and the wire wears the wall's
   bounce light. Visibly, the back wires of the Q14 sphere wash out. Each history
   texel is tagged with the raw (jittered, undilated) view depth it was built on. A
   sample from another surface neither updates nor reads that history. It is shaded
   from neighboring histories that carry its tag, or else from the same-surface
   spatial mean. The dilated depth can't do this, because it reads the wire's depth
   on both sides.
4. **Anti-lag, centered on the fast mean, never on one jitter phase's box**
   (convergence rule 2). There are two stages. A 3×3 block-mean rescale catches
   coherent lighting changes, then a per-pixel clamp follows. Both boxes are
   `clampGamma` (4) standard errors of the fast mean, taken from this frame's
   *spatial* σ. The first version sized the box by the fast window's *temporal* σ.
   A lighting step inflates that σ, so the step hid inside its own box. Before the
   block stage existed, the light step's mean error was 6.35 with that box and 4.86
   with the standard-error box (both at history 32, γ 2). Nothing ages the history length by
   clamp magnitude (convergence rule 1). A ReBLUR-style "shorten on clamp" variant
   measured as a no-op (step 6.13 vs 6.10) and was removed.
5. **History fix.** While the length is under 4, the output leans on the
   depth-weighted spatial mean.

Isolation:

- **Flags are pass-local.** Six bits live in a 32-byte pass UBO, and nothing was
  added to `WGSL_CONSTANTS`, so no other shader re-fingerprints.
- **The `Upscaler` diff is one fenced branch.** `_encodeGiFusion` is called at the
  top of `_encodeLate` and returns the texture used as `color`. Lazy allocation, plus
  teardown in `_destroyTextures`, cover the rest.
- **Bench and tests.** Q14 gained subruns `raw-static`, `raw-rotating`,
  `fused-static` and `fused-rotating`, and Q20 is new. Six GPU-free structural tests
  cover the pass, including that accumulate is untouched and that the clamp is
  centered on the fast mean.

## Results

The meter is `scripts/measure-gi-fusion.mjs`. All figures are on the presented
canvas, 0–255. Recipes:

- `builtin`: static pattern + `DenoiseNode`, the 06/09 recipe.
- `static` / `rotating`: issue #17's spatial `recurrentDenoise`.
- `raw-*`: undenoised SSGI composited into the beauty.
- `fused-*`: undenoised SSGI handed to `giFusion` at its defaults (48 / 4, all stages
  on).

### Still camera, Q14

Settle 240, then 105 frames. The columns:

- **cons**: consecutive-frame mean |Δ|.
- **phase**: the same jitter phase, 32 frames apart.
- **cycle**: 96 frames apart, lcm(jitter 32, SSGI rotation 12). This isolates
  *aperiodic* churn.
- **std**: per-pixel temporal luma std-dev.
- **ref**: the period-averaged image's distance to a long-accumulated linear-mean
  reference.
- **wire**: the 15 730 px where the clean `off` control's lock life averages > 0.3.
- **locks**: the mean `Locks` debug value.

| recipe | cons | phase | cycle | std | ref | wire cons | wire phase | wire cycle | wire std | wire locks | wire ref |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off (no GI) | 0.056 | 0.001 | 0.002 | 0.083 | 13.77 | 0.459 | 0.026 | 0.068 | 0.695 | 0.870 | 46.67 |
| **builtin (06/09)** | 0.194 | **0.002** | **0.007** | 0.272 | 11.00 | 0.682 | **0.016** | **0.046** | **0.929** | 0.628 | 36.16 |
| static (#17) | 0.356 | 0.910 | 0.996 | 0.827 | 8.07 | 1.158 | 1.763 | 2.059 | 2.059 | 0.556 | 22.66 |
| rotating | 0.412 | 1.683 | 0.990 | 1.221 | 6.59 | 1.204 | 3.944 | 2.056 | 3.062 | 0.600 | 17.05 |
| raw-static | 0.400 | 0.004 | — | 0.486 | 9.35 | 1.221 | 0.019 | — | 1.601 | 0.535 | 23.74 |
| raw-rotating | 0.503 | 2.047 | 0.058 | 1.417 | 6.76 | 1.294 | 4.169 | 0.090 | 3.153 | 0.587 | 16.67 |
| fused-static | 0.368 | 0.018 | 0.045 | 0.437 | 9.08 | 1.021 | 0.058 | 0.156 | 1.273 | 0.538 | 23.10 |
| **fused-rotating** | **0.124** | 0.264 | 0.049 | 0.286 | **6.15** | 0.775 | 1.154 | 0.219 | 1.343 | **0.724** | **16.03** |

The raw-static row comes from the 97-frame run, which has no 96-frame pair. The
reference is `fused-rotating` with every guard off (linear, no clamp, history 2048),
`maxAccumulation` 256, settled for 1500 frames and averaged over 96 frames: the
linear mean of SSGI's rotation set. A raw-path reference (`raw-rotating` at 256)
also puts fused-rotating far closer than builtin (9.3 vs 14.2, measured before the
surface tag), but ranks raw-rotating, its own estimator, first. It reads darker than
every 24-frame recipe (raw-rotating at 24 is +6.9), because the AA clip is nonlinear
on noisy input, so it is not a clean truth.

Reading it:

- **On walls, fused-rotating wins.** Consecutive churn is −36% against builtin, and
  the temporal std matches it (0.286 vs 0.272). The image is 44% closer to the
  converged SSGI estimate. Builtin's single static rotation plus `DenoiseNode` is
  biased, which shows as sparkle in crops, while fused walls look like the `off`
  control with GI. Full-frame `locks` falls from 0.09 to 0.03: noise no longer forms
  spurious locks.
- **Its residual same-phase churn is a periodic orbit, not noise.** The cycle-locked
  diff is 0.049, against 0.264 same-phase. The history's EMA ripples with SSGI's
  12-frame rotation, which the 32-phase jitter doesn't align with. The #17 recipes
  stay aperiodic (cycle 0.99 / 2.06). Raw-rotating is periodic too, at 8× the
  amplitude.
- **On wires, issue #17's question:**
  - Locks engage best of any GI recipe: 0.724, against 0.628 for builtin and 0.87
    for the clean control.
  - Wire bias is the lowest: 16.0, against 36.2 for builtin.
  - Wire same-phase churn (1.15) is far above builtin's 0.016. That is the rotation
    ripple plus the foreground path's spatial shading.
  - Q14's acceptance ("`static` should approach `builtin`") is therefore half met.
    Fused beats builtin on consecutive churn, std is close (1.34 vs 0.93), and phase
    churn does not approach it.
- **Fusion does not rescue the static pattern.** Its noise is screen-anchored and
  constant per pixel, so there is nothing temporal to integrate. Fused-static is a
  stable, grainy image (ref 9.1). Fusion is the partner of SSGI's *rotating* pattern,
  the default that the current recipe has to turn off.
- **Aliasing did not return.** Wires stay crisp in crops, and locks engage more, not
  less. Only the demodulated irradiance is stabilized, and albedo and direct light
  keep their jitter.

### Camera motion, Q20

Q20 sweeps sideways 120–239, then holds. Each frame is compared to a held-state
reference: the same recipe's converged image at that pose. The columns:

- **mean**: mean |Δ| over frames 130–310, step 12.
- **err**: the share of pixels with |Δluma| > 8.

| recipe | full mean | full err | lattice | sphere |
| --- | --- | --- | --- | --- |
| builtin | 3.62 | 14.7% | **6.89** | 5.11 |
| static | 4.75 | 19.5% | 9.92 | 6.87 |
| rotating | 3.46 | 13.7% | 7.20 | **4.87** |
| raw-rotating | 4.03 | 17.4% | 8.54 | 5.41 |
| fused-static | 7.41 | 28.7% | 15.85 | 10.29 |
| **fused-rotating** | **3.36** | **10.5%** | 7.57 | 4.99 |

- **During the sweep, fused-rotating has the least error** at every sampled frame
  from 130 to 238 (frame 190: 4.31 against 4.71 for builtin and 5.86 for
  raw-rotating). Against raw-rotating, the same SSGI pattern composited raw, the
  error fraction drops from 17.4% to 10.5%.
- **On the wires it is mid-pack:** lattice 7.57 against builtin's 6.89. Crops show
  both recipes washing the sphere's back wires under motion, which is the accumulate
  pass's thin-feature behavior; fused is slightly softer.
- **After the camera stops, fused re-converges slower**, because two stacked
  histories compound: 1.90 at frame 310 against about 1.44 for the rest. Fused-static
  is worst everywhere, because its grain is screen-anchored and decorrelates under
  motion.

### Lighting step, Q20 frame 330

At frame 330 the wire light drops to 35%. The column is the mean |Δ| against a
held-light reference over 326–398, step 4.

| recipe | mean | at 330 | at 350 | at 390 |
| --- | --- | --- | --- | --- |
| **builtin** | **3.83** | **8.92** | **4.55** | 2.23 |
| static | 4.23 | 13.93 | 4.91 | 1.64 |
| rotating | 4.40 | 14.31 | 5.20 | 1.65 |
| raw-rotating | 4.86 | 18.71 | 5.66 | **1.29** |
| fused-rotating | 4.94 | 15.26 | 5.90 | 1.75 |
| fused-static | 8.26 | 23.12 | 9.95 | 3.34 |

Lag is fusion's weak spot. The GI history can only tell a change from its noise after
the fast mean moves, which takes about 5 frames. The block stage then catches it.
Without the block stage the mean is 6.47, and with the temporal-σ box it is 6.35.
Builtin reacts fastest because its composite is spatially smooth, so the AA clip
catches the step immediately; it then has the slowest tail. With locks off, builtin
reaches 2.53 and fused 4.79, so the fused lag is in the GI history, not in locks. On
the lattice, fused trails at 12.06 against builtin's 8.30. Foreground wire pixels
read neighbor histories that the block stage only corrects as their owners update.

### Ablations, fused-rotating at the defaults

| variant | still phase | wire phase | wire ref | step mean |
| --- | --- | --- | --- | --- |
| **defaults** | 0.265 | 1.159 | 16.03 | 4.94 |
| no surface tag | 0.293 | 1.616 | 22.05 | 4.81 |
| no tonemap | 0.402 | 1.992 | 25.97 | 6.45 |
| no block anti-lag | 0.254 | 0.992 | 16.64 | 6.47 |
| temporal-σ box | 0.270 | 1.176 | 16.79 | 5.03 |
| `maxHistory` 32 | 0.311 | 1.302 | 16.25 | 4.79 |
| `maxHistory` 96 | 0.226 | 1.037 | 15.64 | 5.08 |

Without the surface tag, wire consecutive churn is lower (0.57 vs 0.78), but at the
cost of the wire bias above. Before neighbor histories shaded the foreground, the tag
raised wire phase churn to 1.48. The anti-lag box size trades still churn against lag
monotonically. At γ 2 with a 32-frame history the step mean is 4.19 and still phase is
0.35, against 4.94 and 0.265 at the defaults.

### Cost

ABBA, `timing` mode, Q14, 4 blocks each, the median of 120 frames per block:

- The `giFusion` pass takes **0.32 ms** (0.319–0.323). Accumulate takes 0.97 ms in
  the same frames.
- The upscaler's total rises by about 0.28 ms, against ±0.08 ms block-to-block spread
  that comes mostly from `reconstruct`.
- This ran in a git worktree, where absolute times read about 3× slow (CLAUDE.md),
  so only the ratio carries over. The pass costs roughly a third of accumulate.
- Not measured: `DenoiseNode`'s cost, which the fused recipe removes, and three's
  SSGI cost, which is the same in every recipe.
- Memory: two rgba16f histories, two rgba16f moment textures, two r32f tags and one
  rgba16f composite, all at render resolution. That is 48 bytes per render pixel.

### Byte identity

Feature off, `snapshot` mode: Q0, Q1, Q2, Q12 and Q14 `off` / `static` / `rotating` /
`builtin`, at frames 0, 1, 23, 31, 32, 63, 119 and 239, across every declared debug
view. That is **376 captures, all byte-identical to main.** Main against itself is
also 376/376, so the harness is deterministic.

## Recommendation: iterate, don't adopt, don't abandon

Fusion works where the issue predicted. Paired with SSGI's default rotating pattern,
it gives the cleanest walls, the most faithful GI, the least motion error and the
best lock engagement of any recipe measured. It also retires the "turn
`useTemporalFiltering` off" landmine. Three gaps keep it from replacing the 06/09
recipe:

1. **Lighting-change lag** (mean 4.94 vs 3.83). A detector on the GI signal itself
   should fix it: the shading-change detector's multi-scale block means, run on the
   demodulated signal before the history. That is the A-SVGF idea, without needing
   the sampler.
2. **Same-phase ripple** (0.26 vs 0.003, periodic). Accumulate per rotation phase,
   or weight the EMA to a whole number of SSGI cycles. Either is cheap, but it ties
   the pass to a sampler's period, which is a contract question.
3. **Sub-texel foregrounds.** The depth tag removes the bias, but wire pixels stay
   churnier than builtin's. A two-layer (foreground/background) history, or
   option A's display-resolution history, are the candidates.

**For #17 specifically, the configuration fix stands:** builtin, the 06/09 recipe, is
still the stablest image for wires today. Fusion is the direction for "GI that
converges instead of being blurred". It is not yet a drop-in.

## Open questions and what's unverified

- **Scope of the evidence.** One device (Apple Metal-3), ratio 2, 1280×720, one scene
  family (Q14/Q20), and three r186's `SSGINode` only. GTAO-only inputs, SSR and
  ray-traced GI are untried.
- **Integration surfaces.** Only the raw `Upscaler`'s monolithic `dispatch()` is
  exercised. The split `dispatchUpscale()` path shares the code but needs `depth` on
  the late call, and is untested. The TSL nodes and `UpscalePass` have no wiring.
- **Interactions.** Reactive masks, the auto-reactive generator and the alpha
  composite (it carries `color.a`) are untested with fusion on. Auto-exposure ran at
  its default (on).
- **The references are self-constructed.** The still reference is the fusion pass
  with its guards off (linear, unclamped), so it shares the depth-tag decomposition.
  The raw-path reference agrees in ranking but sits brighter.
- **Shared-chunk dependency.** The pass reads the shared constants UBO: render size,
  near/far, and the reset and perspective flags. It adds nothing to the chunk.
- **Not built:**
  - Option A (display-resolution history).
  - Using `MomentsPass`. The pass computes its moments inline, as accumulate does; a
    standalone dispatch would add a round-trip for nothing.
  - A debug view of the GI history.

## Reproduce

Bench on `--url`, defaulting to 5199. The wire mask comes from the `off` control in
the same invocation, or pass `--mask`:

```bash
# Still matrix (+ linear-mean reference, then reused via --reference-label)
node scripts/measure-gi-fusion.mjs still --scenario Q14 \
  --subruns off,builtin,static,rotating,raw-static,raw-rotating,fused-static,fused-rotating \
  --reference fused-rotating --reference-settle 1500 \
  --reference-settings '{"maxAccumulation":256,"giFusion":{"maxHistory":2048,"clampGamma":1000,"tonemap":false}}' \
  --count 105 --label final
# Camera sweep and lighting step
node scripts/measure-gi-fusion.mjs motion --scenario Q20 \
  --subruns builtin,static,rotating,raw-rotating,fused-static,fused-rotating --frames 130:310:12 --label sweep
node scripts/measure-gi-fusion.mjs motion --scenario Q20 \
  --subruns builtin,static,rotating,raw-rotating,fused-static,fused-rotating --frames 326:398:4 --label step
# Ablations: any GiFusionInputs tuning via --settings, e.g.
node scripts/measure-gi-fusion.mjs still --scenario Q14 --subruns fused-rotating \
  --reference-label final --mask bench/results/raw/gi-fusion/still-final/wire-mask.u8 \
  --settings '{"giFusion":{"surfaceTolerance":0}}' --label nosurface
# Cost (ABBA) and byte identity
node scripts/measure-gi-fusion.mjs timing --scenario Q14 \
  --subruns raw-rotating,fused-rotating,fused-rotating,raw-rotating
node scripts/measure-gi-fusion.mjs snapshot --scenarios Q0,Q1,Q2,Q12,Q14:off,Q14:static,Q14:rotating,Q14:builtin \
  --frames 0,1,23,31,32,63,119,239 --label branch --compare main   # after a --label main run on main
```

Artifacts land under `bench/results/raw/gi-fusion/`, which is git-ignored: summaries,
the wire mask, period means, and PNGs at `--keep` frames.
