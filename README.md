# @pmndrs/upscaler

[![npm](https://img.shields.io/npm/v/@pmndrs/upscaler?color=cb3837&label=npm)](https://www.npmjs.com/package/@pmndrs/upscaler) [![live demos](https://img.shields.io/badge/demos-live-7dd3fc)](https://pmndrs.github.io/upscaler/) [![license](https://img.shields.io/npm/l/@pmndrs/upscaler?color=blue)](./LICENSE)

AMD FidelityFX Super Resolution (FSR) brought to **three.js `WebGPURenderer`** as raw **WGSL compute passes**, with an interactive test bench.

Three ships an official [`FSR1Node`](https://threejs.org/docs/#FSR1Node) — spatial-only upscaling. This package goes further: three's WebGPU renderer already produces every temporal input FSR2/3 needs (depth, per-pixel motion vectors via the `velocity` node, jitterable projections), so we can run a **temporal** upscaler — the architecture behind FSR 2/3, DLSS, and XeSS — which reconstructs detail spatial upscalers can't, and anti-aliases for free.

> **WebGPU only.** The passes are hand-written WGSL dispatched straight on the renderer's `GPUDevice` — no TSL, no WebGL fallback. This is deliberate: the goal is a performance-first pipeline with sources that read like the FidelityFX originals.

## Install

```bash
npm install @pmndrs/upscaler three
```

WebGPU only — needs a WebGPU-capable browser (Chrome/Edge 113+) and `three` **r184+** (a peer dependency). There is no WebGL fallback.

**▶ Live demos: [pmndrs.github.io/upscaler](https://pmndrs.github.io/upscaler/)** — 11 interactive examples: spatial vs temporal, the aliasing-torture scene, transparency + reactive masks, the composable TSL node, SSGI/SSR upscaled in one post graph, and more.

## Using the upscaler

The recommended integration is the **TSL node** — drop it in as the output of a `THREE.PostProcessing` graph and it renders your scene at a reduced resolution and upscales it back, jitter and all:

```ts
import * as THREE from 'three/webgpu';
import { upscaleScene, QualityMode } from '@pmndrs/upscaler';

// The upscaler outputs display-ready sRGB, so make the post output transform
// identity: boot the renderer with NoToneMapping + LinearSRGBColorSpace.
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const post = new THREE.PostProcessing(renderer);
post.outputNode = upscaleScene(scene, camera, { quality: QualityMode.Quality });

renderer.setAnimationLoop(() => post.render());
```

That's the whole thing — no manual jitter, MRT, or velocity wiring. `upscaleScene` renders the scene _in-graph_ as an FSR input, so the sub-pixel jitter lands on it and you get real reconstruction (not just a smart blur).

**Composing with other effects.** If you already render a reduced-resolution G-buffer feeding SSGI / SSR / GTAO, feed those texture nodes to the composable `upscale()` node and it upscales the composited result — the scene, effects, and upscale are one post graph:

```ts
import { pass, mrt, output, velocity } from 'three/tsl';
import { upscale } from '@pmndrs/upscaler';

const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, velocity }));
scenePass.setResolutionScale(0.5); // render at half res per axis
// …composite your SSGI/SSR onto the reduced-res color here…

post.outputNode = upscale(
    composedColor,
    scenePass.getTextureNode('depth'),
    scenePass.getTextureNode('velocity'),
    camera,
    { ratio: 2, reactive /* optional mask */, exposureTexture /* optional */ },
);
```

Color-only input with no motion data? `upscaleSpatial(color)` runs the spatial (FSR1) path — no history, no depth/velocity. The [live demos](https://pmndrs.github.io/upscaler/) cover every node path (examples 07–11).

### Low-level API

When you are **not** in a post-processing graph — compositing in your own render-target loop — drive the imperative `Upscaler` directly. (`UpscalePass` bakes this exact MRT/jitter/velocity/present recipe into a renderer-agnostic drop-in if you want it done for you.)

```ts
import { Upscaler, QualityMode } from '@pmndrs/upscaler';
import { velocity, mrt, output } from 'three/tsl';

const upscaler = new Upscaler({ renderer });
upscaler.init();
upscaler.configure({
    displayWidth: canvas.width,
    displayHeight: canvas.height,
    qualityMode: QualityMode.Quality, // renders at 1/1.5 res per axis
    path: 'temporal',
});

// Scene render target: color + velocity MRT at *render* resolution.
const rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
    count: 2,
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight),
});
// Motion vectors must be jitter-free — feed the velocity node the upscaler's
// unjittered projection (stable instance, refreshed per frame).
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

//* Per frame
upscaler.beginFrame(camera); // applies sub-pixel jitter (setViewOffset)
renderer.setMRT(mrt({ output, velocity }));
renderer.setRenderTarget(rt);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
renderer.setMRT(null);
upscaler.endFrame(camera); // clears the jitter offset

upscaler.dispatch(
    { color: rt.textures[0], depth: rt.depthTexture, velocity: rt.textures[1], deltaTime },
    camera,
);
// upscaler.outputTexture is a display-resolution three texture — present it on
// a fullscreen quad (already tonemapped + sRGB, so keep renderer tone mapping /
// output encoding off for that draw).
```

Runtime knobs live on `upscaler.settings` (`sharpness`, `maxAccumulation`, `exposure`, `debugView`) and take effect next frame. `upscaler.resetHistory()` drops accumulation on camera cuts.

## How it works

### Why temporal upscaling works

Each frame the projection is offset by a sub-pixel **jitter** (Halton(2,3) sequence, `8·ratio²` phases — at 2× upscale, 32 frames sweep 32 distinct sample positions per pixel). A static scene therefore delivers a _super-sampled_ image over time; the upscaler's job is to integrate those samples — and to know when **not** to (movement, disocclusion, shading change), falling back to spatial reconstruction there.

### The pipeline

```
                       render res                                    display res
              ┌──────────────────────────┐              ┌────────────────────────────────┐
   depth ────▶│ dilate                   │              │                                 │
   velocity ─▶│  nearest-depth 3×3       │─ motion ────▶│ accumulate                     │
              │  motion + linear depth   │─ depth ─┐    │  jitter-aware Lanczos2 upsample │
              └──────────────────────────┘         │    │  Catmull-Rom history reproject  │──▶ history
              ┌──────────────────────────┐         │    │  YCoCg variance clip            │      │
   history ──▶│ depth clip               │◀────────┘    │  disocclusion-weighted blend    │      ▼
   depth  ───▶│  disocclusion mask       │─ mask ──────▶│                                 │   ┌──────┐
              └──────────────────────────┘              └────────────────────────────────┘   │ RCAS │──▶ output
                                                                                              └──────┘
```

1. **Dilate** — per render pixel, find the nearest depth in a 3×3 ring and take _that_ texel's motion vector (foreground silhouettes drag their motion), storing linearized view depth.
2. **Depth clip** — reproject into last frame's dilated depth; when the previous surface was meaningfully nearer, the pixel was occluded and its history is poisoned → disocclusion mask.
3. **Accumulate** — the core. Upsamples the current frame with a jitter-aware Lanczos2 kernel, samples history through the motion vector with a 9-tap Catmull-Rom, rectifies history against the current neighborhood's YCoCg variance box, and blends with a per-pixel accumulation counter (stored in history alpha) so fresh regions converge fast and stable regions stay smooth. Runs in invertible-tonemap space so HDR fireflies can't dominate.
4. **RCAS** — FSR's analytically-bounded contrast-adaptive sharpener counteracts the mild softness of temporal integration.

The **spatial path** (`path: 'spatial'`) is a faithful FSR1 port: EASU's edge-direction-rotated, anisotropically-stretched 12-tap Lanczos kernel, then RCAS. No history, no motion vectors — also the fallback story for content that can't produce velocity.

Full per-pass details and deviations from the FidelityFX reference: [`src/shaders/README.md`](./src/shaders/README.md).

### Integration approach

Three doesn't expose its WebGPU internals publicly, so the upscaler grabs `renderer.backend.device` and the `GPUTexture` handles behind render-target attachments (`internal/threeWebGPU.ts` documents exactly which internals we touch and throws loudly if a three upgrade changes them). Compute passes are encoded on our own `GPUCommandEncoder` and submitted between three's scene render and the presentation draw — queue order guarantees correctness with zero synchronization code. The final image lands in a three `StorageTexture` so presenting it is ordinary three code.

## Phases

| Phase | Scope                                                                                                                                                                                    | Status |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **0** | Package scaffold, raw-WebGPU pass infra on three's device, bench app, unit tests                                                                                                         | ✅     |
| **1** | Spatial baseline: faithful FSR1 EASU + RCAS ports                                                                                                                                        | ✅     |
| **2** | Temporal pipeline: Halton jitter, unjittered velocity, dilation, depth-clip disocclusion, Lanczos2 accumulate w/ YCoCg variance clipping, per-pass GPU timings                           | ✅     |
| **3** | Fidelity: luminance-stability **locks**, luminance-average auto-exposure (+ external exposure input), shading-change detection, reactive mask input for transparents/particles           | ✅     |
| **4** | API & ecosystem: reactive-mask authoring helpers, imperative `UpscalePass` + composable TSL nodes (`upscale` / `upscaleScene` / `upscaleSpatial`), RCAS denoise toggle (MSAA input intentionally excluded — FSR's temporal path _is_ the anti-aliaser) | ✅     |
| **5** | Performance: merged dilate+clip pass ✅; remaining — `textureGather` tap packing, f16 (`shader-f16`), bind-group caching, a true SPD luminance mip chain (steadier shading-change), half-res luma analysis | 🚧     |

Frame generation (the other half of "FSR3") needs swapchain-level frame pacing that browsers don't expose; if we ever want it, the realistic shape is interpolating between presented frames ourselves — out of scope here.

## Package layout

```
src/
  Upscaler.ts      — public API / pass orchestration
  types.ts             — quality modes, config, settings
  math/                — Halton, jitter sequencing, resolution presets (unit-tested)
  shaders/             — WGSL sources as TS modules + assembler (unit-tested)
  internal/            — device access, constants UBO, pass + timestamp helpers
bench/                 — Vite test bench (npm run dev)
```

## Develop

Clone the repo, then:

```bash
npm install
npm run dev        # interactive bench   → http://localhost:5199
npm run examples   # example gallery      → http://localhost:5300
npm test           # unit tests (GPU-free)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # library build → dist/
```

The bench (in [`bench/`](./bench/README.md)) renders an aliasing-hostile scene and lets you flip between native rendering, bilinear upscaling, FSR1 spatial, and FSR3 temporal — with quality presets, sharpness control, debug views, and per-pass GPU timings. The [example gallery](https://pmndrs.github.io/upscaler/) is what's deployed to GitHub Pages.

## Releasing

Publishing is automated — **just push to `main`**. A GitHub Action reads your [Conventional Commit](https://www.conventionalcommits.org/) messages since the last release and, if any warrant one, bumps the version, publishes to npm, and pushes the release commit + tag back. Auth is OIDC **Trusted Publishing** (no tokens, provenance attached); `npm publish` runs the full lint/typecheck/test/build gate first.

| Commit type on `main`                     | Bump              | Example         |
| ----------------------------------------- | ----------------- | --------------- |
| `feat: …`                                 | minor             | 0.1.0 → 0.2.0   |
| `fix: …` / `perf: …`                       | patch             | 0.1.0 → 0.1.1   |
| `feat!: …` / `BREAKING CHANGE:`            | major\*           | 0.1.0 → 0.2.0\* |
| `docs:` / `chore:` / `ci:` / `refactor:` …| _no release_      | —               |

\* While in `0.x`, a breaking change bumps **minor** (not `1.0.0`) so a stray break can't cut a major. Edit [`scripts/release-version.mjs`](./scripts/release-version.mjs) to change the policy.

**Manual / prerelease override.** Set an explicit version yourself and the Action publishes exactly that instead of auto-bumping — prereleases route to their own dist-tag so they never overwrite `latest`:

```bash
npm version prerelease --preid next   # 0.2.0-next.0
git push origin main --follow-tags    # → publishes to the `next` tag
```

| You set                       | Publishes to | Install                        |
| ----------------------------- | ------------ | ------------------------------ |
| `0.2.0` (stable)              | `latest`     | `npm i @pmndrs/upscaler`       |
| `0.2.0-next.0`                | `next`       | `npm i @pmndrs/upscaler@next`  |
| `0.2.0-beta.0`                | `beta`       | `npm i @pmndrs/upscaler@beta`  |
| `1.0.0-rc.0`                  | `rc`         | `npm i @pmndrs/upscaler@rc`    |

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
