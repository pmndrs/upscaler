# Getting started

The package exports `/core` without engine dependencies, `/babylon` for Babylon
9.29.x, and `/three` plus the compatible root for Three.js. Start with
[WebGPU core](webgpu-core.md) or [Babylon Frame Graph](babylon-framegraph.md)
for those integrations. Engine peer dependencies are optional. These entry points are proposed additions;
validate a locally packed archive before release.

The rest of this guide covers the four Three integration surfaces.
What the inputs must contain (velocity, depth, jitter,
reactive masks, exposure, alpha) is specified in
[Inputs and contracts](inputs-and-contracts.md); read that before shipping an
integration, because most upscaler bugs are input bugs.

## Requirements

- **three.js `WebGPURenderer` on the WebGPU backend.** The passes are WGSL compute
  shaders dispatched on the renderer's own `GPUDevice`. There is no WebGL path: if
  three falls back to its WebGL backend, the upscaler throws when it initializes.
  Await `renderer.init()` before constructing anything from this package.
- **three r186 or newer.** r184 and r185 still work but are deprecated. See
  [Compatibility](compatibility.md) for the version policy and the known
  limitations.
- A browser with WebGPU (Chrome/Edge 113+).

```bash
npm install @pmndrs/upscaler three
```

## Choose an integration

All four surfaces run the same `Upscaler` underneath. They differ only in who renders
the inputs and who applies the jitter.

