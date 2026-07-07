# three-fsr3

AMD FidelityFX Super Resolution (FSR) brought to **three.js `WebGPURenderer`** as raw **WGSL compute passes**, with an interactive test bench.

Three ships an official [`FSR1Node`](https://threejs.org/docs/#FSR1Node) — spatial-only upscaling. This package goes further: three's WebGPU renderer already produces every temporal input FSR2/3 needs (depth, per-pixel motion vectors via the `velocity` node, jitterable projections), so we can run a **temporal** upscaler — the architecture behind FSR 2/3, DLSS, and XeSS — which reconstructs detail spatial upscalers can't, and anti-aliases for free.

> **WebGPU only.** The passes are hand-written WGSL dispatched straight on the renderer's `GPUDevice` — no TSL, no WebGL fallback. This is deliberate: the goal is a performance-first pipeline with sources that read like the FidelityFX originals.

## Quick start

```bash
npm install
npm run dev   # bench on http://localhost:5199
npm test      # unit tests
```

The bench (in [`bench/`](./bench/README.md)) renders an aliasing-hostile scene and lets you flip between native rendering, bilinear upscaling, FSR1 spatial, and FSR3 temporal — with quality presets, sharpness control, debug views, and per-pass GPU timings.

## Using the upscaler

```ts
import { FSR3Upscaler, FSRQualityMode } from 'three-fsr3';
import { velocity, mrt, output } from 'three/tsl';

//* Setup (once, after renderer.init())
const upscaler = new FSR3Upscaler({ renderer });
upscaler.init();
upscaler.configure({
    displayWidth: canvas.width,
    displayHeight: canvas.height,
    qualityMode: FSRQualityMode.Quality, // renders at 1/1.5 res per axis
    path: 'temporal',
});

// Scene render target: color + velocity MRT at *render* resolution
const rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
    count: 2,
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight),
});
// Motion vectors must be jitter-free — feed the velocity node the
// upscaler's unjittered projection (stable instance, refreshed per frame).
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

// upscaler.outputTexture is a display-resolution three texture —
// present it on a fullscreen quad (it is already tonemapped + sRGB,
// so disable renderer tone mapping / output encoding for that draw).
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
| **3** | Fidelity: luminance-stability **locks**, luminance pyramid (SPD) + auto-exposure, shading-change detection, reactive mask input for transparents/particles                               | ⬜     |
| **4** | API & ecosystem: reactive-mask authoring helpers, `postprocessing`/TSL node wrapper, RCAS denoise toggle (pairs with the three SSR denoiser for noisy GI/SSR inputs), MSAA-input support | ⬜     |
| **5** | Performance: `textureGather` tap packing, f16 arithmetic (`shader-f16`), merged dilate+clip pass, bind-group caching, half-res luma analysis                                             | ⬜     |

Frame generation (the other half of "FSR3") needs swapchain-level frame pacing that browsers don't expose; if we ever want it, the realistic shape is interpolating between presented frames ourselves — out of scope here.

## Package layout

```
src/
  FSR3Upscaler.ts      — public API / pass orchestration
  types.ts             — quality modes, config, settings
  math/                — Halton, jitter sequencing, resolution presets (unit-tested)
  shaders/             — WGSL sources as TS modules + assembler (unit-tested)
  internal/            — device access, constants UBO, pass + timestamp helpers
bench/                 — Vite test bench (npm run dev)
```

## References

- [FidelityFX Super Resolution 2/3 (GPUOpen)](https://gpuopen.com/fidelityfx-superresolution-3/) — algorithm & source (MIT)
- [`ffx_fsr1.h`](https://github.com/GPUOpen-Effects/FidelityFX-FSR) — EASU/RCAS reference the WGSL ports follow
- ["Filmic SMAA / temporal reprojection" (Jimenez, SIGGRAPH 2016)](https://advances.realtimerendering.com/s2016/) — Catmull-Rom history filtering
- ["Temporal Reprojection Anti-Aliasing" (Playdead)](https://github.com/playdeadgames/temporal) — variance clipping
- three.js `TRAANode` — jitter/velocity integration pattern this package mirrors

## License

MIT — see [LICENSE](./LICENSE). The EASU/RCAS shaders derive from AMD's MIT-licensed [FidelityFX Super Resolution](https://github.com/GPUOpen-Effects/FidelityFX-FSR); AMD's copyright notice is included in the license file.
