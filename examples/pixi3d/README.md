# pixi-3d examples

[PixiJS 3D](https://github.com/pixijs/3d) (`@pixi/3d`) is public on npm since
0.1.0 (2026-11-12) and is a devDependency here, so these examples run like any
other:

```bash
pnpm examples      # http://localhost:5300/pixi3d/hello/
```

The root `pnpm typecheck` covers them. `@pixi/3d` 0.1.0 needs pixi.js 8.23 or
newer, the dev version here.

| # | Demo | Shows |
|---|------|-------|
| P2 | **pixi-3d** (`hello`) | A `View3D` (a thin-slat fence, glossy spheres, a metal knot) sized to the render resolution, rendered into a half-resolution `RenderTexture`, upscaled by FSR1 between pixi renders, and presented on a `Sprite`. Keys: `1` spatial, `2` bilinear, `3` native, space to pause. |

pixi-3d has no motion vectors or projection jitter yet, so these use the
spatial path. With those, the same adapter runs the temporal path
([docs/pixi.md](../../docs/pixi.md#temporal)).
