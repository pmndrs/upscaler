# Benchmarking guide

How to measure a change in this repo, read the result, and know whether to
believe it. The other docs in this folder are *evidence* — records of specific
experiments. This one is the *manual*.

---

## TL;DR

```bash
pnpm dev                     # interactive bench with a live GPU-ms readout

# An interleaved A/B of two registered variants (see "Running an A/B")
node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 \
  --variant rcas-hoisted-exposure-v1 --comparison baseline
```

---

## What the harness actually does

Two things make GPU timing hard: the GPU drifts (clocks, thermals, other
tenants), and a browser is not a quiet machine. The harness handles both by
**interleaving** rather than by measuring A and then measuring B.

Each repetition runs the pattern **A B B A**. Both configurations are measured
inside the same short window, and the symmetric ordering cancels linear drift —
if the GPU is slowly warming up, both sides absorb the same amount of it. It
also runs the pattern several times (`--blocks`) and takes the median across
repetitions, so one bad block cannot carry the result.

That is why **you cannot get a trustworthy number by running the benchmark
twice and comparing.** Two separate invocations differ in browser launch, GPU
power state, and page warmup, none of which the numbers separate from your
change. (This mistake is recorded in `NEXT-STEPS.md` §6: a first pass reported
+2.6% for a change that an interleaved run against production measured at +5.1%.
It compared two separate invocations and, the larger error, used the wrong
baseline variant — so pick `--variant`/`--comparison` deliberately too.)

### The vocabulary

| term | meaning |
| --- | --- |
| **variant** | A registered pipeline configuration, by id — `baseline`, `rcas-tonemap-space-v1`, … |
| **ratio** | Display ÷ render resolution. `2` means the scene renders at half width and half height. `1` is native-resolution AA. |
| **block / repetition** | One full A-B-B-A pattern. `--blocks 4` runs four of them. |
| **warmup** | Frames rendered and thrown away before timing starts, so shader compilation and caches are not in the sample. |
| **samples** | Timed frames per leg. More samples = tighter medians, longer runs. |
| **scenario** | A scripted camera/scene animation, `Q0`–`Q19`. See the catalogue below. |
| **noise floor** | How much the harness disagrees with *itself*. The bar your delta has to clear. |

---

## Running an A/B

Every A/B needs two registered variant ids. To see what exists, look at
`RESOLVER_FACTORIES` in `bench/src/benchmark/variants.ts`.

```bash
node scripts/run-benchmark.mjs --smoke \
  --ratios 1,2,3 --blocks 4 --warmup 240 --samples 300 \
  --variant rcas-hoisted-exposure-v1 --comparison baseline
```

`--smoke` is **required** for candidate A/B runs. Without it the script runs the
strict E00 baseline acceptance protocol instead — 64 runs with hard noise gates,
which is a different job and takes far longer.

A run takes a few minutes per ratio. Results land in
`bench/results/raw/E00/<timestamp>/` unless you pass `--output`.

### Registering your own variant

Three edits, all small:

1. Add the id to the union in `bench/src/types/benchmark.d.ts`.
2. Add it to `VARIANTS` in `bench/src/benchmark/config.ts` — this is the
   page-side allowlist. **Forgetting this one fails as a timeout**, not as a
   clear error: the page throws `Invalid benchmark variant` during boot and the
   script waits for an API that never appears.
3. Map it to a resolver factory in `bench/src/benchmark/variants.ts`, and give
   it a `name` in `metadata()`.

`createRcasExperimentResolver` (in `BenchmarkResolver.ts`) is a good template — its
ids are the same production pipeline differing only in the RCAS shader handed to
the constructor, which is the shape you want for a clean single-variable
comparison.

### Which RCAS each mode runs

RCAS is the one shader the identities swap, and the swap can differ between the
temporal path and the FSR1 spatial path. Shader names refer to
`src/shaders/rcas.ts`.

