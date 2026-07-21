# FSR3-BRIEF.md — how the FSR3 port should decompose to flow with this pipeline

Audience: the agents working on Dennis's separate FSR3-for-three.js port. That
repo stays self-contained; this brief defines the *decomposition and contracts*
so its internals can be produced early and consumed by effects (SSGI temporal,
denoisers) well before the upscale — instead of shipping as one monolith that
only runs last.

## The architectural thesis (why decompose)

Disocclusion, dilated motion vectors, reactivity, and history validity are
**frame properties, not upscaler properties**. FSR3 computes them internally
and hides them; meanwhile every temporal effect upstream (our SSRT3 temporal
pass, bilateral denoisers, any TAA) re-derives worse versions privately. The
port should expose FSR3's early data products as standalone passes with clean
texture contracts, so one computation feeds everything. See
`advantagous-concepts.md` ("temporal guides") for the consumer-side motivation.

## Required decomposition (pass boundaries, not a monolith)

1. **Reconstruct & dilate** (early — immediately after G-buffer):
   - in: depth, motion vectors, prev depth
   - out: `dilatedVelocity` (closest-depth 3×3 dilation), `dilatedDepth`,
     `disocclusionMask` (graded 0..1, depth-reprojection based — NOT binary)
2. **Locks / reactivity** (early-mid):
   - in: luma, history, app-provided reactive hints
   - out: `reactiveMask`, `lockStatus` (or nearest FSR3 equivalents)
3. **Accumulate + upsample** (late): consumes 1+2 plus color; owns history.
4. **RCAS sharpen** (last): consumes 3 only.

Each pass = explicit input/output textures with documented formats and a
uniform block; no pass reaches into another's internals. Passes 1–2 must be
runnable WITHOUT 3–4 (that is the whole point): an app that never upscales can
still run them as its temporal-guides provider.

## Contracts this bench expects (the "temporal guides" bundle)

Produced once per frame, post-G-buffer, pre-effects:

| texture | format (suggested) | contents |
|---|---|---|
| `dilatedVelocity` | rg16float | closest-depth-dilated NDC delta |
| `disocclusion` | r16float | graded disocclusion 0 (stable) .. 1 (fresh) |
| `historyLength` | r16float | per-pixel valid-history frame count N |
| `reactive` | r8unorm | app/effect-flagged fast-changing pixels |

Notes:
- `historyLength` may be produced by the consumer instead (demo 03 already
  maintains one for frame-count accumulation); the contract just names it.
