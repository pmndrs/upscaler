# Engine contract

What `UpscalerCore` (`@pmndrs/upscaler/core`) needs from whoever drives it: a raw
WebGPU app, or an engine adapter like the three `Upscaler`. The core runs the
passes on your `GPUDevice` and knows nothing about scenes, cameras or texture
classes. Everything engine-specific stays on your side of this contract.
[Inputs and contracts](inputs-and-contracts.md) explains *why* each input looks
the way it does, from the three adapter's side. This page states the same rules
in engine-neutral terms.

The executable reference is
[`examples/webgpu/hello`](../examples/webgpu/hello/main.ts): a few hundred lines of
plain WebGPU (no engine) that render a scene and run every path through the core.

## The shape of an integration

```ts
import { UpscalerCore, QualityMode } from '@pmndrs/upscaler/core';

const core = new UpscalerCore({ device });            // your device, never ours
core.configure({ displayWidth, displayHeight, qualityMode: QualityMode.Quality, path: 'temporal' });
await core.prepare();                                  // async pipeline compile

// per frame
const jitter = core.beginFrame();                     // null off the temporal path
// render color + depth + motion at core.renderWidth × core.renderHeight,
// projection offset by `jitter`, motion vectors without it
core.encode(encoder, { color, depth, velocity, deltaTime }, { near, far, perspective: true });
// sample core.output (display size, linear/HDR) when presenting
```

## Device

- **Bring your own.** `UpscalerCore({ device })` takes the engine's `GPUDevice`, so
  the passes share its queue. The core never creates, configures or destroys it.
  `dispose()` frees only what the core allocated.
- **Limits.** `UpscalerCore.isSupported(device)` checks the baseline (13 bindings
  per group, 9 sampled and 3 storage textures per stage, and so on). Every
  WebGPU-conformant device passes it at default limits, so you don't need to
  request higher ones.
- **Optional features.** With `timestamp-query` on the device, `gpuTiming: true`
  fills `core.gpuTimings`. Without it the timer silently does nothing. Nothing else
  is feature-gated.
- **Device loss.** After `device.lost` resolves, `isReady` turns false and
  dispatches throw `UpscalerNotReadyError` (`reason: 'device-lost'`). Recreate
  the core on the new device.

## Lifecycle

1. `configure(config)` sizes everything for a display resolution and a path. It
   reallocates the output and the guides, and drops history. Call it again on
   resize or on a path change, then re-read `output` and `renderWidth` /
   `renderHeight`.
2. `await prepare()` compiles the path's pipelines. Until `isReady` is true, every
   `dispatch*` / `encode*` throws `UpscalerNotReadyError`, so skip the upscale in
   the frames before that.
3. Per frame: `beginFrame()`, render your inputs, then one of `dispatch` / `encode`
   (or the split pair, below).
4. `resetHistory()` on a camera cut or teleport. Passing `reset: true` in the
   inputs does the same for one frame.
5. `dispose()` when done.

`core.settings` is the live `RuntimeSettings` object (sharpness, auto-exposure,
debug view…). It is read every frame and held by reference: mutate it, or pass
your own via the `settings` option.

## Inputs