| You have… | Use | Live reference |
| --- | --- | --- |
| A scene, and you render with a `RenderPipeline` (TSL post-processing) | [`upscaleScene()`](#upscalescene-the-one-line-node) | `examples/07-tsl-node`, `08-tsl-compose` |
| A reduced-resolution effect graph (SSGI/SSR/GTAO composited at low res) in a `RenderPipeline` | [`upscale()`](#upscale-the-composable-node) | `examples/09-kitchen-sink`, `11-node-reactive` |
| Only a color texture, no depth or motion | [`upscaleSpatial()`](#upscalespatial-color-only) | `examples/16-spatial-node`; spatial path: `14-pathtracer-alpha` (raw), `02-fsr1-vs-fsr3` (toggle) |
| A plain render loop with no post-processing graph | [`UpscalePass`](#upscalepass-the-imperative-drop-in) | `examples/01-hello` … `05-transparency`, `15-transparent-canvas` |
| Your own render-target loop, split frames, or inputs the other surfaces don't expose | [`Upscaler`](#upscaler-the-raw-api) | `examples/06-screenspace-gi`, `12-temporal-guides`, `14-pathtracer-alpha` |
| Other temporal effects that should share the upscaler's motion/disocclusion data | [`temporalGuides()` / `upscaler.guides`](temporal-guides.md) | `examples/12-temporal-guides` (raw), `13-guides-node` (TSL) |

Run the examples locally with `npm run examples` (port 5300), or browse the
[example gallery](https://pmndrs.github.io/upscaler/).

The upscaler's output is **linear/HDR** on every surface. It applies no tone mapping and
no output transfer function, so presentation stays your renderer's job. The snippets
below set `ACESFilmicToneMapping` + `SRGBColorSpace` because the examples do, not
because the upscaler needs them.

## `upscaleScene()`: the one-line node

```ts
import * as THREE from 'three/webgpu';
import { upscaleScene, QualityMode } from '@pmndrs/upscaler';

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
scene.background = new THREE.Color(0x10141a); // opaque output; see "Alpha"

const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = upscaleScene(scene, camera, { quality: QualityMode.Quality });

renderer.setAnimationLoop(() => pipeline.render());
```

`upscaleScene` builds a `pass(scene, camera)` with an `{ output, velocity }` MRT at
`1 / ratio` of the drawing-buffer size and hands its texture nodes to `upscale()`.
Because that pass is a dependency of the node, three renders it *inside* the pipeline
render, after the node has applied this frame's sub-pixel jitter to the camera. The
jitter therefore lands on the scene, and you get reconstruction beyond render
resolution rather than a smart blur. There's no MRT, jitter or velocity wiring to do.

Options: `quality` (a `QualityMode`, default `Quality` = 1.5×) or `ratio` (overrides
`quality`), `jitter` (default `true`), `path`, and the input options listed under
`upscale()` below.

`THREE.PostProcessing` is the pre-r183 name of `RenderPipeline`. It still works, with
a deprecation warning from three; the examples all use `RenderPipeline`. The factories return
an `UpscalerNode` (a `vec4` node, typed like three's own `fsr1()`/`traa()`), so it
assigns to `outputNode` and composes (`.mul(…)`) without a cast.

## `upscale()`: the composable node

Use this node when the low-resolution input is the output of other effects. It takes
reduced-resolution color, depth and velocity texture nodes, and it outputs the
display-resolution result:

```ts
import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity } from 'three/tsl';
import { upscale } from '@pmndrs/upscaler';

const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, velocity }));
scenePass.setResolutionScale(0.5); // you choose the input resolution
// …composite SSGI/SSR/GTAO onto the reduced-res color here → composedColor…

pipeline.outputNode = upscale(
    composedColor,
    scenePass.getTextureNode('depth'),
    scenePass.getTextureNode('velocity'),
    camera,
);
```

- **The caller controls input resolution.** The node reads the input texture's actual
  size every frame and upscales it to the renderer's drawing-buffer size. `ratio` and
  `quality` only size `upscaleScene`'s own pass.
- **The inputs render in-graph.** Every input node (and `reactive`,
  `reactiveOpaqueColor`, `exposureTexture`) is registered as a graph dependency, so
  three renders the whole chain in dependency order before the upscale runs. Hand the
  node a node chain; don't render the inputs yourself.
- **Jitter defaults on**, because in-graph inputs render under the node's jitter.
  Pass `{ jitter: false }` only when the input is *not* re-rendered in this pipeline
  each frame, such as a `texture()` you fill in your own loop. Otherwise history lands
  on the wrong texels and smears. With jitter off, the node still reprojects,
  accumulates and denoises; it just doesn't reconstruct sub-pixel detail. See
  [Jitter](inputs-and-contracts.md#jitter).
- **Optional inputs:** `reactive` (a mask), `reactiveOpaqueColor` (auto-generated mask),
  `exposureTexture`, and `guides` (a linked `temporalGuides()` node; see
  [Temporal guides](temporal-guides.md#tsl-linked-mode)). Host pre-exposure is not
  exposed on the node; use the raw `Upscaler` for it.
- **Runtime settings:** the node creates its `Upscaler` lazily on first build.
  After that, `node.upscaler.settings` holds the knobs
  ([Runtime settings](#runtime-settings)), and `node.upscaler.resetHistory()` drops
  history on a camera cut.

## `upscaleSpatial()`: color only

```ts
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { upscaleSpatial } from '@pmndrs/upscaler';

pipeline.outputNode = upscaleSpatial(pass(scene, camera).getTextureNode('output'));
```

`upscaleSpatial()` runs the single-frame FSR1 path: EASU, then RCAS. It needs no depth,
no velocity, no camera and keeps no history, so it can't reconstruct detail beyond the
input. It is a good edge-aware upscale of the frame you give it. If you have depth and
jitter-free velocity, `upscale()` is strictly better.

The input can also be a texture you fill outside the pipeline, such as a path tracer's
output or your own render target, wrapped in `texture()`. The node sizes itself from
whatever it receives. `examples/16-spatial-node` shows both inputs, with RCAS
`sharpness` / `rcasDenoise` controls (`node.upscaler.settings`) and HDR highlights.

## `UpscalePass`: the imperative drop-in

`UpscalePass` packages the whole imperative recipe: a render target with correctly
named MRT attachments, an attachment count that matches the MRT, jitter-free velocity,
float depth, and a present quad that keeps alpha. It turns "scene + camera" into an
upscaled texture without a post-processing graph.

```ts
import { UpscalePass, QualityMode } from '@pmndrs/upscaler';

const upscalePass = new UpscalePass(renderer); // after await renderer.init()

function resize() {
    const dpr = renderer.getPixelRatio();
    upscalePass.configure({
        displayWidth: Math.floor(innerWidth * dpr), // physical pixels
        displayHeight: Math.floor(innerHeight * dpr),
        quality: QualityMode.Performance, // 2× per axis
    });
}
resize();
await upscalePass.init();
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); resize(); });

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    upscalePass.renderScene(scene, camera, timer.getDelta()); // draw() + present()
});
```

- `draw(scene, camera, dt)` renders and upscales into `outputTexture` without
  presenting. Use it with `outputTexture` for split views, custom composites, or
  feeding another pass. `present()` draws the full-screen quad through the renderer's
  output transform; while a debug view is on, it skips the tone mapping for that draw
  (see [Debugging](debugging.md#reading-debug-values)).
- `configure()` reallocates the render target and resets history. Call it on resize
  and when changing quality or path. `path` accepts `'temporal'` (default),
  `'spatial'` or `'bilinear'`; `'guides'` throws because there's nothing to present.
- `applySettings(partial)` merges into `upscaler.settings`. `setReactiveMask(tex)` and
  `setReactiveOpaqueColor(tex)` feed the reactive inputs to the next `draw()`.
- `three`'s `velocity` node is a singleton, and its projection override is global. Pass
  `new UpscalePass(renderer, { shareVelocityMatrix: false })` for every pass but one
  when several share a renderer.
- `UpscalePass` doesn't expose `exposureTexture` or `preExposureTexture`. Drive
  `pass.upscaler` (the raw API) directly if you need them.

## `Upscaler`: the raw API

Use the raw class when you composite in your own render-target loop, need the split
guides frame, or need an input the other surfaces don't expose. This is the recipe
`UpscalePass` wraps:

```ts
import * as THREE from 'three/webgpu';
import { mrt, output, velocity } from 'three/tsl';
import { Upscaler, QualityMode } from '@pmndrs/upscaler';

const upscaler = new Upscaler({ renderer });
// Configure first so only the selected path is prepared.
upscaler.configure({
    displayWidth, displayHeight,           // physical pixels
    qualityMode: QualityMode.Quality,      // or customUpscaleRatio, or renderWidth/renderHeight
    path: 'temporal',
});
await upscaler.init();

// Render target at RENDER resolution. Attachment names route the MRT outputs and the
// attachment count must equal the MRT output count.
const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
depthTexture.type = THREE.FloatType;
const rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
    count: 2,
    type: THREE.HalfFloatType,
    depthTexture,
});
rt.textures[0].name = 'output';
rt.textures[1].name = 'velocity';
const sceneMRT = mrt({ output, velocity });

// Motion vectors must be jitter-free (stable instance, refreshed by beginFrame).
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

function frame(dt: number) {
    upscaler.beginFrame(camera);   // applies this frame's sub-pixel jitter
    renderer.setMRT(sceneMRT);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    upscaler.endFrame(camera);     // removes the jitter, restoring any view offset you set

    upscaler.dispatch(
        { color: rt.textures[0], depth: rt.depthTexture!, velocity: rt.textures[1], deltaTime: dt },
        camera,
    );
    // upscaler.outputTexture: display-res rgba16float, linear/HDR. Present it or keep post-processing.
}
```

- **Sizing.** `configure()` takes the display size in physical pixels plus one of
  `qualityMode`, `customUpscaleRatio`, or an explicit `renderWidth`/`renderHeight`
  pair (for inputs whose size you don't control). It reallocates every working
  texture and resets history, so call it on resize. `renderWidth`, `renderHeight`,
  `displayWidth`, `displayHeight`, `upscaleRatio` and `jitterPhaseCount` report the
  result.
- **Reading the jitter.** After `beginFrame()`, `upscaler.jitter` is this frame's
  sub-pixel offset in render pixels and `upscaler.jitterPhase` its index in the cycle,
  for any pass of your own that must line up with it (the TSL nodes expose the same
  offset as `node.jitterNode`). Convention and conversions:
  [Reading the jitter](inputs-and-contracts.md#jitter).
- **Non-temporal paths** need only `color`: `'spatial'` (EASU + RCAS) and
  `'bilinear'` (a plain resample, the comparison baseline). For them, render a
  `count: 1` target with `mrt({ output })`. A `count: 2` target rendered without the
  velocity output leaves color unwritten (black).
- **Presenting** the output yourself: sample `outputTexture` on a full-screen
  `QuadMesh` with `depthTest`/`depthWrite`/`fog` off. To keep alpha, also set
  `transparent: true` and `blending: NoBlending`; an opaque material resolves alpha
  to 1. See [Alpha](inputs-and-contracts.md#alpha).
- **Split frames and guides:** `dispatchGuides()` / `dispatchUpscale()` and
  `path: 'guides'` are specified in [Temporal guides](temporal-guides.md).
- **Teardown:** `dispose()` releases every GPU resource the upscaler allocated,
  including the guide textures. It doesn't touch your inputs.

## Runtime settings

`upscaler.settings` (`RuntimeSettings`) can be mutated between frames and takes effect
on the next dispatch, with no rebuild:

| Setting | Default | What it does |
| --- | --- | --- |
| `sharpness` | `0.8` | RCAS strength in `[0, 1]`; `0` skips RCAS for a plain resolve. HDR edges are sharpened with a capped gain, so highlights don't overshoot into fireflies. |
| `rcasDenoise` | `false` | FSR1's RCAS denoise variant: no extra sharpening of lone luma outliers. For noisy inputs (reduced-res GI/SSR, path tracing). |
| `maxAccumulation` | `24` | History length cap. Higher is steadier but ghosts longer. |
| `autoExposure` | `true` | Meter the conditioning exposure from the scene. It conditions accumulation only and is divided back out, so brightness doesn't change. |
| `exposure` | `1.0` | Fixed conditioning exposure, used when `autoExposure` is off. |
| `lockThinFeatures` | `true` | Luminance-stability locks for thin, high-contrast features. |
| `detectShadingChanges` | `true` | Age history where shading genuinely changed, so lighting changes don't ghost. |
| `debugView` | `DebugView.None` | Render a pipeline internal instead of the image; see [Debugging](debugging.md). |

All except `sharpness` and `rcasDenoise` affect only the temporal path.

**Camera cuts:** call `upscaler.resetHistory()`, or pass `reset: true` in that
frame's dispatch inputs, so the first frame after a teleport doesn't blend against
the old view.

**GPU timings:** off by default, because profiling has a per-frame cost (timestamp
writes on every pass plus a readback) and nothing in the pipeline needs it. Opt in with
`new Upscaler({ renderer, gpuTiming: true })`, `new UpscalePass(renderer, { gpuTiming:
true })`, or `{ gpuTiming: true }` in the node and `temporalGuides()` options, or toggle
`upscaler.gpuTiming` at runtime (turning it off frees the timer's query sets and
buffers). `upscaler.gpuTimings` is then a per-pass map of GPU milliseconds for the
latest timed frame (labels such as `reconstruct`, `exposure`, `shadingChange`,
`accumulate`, `rcas`). It holds only the passes that frame ran, so summing it gives the
frame's upscale cost. It's empty while timing is off, where the device lacks
`timestamp-query`, and for the first frame or so after timing starts.

## Asynchronous preparation

Configure sizes and path, then await `init()` before raw dispatch. Configuration
allocates textures synchronously and queues only that path's pipelines. Await
initialization again when switching to a path whose pipelines are not ready.
`isReady` describes mandatory-pass readiness, not every optional setting.

`prepare()` explicitly warms the current settings and retries failed compilation.
A newly enabled debug view or shading-change detector otherwise prepares on first
dispatch and stays inactive until ready. Activation invalidates affected history
without changing the input frame's jitter. Settings are frozen across split dispatch.

TSL nodes prepare automatically, show the input color while pending, and avoid
jitter until mandatory pipelines are ready. Failed compilation is reported once;
explicit initialization rejects and node fallback remains usable. `UpscalePass`
also presents its reduced-resolution input during path preparation. Its raw
`outputTexture` is ready for use after awaiting initialization.

`Upscaler.isSupported(device)` checks baseline device limits without compiling
or allocating. Timestamp queries are optional. Support does not guarantee shader
compilation, device health, or allocation at an arbitrary output size.
