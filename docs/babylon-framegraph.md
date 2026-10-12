# Babylon.js Frame Graph adapter

`FrameGraphUpscaleTask` provides temporal, spatial and bilinear paths. It is tested
with `@babylonjs/core@9.29.0`; its initial peer range is `~9.29.0`. Required engine
internals live in `src/babylon/compatibility.ts`, guarded by version and WebGPU checks.

## Setup and lifecycle

Construct with a name, Frame Graph and options containing configuration, a
`frame` callback and optional settings. `FrameGraphUpscaleConfiguration.path`
defaults to `temporal`; `spatial` runs EASU/RCAS and `bilinear` resizes color.
The core's guides-only path is not a separate task path.

Assign `colorTexture` for all paths, plus `depthTexture` and `velocityTexture`
for temporal. Spatial/bilinear accept color alone and apply no jitter.
Optional inputs are `reactiveTexture`, `reactiveOpaqueColorTexture`,
`exposureTexture` and `preExposureTexture`. Add the task before the consumer
of `outputTexture`; await `graph.buildAsync()` before first execution.

Render inputs with `task.jitter`. `beginFrame(camera)` saves the projection,
composes jitter and freezes it. `endFrame()` restores the projection and its prior
frozen state. Wrap scene/graph execution in `try/finally`; reset after an abandoned
frame. `unjitteredProjectionMatrix` supplies the projection for motion calculations.

