# Temporal guides

The raw core exposes `encodeGuides()` / `encodeUpscale()` with adapter-owned
textures; see [WebGPU core](webgpu-core.md) for the frozen split-frame contract.
Babylon exposes stable `FrameGraphUpscaleTask.guides` handles and
`createGuidesTask()` for guide consumers before the final upscale. The current
depth guide resolves to native `history.write`; see
[Babylon Frame Graph](babylon-framegraph.md#effets-écran-et-guides-partagés).
The remainder of this page documents the compatible Three bundle and TSL nodes.

Dilated motion, dilated depth and disocclusion are **frame properties, not upscaler
properties**. Every temporal effect upstream of the upscaler needs them: SSGI/SSR
temporal reprojection, SVGF-class denoisers, any TAA-class pass. Without a shared
source, each re-derives its own copy, usually a worse one. The upscaler computes
them anyway, so it publishes its working set as the **temporal guides** bundle, and
lets the frame run split so the geometry guides exist *before* the final color does.

This page is the maintained contract for that bundle. The authoritative per-field
documentation is the `TemporalGuides` type in [`src/types.ts`](../src/types.ts); this
page explains how the pieces fit and why. Live references are
`examples/12-temporal-guides` (raw split dispatch) and `examples/13-guides-node`
(TSL).

The contract is accepted. An external SSGI/SVGF consumer replaced its private
temporal front-end with the raw bundle and measured bit-identical still-camera
stability, with matching reconvergence after a teleport. The linked TSL surface is
verified at the npm package boundary by `scripts/verify-packed-guides.mjs`: shared
ownership, stable guide-node identity, and a steady-state split frame with no
monolithic fallback. No independent TSL consumer has exercised it yet.

## The two-stage frame

The seam is set by the data. **Geometry products are signal-agnostic and need only depth +
velocity**; everything else needs the final beauty color.

```
frame start ── last frame's products are readable (dilatedDepth still holds frame N−1)
  ├─ G-buffer: depth + velocity rendered
  ├─ dispatchGuides()     EARLY  reconstruct + depth clip: dilatedMotion, dilatedDepth, disocclusion
  ├─ effects run, sampling the guides
  ├─ final beauty color available
  ├─ dispatchUpscale()    LATE   reactive → exposure → shading change → accumulate → RCAS
  └─ present
```

- `dispatch()` is exactly the early stage followed by the late stage, on one command
  encoder and one submit. The split only exists if you call the halves yourself.
- Queue ordering on three's shared device makes each stage's writes visible to work
  submitted after it. No explicit synchronization is needed.
- **Late products are frame N−1 priors for anything that runs before the late stage.**
  Locks, history age and shading change derive from final color by construction (FSR's
  own locks are luminance-based), so no implementation can provide them same-frame to a
  pass that runs before final color exists. For a history-rejection consumer,
  last frame's state is the correct prior anyway.

## The bundle

`upscaler.guides` is a `TemporalGuides` object of ordinary three textures, usable as TSL
`texture()` nodes or through raw bind groups. It is available after `configure()` on the
`temporal` and `guides` paths; the getter throws on the others.

| Product | Resolution | Format | Meaning | Valid |
| --- | --- | --- | --- | --- |
| `dilatedMotion` | render | rgba16float, `.xy` | Closest-depth-dilated motion as a **UV delta**, y-flip applied: `prevUV = uv − motion` | after `dispatchGuides` |
| `dilatedDepth` | render | r32float, nearest only | Dilated linear view depth (eye-Z), reversed depth already resolved | after `dispatchGuides` |
| `previousDepth` | render | r32float, nearest only | The same, frame N−1 | after `dispatchGuides` (before it, `dilatedDepth` is frame N−1) |
| `disocclusion` | render | rgba8unorm, `.r` | Graded `0` stable → `1` fresh history | after `dispatchGuides` |
| `reactive` | render | rgba8unorm, `.r` | Merged reactive mask target (see below) | late; `null` on `guides` |
| `shadingChange` | ⌈render / 2⌉ | r32float, nearest only | `0..1` shading-change response per 2×2 block | late; `null` on `guides` |
| `exposure` | 1×1 | rgba16float | `r` conditioning exposure, `g` metered average luma of the beauty input, `b` host pre-exposure | late; `null` on `guides` |
| `lockStatus` | **display** | rgba16float | `r` lock lifetime, `g` locked luma (conditioned tonemap space), `b` shading-change age, `a` resolved caller alpha | late, N−1 prior; `null` on `guides` |
| `history` | **display** | rgba16float | `rgb` accumulated color in conditioned tonemap space (not display-ready), `a` accumulation age in frames | late, N−1 prior; `null` on `guides` |

Rules a consumer must follow:

- **Re-read the getters every frame.** `dilatedDepth`/`previousDepth`, `exposure`,
  `lockStatus` and `history` are ping-ponged. The getters resolve to the
  most-recently-written half, both mid-frame (between the split dispatches) and after
  the frame. A texture reference cached across frames is a stale half every other
  frame. For TSL `texture()` nodes, re-point `node.value` each frame, as example 12
  does; `temporalGuides()` does this for you.
- **r32float products are not filterable.** Use `textureLoad` or a nearest sampler.
  They ship with `NearestFilter` set; a linear sampler on them is a WebGPU validation
  error.
- **Spaces are labelled for a reason.** `exposure.g` is metered on the beauty input,
  which is the wrong space for GI statistics. `lockStatus.g` and `history.rgb` are in
  conditioned tonemap space. Use [`MomentsPass`](#momentspass) for signal statistics.
- **Undocumented channels are reserved** (for example `dilatedMotion.zw`). Spare
  channels get repurposed: `lockStatus.a` became the resolved alpha.
- **`configure()` reallocates every guide.** Re-read after a resize or path change. The
  textures belong to the upscaler, and `dispose()` releases them.
- `shadingChange` is only written while `settings.detectShadingChanges` is on, because
  the detector pass isn't dispatched otherwise.
- **The jitter isn't a guide.** Render-resolution products were sampled under this
  frame's jitter; read it from `upscaler.jitter` / `jitterPhase` (or an `upscale()`
  node's `jitterNode`) — see [Jitter](inputs-and-contracts.md#jitter). The `guides`
  path never jitters, so there it reads `(0, 0)`.

## Raw split frame

```ts
import { velocity } from 'three/tsl';

upscaler.configure({ displayWidth, displayHeight, customUpscaleRatio: 2, path: 'temporal' });
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

// per frame
upscaler.beginFrame(camera);
/* render the G-buffer (depth + velocity MRT, plus whatever your effects need) */
upscaler.endFrame(camera);
upscaler.dispatchGuides({ depth: gbuffer.depthTexture!, velocity: gbuffer.textures[1], deltaTime }, camera);
/* effects sample upscaler.guides.dilatedMotion / .disocclusion / .dilatedDepth … */
upscaler.dispatchUpscale({ color: beautyColor, deltaTime }, camera); // + reactive / exposure inputs
```

- A split frame is in flight between the two calls (`upscaler.guidesPending`). Inside it,
  `dispatch()` and a second `dispatchGuides()` throw; finish with `dispatchUpscale()`.
  `dispatchUpscale()` without a preceding `dispatchGuides()` throws too.
- Frame-end bookkeeping (ping-pong flips, the history reset) happens once per frame: in
  `dispatch()`, in `dispatchUpscale()`, or, on the `guides` path, in `dispatchGuides()`.
- `upscaler.gpuTimings` reports both submits together: the early stage's timings are held
  until `dispatchUpscale()`'s submit reads back, so the map never shows half a frame.

## Guides-only path

An app that never upscales can still have the geometry guides:
`configure({ path: 'guides', … })` allocates only the early working set, and
`dispatchGuides()` is the whole frame. There's no color input, no jitter, no history
and no output: `outputTexture`, `dispatch()` and `dispatchUpscale()` throw with an
explanation, and the late products are `null`.

## TSL: `temporalGuides()`

`temporalGuides(depth, velocity, camera)` publishes the bundle into a `RenderPipeline`
graph as texture nodes. `guides.getTextureNode(name)` returns a **stable** node: it is
created once, and ping-ponged products are re-pointed to the fresh half every frame, so
you can capture it at graph-construction time. Consuming a guide node pulls the guides
dispatch into the graph in dependency order.

### Standalone mode

With no upscale in the graph, the node owns a `guides`-path upscaler sized to its depth
input:

```ts
const guides = temporalGuides(scenePass.getTextureNode('depth'),
                              scenePass.getTextureNode('velocity'), camera);
pipeline.outputNode = myEffect(scenePass.getTextureNode('output'),
                               guides.getTextureNode('disocclusion'));
```

Only the early products are live. Sampling a late product warns once and reads black.

### TSL linked mode

Pass the guides node to `upscale()` and both share **one** upscaler. The guides node
dispatches the early stage as soon as depth and velocity have rendered, effects in the
graph consume the products, and the upscale node finishes the split frame. The early
stage (reconstruct + depth clip) runs once and serves both, and every product, including
the late N−1 priors, is live:

```ts
const guides = temporalGuides(depth, velocity, camera);
const effected = myEffect(color, guides.getTextureNode('disocclusion'));
pipeline.outputNode = upscale(effected, depth, velocity, camera, { guides });
```

- Hand the guides node the **same** depth, velocity and camera as `upscale()`.
- `upscale()` registers the guides node as a graph dependency *before* the color
  chain, so its dispatch precedes the effect renders that sample it.
- If the early stage couldn't run in a frame (inputs not yet GPU-backed, or a
  reconfigure), the upscale node falls back to the monolithic `dispatch()` so the
  frame still completes.

## Reactive is bidirectional

The reactive mask is merged, never overwritten:

- With `reactiveOpaqueColor`, the generator writes `guides.reactive` and max-merges
  any incoming `reactive` mask into it. The incoming mask must then be a *different*
  texture; passing `guides.reactive` itself throws, because the generator writes it.
- Without `reactiveOpaqueColor`, an effect may write reactivity into `guides.reactive`
  (it's storage-writable) between `dispatchGuides` and `dispatchUpscale`, then pass
  that same texture as `dispatchUpscale({ reactive })`.
- An explicit `reactive` mask on its own binds directly, and `guides.reactive` is not
  written that frame.

## `MomentsPass`

The statistics half an SVGF-class denoiser needs, as a standalone primitive with
**no coupling to the upscaling pipeline**. It doesn't read or write anything inside
`Upscaler`, and has its own constants buffer and pipeline.

```ts
import { MomentsPass } from '@pmndrs/upscaler';

const moments = new MomentsPass({ renderer });
moments.configure({ width, height, space: 'ycocg' }); // or 'linear' (default)
await moments.init();
moments.dispatch({ source: giTexture });              // per frame, any float texture
// moments.moments        rgba16float, source size:   .rg = (s, s²) per texel
// moments.coarseMoments  rgba16float, ⌈size / 4⌉:   .rg = 4×4 block means of (s, s²)
```

- The scalar is either Rec.709 luma of `.rgb` in the caller's linear domain
  (`'linear'`; a single-channel source reads through unchanged) or YCoCg Y
  (`'ycocg'`). It makes no exposure, tonemap or albedo assumption, so it runs on
  pre-albedo GI irradiance as readily as on scene color.
- Outputs are `rgba16float` with `.rg` used, because `rg16float` isn't a core WebGPU
  storage format. `.ba` is reserved. There is exactly one coarse level.
- Per texel the pass writes the raw moments `(s, s²)`. Variance is `E[x²] − E[x]²`
  once you accumulate those over time (SVGF's temporal moments). The coarse level
  gives a spatial estimate for short-history pixels directly.
