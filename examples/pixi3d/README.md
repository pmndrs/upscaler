# pixi-3d examples

[pixi-3d](https://pixijs.com) (`@pixi/3d`) is in **closed beta**: it isn't on npm
yet, and the beta asks testers to keep its code and builds inside the beta. So
this repo never bundles it. These examples run against your own copy of the
beta and show a setup notice without it, which is also what CI and the public
gallery build.

## Running them

1. Download the beta's release tarball (`pixi-3d-<version>.tgz`) from the beta
   repository's releases.
2. From the repo root, unpack it into `examples/pixi3d/vendor/` (gitignored):

   ```bash
   mkdir -p examples/pixi3d/vendor
   tar -xzf pixi-3d-*.tgz -C examples/pixi3d/vendor --strip-components=1
   pnpm examples      # http://localhost:5300/pixi3d/hello/
   ```

`examples/vite.config.ts` notices `vendor/package.json` and resolves `@pixi/3d`
(and `@pixi/3d/extras`) from there. pixi-3d's one runtime dependency,
`meshoptimizer`, is already a devDependency here.

Typecheck against the beta's types with `pnpm exec tsc -p examples/pixi3d`. The
root `pnpm typecheck` skips these examples, because CI has no beta.

| # | Demo | Shows |
|---|------|-------|
| P2 | **pixi-3d** (`hello`) | A `View3D` (a thin-slat fence, glossy spheres, a metal knot) sized to the render resolution, rendered into a half-resolution `RenderTexture`, upscaled by FSR1 between pixi renders, and presented on a `Sprite`. Keys: `1` spatial, `2` bilinear, `3` native, space to pause. |

pixi-3d has no motion vectors or projection jitter yet, so these use the
spatial path. With those, the same adapter runs the temporal path
([docs/pixi.md](../../docs/pixi.md#temporal)).
