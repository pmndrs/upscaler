# Babylon.js adapter (experimental)

`@pmndrs/upscaler/babylon` runs the upscaler on a Babylon.js `WebGPUEngine`. It is
the same `UpscalerCore` the three adapter wraps, with Babylon handling the
textures, the jitter and submission. It is **experimental**: the API may change
in minor releases, and it is verified on one Babylon version
(`@babylonjs/core` 9.31) on Chrome.

The live reference is [`examples/babylon/hello`](../examples/babylon/hello/main.ts):
a frame graph that renders color, depth and linear velocity at render
resolution, upscales them, and presents them through Babylon's image
processing.

## Requirements

```bash
npm install @pmndrs/upscaler @babylonjs/core
```

- `@babylonjs/core` `>=9.31.0 <10` (an optional peer dependency of
  `@pmndrs/upscaler`), on a **`WebGPUEngine`** after `await engine.initAsync()`.
  WebGL engines are rejected.
- Inputs at render resolution: linear HDR color (`rgba16float`; render with
  image processing disabled), a depth texture, and **linear** velocity.
- A camera with a finite far plane (`maxZ > 0`, `ignoreCameraMaxZ` off). The
  passes linearize depth with `minZ` / `maxZ`.

## With a frame graph

`FrameGraphUpscaleTask` is the drop-in. Put it after a
`FrameGraphGeometryRendererTask`, and feed its output to whatever presents it:

```ts
import { FrameGraphUpscaleTask, QualityMode, Upscaler } from '@pmndrs/upscaler/babylon';

const upscaler = new Upscaler({ engine, scene });
upscaler.configure({ displayWidth, displayHeight, qualityMode: QualityMode.Quality });
await upscaler.init();

// geometry: a FrameGraphGeometryRendererTask at upscaler.renderWidth × renderHeight,
// disableImageProcessing = true, with a PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE description
const upscale = new FrameGraphUpscaleTask('upscale', graph, upscaler);
upscale.camera = camera;
upscale.colorTexture = geometry.outputTexture;
upscale.depthTexture = geometry.outputDepthTexture;
upscale.velocityTexture = geometry.geometryLinearVelocityTexture;
graph.addTask(upscale);

// present: e.g. FrameGraphImageProcessingTask (fromLinearSpace, ACES) to the backbuffer
present.sourceTexture = upscale.outputTexture;
```

The task owns the jitter window. It starts the jitter when the graph is built,
ends it before each dispatch, and starts the next frame's jitter after it, so
`scene.render()` is the only per-frame call. After `upscaler.configure()`
(resize, quality or path change), rebuild the graph, because the output is
reallocated.

## Without a frame graph

The `Upscaler` class is the low-level surface, shaped like the three one:

```ts
upscaler.beginFrame();                     // jitter every material in the scene
// render color + depth + linear velocity into your render targets
upscaler.endFrame();                       // later renders this frame are unjittered
upscaler.dispatch({ color, depth, velocity, deltaTime }, camera);   // InternalTextures
// upscaler.outputTexture: an InternalTexture, display size, linear HDR
```

`dispatchGuides` / `dispatchUpscale` (the split frame), `guides`,
`resetHistory()`, `settings`, `gpuTiming` and the jitter getters behave as in
the three adapter. Published textures (`outputTexture`, `guides.*`) are Babylon
`InternalTexture`s that share the core's allocation. Bind them to a post
process, or `importTexture()` them into a frame graph.

## How it maps onto Babylon

**Jitter goes through `TAAMaterialManager`**, the material plugin Babylon's own
TAA uses. It offsets every material's clip-space position after projection, so
the camera is never modified and Babylon's velocity buffer stays jitter-free.
That is the core's motion contract, satisfied without any conversion pass.
Consequences:

- Materials whose shaders carry Babylon's plugin injection points (Standard,
  PBR) are jittered. A material without them, such as a hand-written
  `ShaderMaterial`, renders unjittered: it still upscales, but it doesn't
  reconstruct detail.
- The plugin registration is global and its constructor recompiles the scene's
  materials once, on the first jittering `configure()`. `dispose()` removes it.
- Don't combine it with Babylon's TAA pipeline (`reprojectHistory`). It uses the
  same plugin, and two temporal resolvers double-jitter anyway.

**Orientation.** Babylon's WebGPU engine draws render targets Y-flipped
(row 0 holds the bottom of the image), so a sampled render target matches
WebGL's texture convention. The adapter keeps the inputs in that layout instead
of flipping them. It applies the jitter along the flipped rows and reads motion
with `motionScale = [-1, -1]` (`BABYLON_MOTION_SCALE`): Babylon's linear velocity
is `0.5 · (previousNDC − currentNDC)`, and on a flipped target `current − previous`
in texel UV is exactly its negation. The output and the guides come out in the
same orientation, so Babylon samples them upright like any render target. A raw
consumer of `guides.dilatedMotion` should note that its `.y` grows upward.

Use the **linear** velocity texture (`geometryLinearVelocityTexture`,
`PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE`). The non-linear `geometryVelocityTexture`
packs motion into `[0, 1]` with a cube-root curve, so it can't be fed in as is.

**Depth.** Babylon's WebGPU depth already follows the core's convention: `[0, 1]`
from `minZ` to `maxZ`, or reversed under `engine.useReverseDepthBuffer`, which
the adapter reads. Bind the geometry renderer's depth texture (`depth32float`,
or a depth-stencil format) directly. The view-depth color textures aren't
depth textures and won't bind.

**Submission.** Each dispatch calls `engine.flushFramebuffer()` first. That
submits everything Babylon has recorded so far, which includes the input renders,
then the upscale goes out as its own submit. Babylon's later work in the frame
(presenting the output) follows it on the queue. The flush ends Babylon's
current render pass, which is harmless between tasks but costs one extra submit
per frame. GPU timing and the split frame work as on three, because each stage
submits.

## Babylon internals the adapter depends on

Everything is public `WebGPUEngine` / frame-graph API except two private fields,
kept in [`packages/babylon/src/internal/babylonWebGPU.ts`](../packages/babylon/src/internal/babylonWebGPU.ts).
That file throws loudly if either one changes shape:

- `engine._device`: the `GPUDevice`.
- `internalTexture._hardwareTexture.underlyingResource`: the `GPUTexture` behind a
  Babylon texture.

The allocator uses public API: `wrapWebGPUTexture()`, then
`updateWrappedWebGPUTexture()` on the same allocation, because the wrap alone
creates no sampling view. **On a Babylon upgrade, re-verify the two private
fields first**, then the render-target Y flip
(`webgpuEngine` `_ubInvertY`). If the flip went away, the jitter and motion signs
in `internal/conventions.ts` would invert.

## Verification

GPU-verified on Chrome (Apple Metal-3), Babylon 9.31, 2026-10-19:

- `examples/babylon/hello` renders on all four paths (temporal, spatial,
  bilinear, native) with no WebGPU errors.
- Motion vectors show smooth gradients, disocclusion thin trailing edges,
  and accumulation age saturating on a still scene.
- **Jitter sign.** A still frame converged against native resolution reads 14.2
  mean-abs; the same frame with the jitter sign flipped reads 16.7, which doubles
  every grid line, and bilinear reads 15.1.

Not yet covered: reactive masks, external exposure, split-frame use from a frame
graph, `ShaderMaterial`/`NodeMaterial` jitter coverage, and other GPUs.
