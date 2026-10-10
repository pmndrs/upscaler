# Compatibility and limitations

## Engine entry points

`/core` has no engine dependency. `/babylon` targets `@babylonjs/core@9.29.0`
with a peer range restricted to 9.29.x, guarded private accesses in
`src/babylon/compatibility.ts`, and native Frame Graph history rotation.
The root and `/three` preserve the Three integration described below. Engine
peers are optional; importing `/babylon` does not require Three and importing
`/core` requires neither engine. See [WebGPU core](webgpu-core.md),
[Babylon Frame Graph](babylon-framegraph.md) and the recorded
[validation limits](webgpu-validation.md).

## three.js versions

| three | Status |
| --- | --- |
| **r186+** | **Supported.** Developed and GPU-verified on r186.1. |
| r184, r185 | **Deprecated.** They still work. The TSL nodes warn once and fall back to the pre-r186 render-pipeline hooks; that fallback will be removed. |
| r187 | Not yet released. Known changes are tracked in [#23](https://github.com/pmndrs/upscaler/issues/23). |
| < r184 | Unsupported (the peer dependency is `three >= 0.184.0`). |

**Why the line is at r186.** three r186 removed `RenderPipeline.context`, the slot
the TSL node used to apply sub-pixel jitter before the pipeline renders
([#19](https://github.com/pmndrs/upscaler/issues/19)). On r186 and later the node
registers through the TSL events `OnBeforeRenderPipeline` / `OnAfterRenderPipeline`
and claims the pipeline's view-offset ownership, so only one node jitters the camera.
The events are feature-detected at runtime, so the same build still runs on r184/r185
through the old slot. The imperative surfaces (`Upscaler`, `UpscalePass`) don't use
render-pipeline hooks and aren't affected.

**What a three upgrade can break.** The upscaler dispatches raw WebGPU on three's
device, so it depends on two private internals: `renderer.backend.device` (the
`GPUDevice`) and `renderer.backend.get(texture).texture` (the `GPUTexture` behind a
three texture). They are isolated in
[`src/internal/threeWebGPU.ts`](../src/internal/threeWebGPU.ts), which throws loudly
if their shape changes, rather than limping along. They were verified on r184 and
re-verified on r186.1.

## WebGPU

- **WebGPU backend required.** There is no WebGL fallback, and none is planned: the
  pipeline is WGSL compute. If three falls back to WebGL, the upscaler throws at
  `init()`. Await `renderer.init()` first, configure the desired path, then await
  `upscaler.init()`. Raw dispatch no longer compiles synchronously.
- **Browsers:** Chrome/Edge 113+. Other engines work to the extent their WebGPU
  implementation does; the project's GPU verification runs on Chrome.
- **`timestamp-query`** is optional and only used when GPU timing is opted into
  (`gpuTiming: true`; off by default). Without it, `upscaler.gpuTimings` stays empty
  and nothing else changes. It's often missing on mobile.
- **Measured hardware.** The original performance/quality program used Apple Metal.
  The [Windows cross-device audit](windows-cross-device.md) adds NVIDIA and Intel
  coverage, with explicit adapter identity and noise limits. Treat figures as
  specific to their recorded workload and hardware; mobile tilers remain unverified.

## Out of scope by design

- **Frame generation** (the other half of "FSR3"). It needs swapchain-level frame
  pacing, which browsers don't expose.
- **MSAA input.** The temporal path is the anti-aliaser; a multisampled input is
  redundant, can't bind to the compute passes, and triggers a warning.
- **Stacking another temporal AA** (`traa()`, `taau()`) with the upscaler. Two temporal
  resolvers double-jitter and smear. When another node already owns the camera jitter,
  `upscale()` warns once and runs unjittered.
- **Presentation transforms.** The upscaler never tone maps or encodes output; that
  stays with the renderer or post graph.

## Current limitations

- **Logarithmic depth** (`logarithmicDepthBuffer`) has no linearization path.
- **Transparency & Composition mask.** FSR2/3's second mask is not implemented; the
  reactive mask (explicit or auto-generated) covers the common three.js transparency
  case. It's deferred until real content shows reactive is insufficient.
- **Second temporal denoisers in front of the upscaler** can't work as a stack. Any
  separate temporal resolver reprojects with jitter-free velocity, so it rejects the
  jittered history (noise survives) and cancels the jitter variance the upscaler needs
  (aliasing returns). `examples/10-ssgi-denoise` documents this. Use spatial-only
  denoising and let the upscaler own the temporal resolve.
- **Tuning constants** in the temporal path (locks, shading-change floors,
  auto-exposure, the still-scene relax) are measured defaults, not laws. They're not
  exposed as settings; the feature toggles in `RuntimeSettings` are.
- **Host pre-exposure** (`preExposureTexture`) is available only on the raw `Upscaler`,
  not on `UpscalePass` or the TSL nodes.
