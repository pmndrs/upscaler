# @pmndrs/upscaler

[![npm](https://img.shields.io/npm/v/@pmndrs/upscaler?color=cb3837&label=npm)](https://www.npmjs.com/package/@pmndrs/upscaler) [![live demos](https://img.shields.io/badge/demos-live-7dd3fc)](https://pmndrs.github.io/upscaler/) [![license](https://img.shields.io/npm/l/@pmndrs/upscaler?color=blue)](./LICENSE)

**Render fewer pixels. Get a sharper image.**

`@pmndrs/upscaler` is a temporal upscaler for the web. Render your scene at a fraction of
its resolution, and it rebuilds the full-resolution frame from the last several,
recovering detail that no single frame ever had and anti-aliasing it along the way. It's
the idea behind FSR 2/3, DLSS and XeSS, running in the browser on WebGPU.

What you do with the GPU time it saves is up to you: hold your frame rate on a laptop, or
spend it on GI, reflections and heavier materials that wouldn't fit at native resolution.

```ts
pipeline.outputNode = upscaleScene(scene, camera);
```

**▶ [See it live](https://pmndrs.github.io/upscaler/)**: 30 hands-on examples and
four Three.js showcases, grouped into Three.js, Babylon.js and raw WebGPU.

### Built on FSR, grown up on the web

It started as a port of AMD's [FidelityFX Super Resolution](https://gpuopen.com/fidelityfx-superresolution-3/).
The spatial EASU/RCAS shaders are faithful WGSL ports of AMD's originals, and the temporal
path follows the FSR 2/3 architecture ([credits](#credits)). Then the web asked questions
FSR never had to answer, and we measured our way past the port:

- **Leaner than the source.** We rebuilt source-faithful FSR 3.1.5 pass graphs and
  raced them against ours on the GPU. Where they cost 6–76% more for no visible gain,
  our fused passes stayed. Where the source's design earned its keep, as with the depth
  reconstruction that keeps history through camera motion, we adopted it in a leaner
  form. ([Why we diverge](./docs/research/PARITY.md))
- **Still images that actually settle.** A standing scene converges and stays put,
  instead of shimmering as each jitter phase re-snaps the history.
- **HDR-safe sharpening.** Bright highlights stay crisp, and the sharpening is capped
  so they never blow out into fireflies.
- **Transparent canvases.** Alpha is upscaled along with color, so the page shows
  through where it should.
- **At home in a render pipeline.** A native TSL node makes it one line in three's
  `RenderPipeline`, and it composes with reduced-resolution SSGI, SSR and GTAO graphs.
  It also publishes its motion and disocclusion *temporal guides* so your own effects
  can reuse them instead of recomputing them.
- **Debuggable by design.** Every stage has a debug view, there's an interactive bench,
  and the tuning decisions are backed by measurement scripts you can re-run.

### Where it runs

The package provides **Three.js `WebGPURenderer`** integration (r186+ recommended),
**Babylon.js Frame Graph** integration (9.29.x), and an engine-independent WebGPU
core. The adapters share WGSL compute passes on the host renderer's `GPUDevice`.
The host owns textures, camera jitter, history rotation and submission. It needs a
WebGPU-capable browser, and there's no WebGL fallback.

## Install

```bash
npm install @pmndrs/upscaler three
```

The command above installs the Three integration. The additional entry points below
are proposed additions; use a locally packed archive to validate this change.

| Entry point | Engine dependency | Integration guide |
| --- | --- | --- |
| `@pmndrs/upscaler` or `/three` | Three.js | [Getting started](docs/getting-started.md) |
| `@pmndrs/upscaler/core` | None | [WebGPU core](docs/webgpu-core.md) |
| `@pmndrs/upscaler/babylon` | Babylon.js 9.29.x | [Babylon Frame Graph](docs/babylon-framegraph.md) |

Engine peers are optional: install only the engine used by your chosen entry point.
For Three, **r186+** is recommended. r184/r185 still work but are deprecated. The TSL node
warns once and falls back to the pre-r186 render-pipeline hooks, and that fallback
will be removed. There is no WebGL fallback. See
[Compatibility](./docs/compatibility.md).

**▶ Live demos: [pmndrs.github.io/upscaler](https://pmndrs.github.io/upscaler/)**: 30
examples and four showcases, covering spatial vs temporal, the aliasing-torture scene,
transparency and reactive masks, the composable and spatial-only TSL nodes, SSGI/SSR
upscaled in one post graph, temporal guides, transparent-canvas alpha, raw WebGPU
and 13 Babylon Frame Graph examples, including mesh scenes, native screen-space
effects, authored reactive coverage, transparent alpha and shared temporal guides.

## Quick start

The recommended integration is the **TSL node**. Make it the output of a
`RenderPipeline`, and it renders your scene at reduced resolution and upscales it
back, jitter and all:

```ts
import * as THREE from 'three/webgpu';
import { upscaleScene, QualityMode } from '@pmndrs/upscaler';

// The upscaler stays linear/HDR; presentation is the renderer's job.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
scene.background = new THREE.Color(0x10141a); // or empty regions stay transparent (see Alpha)

const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = upscaleScene(scene, camera, { quality: QualityMode.Quality });

renderer.setAnimationLoop(() => pipeline.render());
```

That's the whole integration: no manual jitter, MRT or velocity wiring.
`upscaleScene` renders the scene *in-graph* as the upscaler's input, so the sub-pixel
jitter lands on it and you get real reconstruction rather than a smart blur.

| Integration | When |
| --- | --- |
| `upscaleScene(scene, camera)` | A scene, rendered through a `RenderPipeline`. |
| `upscale(color, depth, velocity, camera)` | A reduced-resolution effect graph (SSGI/SSR/GTAO) in the same pipeline. |
| `upscaleSpatial(color)` | Only a color texture: single-frame FSR1, no motion data. |
| `UpscalePass` | A plain render loop with no post-processing graph. |
| `Upscaler` | Your own render-target loop, split frames, or inputs the others don't expose. |
| `temporalGuides()` / `upscaler.guides` | Other temporal effects sharing the upscaler's motion, depth and disocclusion. |

**[Getting started](./docs/getting-started.md)** walks through each one.
**[Inputs and contracts](./docs/inputs-and-contracts.md)** specifies what color, depth,
velocity, jitter, reactive masks and exposure must contain. Most integration bugs are
contract bugs.

### Alpha

Every path upscales **RGBA**: the input's alpha is filtered and accumulated, not
replaced with 1.0, so a transparent canvas stays transparent through the upscale.
This is the same convention as three's `FSR1Node`. An opaque input comes out with
alpha exactly 1.

> **Coming from 0.2:** earlier versions wrote alpha 1.0 everywhere. three's
> `WebGPURenderer` defaults to `alpha: true` and clears to alpha 0, so a scene with no
> `scene.background` (and no opaque clear color) presented through `UpscalePass` or
> the TSL nodes now shows the page through its empty regions, exactly as three does
> without the upscaler. For the old look, set `scene.background` or
> `renderer.setClearColor(color, 1)`, or create the renderer with `alpha: false`.
> Likewise, a post graph that scales the upscaled `vec4` by a scalar, such as
> `upscale(...).mul(vignette)`, now scales alpha too. Multiply by
> `vec4(vec3(vignette), 1)` to darken color only. Details:
> [Alpha](./docs/inputs-and-contracts.md#alpha).

## Documentation

- [Getting started](./docs/getting-started.md): the integration surfaces and runtime
  settings
- [Inputs and contracts](./docs/inputs-and-contracts.md): color, depth, velocity,
  jitter, reactive, exposure, output, alpha
- [Temporal guides](./docs/temporal-guides.md): the published motion/disocclusion
  bundle and the split frame
- [Debugging](./docs/debugging.md): debug views, symptoms, real-GPU verification
- [Compatibility](./docs/compatibility.md): three.js versions, WebGPU, limitations
- [Architecture](./docs/architecture.md): the pass graph and internals, for
  contributors
- [Design rationale vs FSR 3.1.5](./docs/research/PARITY.md), and the
  [full index](./docs/README.md)

## Status

The pipeline is **feature-complete and GPU-verified**. It covers the spatial (FSR1)
and temporal paths, RGBA (alpha) passthrough, luminance-stability locks, auto-exposure
(plus external and host pre-exposure inputs), multi-scale shading-change detection,
reactive masks (explicit and auto-generated), RCAS with opt-in denoise, the imperative
`UpscalePass`, the composable TSL nodes, and the raw and linked-TSL temporal-guides
surfaces. A benchmarking program A/B-compared this implementation against
source-style FSR 3.1.5 pass graphs on the GPU. The measurements and the reasoning for
each divergence are in [PARITY.md](./docs/research/PARITY.md).

Deliberately **not** planned:

- **Frame generation** (the other half of "FSR3"). It needs swapchain-level frame
  pacing, which browsers don't expose.
- **MSAA input.** FSR's temporal path *is* the anti-aliaser; a multisampled input is
  redundant and can't bind to the compute passes.
- **Perf-only micro-optimizations** (`textureGather` tap packing, f16 arithmetic,
  bind-group caching). Each adds correctness risk to a core path with no image-quality
  gain, so they wait until performance is an actual bottleneck on real content.

## Contributing

Bug reports, examples and PRs are welcome. [Contributing](./docs/contributing.md) covers
the dev loop, the bench, testing on a real GPU, and how releases are cut.

## References

- [FidelityFX Super Resolution 2/3 (GPUOpen)](https://gpuopen.com/fidelityfx-superresolution-3/) — algorithm & source (MIT)
- [`ffx_fsr1.h`](https://github.com/GPUOpen-Effects/FidelityFX-FSR) — EASU/RCAS reference the WGSL ports follow
- ["Filmic SMAA / temporal reprojection" (Jimenez, SIGGRAPH 2016)](https://advances.realtimerendering.com/s2016/) — Catmull-Rom history filtering
- ["Temporal Reprojection Anti-Aliasing" (Playdead)](https://github.com/playdeadgames/temporal) — variance clipping
- three.js `TRAANode` — jitter/velocity integration pattern this package mirrors

## Credits

Built by **[Dennis Smolek](https://github.com/DennisSmolek)**. Maintained under the [Poimandres](https://github.com/pmndrs) collective.

Based on AMD's [FidelityFX Super Resolution](https://github.com/GPUOpen-Effects/FidelityFX-FSR) — this package ports its MIT-licensed EASU/RCAS shaders and follows the FSR2/3 temporal-upscaling architecture. "FSR" and "FidelityFX" are AMD's; this is an independent, unaffiliated implementation for three.js.

## License

MIT — see [LICENSE](./LICENSE). The EASU/RCAS shaders derive from AMD's MIT-licensed [FidelityFX Super Resolution](https://github.com/GPUOpen-Effects/FidelityFX-FSR); AMD's copyright notice is included in the license file.
