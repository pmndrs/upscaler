# Albedo demodulation — design draft

**Status: proposal, not started (2026-11-06).** Nothing here is implemented or
measured. It turns idea 01 from the I3D 2025 joint denoising/upscaling paper
(Kazmierczyk et al., AMD, [doi:10.1145/3728297](https://doi.org/10.1145/3728297))
into a plan for this codebase, and it is the first concrete step of the deferred
"fused GI/denoise temporal path" in `CLAUDE.md`. Numbers below marked *estimate*
are guesses to be replaced by measurements; the milestones say which run replaces
each one.

## What and why

Let an app pass an optional render-resolution **albedo** texture. When it is
present, the temporal path accumulates **irradiance** (`color ÷ albedo`) in its
history, accumulates the albedo separately in a second history, and multiplies
the two back together at display resolution before RCAS.

Texture and lighting then live in separate histories:

- **Albedo is clean** (no random rays: it is rasterized like depth), so its history
  converges like plain TAA on a noise-free signal and keeps texture detail
  super-resolved by the jitter.
- **Irradiance carries all the noise and none of the texture**, so anything that
  blurs it (long accumulation, a future spatial filter) costs no texture detail.
- **Rectification gets a cleaner signal.** Today the variance box on a textured
  surface is texture variance plus lighting variance, so a shadow edge moving across
  a busy texture hides inside the box and ghosts. In irradiance space the box only
  measures lighting.

The paper does the same split ("implicit radiance decomposition", §3.4) with a
learned composition. This design does it analytically.

### Expected payoff, honestly

Phase 1 (this document) on its own is probably **near-neutral on clean raster
scenes** (it must be: that is a gate below) and a **modest** win on noisy ones. The
large win the paper shows comes from denoising the irradiance spatially, which is
phase 2 and needs normals as well (see [Phase 2](#phase-2-out-of-scope-here)). Phase 1
is still the prerequisite: without separate histories, any spatial filter blurs
texture. If phase 1 shows no measurable win, it stays a bench-only option until
phase 2 lands, the same discipline the parity program applied (no visual win → not
adopted).

## Where the albedo comes from

Most apps that would want this already render it:

- **three:** `diffuseColor` from `three/tsl` as an MRT attachment.
  `examples/06-screenspace-gi` already does this for SSGI (`mrtInputs.diffuse =
  diffuseColor`) and composites `beauty·AO + diffuse·GI`. Example 09 has the same
  setup.
- **Path tracers:** the first-hit albedo AOV, which most path tracers output for
  their own denoisers.
- **Babylon / raw WebGPU:** any albedo G-buffer target from the same render as color.

Contract for the input (goes into `docs/inputs-and-contracts.md` when it ships):

- Same render resolution and same jittered render as `color`. An MRT attachment
  satisfies this for free.
- Noise-free, linear, `rgb` in [0, 1]. Any filterable format (`rgba8unorm` is enough).
- It is the reflectance to divide out. Diffuse albedo is the intended input; see
  [Metals and dark surfaces](#metals-and-dark-surfaces) for what happens where it is
  near zero.
- Alpha is ignored.

WebGPU caps color attachments at 32 bytes per sample. `output` + `velocity` +
`diffuse` fits in any format; with `normal` added (example 06) all four must stay
`rgba16float` or smaller.

## API

| Layer | Addition | Default |
| --- | --- | --- |
| `UpscalerConfig` | `albedoDemodulation?: boolean`. Allocation-time, like `path`: it decides which accumulate pipeline is built and whether the extra textures exist. | `false` |
| `DispatchInputs` | `albedo?: TTexture` | absent |
| `TemporalGuides` | `albedoHistory: TTexture \| null`: the accumulated display-res albedo (rgba16float, linear). A free, clean, super-resolved albedo for render-stage consumers. | `null` when off |
| three `UpscalePass` | adds a `diffuse` MRT attachment and passes it through | follows config |
| three `upscale()` node | `options.albedo` texture node, registered as a graph dependency the way `options.reactive` is | absent |
| three `upscaleScene()` | adds `diffuse: diffuseColor` to its MRT when `albedoDemodulation` is on | follows config |

Behaviour at the edges:

- **Config off:** nothing changes. The existing accumulate shader is built from the
  same source text, no textures are added, and `albedo` passed to `dispatch()` is
  ignored with a one-time warning.
- **Config on, no `albedo` this frame:** a 1×1 white texture is bound with a
  one-time warning. Effective albedo is then 1 everywhere, so the result equals the
  off path up to f16 rounding of the extra round trip (verified in M2), at the on
  path's cost.
- **Size mismatch with `color`:** `dispatch()` throws. This is new: today the core
  validates no input sizes, and the reactive mask just clamps its coordinates. Albedo
  can't follow that pattern, because a mismatched albedo would divide each pixel by
  another pixel's texture.

The three adapter must keep two landmines in mind. MRT attachments route by
texture `.name` (#1), so the attachment is named `diffuse`. The render target's
attachment count must match the MRT (#7), so temporal + albedo is `count: 3`.

## Shader design

### A second accumulate variant

`ACCUMULATE_SHADER` becomes `createAccumulateShader({ albedo })`.
`createAccumulateShader({ albedo: false })` must return the **current string
exactly**, and `ACCUMULATE_SHADER` stays exported as that value. The core picks
the variant at configure time.

Because demodulation is a separate pipeline, it needs **no new flag bit, no
`FsrConstants` field, and no change to `common.ts`**. Every other shader keeps its
current text and fingerprint, and the off path cannot regress by construction. That
is cheaper than a runtime flag inside the shared pass. (The paper-breakdown page
originally suggested bundling a UBO field; working through the bindings showed none
is needed.)

### New bindings (albedo variant only)

| Binding | Resource | Size |
| --- | --- | --- |
| 13 | albedo input, `texture_2d<f32>` | render |
| 14 | albedo history in, `texture_2d<f32>` | display |
| 15 | albedo history out, `texture_storage_2d<rgba16float, write>` | display |
| 16 | composite out, `texture_storage_2d<rgba16float, write>` | display |

Bindings 1–12 are unchanged, so `_encodeTemporal`'s existing entry list is a
prefix of the new one (bind-group order must match `@binding` order).

**Storage-texture limit:** WebGPU's default `maxStorageTexturesPerShaderStage` is
4. The current pass writes 2 (history, locks); this variant writes 4. It uses the
last slot. A future storage output in accumulate would force the alternative under
[Open questions](#open-questions) (remodulate inside RCAS instead).

Sampled textures go from 9 to 11 of the default 16.

### Math

Per tap, inside the existing 3×3 loop:

```wgsl
// Effective albedo: fade demodulation out where albedo is too dark to divide by
// (black paint, metals with diffuse ≈ 0). Below ALBEDO_LO the pixel behaves
// exactly as without demodulation.
let alb = textureLoad(albedoTex, coord, 0).rgb;
let demod = smoothstep(ALBEDO_LO, ALBEDO_HI, max(alb.r, max(alb.g, alb.b)));
let effAlbedo = mix(vec3f(1.0), max(alb, vec3f(ALBEDO_LO)), demod);

// Everything that reads `c` today (Lanczos sum, YCoCg moments, box, locks,
// still relax) now sees conditioned irradiance instead of conditioned color.
let c = tonemapInvertible(src.rgb / effAlbedo * exposure);

albedoSum += effAlbedo * w;
albedoMin = min(albedoMin, effAlbedo);
albedoMax = max(albedoMax, effAlbedo);
```

After the color blend, the albedo resolves on the same schedule:

```wgsl
let albedoCur  = clamp(albedoSum / max(weightSum, 1.0e-4), albedoMin, albedoMax);
let albedoPrev = sampleCatmullRom(albedoHistoryIn, prevUV).rgb;
// Range clamp, not a variance clip: albedo is clean, so the 3x3 range is the
// honest box. Still-scene relax as for alpha, or sub-texel texture detail
// re-snaps every jitter cycle (convergence rule 2).
let albedoRect   = mix(clamp(albedoPrev, albedoMin, albedoMax), albedoPrev, alphaRelax);
let albedoResult = mix(albedoRect, albedoCur, alpha);

textureStore(albedoHistoryOut, gid.xy, vec4f(albedoResult, 1.0));
// Remodulate in linear (exposed) space, re-condition for RCAS/blit.
let composite = tonemapInvertible(tonemapInvert(result) * albedoResult);
textureStore(compositeOut, gid.xy, vec4f(composite, 1.0));
```

The reset/off-screen early return writes the same three values from the current
frame alone.

`sampleHistoryCatmullRom` generalizes to take the texture as a parameter (WGSL
allows texture and sampler function parameters). The albedo history uses
Catmull-Rom for the same reason color does: bilinear reprojection softens texture
over time, and texture sharpness is the point.

Starting constants (*estimate*, tune in M3): `ALBEDO_LO = 0.02`,
`ALBEDO_HI = 0.08`.

### Output passes

`_encodeTemporal` binds the **composite** instead of `historyOut` as RCAS/blit
input when the variant is on. The composite has exactly the history's format and
domain (conditioned, exposed, rgb), so RCAS and blit keep their current text.
Alpha still comes from the locks buffer `.a`. Debug views keep reading
`historyOut`, whose `.a` is still the accumulation age.

Optional: a `DebugView.Albedo` that shows `albedoHistory` would help M2/M3. It
changes `debug.ts`'s text, so add it only if the verification needs it.

### What stays the same

- **Shading-change detector:** reads the color input's luma, as today. It detects
  lighting changes on the beauty frame, which is what it is tuned for.
- **Auto-exposure:** meters the color input, as today. Irradiance is brighter than
  color by about 1/mean albedo, so conditioning sits higher in the curve; see the
  exposure-ceiling question.
- **Reactive mask:** unchanged. Reactive pixels already keep almost no history.
- **Alpha:** unchanged.

## Costs

Per display pixel the variant adds 9 render-res albedo loads, 5 bilinear fetches
for the albedo history, and 2 display-res writes.

| | 1920×1080 display | 3840×2160 display |
| --- | --- | --- |
| Extra memory (2 albedo histories + composite, rgba16float) | 3 × 16.6 MB ≈ 50 MB | ≈ 199 MB |
| GPU time, *estimate* | +30–60 µs on Apple Metal at ratio 2 (the alpha passthrough, one extra fetch path, measured +14.6 µs on accumulate) | measure |

Off: zero (the variant isn't built, nothing is allocated). Measure the on-path cost
ABBA against off, with `gpuTiming: true`, in the repo checkout rather than a
worktree (worktree absolutes read ~3× slow), and report it as % plus absolute µs
with the base named.

## Risks and how each is checked

1. **Remodulation error at material edges.** Filtering irradiance and albedo
   separately and multiplying is not the same as filtering their product: where
   albedo *and* lighting change inside one display pixel, `E[a]·E[L] ≠ E[a·L]`. The
   two dering clamps also run independently. Expected small (SVGF-class denoisers
   live with it), but it is a halo risk on exactly the high-contrast edges this
   project protects. **Check:** clean raster scenes (Q0/Q1/Q12/Q18) with a real
   albedo input, on vs off. Any difference there is this error, because clean input
   gains nothing from demodulation.
2. **Thin texture features lose their locks.** A painted line or printed text is an
   albedo feature, so it vanishes from irradiance and locks never form on it. The
   albedo history only has its range clamp + still relax. **Check:** Q18
   (resolution chart) with its bars as an albedo texture under motion; compare bar
   contrast with the off path.
3. **Exposure ceiling (#49).** Conditioned history clips at `999 / exposure`
   *in irradiance*, so the colour ceiling drops to `999 · albedo / exposure`. At
   albedo 0.2 and the `EXPOSURE_MAX` of 8, a highlight above ~25 clips.
   **Check:** `scripts/measure-exposure-ceiling.mjs` with the emitters on a
   mid-grey albedo. Fix if needed by metering exposure on irradiance in the
   variant.
4. **Domain switches.** A pixel whose effective albedo changes between frames
   (material boundary moving, the `ALBEDO_LO/HI` fade) reprojects history from
   another surface's domain. Both clip boxes see the current frame's taps, so it
   behaves like a shading change. **Check:** Q4 (motion) and Q3 (rotating knots)
   disocclusion trails, on vs off.
5. **Metals and dark surfaces** — see below.

### Metals and dark surfaces

three's `diffuseColor` is `baseColor · (1 − metalness)`, so pure metals read black
and fall below `ALBEDO_LO`: they behave exactly as today. That is safe, but metals
get none of the benefit. The paper uses diffuse **and** specular albedo for this
reason. A later step could accept a combined reflectance (diffuse + a split-sum
specular estimate). Leave it until phase 1 shows the diffuse case pays off.

## Milestones

| | Work | Done when |
| --- | --- | --- |
| **M0** | Baseline before any code. Pick scenes: Q14 (SSGI-lit walls + wires), example 09's ghost band, example 06 SSGI, a Q9 variant with a textured floor (lighting steps), plus Q0/Q1/Q12/Q18 for neutrality. Record convergence (`measure-convergence.mjs`), drift lag (`measure-drift-lag.mjs`), rgba16float readbacks. A bench scene with real albedo needs a `diffuse` MRT in `BenchPipeline`. | Baseline numbers + commands in `bench/docs/NEXT-STEPS.md` |
| **M1** | Core: `createAccumulateShader`, allocation, encode, `dispatch({ albedo })`, `guides.albedoHistory`. GPU-free tests: the off variant equals the legacy string; binding order; ≤ 4 storage textures; `_encodeTemporal` entry count matches the variant. | `pnpm test`, `typecheck`, `lint` green |
| **M2** | GPU verification (headless Chrome + CDP, per `CLAUDE.md`). Off path: Q0 captures **bit-identical** to `main`. On path with the white fallback: within 1 f16 ulp of off. No WGSL/validation errors. | Hard gates pass |
| **M3** | Quality A/B on the M0 scenes. Tune `ALBEDO_LO/HI`. Measure cost ABBA. | Results + decision inputs in `NEXT-STEPS` |
| **M4** | three surfaces (`UpscalePass`, `upscale()`, `upscaleScene()`), an example-06/09 toggle, docs (`inputs-and-contracts`, `temporal-guides`, `getting-started`, `debugging`). Babylon/pixi pass-through. | Examples verified on GPU |
| **M5** | Decide: ship public, keep `_`-prefixed bench-only until phase 2, or drop. Record in `NEXT-STEPS`; a paper-worthy result goes to `PAPER-NOTES.md`. | Decision recorded |

M4 happens only if M3 says ship. Until then the config option stays an internal
`_albedoDemodulation`, never exported from an index, like the other bench knobs.

### Go / no-go gates for M5

- **Hard:** off path bit-identical; no new validation errors; storage limit respected.
- **Neutral on clean content:** Q0/Q1/Q12/Q18 on vs off within run-to-run noise on
  readback, no visible new edge halos in captures, convergence meter no worse than
  5%.
- **A win somewhere real:** less ghosting on the textured lighting-step scene
  (integrated error after the step), or less residual noise at equal texture
  sharpness on Q14 / example 09. Without one, it waits for phase 2.

## Open questions

1. **Composite texture or remodulate in RCAS?** The composite costs 16.6 MB at
   1080p and one write, and keeps RCAS/blit text untouched. The alternative, RCAS
   and blit variants that load the albedo history per tap and re-condition, saves
   the memory and the storage slot but adds 5 loads and per-tap tonemap math to the
   pass that #50 made ~35% cheaper. Start with the composite; time both if memory
   matters.
2. **8-bit albedo history?** `rgba8unorm` halves the albedo-history memory, but a
   blend weight near `1/maxAccumulation` cannot move an 8-bit value by less than
   ~8/255, so converged albedo would stall off target. Stay on rgba16float unless
   memory forces it.
3. **Should the shading-change detector read irradiance?** On textured surfaces it
   might fire more cleanly on lighting changes. It is tuned on color (SHADING_FLOOR_*),
   so this is a separate experiment after M3.
4. **Specular albedo** for metals (see above).

## Phase 2 (out of scope here)

With texture out of the irradiance history, a spatial filter on irradiance becomes
safe: a variance-guided à-trous pass with depth and normal edge-stops, between
accumulate and remodulation. That is idea 02 from the paper review, it needs a
`normal` input as well, and `MomentsPass` already supplies the per-pixel variance
such a filter weights by. It deserves its own design once phase 1 has numbers.