| identity | temporal mode | FSR1 spatial mode |
| --- | --- | --- |
| `baseline`: the page default, so the interactive bench, `measure-convergence.mjs` and `measure-drift-lag.mjs` | `RCAS_LEGACY_SHADER` | **`RCAS_SHADER` (production)** |
| `local-baseline-5d6a65e`, `local-baseline-through-e00-harness`: the frozen E00 pair that `run-benchmark.mjs` maps `baseline` to | `RCAS_LEGACY_SHADER` | `RCAS_LEGACY_SHADER` |
| `rcas-fsr315-limiter`, `rcas-fsr315-numeric` | `RCAS_PER_TAP_SHADER` | `RCAS_PER_TAP_SHADER` |
| `rcas-hoisted-exposure-v1` / `rcas-tonemap-space-v1` | the experiment shader of the same name | the same shader |
| `source-*-bundle-v1` (frozen candidates) | `RCAS_PER_TAP_SHADER` | `RCAS_PER_TAP_SHADER` |

Native and bilinear modes run no RCAS; they use the blit pass. FSR1 with
`sharpness` 0 blits too.

The temporal column is frozen on purpose. The legacy shader is the E00
`local-baseline-5d6a65e` shader identity, and every temporal capture and
convergence record so far was taken through it. Switching `baseline`'s temporal
RCAS would silently break comparisons against those records. The spatial column
is not frozen, because automated runs never use the spatial path
(`configureBenchmark` always selects the temporal path). So `baseline` runs
production RCAS there, and spatial-path changes such as the conditioned-space
RCAS from #30 show up in the interactive bench. For the old FSR1 behaviour in an
A/B, open the bench with `?variant=local-baseline-5d6a65e`. The split is wired
through the bench-only `_spatialRcasShader` constructor option on `Upscaler`.

---

## Reading the results

The file to open is **`abba-analysis.json`**. It is an array with one entry per
`(ratio, label)`, where label is a pass name (`accumulate`, `rcas`, …) or
`compute-sum` for the whole pipeline.

```jsonc
{
  "ratio": 2,
  "label": "compute-sum",
  "median": {
    "rows": [ { "repetition": 1, "A1": 0.74, "B1": 0.73, "B2": 0.75, "A2": 0.80,
                "meanA": 0.77, "meanB": 0.74, "comparisonDelta": 0.041 } ],
    "noiseFloor": 0.0018
  }
}
```

- `meanA` / `meanB` — mean of the two A legs and the two B legs, in milliseconds.
  A is `--variant`, B is `--comparison`.
- `comparisonDelta` — the unsigned A-vs-B difference for that repetition,
  relative to the pair mean (`|A − B| / mean(A, B)`). Read the direction from
  `meanA` vs `meanB`.
- **`noiseFloor`** — the harness's own A-vs-A disagreement. This is the number
  that decides whether you believe the result.

### Is my delta real?

Compare it to the noise floor:

- **≥10× the noise floor** — real. Report it.
- **3–10×** — probably real, but say so with the ratio attached rather than as a
  bare percentage.
- **<3×** — you have not measured anything yet. Add blocks and samples.

A worked example from the (since retired) alpha on/off A/B — `NEXT-STEPS.md` §6: `compute-sum` moved 5.1% against a 0.41%
noise floor (12×, solid), while `rcas` moved 27.2% against a 9.7% floor (2.8×,
believable but stated with the caveat). Same run, two very different confidence
levels — which is exactly why the floor is per-label.

### Percentages lie about small passes

A pass that costs 0.067 ms will show a huge percentage for a small absolute
change. Always look at the microseconds too. The alpha work costs a flat ~33 µs
regardless of ratio, which reads as +3.6% at ratio 1 and +5.5% at ratio 3 — the
work did not change, the rest of the frame got cheaper.

---

## Scenarios (Q0–Q19)