The host renders scenes, produces motion/exposure and converts depth.
The [analytic example](https://github.com/pmndrs/upscaler/blob/main/examples/18-babylon-framegraph/main.ts) makes those
inputs explicit. Engine-specific integration policies stay with the caller.

The texture manager owns intermediate, history and dummy textures. Each history
has one handle; `getTextureFromHandle(handle, false/true)` resolves read/write.
No extra swap occurs. All input/working handles appear in render-pass dependencies,
which Babylon 9.29's lifetime analysis reads. The bridge closes the active render
pass before compute and retrieves the engine encoder. It neither creates a second
encoder nor submits work; submission and end-of-frame handling stay with the engine.

An unprepared task refuses execution. Await `prepare()`, `graph.buildAsync()` or
`whenReadyAsync()`. Optional debug/shading pipelines are also prepared for varying
frame settings. `disabled = true` writes a defined bilinear output to the same
handle and invalidates history; reenabling forces reset.

After resize or variant changes, configure, await preparation and rebuild the graph.
Reconstruction releases prior intermediate handles. Host texture replacement needs
updated dependencies and reset. Reset after abandoning an encoder as well.
Device loss requires a new working engine/device. Advanced `babylonWebGPU` exposes
the guarded bridge for host compute tasks.

When Babylon restores the same engine, recreate the graph and upscaler task only
after WebGPU initialization completes and the engine exposes a replacement device.
In 9.29.0, `onContextRestoredObservable` can fire before the asynchronous `initAsync`
restoration finishes; the observable alone is not a readiness barrier. Keep graph
execution suspended until initialization resolves, then prepare the new task.

A host migration must confirm depth units/background, motion sign/space, unjittered
projection, reactive coverage, both exposure domains, dynamic dimensions, task
ordering and HDR presentation.

## Mesh examples

| Example | Integration |
| --- | --- |
| [19 — Hello](https://github.com/pmndrs/upscaler/blob/main/examples/19-babylon-hello/main.ts) | Animated opaque meshes and motion |
| [20 — Aliasing](https://github.com/pmndrs/upscaler/blob/main/examples/20-babylon-aliasing/main.ts) | Thin geometry and subpixel detail |
| [21 — Native](https://github.com/pmndrs/upscaler/blob/main/examples/21-babylon-compare/main.ts) | Unjittered display-resolution reference |
| [22 — Transparency](https://github.com/pmndrs/upscaler/blob/main/examples/22-babylon-transparency/main.ts) | Transparent meshes and reactivity |
| [23 — Spatial/temporal](https://github.com/pmndrs/upscaler/blob/main/examples/23-babylon-spatial-temporal/main.ts) | Separate spatial/temporal inputs |
| [24 — Composition](https://github.com/pmndrs/upscaler/blob/main/examples/24-babylon-compose/main.ts) | Frame Graph vignette after upscale |
| [25 — Authored mask](https://github.com/pmndrs/upscaler/blob/main/examples/25-babylon-reactive-mask/main.ts) | Depth-tested transparent coverage |
| [26 — Transparent canvas](https://github.com/pmndrs/upscaler/blob/main/examples/26-babylon-transparent-canvas/main.ts) | Alpha reconstruction over HTML |
| [27 — Screen effects](https://github.com/pmndrs/upscaler/blob/main/examples/27-babylon-screen-effects/main.ts) | Native SSAO or SSR |
| [28 — Effect stack](https://github.com/pmndrs/upscaler/blob/main/examples/28-babylon-effect-stack/main.ts) | SSAO, SSR and HDR bloom |
| [29 — Guides](https://github.com/pmndrs/upscaler/blob/main/examples/29-babylon-temporal-guides/main.ts) | Disocclusion, dilated depth/motion |
| [30 — Shared guides](https://github.com/pmndrs/upscaler/blob/main/examples/30-babylon-guides-compose/main.ts) | Color modification before upscale |

Scenes/UI are shared in `examples/shared/babylon`. The pages adapt Three examples'
purpose rather than TSL materials. NativeAA uses temporal at display resolution.
Default dimensions use canvas CSS pixels. Examples 23–26 adapt Three 02, 08, 11
and 15. In 23, the selector changes the right half; the left keeps spatial filtering.

`FrameGraphGeometryRendererTask` produces opaque HDR color, R32F view depth and
`PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE`. A host compute pass normalizes inputs:

- Babylon 9.29 offscreen WebGPU targets are inverted vertically. Flip color,
  depth, motion and reactive inputs together to top-left origin.
- Raw motion is `0.5 * (previousNDC - currentNDC)`, including jitter. After flipping
  texels, UV motion is `(-raw.x, raw.y) +
  (jitterCurrent - jitterPrevious) / renderSize`, with `motionScale = (1, 1)`.
  First frame after reset writes zero motion.
- Background depth zero becomes finite positive `camera.maxZ`; mesh depth stays linear.
- Example 22 compares opaque and complete RGB with threshold `0.04`, factor `2`
  and ceiling `0.9`. Disabling writes zero without changing dependencies.
  This reactive mask is a demo heuristic.

Example 25 instead renders transparent meshes white under the color jitter,
with opaque depth, depth testing enabled and writes disabled. Coverage reaches
one. “Show mask” displays the texture supplied to the core. Transparency renders
complete color separately to preserve an opaque reference. Native comparison
uses another unjittered camera at display resolution, flips its presentation
texture and applies the same Reinhard/gamma transform. These additional renders
compare images; they do not measure core performance. Mesh exposure is one;
example 18 exercises varying exposures.

Spatial comparison renders separate unjittered low-resolution color and flips it
before EASU/RCAS. `ColorEffectTask` owns a separate output and explicit input
dependency. Its vignette preserves alpha without changing history; zero strength
preserves exact input color.

Transparent targets clear to RGBA zero. Presentation unpremultiplies HDR by coverage
before Reinhard/gamma, then premultiplies for canvas `premultipliedAlpha`.
Checkerboard, backgrounds and text are HTML/CSS behind the canvas. The presenter
rebuilds on size/ratio changes, restores projection in `finally` and disposes on
exit. Device loss asks for reload. Asynchronous bootstrap without top-level await
allows Babylon lazy shader chunks to load in production.

## Screen effects and split guides

27/28 use native `FrameGraphSSAO2RenderingPipelineTask`,
`FrameGraphSSRRenderingPipelineTask` and `FrameGraphBloomTask`, processing the
G-buffer in Babylon orientation before normalization. View normals/reflectivity
complement geometry; raw motion is RG16F to fit the default MRT budget.
Geometry depth stays R32F through the core. Native effects use a filterable
RGBA16F depth copy with background 120 and a valid normal, avoiding undefined
SSAO reconstruction at zero. Only effect depth precision is reduced in this
short-range demo. Dependencies include textures read by Babylon's SSR blur combiner.

SSAO is occlusion, not diffuse SSGI. SSR only sees visible surfaces. Bloom is
spatial; the upscaler is the stack's only temporal reconstruction. The experimental
SSGI denoiser and Three path tracer are not ported.

Temporal `task.guides` exposes stable handles: `dilatedDepth`, `dilatedMotion`,
`disocclusion`. Disocclusion R equals one to reject history; motion is UV in RG.
Depth is **current write history**: raw consumers use
`babylonWebGPU.resolveBabylonTexture(manager, handle, true)`. Babylon consumers
select `history.write` and declare every read handle as a dependency.

```ts
// Geometry inputs are produced before these tasks.
graph.addTask(upscale.createGuidesTask());
graph.addTask(colorFromGuides); // Reads guides and writes a separate color handle.
upscale.colorTexture = colorFromGuides.outputTexture;
graph.addTask(upscale);
```

`createGuidesTask()` is idempotent and shares preparation/allocation with the owner.
Record guides before consumers and final upscale. The `frame` callback runs at
both stages: index, jitter and geometry agree; color/exposure may be finalized
afterwards. Final upscale records only the late stage; without a guides task
it retains complete encoding. Split encoding requires temporal.

Wrap execution in `beginFrame(camera)` / `endFrame()` with `finally`. Interrupted
split frames invalidate history at `endFrame()`; otherwise reset explicitly.
Configure between frames and rebuild. Disable the **owning upscale task**:
guides continue, final output becomes bilinear and reenabling resets history.
Do not disable the guides task independently.

29 displays published guides. 30 applies orange tint from shared disocclusion;
it is a diagnostic, not a denoiser. Disabled tint preserves exact color and alpha.

## Verification

`npm run verify:babylon-examples:gpu` builds the production gallery and runs Chrome
with WebGPU, publishing nothing. Reports/captures go to ignored
`output/playwright/babylon-scenes/`. `PAGES_BASE=/upscaler/` checks Pages URLs too.

Chrome / RTX 5080 checks on October 7, 2026 covered twelve mesh pages: finite RGB/
depth, orientation, jitter-free static motion, mesh/camera motion, reactive toggles,
bilinear/temporal, reset, odd dimensions, NativeAA and alias optimization on/off.
Mobile layout was checked at 390 pixels. Additional assertions cover spatial output,
active/neutral vignette, coverage one, zero/opaque/fractional alpha, SSAO/SSR/bloom
toggles, published guides and composition before upscale. Effect comparisons freeze
the scene without jitter; SSR compares RGB regions. Copies are encoded before
the first await to read one frame; dilated motion checks RG (B stores relief).

See [current evidence and limits](webgpu-validation.md), including RX 580 results.
Functional checks are not a benchmark or evidence for untested mobile GPUs.
