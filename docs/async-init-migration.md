# Async initialization migration

[PR #83](https://github.com/pmndrs/upscaler/pull/83) changes `Upscaler.init()` from
`void` to `Promise<void>`, and adds explicit async initialization to `UpscalePass`
and `MomentsPass`. These changes are not published yet.

The renderer still needs `await renderer.init()` before constructing these objects.
Configure the selected path first, then await preparation before starting dispatch.

## Raw Upscaler

Before:
```ts
const upscaler = new Upscaler({ renderer });
upscaler.init(); // synchronous compilation
upscaler.configure(config);
startRendering();
```

After:
```ts
const upscaler = new Upscaler({ renderer });
upscaler.configure(config); // still synchronous; allocates and queues preparation
await upscaler.init();     // waits for the selected path's required pipelines
startRendering();
```

The existing rendering/jitter recipe stays the same. Raw dispatch before mandatory
passes are ready throws `UpscalerNotReadyError` before encoding compute commands.
Its stable code is `UPSCALER_NOT_READY`; its reason is `preparing` or `device-lost`.
Actual premature dispatch also warns once per instance with the migration step.
Correctly awaited callers receive no migration warning. MomentsPass uses the same
diagnostic contract. This detects unready dispatch, not whether a Promise was ignored.

## UpscalePass

Before, the constructor initialized its internal upscaler synchronously:
```ts
const pass = new UpscalePass(renderer);
pass.configure(config);
startRendering();
```

After:
```ts
const pass = new UpscalePass(renderer);
pass.configure(config);
await pass.init();
startRendering();
```

Its `draw()` / `present()` methods also support an unjittered input fallback while
preparing, but awaiting startup makes the initial upscale ready before the loop.

## MomentsPass

Before:
```ts
const moments = new MomentsPass({ renderer });
moments.configure({ width, height, space: 'ycocg' });
moments.dispatch({ source: giTexture });
```

After:
```ts
const moments = new MomentsPass({ renderer });
moments.configure({ width, height, space: 'ycocg' });
await moments.init();
moments.dispatch({ source: giTexture });
```

## Path changes, readiness and errors

`Upscaler.prepare()` warms the currently selected path and requested optional
settings. `init()` uses the same preparation contract. For an existing raw loop:
```ts
async function changePath(path: 'temporal' | 'spatial') {
    renderer.setAnimationLoop(null);
    upscaler.configure({ ...config, path });
    await upscaler.prepare();
    renderer.setAnimationLoop(renderFrame);
}
```

Catch rejection to display a preparation error instead of resuming dispatch.
The library observes bare initialization rejections to prevent an ignored init
Promise from producing an additional unhandled rejection. Compilation failures
are logged, and the original Promise still rejects for callers that await/catch it.
Explicit `init()` / `prepare()` can retry compilation failures; dispatch does not
silently retry failed shaders. Existing pipelines are shared per device, so an
already prepared path or ordinary resize usually requires no new compilation.

`upscaler.isReady` means the mandatory passes are ready. A newly requested optional
debug/shading feature can still be preparing while it is true. Rendering continues
with that feature temporarily inactive; it activates at a frame boundary without
restarting history (the shading-change detector spends its first frame seeding its
own state and reports no change on it). Await `prepare()` if the host needs that
feature warmed first.

For code that keeps rendering an input fallback, check `isReady` before raw dispatch.
You can also catch `UpscalerNotReadyError` (or check its code across bundles) in a
central error handler. A `device-lost` reason requires a working renderer/device;
awaiting the lost instance again does not restore it.

## TSL factories

These factories remain synchronous:
```ts
pipeline.outputNode = upscaleScene(scene, camera, { ratio: 2 });
renderer.setAnimationLoop(() => pipeline.render());
```

Do not add an await to `upscaleScene()`, `upscale()`, `upscaleSpatial()` or
`temporalGuides()`. Their nodes keep the input visible without jitter while
preparing; linked guides/upscale nodes share readiness.