Scripted camera and scene animations, defined in
`bench/src/benchmark/scenarios.ts`. Performance runs use the default; capture
runs select Q0–Q11 (the E00 manifest's set) with `--scenarios`. Q12–Q19 are
capture-only through the `measure-*` scripts (`measure-convergence.mjs
--scenario <id>` and the scripts named in their rows); `run-benchmark.mjs` drops
them from `--scenarios` without an error.

| id | name | what it exercises |
| --- | --- | --- |
| Q0 | `input-debug-validation` | Animated baseline captured as the final image plus every debug view except depth. The first thing to run when something looks wrong. |
| Q1 | `static-convergence` | Still camera, 240 frames. The convergence scenario — does a still image stop moving? |
| Q2 | `slow-aliasing-dolly` | Slow dolly across the grid floor and fence. Sub-pixel motion, worst case for aliasing. |
| Q3 | `object-motion-disocclusion` | Moving objects, so history is invalidated behind them. Disocclusion trails. |
| Q4 | `camera-motion-hold` | Orbit, then a lateral translate, then orbit again — motion that changes character. |
| Q5 | `seeded-transparency-reactivity` | Particles visible; the reactive-mask path. |
| Q6 | `isolated-screenspace-effects` | GTAO / SSR / SSGI as separate subruns, each in isolation. |
| Q7 | `in-graph-screenspace-composition` | The same effects composed in one post graph, camera moving through a room. |
| Q8 | `recurrent-denoiser-characterization` | Subruns `builtin` / `spatial` / `recurrent` — the denoiser comparison behind `DENOISING-DIRECTION.md`. |
| Q9 | `exposure-transition` | Directional light steps 3.2 → 8 at frame 60, ramps 8 → 2 over 120–179, then returns to 3.2 at 180. Auto-exposure and the shading-change detector. |
| Q10 | `reset-cut-resize` | Hard camera cut at 60, history resets, and resizes to 1280×720 then back to 1920×1080. Lifecycle correctness. |
| Q11 | `host-pre-exposure` | Host pre-exposure steps 2.5× at 60 and ramps back. With DeltaPreExposure correct, the shading-change view stays black throughout. |
| Q12 | `cornell-still-convergence` | A consumer's Cornell-box repro: still camera, point-light shadow dither. The hardest convergence case we have. |
| Q13 | `merged-reactive-masks` | Explicit reactive mask **and** the `reactiveOpaqueColor` auto-generator at once, on three still panels: explicit-only (reads 1.0), overlap (explicit 0.5 under a generated ramp, so it reads as a flat 0.5 floor rising to the 0.9 cap), diff-only. The `reactivity` capture is the per-pixel `max` from `generateReactive.ts`. A merge that overwrites, takes the min or sums the masks changes a panel. |
| Q14 | `ssgi-thin-feature-locks` | Issue #17: still camera into an SSGI-lit box holding 1px wireframe meshes. Subruns `off` (no SSGI, clean control) / `static` (SSGI static pattern + spatial `recurrentDenoise`, the issue's config) / `rotating` (SSGI's default rotating pattern) / `builtin` (static pattern + `DenoiseNode`: the recipe examples 06/09 used until #58; they now keep SSGI's rotating pattern). Measure with `measure-convergence.mjs --scenario Q14 --subrun <s> --pairs 40`. |
| Q15 | `sub-detector-lighting-drift` | Still camera, sun ramps 8 → 2 (120–188) and back 2 → 8 (240–308), exponentially at ~2 %/frame: half the shading detector's flattest floor, so the detector stays silent and only the variance clip limits lag. Measure with `scripts/measure-drift-lag.mjs`. |
| Q16 | `sparse-wires-empty-background` | Issue #22: fans of sub-texel bars (about 0.5–1 render px at ratio 2, 0.35–0.7 at ratio 3) over an opaque black background, still camera, plus a solid knot as a control. The jitter phase decides whether a bar lands in a texel, so block means swing although nothing changed: the shading-change view must stay black until the fans' light drops to a quarter at frame 300. Measure with `measure-convergence.mjs --scenario Q16 --shading-frames 32` (and `measure-drift-lag.mjs --frames 296:356:2` for the step). |
| Q17 | `subpixel-emitter-retention` | Issue #51: still camera onto unlit discs of 0.3–1.5 render-px diameter and 0.5 px lines, over black and over a textured backdrop, each floating (depth edge) or as a decal (no depth edge). Measure with `scripts/measure-emitter-retention.mjs` (per-emitter retention vs input coverage, flicker, switch-off ghost) and `measure-convergence.mjs --scenario Q17`. |
| Q18 | `fine-line-chart` | Still camera square-on to a resolution chart: line-pair bars of 6 → 0.75 render px period at ratio 2 (4 → 0.5 at ratio 3), so they cross the render Nyquist; a Siemens star; flat swatches (the control); a swatch crossed by 0.5 px hairlines. The chart is unmipmapped, so the bars alias differently on every jitter phase and render-space block means swing although nothing changed: the shading-change view must stay black until the light drops to a quarter at frame 300. ROIs per chart region. Measure with `measure-convergence.mjs --scenario Q18 --shading-frames 32 --views final,accumulation-age` (per-ROI firing and accumulation age) and `measure-drift-lag.mjs --scenario Q18 --frames 296:356:2` for the step, and `measure-shading-restart.mjs` for a step right after the detector is re-enabled (`NEXT-STEPS.md` §14). |
| Q19 | `receding-disocclusion` | Issue #67: converge, then dolly back / forward, orbit left / right, slide, and the scene receding / approaching under a still camera, each followed by a 60-frame hold; then a fast dolly (0.3 u/frame, #67's headline case) back and forward; a frontal textured wall stands behind the props. A camera-invariant depth clip keeps receding surfaces' history. Measure with `scripts/measure-receding-disocclusion.mjs --variants baseline,reconstruct-cross-frame-v1` (per-segment disocclusion and accumulation age, plus frame-to-frame flicker at `--stride 1`; the interior crop excludes the border strip entering view). Still scenes never disocclude under the scatter, so this, not Q1/Q12, separates depth-clip forms (`depth-clip-*` identities, NEXT-STEPS §15). |

---

## Visual regression (capture mode)

Timing is only half of it. Capture mode renders fixed frames and diffs the PNGs,
which is how you prove a change is *visually* identical rather than merely fast.

```bash
node scripts/run-benchmark.mjs --mode capture --smoke \
  --scenarios Q0,Q1,Q3 --reloads 1 --allow-differences --review-all
```

Frames are chosen per scenario and include jitter-phase-relative picks: `P-1`,
`P`, `2*P-1`, where `P` is the jitter period. Comparing the same jitter phase
across runs is the only way to distinguish "the image changed" from "the image
is at a different point in its jitter cycle."

For convergence specifically there is a dedicated, faster tool:

```bash
node scripts/measure-convergence.mjs --scenario Q12 --ratio 2
```

It reports consecutive-frame and same-jitter-phase differences, which is the
measurement to run before and after touching anything in `accumulate.ts`. It also
reports them over a content mask (pixels brighter than 40/255), for sparse scenes
like Q16. `--shading-frames N` replays N frames through the shading-change view and
reports how much of the frame the detector fires on (`NEXT-STEPS.md` §9), in total
and per scenario ROI. Capturing the `accumulation-age` view also reports the mean
age and the share of pixels under half the cap per ROI. Run it before and after
touching `shadingChange.ts`. The full-frame figures include the dark page strip
the canvas clip picks up below the headless viewport (the bottom ~7 % of a
1280×720 capture), which reads as age 0; compare them as deltas, or use ROIs.
`--variant <id>` (also on `measure-drift-lag.mjs`) drives a registered bench
variant instead of the page default.

Its lighting-drift counterpart measures how far the output trails a slow lighting
ramp on a still camera. It compares every sampled frame against a held-light
reference at the same jitter phase, and reports the lag in frames plus whether
the shading-change detector fired. Use it for anything that trades rectification
for convergence, such as `STILL_CLAMP_RELAX` (`NEXT-STEPS.md` §8):

```bash
node scripts/measure-drift-lag.mjs --scenario Q15 --settings '{"autoExposure":false}'
```

Its alpha counterpart drives `examples/15-transparent-canvas` (sub-texel wires over a
zero-alpha background) instead of the bench, and reads the output texture back so
alpha is measured exactly — run it before and after touching the alpha resolve:

```bash
node scripts/measure-alpha-convergence.mjs --ratio 3
```

---

## Benchmarking on a device

```bash
node scripts/run-benchmark.mjs --smoke --cdp http://127.0.0.1:9222 \
  --ratios 2 --blocks 8 --variant <A> --comparison <B>
```

Android with Chrome only — **iOS cannot work**, because Safari exposes no
DevTools Protocol and the harness has nothing to drive.

Two ports need forwarding, and only the first is obvious:

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote   # we drive the device
adb reverse tcp:5199 tcp:5199                               # device reaches our bench
```

`run-benchmark.mjs` drives `http://127.0.0.1:5199` by default (`--url` changes
it — see "Ports and parallel runs") and binds the dev server to loopback.
Without the **reverse** mapping the phone loads its own localhost, and
the run dies in a timeout with nothing useful to point at. Check both before
starting: `curl http://127.0.0.1:9222/json/version` must answer, and
`adb reverse --list` must show `tcp:5199` (or whichever port `--url` names).

