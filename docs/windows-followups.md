# Windows follow-ups implemented

This follows [the initial audit](windows-audit.md) and PR #83. The follow-up branch
is based on #83; it does not publish either package.

## Completed work

- Native Windows release-workflow emulation uses Git Bash, normalized LF scripts,
  converted paths, and a real pre-push hook for the two concurrent-merge scenarios.
  All 63 cases pass with their original assertions; none are excluded.
- CI now runs the complete verification on Ubuntu and Windows with Node 22 and
  the same npm specification as publishing. Windows needs Git Bash (standard Git
  for Windows installs are discovered; GIT_BASH_PATH can override).
- All ten GPU measurement/package scripts share Chrome/Edge discovery. Explicit
  paths and CHROME_PATH are authoritative. Missing paths fail clearly.
- Native npm release commands invoke npm's JS CLI instead of a non-executable
  Windows wrapper. No release was performed.
- Owned Windows child processes are terminated as trees; temporary-directory
  removal refuses the temp root and paths outside it. Browser audit shutdown
  closes CDP before fallback process cleanup.
- S2 opts into upscaler GPU timing, so its upscale and total HUD values populate.
- Demo 14 prepares its path-tracer compute kernels through three's public
  compileComputeAsync(). Uniform values, copy commands and resource disposal are
  replayed in order. Startup, resize and ratio changes show zero synchronous
  compute-pipeline calls. A narrowly scoped Vite transform handles the pinned
  dependency's Source→TextureSource rename, without changing installed packages.

The path-tracer adapter is an example integration, not a global renderer patch.
It pauses rendering during preparation, restores renderer methods on failures,
and only accepts synchronous setup actions. It relies on the pinned path-tracer
ComputeKernel parameter exposure. A dependency upgrade should rerun its warmup tests
and GPU transition check.

## Exposure experiment and adopted change

The exposure shader was evaluated before changing production. Three fresh-profile
runs compared compiler time, exact rgba16float readback and ABBA GPU timestamp samples.

| Variant | Compile median | GPU pass median | Readback |
| --- | ---: | ---: | --- |
| Original constant-bound loop | 338.3 ms | 0.054272 ms | Reference |
| Uniform outer loop, constant inner row | 38.7 ms | 0.030720 ms | Identical in all tested cases |
| Both loops uniform (rejected) | 33.8 ms | 0.280576 ms | Identical, but too expensive per frame |

The fully rolled experiment used a separate set of three runs (original compile
median 362.5 ms, GPU 0.055296 ms). It is retained as evidence and is not shipped.

Production keeps the original 32×32 taps, UV coordinates, summation order, adaptation,
manual/external precedence and host pre-exposure. Only the outer loop's bound is read
from a fixed uniform. The writer stores 32 at byte 92, the existing reserved slot;
the exposure shader names that slot exposureTaps. The 96-byte uniform layout, other
shader assemblies and public settings do not change.

Readback cases: auto exposure with reset, auto adaptation, manual exposure, external
exposure and host pre-exposure. Every output channel matched bit for bit for these
fixtures. This is measured on the RTX 3060 Laptop/DXC; it is not an FXC or multi-adapter
guarantee.

Reproduce with:
```powershell
node scripts/measure-exposure-compile.mjs
node scripts/audit-windows.mjs --demos 14-pathtracer-alpha,s2-fractal,01-hello
node scripts/audit-windows.mjs --demos 14-pathtracer-alpha --exercise
npm test
```

### 2026-11-11: parallel metering (to confirm on Windows)

The pass now spreads the same 1024 taps over the workgroup's 64 lanes (16 each)
and tree-sums them in workgroup memory; [NEXT-STEPS §16](../bench/docs/NEXT-STEPS.md)
has the change and the Apple M5 Pro evidence. The row loop keeps the uniform bound;
the column loop is 4 constant steps. The single-lane form is frozen, unchanged, as
`LUMINANCE_PYRAMID_SERIAL_SHADER` (bench identity `exposure-serial-v1`).

This relaxes the bit-identity requirement above in one respect: the summation order
changes, so the f32 log-sum differs in its last bits. The two orders still read back
identical rgba16float exposure in every synthetic case and every bench frame measured
on Metal. The rolled/unrolled check above still compares one order with itself and
must stay bit-identical.

**Hypothesis, not yet measured on Windows:** the pass drops from 0.031 ms isolated
(~0.06 ms in the bench) to under 0.01 ms on the RTX 3060 Laptop, and from ~0.17 ms
in-pipeline (0.34–0.38 ms isolated) to under 0.08 ms on the Intel UHD. DXC compile
time stays at or below the shipped form's 39 ms. With only 16 taps per lane, the constant-bound form should no longer
approach 338 ms, but the uniform bound stays. The f16 readback should match the
serial form in all 130 synthetic cases. Run on each adapter:

```powershell
node scripts/measure-exposure-parallel.mjs --power-preference high-performance --expected-vendor nvidia
node scripts/measure-exposure-parallel.mjs --power-preference low-power --expected-vendor intel
node scripts/measure-exposure-compile.mjs
node scripts/run-benchmark.mjs --smoke --ratios 1,1.5,2,3 --blocks 4 --warmup 240 --samples 300 --variant baseline --comparison exposure-serial-v1
```

Each `measure-exposure-parallel` run writes
`bench/results/raw/exposure-parallel/<timestamp>/results.json`. Its summary reports compile medians for the four forms, ABBA GPU medians at 960×540 and
1920×1080, the f16 and f32 readback deltas, and the exposure-guide deltas per bench scene.
Record the numbers in NEXT-STEPS §16.

## Evidence and remaining boundaries

The final gallery sweep captured all 20 Chrome demos, cold and warm, with zero
synchronous compute calls and no rendering/validation errors. The only cold-page
log noise was a missing favicon. Path-tracer transitions also retained zero sync
calls and no validation errors.

- [Exposure experiments](windows-evidence/exposure-compile-followup.json)
- [Final gallery](windows-evidence/followup-demo-results.json)
- [Path-tracer startup and transitions](windows-evidence/pathtracer-followup.json)

Lint, typecheck, library/gallery builds and packed linked-guides GPU verification pass.
The full native Windows suite includes the previously failing release tests.
CI results are attached to the follow-up PR.

Homefig remains unchanged: adopting the new capability/readiness API depends on
shipping #83, as recorded in the initial plan. The demo integration does not change
three-gpu-pathtracer's own public synchronous API for its other consumers. General
upstream async APIs, forced FXC, other adapters and long-duration recovery remain
separate integration/validation work; the four local findings from the audit are resolved.
