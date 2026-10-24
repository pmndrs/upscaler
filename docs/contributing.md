# Contributing

How to work on `@pmndrs/upscaler` itself: the dev loop, the bench, verifying on a real
GPU, and cutting a release. To *use* the library, start with
[Getting started](getting-started.md).

Before changing shaders or passes, read [Architecture](architecture.md) and the
"landmines" in [`CLAUDE.md`](../CLAUDE.md). Many of the rules there were learned the
hard way on a real GPU.

## Develop

Clone the repo, then:

```bash
pnpm install
pnpm dev           # interactive bench   → http://localhost:5199
pnpm examples      # example gallery      → http://localhost:5300
pnpm test          # unit tests (GPU-free)
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # library build → dist/
pnpm verify:packed-subpaths   # each subpath from the packed tarball, only its own engine installed
```

The bench (in [`bench/`](../bench/README.md)) renders an aliasing-hostile scene and
lets you flip between native rendering, bilinear upscaling, FSR1 spatial, and FSR3
temporal, with quality presets, sharpness control, debug views, and per-pass GPU
timings. The [example gallery](https://pmndrs.github.io/upscaler/) is what's deployed
to GitHub Pages. CI is GPU-free, so changes to shaders or passes need a real-GPU run;
see [Debugging](debugging.md#verifying-on-a-real-gpu). The code layout is in
[Architecture](architecture.md).

## Releasing

Merging to `main` never publishes, and releasing needs no local step. Either:

- **Actions → Publish to npm → Run workflow** (`version: auto`): CI computes the next version from [Conventional Commits](https://www.conventionalcommits.org/), commits and tags it on `main`, and publishes, all in one run. `patch`/`minor`/`major`, an explicit `X.Y.Z` and a prerelease `preid` are options; or
- **Releases → Draft a new release → new tag `vX.Y.Z` on `main` → Publish release**: the tag is the version. CI publishes it, keeps your Release notes, and bumps `main`'s `package.json` afterwards.

Both check that the tag is SemVer and on `main`, publish to npm with OIDC **Trusted Publishing** (no tokens, provenance attached), and create the GitHub Release if it is missing. [GitHub Releases](https://github.com/pmndrs/upscaler/releases) are the changelog. Re-runs, prereleases, the optional local `npm run release` and the one-time npm setup are covered in [Releasing](releasing.md).