Expect worse data than a desktop run, for two reasons:

- **`timestamp-query` is often unavailable** on mobile browsers. `GpuTimer`
  no-ops when it is, so the per-pass breakdown comes back empty and only frame
  time is available — noisier, and it includes the scene render.
- Driving a browser you launched yourself gives up the harness's cold-start and
  throttling controls. **Use more blocks than a local run needs.**

---

## Ports and parallel runs

Every GPU harness script talks to two local ports: a **dev server** (the page it
drives) and **Chrome's DevTools port** (how it drives it). Both are flags, so
several runs — or several worktrees — can share a machine without colliding.

| script | page (`--url`, default) | CDP port |
| --- | --- | --- |
| `run-benchmark.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333), or `--cdp <url>` for a browser you launched |
| `measure-convergence.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `measure-alpha-convergence.mjs` | examples, `http://127.0.0.1:5300` | `--port` (9333) |
| `measure-drift-lag.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `measure-exposure-ceiling.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `measure-emitter-retention.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `measure-shading-restart.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `measure-receding-disocclusion.mjs` | bench, `http://127.0.0.1:5199` | `--port` (9333) |
| `verify-packed-guides.mjs` | its own `vite preview` on `--port` (a free port) | `--cdp-port` (a free port) |

```bash
node scripts/measure-convergence.mjs --scenario Q1 --ratio 2 \
  --url http://127.0.0.1:5601 --port 9601
```