- `reactive` flows the other way too: GI/multibounce passes can WRITE into it
  (fast-changing GI ⇒ don't lock/ghost) — design the pass to accept an
  optional pre-populated mask and merge rather than overwrite.

## three.js r185 / WebGPU environment facts (traps we already paid for)

- `PostProcessing` is deprecated → `RenderPipeline`; after reassigning
  `outputNode` you MUST set `needsUpdate = true` or the graph silently keeps
  rendering the old output.
- Velocity convention (three MRT `velocity`): ndc delta; UV reprojection is
  `prevUV = uv - velocity.xy * vec2(0.5, -0.5)` (TRAANode convention).
- Compute/raw passes: top-left UV origin, y-down. Anything derived from Unity
  or Shadertoy (y-up) needs the y-mirror at the screen-step seam — this bug
  cost us the demo 03 "box-top speckle" hunt; check every direction that is
  used in BOTH view space and screen space.
- Raw WGSL passes never allocate GPU textures: allocate as three
  RenderTarget/StorageTexture, bridge via `renderer.backend.get(...)`
  (isolated in one file, see `bench/src/harness/three-internals.ts`), so
  outputs stay consumable as TSL `texture()` nodes.
- Camera jitter: `setViewOffset` (TRAANode convention); harness helpers exist
  (`bench/src/harness/temporal.ts`, Halton(2,3)).
- Known port bug from earlier work: **ACES tonemapping baked into RCAS** —
  RCAS must be tonemap-agnostic (sharpen in the same space FSR3 specifies,
  don't embed a display transform; three applies output encoding itself).
  Shadertoy-derived passes similarly must not carry a trailing `pow(x, 0.45)`.

## Verification expectations (same discipline as this bench)

- Headed browser only for WebGPU verification (headless chromium = software
  adapter = black canvas). `--enable-unsafe-webgpu`, no Vulkan flag on macOS.
- Each pass verified standalone with a scripted capture before integration;
  numbers recorded with config + commit (see TESTING.md methodology).
- The bench will consume passes 1–2 in a lab (demo 10 extension) A/B-ing
  guides-fed SSGI temporal vs its private logic — that lab is the acceptance
  test for the decomposition being real and not cosmetic.

## Addendum — data products SVGF wants (denoiser as first-class consumer)

Motivation: the bench is adding an SVGF-style GI denoiser (variance-guided
à-trous). Its temporal front-end is *identical* to FSR3's, and its missing
half (per-pixel variance) reuses FSR3's luminance-statistics machinery. This
addendum expands the decomposition so the port serves the denoiser directly.
See `advantagous-concepts.md` (SVGF-style variance moments) for the
consumer-side motivation; the bench SVGF lab is the acceptance test for the
statistics primitive below being real and not cosmetic.

**The one rule that governs this addendum — signal & space.** FSR3's
frame-property outputs (motion, disocclusion, depth, history length) are
*signal-agnostic*: correct for any temporal consumer. Its luminance-derived
products are NOT — they live on tonemapped display-luminance of the full
beauty, in FSR3's exposure/YCoCg conventions, sometimes at display res. SVGF
variance must live on **GI irradiance: pre-albedo, linear HDR, render res**.
So the denoiser consumes FSR3's *geometry/frame data* directly, but must NOT
consume its *luminance buffers* — it reuses the luminance *pass* on a
different input. Every luma-derived output MUST carry a space label so a
consumer cannot mis-apply display-luma to a linear-HDR denoiser.

### A. Promote three internals into the published contract

These already exist inside passes 1–2 but aren't in the consumed bundle. SVGF,
the SSGI march, and the temporal pass each re-derive them privately today;
publish once.

| texture | format (suggested) | contents | space |
|---|---|---|---|
| `dilatedDepth` | r32float | closest-depth 3×3 dilated depth (from pass 1) | linear eye-Z |
| `prevDepth` | r32float | previous frame's depth (pass-1 owns the copy) | linear eye-Z |
| `lockStatus` | rg16float | FSR3 lock state / trust (or nearest equivalent) | unitless |

- `prevDepth`: the bench maintains ≥3 private copies right now
  (`ssrt-copydepth.wgsl`, `ssrt12-copydepth.wgsl`, guides-commit). One
  published copy retires all of them.
- `lockStatus` feeds SVGF as an anti-ghost / history-rejection prior; if the
  port has no clean lock equivalent, omit rather than approximate.

### B. The reusable statistics primitive (SVGF's missing half)

FSR3 already computes luminance moments/pyramids for its own stability and
neighborhood-clamp logic. SVGF's variance stages want the SAME computation on
a DIFFERENT signal. Factor it as a signal-agnostic pass, not a beauty-hardcoded
internal:

    Pass: MomentPyramid (or nearest FSR3 luma-pyramid refactor)
      in:
        source      : any texture (FSR3 passes beauty-luma; SVGF passes GI)
        space       : enum { linear-irradiance, tonemapped-display, ycocg }
        channel     : which channel(s) form the scalar "luminance"
      out:
        moments     : rg16float  — (E[x], E[x^2]) per pixel  → Var = E[x^2]-E[x]^2
        pyramid     : optional mip chain of the above (spatial fallback,
                      short-history pixels borrow a coarser level)

    Contract: the pass reads `source`/`space` as parameters and hardcodes
    NO exposure/tonemap/albedo assumption. FSR3 instantiates it on beauty-luma
    for its stability term; the bench instantiates the same code on pre-albedo
    GI irradiance for SVGF variance. One primitive, two consumers — the guides
    thesis applied to statistics instead of geometry.

If the accumulate stage already tracks a per-pixel accumulation weight /
confidence distinct from `historyLength`, expose it too (`r16float`) — SVGF
consumes it as a variance prior for freshly-accumulated pixels.

### C. What SVGF does NOT need from the port (avoid over-serving)

- **The à-trous / spatial wavelet filter** — SVGF builds its own; RCAS is a
  display-res sharpen at the wrong stage and is not a substitute.
- **Reconstructed-from-depth normals** — the bench has real G-buffer view
  normals (`normalView`); FSR3's depth-reconstructed normals are strictly
  worse. Do not consume them.
- **Any display-res or post-tonemap luminance buffer** — see the space rule;
  wrong signal, wrong space for GI denoising.

### D. Reactive is bidirectional here too

SVGF is a `reactive` PRODUCER as well as a consumer: high GI variance ⇒ flag
reactive (fast-changing GI shouldn't lock/ghost in the upscaler). Same
merge-not-overwrite contract as the base `reactive` note above.

### E. Verification

- The `MomentPyramid` primitive is verified standalone: instantiate on a known
  synthetic input, assert `Var = E[x^2]-E[x]^2` matches a CPU reference within
  tolerance, in BOTH a linear and a ycocg space, before any denoiser consumes
  it. Numbers recorded with config + commit per TESTING.md.
- The SVGF lab (bench, demo-13 candidate) A/Bs variance-guided denoise vs the
  current fixed-radius bilateral — that lab is the acceptance test for this
  addendum's statistics primitive being real and not cosmetic.
