# pixi.js adapter (experimental)

`@pmndrs/upscaler/pixi` runs the upscaler on pixi.js v8's `WebGPURenderer`. It is
the same `UpscalerCore` the three and Babylon adapters wrap. It's **experimental**
and verified on pixi.js 8.22 on Chrome. It **ships the spatial (FSR1) path**
for now: pixi has no depth, motion vectors or camera of its own, and the temporal
path needs all three (see [Temporal](#temporal)).

The live reference is [`examples/pixi/hello`](../examples/pixi/hello/main.ts).
It renders a pixi stage into a reduced-size `RenderTexture`, upscales it with
FSR1, and shows the output on a `Sprite`.

## Requirements

- `pixi.js` `>=8.22.0 <9` (an optional peer dependency of `@pmndrs/upscaler`), with
  the **WebGPU** renderer (`preference: 'webgpu'`). A WebGL renderer is rejected.
- A color input at render resolution, exactly `upscaler.renderWidth ×
  renderHeight`, any filterable float or unorm format (`rgba16float` keeps HDR,
  `rgba8unorm` is fine for LDR content). FSR1 expects **anti-aliased** input, so
  give the `RenderTexture` `antialias: true`. pixi resolves the MSAA to a
  single-sample texture before the upscaler reads it.

## Usage

pixi submits one command encoder per `renderer.render()`. The adapter's
`dispatch()` submits its own, so call it **between** renders: after the one that
fills the input, before the one that presents the output.

```ts
import { QualityMode, Upscaler } from '@pmndrs/upscaler/pixi';

const upscaler = new Upscaler({ renderer: app.renderer });
upscaler.configure({ displayWidth: renderer.width, displayHeight: renderer.height,
                     path: 'spatial', qualityMode: QualityMode.Quality });
await upscaler.init();

const lowRes = RenderTexture.create({ width: upscaler.renderWidth, height: upscaler.renderHeight,
                                      resolution: 1, format: 'rgba16float', antialias: true });
const present = app.stage.addChild(new Sprite(upscaler.outputTexture));
present.setSize(renderer.screen.width, renderer.screen.height);   // the output is physical pixels

app.ticker.add(() => {
    renderer.render({ container: scene, target: lowRes });
    upscaler.dispatch({ color: lowRes });   // the app's own render then presents the Sprite
});
```

- `outputTexture` (and `guides.*`) are pixi `Texture`s backed by `storage` texture
  sources. The core writes them on the GPU and pixi samples them, from one
  allocation. They're excluded from pixi's texture GC, because pixi never sees the
  core's writes.
- `configure()` reallocates the output and frees the old one. Re-read
  `outputTexture`, and point anything that showed the old one at the new one.
- Values stay in the input's color domain. pixi 2D content is display-encoded,
  so it upscales and presents as is. Linear HDR input (a 3D renderer with tone
  mapping deferred) needs a tone-mapping filter on the presenting `Sprite`.
- **Inside a render** (a custom render pipe, a 3D layer's post stage),
  `dispatch()`'s separate submit would run *before* pixi's frame. Use
  `encode(inputs)` instead. It closes pixi's open render pass
  (`renderer.renderTarget.finishRenderPass()`) and records into pixi's frame
  encoder (`renderer.encoder.commandEncoder`), so the upscale lands in order.
  The caller's engine must rebind its render target before drawing again. Only
  one `encode()` per frame: the passes share one constants buffer.

## 3D content (pixi-3d)

A 3D layer that draws through pixi's renderer can be upscaled the same way:
render it into the reduced `RenderTexture` and dispatch. The input must be
exactly render-sized. A pooled or power-of-two texture that only *contains* a
render-sized image needs a copy into an exact-size texture first. The adapter was
checked locally this way against a pixi-3d beta scene (spatial path, Chrome,
2026-10-19). That beta isn't public, so no example here depends on it.

## Temporal

The adapter already carries the temporal surface: `beginFrame()` returns the
jitter, `dispatch(inputs, camera)` takes a `FrameCamera`, and the `motionScale`
option sets the motion convention. It is **not verified**, because nothing in
pixi produces the inputs yet:

- **Depth:** a depth texture of the scene, at render resolution.
- **Motion vectors:** per-pixel `current − previous` screen motion, jitter-free,
  which needs previous-frame model and view-projection matrices.
- **Jitter:** the projection offset by `beginFrame()`'s jitter every frame.
- **Camera facts:** near, far and projection type in a `FrameCamera`, with the
  depth convention ([Engine contract](engine-contract.md)).

A 3D layer that adds these can drive the temporal path through this adapter.
Without them, the temporal path throws when it gets no camera rather than
guessing.

## pixi APIs the adapter depends on

All public `WebGPURenderer` API:
- `renderer.gpu.device`;
- `renderer.texture.getGpuSource()`, the documented way to reach the `GPUTexture`
  behind a `storage` texture source;
- `TextureSource` `storage`, `autoGarbageCollect` and `unload()`;
- `renderer.renderTarget.finishRenderPass()`;
- `renderer.encoder.commandEncoder`.

The core's old textures are freed with `source.unload()` rather than `destroy()`.
pixi keeps batch bind groups after a `Sprite` switches textures, and warns when a
source they reference is destroyed. `unload()` releases the `GPUTexture` without
that warning.

## Verification

GPU-verified on Chrome (Apple Metal-3), pixi.js 8.22, 2026-10-19:
`examples/pixi/hello` renders upright on all three modes (spatial, bilinear,
native) with no WebGPU or pixi warnings. On thin anti-aliased strokes, FSR1 is
visibly sharper than bilinear from the same half-resolution input.
