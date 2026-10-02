# Inputs and contracts

What the upscaler assumes about each input, and why. `UpscalePass` and
`upscaleScene()` satisfy most of this for you. Anything that feeds the raw
`Upscaler` or the composable `upscale()` node has to honour it by hand. A violated
input contract rarely fails loudly; it shows up as smearing, black frames or
flickering silhouettes. [Debugging](debugging.md) maps each symptom back to the
contract below.

Terminology follows the FidelityFX SDK. **Render resolution** is the reduced size the
scene is rasterized at. **Display resolution** is the output size, in physical pixels.
The **upscale ratio** is display / render, per axis.

## Summary

| Input | Resolution | Format | Required for |
| --- | --- | --- | --- |
| `color` | render | linear/HDR, filterable float (`HalfFloatType` → `rgba16float`) | every path |
| `depth` | render | a real depth texture (`DepthTexture`), single-sample | temporal, guides |
| `velocity` | render | three's `velocity` node output: jitter-free NDC delta | temporal, guides |
| `reactive` | render | red channel in `[0, 1]` | optional, temporal |
| `reactiveOpaqueColor` | render | opaque-only color, same domain as `color` | optional, temporal |
| `exposureTexture` | any (1×1 typical) | red channel of texel (0, 0), any float format | optional, temporal |
| `preExposureTexture` | any (1×1 typical) | red channel of texel (0, 0) | optional, temporal (raw `Upscaler` only) |
| `giFusion` | render | **experimental**, see [below](#experimental-gi-fusion-gifusion) | optional, temporal (raw `Upscaler` only) |
| `deltaTime` | n/a | seconds | auto-exposure adaptation |

All inputs are ordinary three textures, typically render-target attachments. The
upscaler resolves the `GPUTexture` behind each one, so a texture must exist on the GPU
before its first dispatch: render to it once, or pass it through
`renderer.initTexture()`.

## Color

- **Domain: linear, scene-referred, HDR is fine.** Feed the scene *before* tone
  mapping and output encoding. The temporal path accumulates in an invertible tonemap
  space (`c / (1 + max(c))`, FSR2's firefly guard) and inverts that before output, so
  HDR values survive. The spatial path's RCAS sharpens in that same tonemap space and
  inverts on output, so highlights above 1.0 are sharpened like any other edge. The
  output is the same domain as the input.
- **Filterable format.** The temporal path's exposure meter and the bilinear path
  sample `color` through a filtering sampler. `rgba16float` (`HalfFloatType`) always
  qualifies; `rgba32float` only does on devices exposing `float32-filterable` (three
  requests it when the adapter has it). Use `HalfFloatType`.
- **Aliased, single-sample, jittered.** The temporal path *is* the anti-aliaser.
  Turn MSAA off: a multisampled input can't bind to the compute passes, and the
  upscaler warns once if it gets one. Don't stack another temporal AA in front
  either; see [Jitter](#jitter).
- **Alpha is carried**, not discarded; see [Alpha](#alpha).

## Velocity (motion vectors)

The temporal path reprojects history with three's `velocity` node output, so velocity
must be exactly what that node produces, rendered into a named MRT attachment:

- **MRT routes by texture name.** `renderer.setMRT(mrt({ output, velocity }))` (or
  `pass.setMRT(...)`) matches outputs to attachments by `.name`. The render target's
  `textures[0].name` must be `'output'` and `textures[1].name` must be `'velocity'`.
- **Attachment count must equal MRT output count.** A `count: 2` target rendered with
  `setMRT(null)`, or with an MRT that lacks `velocity`, leaves color unwritten, and
  the output is black. Non-temporal paths use a `count: 1` target with
  `mrt({ output })`.
- **Jitter-free.** The camera is jittered for reconstruction, but motion vectors must
  describe only real motion. Otherwise every static pixel reports the jitter delta
  as motion. Hand the velocity node the upscaler's unjittered projection:
  `velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix)`. It's a stable
  `Matrix4` whose contents `beginFrame()` refreshes, so set it once. `UpscalePass` and
  the TSL nodes do this themselves. `velocity` is a global singleton, so only one
  upscaler per renderer should own it.
- **Convention.** The value is the NDC delta `current − previous`. Internally it
  becomes a UV delta via `(0.5, −0.5)` and history is fetched at `prevUV = uv − motion`,
  the same convention as three's own `TAAUNode`. Published guides use the converted
  form; see [Temporal guides](temporal-guides.md).
- Per-object motion (skinning, moving meshes) comes from the velocity node tracking
  previous model matrices. A material that bypasses the node produces per-object
  flashing in `DebugView.MotionVectors`.

## Depth

- **A real depth texture**, bound as `texture_depth_2d`: the render target's
  `depthTexture`, or `pass.getTextureNode('depth')`. A color texture holding linear
  depth won't bind. Combined depth-stencil formats work, because the upscaler binds a
  depth-only view. `FloatType` depth (`depth32float`, as `UpscalePass` allocates)
  gives the most precision for disocclusion.
- **Projection-aware.** Depth is linearized from the camera's `near`/`far`, using
  `isPerspectiveCamera` to tell perspective from orthographic, and
  `renderer.reversedDepthBuffer` to choose standard or reversed depth. Pass the camera
  that rendered the frame.
- **Not supported:** logarithmic depth (`logarithmicDepthBuffer`) has no
  linearization path, and multisampled depth won't bind.

## Jitter

Each frame the projection is offset by a sub-pixel amount from a Halton(2,3) sequence
of `8 · ratio²` phases (FidelityFX's `ffxFsr2GetJitterPhaseCount`): 18 at 1.5×, 32 at
2×. A still scene therefore delivers a supersampled image over time, which is what the
temporal path integrates. The offset is applied through the camera's view offset
(`camera.view`), the same mechanism as three's TRAA. `beginFrame(camera)` applies it
and `endFrame(camera)` removes it.

- **An app-set view offset is preserved.** If the camera already has a view offset
  (tiled or multi-screen rendering with `camera.setViewOffset(fullWidth, fullHeight,
  x, y, width, height)`), the jitter composes on top of it, scaled by
  `width / renderWidth` so it stays exactly one render pixel. `endFrame()` restores
  `camera.view` to precisely what it was before `beginFrame()`: no offset stays none,
  and an app offset keeps its values. A perspective camera's `aspect` is never touched.
  `unjitteredProjectionMatrix` includes the app's offset and excludes only the jitter,
  so motion vectors stay correct. Non-jittering paths (`spatial`, `bilinear`,
  `jitter: false`) never touch the view offset. three's own `traa()`/`taau()`
  still clear an app offset.

- **The input must be re-rendered under the jitter every frame.** Jitter buys
  reconstruction only if the color you dispatch was rendered with this frame's
  offset. If it wasn't (a buffer filled outside the jitter window, a pre-rendered
  target), reprojection assumes an offset the image doesn't have, and history smears.
  Set `jitter: false` (`UpscalerConfig.jitter`, or `upscale(…, { jitter: false })`)
  for such inputs. The temporal path still reprojects, rectifies and accumulates; it
  only skips the sub-pixel offset and the reconstruction it buys.
- **Defaults.** Jitter is on for `UpscalePass`, `upscaleScene()`, `upscale()` and the
  raw `Upscaler`. `upscaleSpatial()` forces it off, because the spatial path has no
  history to reconstruct into.
- **One jitter owner per pipeline.** On r186+ the TSL node claims three's
  render-pipeline view-offset ownership. If another node (`traa()`, `taau()`) already
  owns it, `upscale()` warns once and runs unjittered rather than double-jittering.
  Remove the other temporal AA: stacking two temporal resolvers smears, and the
  upscaler already anti-aliases (`QualityMode.NativeAA` is temporal AA at ratio 1).
- **Effects with their own temporal patterns.** An input effect that rotates its
  sampling pattern per frame expecting a TRAA behind it defeats the variance clip at
  silhouettes and ghost-streaks off moving edges. Three's `SSGINode` does this by
  default (`useTemporalFiltering = true`). Set it to `false` when the upscaler is the
  temporal resolver, as examples 06, 09 and 10 do. The same holds for a denoiser that
  re-rolls its kernel every frame: `recurrentDenoise({ accumulate: false })` keeps no
  history but still feeds fresh noise each frame, which thin features show as boiling
  (issue #17). `DenoiseNode` on the static pattern converges.

## Reactive masks

Transparent surfaces, particles and animated textures have no reliable depth or motion,
so their history ghosts. A reactive mask tells the temporal path to favour the current
frame there: flagged pixels suppress locks, keep near-zero accumulation, and snap to the
current color.

- **Explicit:** `reactive`, a render-resolution texture whose red channel is in
  `[0, 1]`. Author it by rendering your transparents' coverage. It must be aligned with
  `color`, which means rendered under the same jitter.
- **Generated:** `reactiveOpaqueColor`, a render of the same frame with transparents
  hidden. The upscaler derives the mask from the opaque-vs-final difference (FSR2's
  `GenerateReactiveMask`). Jitter the opaque render like the final one, or
  high-contrast edges pick up false reactivity from the sub-pixel misalignment.
- **Both:** the explicit mask **merges** with the generated one (per-pixel `max`); it
  is never overwritten. In that combination the explicit mask must not be
  `guides.reactive` itself, because the generator writes that texture, and the
  upscaler throws.
- **Absent:** a 1×1 zero texture is bound and the reactive branch is flag-gated off.
- Surfaces: `dispatch({ reactive, reactiveOpaqueColor })` on the raw `Upscaler`,
  `UpscalePass.setReactiveMask()` / `setReactiveOpaqueColor()`, and
  `upscale(…, { reactive, reactiveOpaqueColor })` on the node, where they render
  in-graph and jittered. References: `examples/05-transparency` (imperative, both
  modes) and `examples/11-node-reactive` (node).
- Inspect with `DebugView.Reactivity`.

FSR2/3's separate Transparency & Composition mask is not implemented. The reactive
path covers the common three.js transparency case, and a second channel with
distinct, tuned behaviour would be added only on evidence that reactive is
insufficient for real content.

## Exposure

Two different exposure concepts exist, and confusing them is a common integration
error.

**Conditioning exposure** keeps accumulation well-conditioned across scenes of very
different brightness. The temporal path multiplies the input by it before the
invertible tonemap, then divides it back out before output, so **it never changes
final brightness**. Three sources, in increasing priority:

1. `settings.exposure` (fixed), used when `settings.autoExposure` is `false`.
2. Auto-exposure (default): a log-average of the scene, eased over time
   (`deltaTime` drives the adaptation rate).
3. `exposureTexture`: the red texel of an app-supplied texture overrides both. Use it
   when your pipeline already meters exposure. Available on `dispatch()` and as the
   `upscale()` node's `exposureTexture` option. It mirrors FSR3's `exposure`
   resource.

**Host pre-exposure** (`preExposureTexture`, raw `Upscaler` only) is different: it
declares an exposure factor your app has *already baked into* the input color. That
factor is part of your color domain, so it is **preserved** at output. The upscaler
tracks its frame-to-frame ratio and corrects reprojected history across a change (FSR3's
`DeltaPreExposure`), so stepping or ramping your exposure doesn't read as a full-screen
shading change. Auto-exposure meters with it divided out, so it doesn't chase a step
you already applied. Omitting it is equivalent to `1`.

Don't pass a host pre-exposure as `exposureTexture`. The upscaler would divide it out
at output and apply no history correction.

## Experimental: GI fusion (`giFusion`)

A research prototype for issue [#7](https://github.com/pmndrs/upscaler/issues/7), on
the raw `Upscaler`'s temporal path only. It is not a supported contract; the API may
change or disappear. Leave it unset and nothing is compiled, allocated or dispatched.
With it set, `color` is the **base** lighting only (direct light, emissive, and so on),
and `giFusion` carries the noisy GI separately:

| Field | Resolution | Format |
| --- | --- | --- |
| `signal` | render | indirect irradiance in `.rgb`, linear, pre-albedo (e.g. `SSGINode`'s GI texture) |
| `albedo` | render | diffuse albedo in `.rgb` |
| `occlusion` | render | optional AO in `.r`; scales `color` |

The upscaler accumulates the signal in its own history, using its motion vectors,
disocclusion and a depth tag per surface. It then composites
`color · occlusion + albedo · signal` into the color the rest of the temporal path
consumes, which is three's SSGI composite. `depth` must be passed to the same
dispatch. Design, measurements and the current recommendation (iterate, don't
adopt) are in [GI history fusion](research/GI-HISTORY-FUSION.md).

## Output

- `outputTexture` is a three `StorageTexture` at display resolution: `rgba16float`,
  `NoColorSpace`, linear/HDR, in the same domain as `color`. Sample it like any
  texture.
- **The upscaler never applies tone mapping, an output transfer function, or any other
  presentation transform.** When a TSL node is the pipeline's final output node,
  three's `RenderPipeline` applies the renderer's `toneMapping` and
  `outputColorSpace`; `UpscalePass.present()` renders through the same output
  transform. Otherwise the result can feed later linear post-processing.
- The texture belongs to the upscaler and is reallocated by `configure()`. Re-read it
  after a resize; the TSL nodes and `UpscalePass` re-point their samplers themselves.

## Alpha

Every path upscales **RGBA**. The input's alpha is filtered and accumulated
alongside color rather than replaced with 1.0, so a transparent canvas stays
transparent through the upscale. This is the same convention as three's
`FSR1Node`. EASU runs one kernel over all four channels. RCAS sharpens color and
passes coverage through. The temporal path resolves alpha with the accumulate pass's
own jitter-aware taps and blend weight, and stores it in the locks buffer's spare
`.a` channel (the history's `.a` holds the accumulation age). An opaque input
(alpha 1 everywhere) resolves to alpha exactly 1. There is no option to turn this
off, and none is needed.

> **Behaviour change from 0.2.** Earlier versions wrote alpha 1.0 everywhere.
> Three's `WebGPURenderer` defaults to `alpha: true` and clears to alpha 0, so a
> scene with no `scene.background` (and no opaque clear color) presented through
> `UpscalePass` or the TSL nodes now **shows the page through its empty regions**,
> exactly as three does without the upscaler. For an opaque result, set
> `scene.background`, call `renderer.setClearColor(color, 1)`, or create the renderer
> with `alpha: false`.
>
> A post graph that scales the upscaled `vec4` by a scalar now scales alpha too.
> `upscale(…).mul(vignette)` fades the frame edges to transparent; multiply by
> `vec4(vec3(vignette), 1)` to darken color only, as `examples/08-tsl-compose` does.

A hand-rolled present must keep alpha. A full-screen quad needs
`transparent: true` (an opaque material resolves alpha to 1) and `NoBlending` (a
present is an overwrite, not a composite). `UpscalePass.present()` already does both,
and the TSL nodes need nothing special. References: `examples/14-pathtracer-alpha`
(spatial path, path-traced RGBA behind a transparent canvas) and
`examples/15-transparent-canvas` (temporal path, coverage reconstructed from jitter).