Every input is a `GPUTexture` on the core's device, created with
`TEXTURE_BINDING` usage and a single sample (the core warns once on a
multisampled input; it can't bind). All render-resolution inputs are exactly
`renderWidth × renderHeight`.

| Input | Format | Notes |
| --- | --- | --- |
| `color` | filterable float, `rgba16float` recommended | Linear, scene-referred; HDR is fine. Before tone mapping and output encoding. Alpha is carried through. |
| `depth` | a depth format (`depth32float`, `depth24plus`, `depth24plus-stencil8`, …) | Bound as `texture_depth_2d`. A stencil format is fine: the core binds a depth-only view. |
| `velocity` | float, motion in `.xy` (`rg16float` / `rgba16float`) | See [Motion](#motion). |
| `reactive` | float, `.r` in `[0, 1]` | Optional. 1 = trust this frame over history. |
| `reactiveOpaqueColor` | as `color` | Optional. The opaque-only render; the core derives a reactive mask from its difference to `color`. |
| `exposureTexture` | float, `.r` of texel (0, 0) | Optional. Overrides auto/fixed conditioning exposure. |
| `preExposureTexture` | float, `.r` of texel (0, 0) | Optional. Exposure already baked into `color`; history is corrected when it changes. |

`depth` and `velocity` are required on the `temporal` and `guides` paths; `bilinear`
and `spatial` read only `color`. `deltaTime` (seconds) drives exposure adaptation.

## Camera: `FrameCamera`

Each dispatch takes the camera facts the passes need, as plain data:

```ts
{ near: number; far: number; perspective: boolean; reversedDepth?: boolean }
```

- **`near` / `far`** are positive view-space distances. The core linearizes depth
  with them, so they must match the projection that rendered `depth`. An infinite
  far plane isn't supported. Pass a finite `far`.
- **`perspective`**: `false` for orthographic.
- **Depth convention.** WebGPU depth, in `[0, 1]`. Standard: 0 at near, 1 at far
  (`depthCompare: 'less'`, cleared to 1). Reversed (`reversedDepth: true`): 1 at
  near, 0 at far. Logarithmic depth, or depth written to a color texture, is not
  supported. A different convention needs a new linearization path in core, not a
  conversion in the adapter.

The non-temporal paths never read these values, but they must still be finite.

## Jitter

`beginFrame()` advances the Halton sequence and returns this frame's offset, or
`null` when there is nothing to apply (the `spatial` / `bilinear` / `guides` paths,
or `jitter: false` in the config). The core is the single source of the jitter.
The values you apply are the ones the shaders reconcile history against, so never
generate your own.

The offset is in render pixels, `[-0.5, 0.5]` per axis, **x right, y down**. The
sample for render texel `(i, j)` moves to `(i + 0.5 + x, j + 0.5 + y)` in the
unjittered image, so the *projection* shifts the opposite way. In clip space, after
the projection:

```wgsl
clip.x += (-2.0 * x / renderWidth) * clip.w;
clip.y += ( 2.0 * y / renderHeight) * clip.w;   // clip y is up
```

That is a translation by `(−2x / renderWidth, 2y / renderHeight)` pre-multiplied
onto the projection matrix. It is the same as three's
`camera.setViewOffset(w, h, x, y, w, h)`. Getting the sign wrong doesn't fail
loudly: it doubles every edge into a blurred pair, about as bad as bilinear.
`core.jitter`, `core.jitterPrevious` and `core.jitterPhase` read the same values
at any time during the frame.

Re-render the inputs under this frame's jitter every frame. A buffer rendered with
a different offset (or none) reprojects as if it had this one, and history smears.

## Motion

`velocity.xy` is the screen-space motion of each pixel's surface since the previous
frame, as **NDC delta, current − previous**, with NDC y up:

```wgsl
velocity = currentClip.xy / currentClip.w - previousClip.xy / previousClip.w;
```

- **Jitter-free.** Compute both endpoints with the *unjittered* projections. Only
  the rasterized position gets the jitter, so a static pixel reports exactly zero.
- **Per object.** The previous position uses last frame's model matrix (and
  skinning), not just last frame's camera.
- **Other conventions:** `motionScale` (default `[0.5, -0.5]`) converts your
  vectors to a UV delta: `prevUV = uv − velocity · motionScale`. A UV-space, y-down
  engine passes `[1, 1]`. A pixel-space engine passes
  `[1 / renderWidth, 1 / renderHeight]`, with the sign that makes
  `prevUV = uv − motion` hold. Pixels with no geometry (sky) may report 0.

`DebugView.MotionVectors` should show smooth gradients under camera motion and no
per-object noise. Check it first when history smears.

## Published textures and the allocator

The core publishes the output and the [temporal guides](temporal-guides.md) as
textures your engine samples. The `allocateTexture` option decides what they are:

```ts
type TextureAllocator<THandle> = (desc: {
    label: string; width: number; height: number;
    format: 'r32float' | 'rgba8unorm' | 'rgba16float';
}) => { gpu: GPUTexture; handle: THandle; destroy(): void };
```

- **Default:** `device.createTexture()`, with the `GPUTexture` itself as the handle.
  This is what a raw WebGPU app wants.
- **Adapter:** wrap your engine's texture type, so that `core.output` and
  `core.guides.*` come back as engine textures (`UpscalerCore<THandle>`). The three
  adapter allocates a `StorageTexture` and returns the `GPUTexture` behind it. Passes
  bind `gpu`, your engine samples `handle`, and the two must be **the same
  allocation**.
- **Requirements on `gpu`:** exactly the requested size and format, one mip level,
  one sample, `TEXTURE_BINDING | STORAGE_BINDING` usage. `r32float` isn't filterable,
  so the engine must sample those with a nearest sampler or `textureLoad`.
- Internal working textures nobody else reads (scratch buffers, the second half of
  each ping-pong pair) stay raw `device.createTexture()` allocations and never reach
  the allocator.

`core.output` is display-sized `rgba16float`, in the same linear/HDR domain as
`color`, with the input's alpha. Tone mapping, output encoding and presentation are
yours. Re-read `output` and `guides` after `configure()`, since both reallocate.
Ping-ponged guides resolve to the half most recently written, so re-read them each
frame.

## Submission and ordering

The core does no explicit synchronization. It relies on WebGPU queue order, so the
only rule is to keep the work in order on the queue: inputs, then the upscale, then
whatever samples the output.

- **`dispatch(inputs, camera)`** encodes into its own command encoder and submits
  immediately. Submit your scene render first. This is the only form `gpuTiming`
  measures.
- **`encode(encoder, inputs, camera)`** records into *your* encoder and never
  submits. Encode it after the scene pass and before the pass that samples the
  output, outside any pass, then submit once. `examples/webgpu/hello` sends scene,
  upscale and present in one submit.
- **One frame in flight per core.** The passes share one constants buffer, which is
  written with `queue.writeBuffer` at encode time. Submit an `encode*()` call's
  encoder before the next `encode*()` / `dispatch*()` call on the same core.
- **Split frame.** `dispatchGuides` / `encodeGuides` runs the geometry stage (depth +
  motion → the early guides), and `dispatchUpscale` / `encodeUpscale` finishes with
  color. Effects that want the guides run in between. With the `encode` forms,
  submit the guides encoder before calling `encodeUpscale`, for the same
  constants-buffer reason.
- **Engines with an open render pass.** The core encodes compute passes, so an
  engine that keeps a render pass open across its frame (Babylon, for one) must
  close it before handing over its encoder, or dispatch on its own encoder after
  flushing the engine's.

## Adding an engine adapter

An adapter is thin. Logic that doesn't need the engine belongs in core, where every
engine shares it. Per engine, an adapter:

1. **Finds the device:** the engine's `GPUDevice` (three:
   `renderer.backend.device`).
2. **Resolves textures:** engine texture → `GPUTexture` for each input (three:
   `renderer.backend.get(texture).texture`). These are usually private engine
   internals. Keep every such accessor in one file that throws loudly when the shape
   changes, as `packages/three/src/internal/threeWebGPU.ts` does.
3. **Allocates:** a `TextureAllocator` that returns engine textures sharing the
   `GPUTexture` the core binds (three: `internal/textureAllocator.ts`).
4. **Fills `FrameCamera`** from the engine's camera and depth convention.
5. **Applies jitter:** offsets the engine camera's projection by `beginFrame()`'s
   result, restores it after the render, and keeps the engine's motion vectors on
   the unjittered projection.
6. **Converts motion** with `motionScale`, or documents the convention it needs
   from the app.

Package layout and rules: [Architecture](architecture.md#the-engine-seam). An
adapter that can't supply motion vectors or jitter yet ships the `spatial` path
first, which needs only `color`.
