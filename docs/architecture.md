# Architecture

How the library is put together, for contributors. Consumer-facing contracts are in
[Inputs and contracts](inputs-and-contracts.md) and
[Temporal guides](temporal-guides.md). The per-pass audit against FidelityFX is in
[`src/shaders/README.md`](../src/shaders/README.md). Hard-won landmines and the
rules a change must not break are in [`CLAUDE.md`](../CLAUDE.md).

## Layers

```
upscaleScene()  ──►  upscale() / UpscalerNode  ─┐
upscaleSpatial() ─►  upscale(path: 'spatial')  ─┤
temporalGuides() / TemporalGuidesNode  ─────────┤
UpscalePass  ───────────────────────────────────┼──►  Upscaler  ──►  WGSL compute passes
(your own render loop)  ────────────────────────┘
```

`Upscaler` ([`src/Upscaler.ts`](../src/Upscaler.ts)) is the only class that
touches the GPU pipeline. Every other surface is a recipe around it:
`UpscalePass` owns the render target, MRT and present quad; the TSL nodes own
graph registration and the jitter hooks. `bench/src/BenchPipeline.ts` is the
canonical example of driving `Upscaler` by hand.

## Raw WebGPU on three's device

The passes are hand-written WGSL, not TSL. That's deliberate: the shaders read like
AMD's originals, and performance stays under direct control. `Upscaler` takes
three's `GPUDevice` and the `GPUTexture`s behind three's textures
([`src/internal/threeWebGPU.ts`](../src/internal/threeWebGPU.ts)). It encodes its
passes on its own `GPUCommandEncoder` and submits them **between** three's scene render
and the presentation draw. Queue ordering on the shared device makes that correct
with no synchronization code.

Outputs and published guides are allocated as three `StorageTexture`s, then
`renderer.initTexture()` is called and the raw handle is fetched back. Passes bind
the raw handle, and consumers sample the three texture: one allocation, two views.
Storage views are pinned to one mip level, and `generateMipmaps` is off, because three
otherwise allocates a mip chain.

## The pass graph

Temporal path, per frame:

```
            render resolution                                display resolution
color ─┬─────────────────────────────────────────────┐
       │                                             ▼
depth ─┤  reconstruct ─► dilatedMotion ─┬──────► accumulate ─► history ─► RCAS (or blit) ─► output
veloc ─┘  (dilate +      dilatedDepth   │        Lanczos2 upsample        └─ debug view instead,
          depth clip)    disocclusion ──┤        Catmull-Rom history         when debugView ≠ None
                                        │        YCoCg variance clip
          generateReactive ─► reactive ─┤        locks · alpha resolve
          exposure (1×1)  ─► exposure  ─┤
          shadingChange   ─► response  ─┘
```

1. **Reconstruct** (`reconstruct.ts`): one fused render-resolution pass. Nearest-depth
   3×3 dilation of depth and motion, then disocclusion by per-bilinear-tap
   confidence voting against last frame's dilated depth, using AMD's
   viewport/depth-scaled tolerance. This is the whole early stage of a split frame.
2. **Generate reactive** (`generateReactive.ts`): only when `reactiveOpaqueColor` is
   given. It max-merges any incoming mask.
3. **Exposure** (`luminancePyramid.ts`): a single 1×1 log-average with eye
   adaptation. It also carries the external and host pre-exposure inputs.
4. **Shading change** (`shadingChange.ts`): one fused half-resolution dispatch
   comparing block-mean luma at 4×4 and 8×8 against a one-frame luma history. It is
   skipped entirely when `detectShadingChanges` is off.
5. **Accumulate** (`accumulate.ts`): the core. A jitter-aware Lanczos2 upsample of
   the current frame, Catmull-Rom history reprojection, YCoCg variance-clip
   rectification (relaxed on still, converged pixels; its cost under slow lighting
   drift is measured in [`NEXT-STEPS.md` §8](../bench/docs/NEXT-STEPS.md)),
   luminance-stability locks,
   reactive and shading-change aging, and the alpha resolve. Blending runs in
   invertible-tonemap space with a per-pixel age stored in history `.a`.
6. **RCAS** (`rcas.ts`) sharpens the conditioned history and inverts the tonemap and
   exposure once, writing caller-domain linear/HDR to the output. The conditioned
   range ends at linear infinity, so the inversion is capped at the lobe applied in
   linear space against the darkest ring tap. That keeps an isolated peak from becoming
   a ~1000× firefly, and keeps a converged HDR plateau edge near linear RCAS's overshoot
   instead of ~2× (issue #50). The cap is never looser than linear RCAS's own maximum
   gain. With
   `sharpness = 0`, **blit** (`blit.ts`) does the same resolve without sharpening.

The spatial path is EASU (`easu.ts`) then RCAS/blit; the bilinear path is blit alone.
On the spatial path RCAS conditions EASU's linear/HDR taps with the same invertible
tonemap before sharpening, because FSR1's limiter assumes [0,1] and otherwise switches
sharpening off on every edge that crosses 1.0. It then inverts once, anchored on the
linear center and under the same lobe cap, computed on the linear taps. That input has no
pre-exposure bounding it, so a plain inversion would clip near 1000 and turn isolated
peaks into fireflies.
The divergences from FSR 3.1.5's own pass graph (the fused reconstruct, the fused
shading detector, conditioned-space RCAS) were measured, not assumed; see
[PARITY.md](research/PARITY.md).

## Color domains

The input is multiplied by the conditioning exposure, then compressed with
`c / (1 + max(c))` (FSR2's invertible tonemap and firefly guard) before
accumulation. RCAS/blit invert both before writing. The spatial path sharpens in the
same tonemap space without the exposure factor (see above) and inverts before writing.
The output is therefore in the caller's domain. Host pre-exposure is a separate factor that stays in that domain,
with history corrected across its changes. Nothing in the library applies ACES, sRGB
encoding or any other presentation transform.

## Shared constants

Every pass binds one uniform buffer at `@group(0) @binding(0)`: the `FsrConstants`
struct (96 bytes of payload, in a 256-byte buffer), written once per frame. The WGSL
layout (`WGSL_CONSTANTS` in [`src/shaders/common.ts`](../src/shaders/common.ts)) and
the CPU writer ([`src/internal/ConstantsBuffer.ts`](../src/internal/ConstantsBuffer.ts))
must stay byte-for-byte in sync. A field added or reordered on one side only silently
corrupts every pass. `FLAG_*` bits in the same struct carry the per-frame feature
switches.

WGSL has no `#include`, so shared chunks are TypeScript strings deduplicated by
`assembleShader()` ([`src/shaders/wgsl.ts`](../src/shaders/wgsl.ts)). Every pass uses
8×8 workgroups, guards against grid overrun, and has the entry point `main`. The
structural tests in `src/shaders/shaders.test.ts` enforce most of this without a GPU.

## Testing and evidence

- `npm test` is GPU-free on purpose, because CI has no GPU. It covers jitter math,
  quality presets, shader-module structure and shader fingerprints. Keep new tests
  device-free.
- Real-GPU verification (bench, headless Chrome over CDP, convergence meters) is
  described in [Debugging](debugging.md#verifying-on-a-real-gpu).
- Benchmark method: [`bench/docs/BENCHMARKING.md`](../bench/docs/BENCHMARKING.md).
  Adoption record: [`bench/docs/NEXT-STEPS.md`](../bench/docs/NEXT-STEPS.md).
  Parity decisions: [`bench/docs/PARITY-DECISIONS.md`](../bench/docs/PARITY-DECISIONS.md).
  Findings worth publishing: [PAPER-NOTES](research/PAPER-NOTES.md).