`--url` is an origin, not a page. If something already answers there, the script
**reuses it** — so it must be the right server (this worktree's bench, not
another checkout's). If nothing answers, the script starts the dev server on
exactly that host and port with `--strictPort`, so a busy port fails fast instead
of Vite quietly moving to the next one. The bench and examples configs keep
separate dep-optimizer caches (`node_modules/.vite-bench`,
`node_modules/.vite-examples`), so both dev servers can run at once.

Most scripts print their full option list with `--help`. `measure-drift-lag.mjs`
and `measure-exposure-ceiling.mjs` have no help handler (`--help` starts a run);
their usage is in the header comment.

---

## Gotchas

- **Git worktrees read ~3× slow.** Absolute times from a benchmark launched in a
  scratchpad worktree are not comparable to repo-run records — the GPU never
  leaves its low power state. A/B comparisons *within* that environment are
  still valid; cross-environment absolutes are not.
- **A `node_modules` symlink in a worktree crashes the working-tree digest.**
  The root `.gitignore` pattern `node_modules/` does not match a symlink
  (trailing slash ≠ symlink). `.git/info/exclude` carries a slash-less entry.
- **The interactive bench reads higher than the timed runs.** `pnpm dev` is
  doing more per frame than the automated protocol. Do not compare the two.
- **Register pressure does not travel.** Costs that come from ALU and register
  allocation — rather than memory traffic — behave differently on a mobile tiler
  than on desktop. Do not extrapolate a desktop microsecond count to a phone.
