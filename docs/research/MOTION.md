# Motion lab (experimental)

Can we do better than three's `velocity` node, and what does motion analysis buy
the upscaler beyond pixi? This lab measures it before anything ships. Nothing
here is in the published package.

**Status (2026-11-14, Apple Metal-3, three r186.1):** analysis passes and the lab
are built and GPU-verified; every number below comes from exact GPU readback.
Phase 1 (§7) gave the lab its own scenes and an exact per-object oracle, and
moved it into `packages/motion` so it leaves with the package for
[pmndrs/motion-vectors](https://github.com/pmndrs/motion-vectors). §2–§6 are
the Phase 0 record (warp-residual proxy); §7 supersedes them where they overlap.
No optical flow yet. That is deliberately gated on the results here (§8).

## 1. What was built

| Piece | Where | What it does |
|---|---|---|
| Camera motion from depth | `packages/motion/src/shaders/cameraMotion.ts` | Unprojects render-res depth through the *jittered* inverse view-projection and reprojects through the current and previous *unjittered* ones. The result is three's `velocity` convention (NDC delta, current − previous), so the upscaler can consume it unchanged. Exact for static geometry; blind to object motion by construction. |
| Warp residual | `packages/motion/src/shaders/motionResidual.ts` | Per pixel and per candidate motion field (zero motion is always candidate 0), warps the previous image by bilinear sampling and compares conditioned luma `l/(1+l)`. An occlusion test compares the previous linear depth at the warped position with the static-scene expectation (5 % relative). Per-workgroup reduction gives the mean residual plus valid / best / unexplained (> 0.02) / beaten / moving shares. Debug views: classification, per-candidate heat, per-candidate motion. |
| Luma histogram | `packages/motion/src/shaders/lumaHistogram.ts` | 64 bins of conditioned luma, the cheapest form of FidelityFX Optical Flow's scene-change signal. Compared on the CPU (`math/histogram.ts`: Jensen–Shannon, earth mover's distance). |
| Oracle comparison | `packages/motion/src/shaders/motionCompare.ts` | Per object id, endpoint error in render pixels of each candidate against an oracle rendered in the same pass (§7). |
| `MotionAnalyzer` | `packages/motion/src/MotionAnalyzer.ts` | Engine-free orchestration on a bare `GPUDevice` (its own copy of the `TextureAllocator` seam). |
| Motion lab | `packages/motion/lab/` | The package's own scenes (deformers, move-then-hold cases, water, a courtyard camera track and a cut timeline) with oracle materials. No upscaler. |
| Lab driver | `packages/motion/scripts/measure-motion.mjs` | Experiments `oracle`, `deformers`, `cases`, `ticks`, `jitter`, `water`, `track`, `cuts`, plus `probe`. |
| Upscaler probe | `bench/motion-upscaler.html`, `bench/src/probes/motionUpscaler.ts`, `scripts/measure-motion-upscaler.mjs` | The upscaler's consumer of the package: Q19/Q10 through native / bilinear / spatial / temporal (`audit-q19`, `warp`, `cut`). Stays in the upscaler. |

```bash
node packages/motion/scripts/measure-motion.mjs          # the lab, all experiments, ~2 min
node packages/motion/scripts/measure-motion.mjs --experiments probe --request '{"scene":"water","view":"audit-heat","heatCandidate":3}'
node scripts/measure-motion-upscaler.mjs                  # upscaler experiments (§4–§6)
```

Raw output lands in `packages/motion/results/<label>/` and
`bench/results/raw/motion/<label>/` (both gitignored); rerun the command to
regenerate it.

### Reading the metrics

- **Residual** is mean |current − warped previous| in conditioned luma, over the
  pixels where that candidate passed the bounds and depth test.
- **Under ~1 px of motion the audit can't discriminate.** On aliased edges,
  bilinear resampling error is as large as the error of not moving. The control
  box spins at ~3 px/frame for this reason. "Best" is tie-biased toward zero
  motion (candidate 0 wins exact ties on flat regions), so read residual and
  "beaten" instead.
- **The `|out − SSAA|` reference** is a 2×2 box supersample. It's a sanity check
  only; quality claims belong to `scripts/measure-reference-quality.mjs`
  (64-sample reference, PSNR/SSIM after the presentation transform). The two
  agree: on Q19, temporal and spatial are close against a reference in both.

## 2. three's `velocity`: where it's wrong (deformers scene)

Still camera, one object at a time, native path (no jitter), frames 1–239.
Whole-frame shares.

| Object | Zero-motion residual | three's residual | three "moving" | three beaten |
|---|---|---|---|---|
| Rigid rotating box (control) | 0.0010 | **0.0004** | 2.58 % | 0.17 % |
| Static `positionNode` displacement | **0.0000** | 0.0028 | 4.90 % | 1.87 % |
| Animated `positionNode` displacement | **0.0001** | 0.0021 | 4.42 % | 1.61 % |
| Morph target | **0.0000** | 0.0005 | 1.92 % | 0.50 % |
| Ball leaving and re-entering the frustum | 0.0003 | **0.0001** | 0.39 % | 0.00 % |

- **Deformation reads as motion.** `positionPrevious` is the raw geometry, but
  `positionNode` and morph targets move `positionLocal`. So a mesh that doesn't
  move at all reports its displacement as motion on every pixel, and a moving
  deformation reports something worse than zero. Skinning, `InstancedMesh` and
  `BatchedMesh` are handled correctly. Upstream candidate #17.
- **Stale previous matrix after culling: real but negligible.** On the one
  frame the ball re-enters (163), its edge sliver warps to where it was last
  drawn. That lands off-target, the depth test rejects it, and the upscaler's
  disocclusion test does the same. A frame later the matrix is fresh.
- **Shading motion isn't explained by any motion vector.** Frames 155–162: the
  ball's shadow crosses the floor before the ball is visible, and every
  candidate leaves it unexplained (0.002 → 0.045 % of the frame). That's the
  class of change only image-based flow could follow.

## 3. Two three landmines found building this

1. **Camera history advances per `NodeFrame` frame, not per render.**
   `VelocityNode.update()` rolls the previous camera only when `frameId`
   changes, and only three's own RAF loop advances it. The first lab version
   rendered many frames per tick, and three's velocity scored *worse than zero
   motion* on camera motion (0.044 vs 0.022) while object motion stayed right
   (object history is per draw). The lab now stops `renderer._animation` and
   advances `nodeFrame` itself, as the bench does (`advanceAutomatedFrame`).
2. **`velocity.setProjectionMatrix()` is baked in when a material's shader
   builds.** `null` means "use the camera projection", which is jittered while
   an upscaler or TAA runs. Materials built under `null` keep it after a later
   `setProjectionMatrix(M)`. After a native run, the next temporal run's
   velocity carried the jitter on every still frame (99.98 % of pixels
   "moving"). `UpscalePass` is safe because it hands over one stable matrix
   before any build. An app that toggles TAA or upscaling at runtime is not.
   Upstream candidate #18.

## 4. Camera motion from depth vs three's velocity (Q19)

Native path, so no jitter. Audit residual (lower is better):

| Segment | three | camera-from-depth | zero |
|---|---|---|---|
| dolly-back / forward | 0.0040 / 0.0041 | 0.0040 / 0.0041 | 0.0224 / 0.0224 |
| orbit-left / right | 0.0040 / 0.0040 | 0.0040 / 0.0040 | 0.0265 / 0.0265 |
| slide | 0.0018 | 0.0018 | 0.0220 |
| dolly-back-fast | 0.0039 | 0.0039 | 0.0349 |
| scene-recede / approach (object motion) | **0.0040 / 0.0041** | 0.0213 / 0.0213 | 0.0213 / 0.0213 |

The two agree to four decimals on every camera segment, which validates the pass
and the motion convention. On object motion it is exactly as good as zero, as
designed.

Fed to the temporal upscaler (ratio 2), output warping error matches three's
velocity within 0.0001 on every camera segment (0.0013–0.0022) and is
2.2–2.5× worse on object segments (0.0038 vs 0.0017 / 0.0015). So for scenes where nothing moves but the camera
(archviz), motion from depth is a drop-in replacement for the velocity target.
It also sidesteps every gap in §2–§3. **Not measured yet:** what dropping the
velocity attachment saves (a second rgba16float MRT write per render pixel, plus
the velocity vertex math).

## 5. Warping error: reference-free temporal stability (Q19, ratio 2)

Mean |output − output from the previous frame, warped by three's motion|,
occlusion-masked:

| Path | Under motion | On holds | `|out − SSAA|` motion / still |
|---|---|---|---|
| native (1280×720) | 0.0038 | 0.0000 | 0.0045 / 0.0044 |
| bilinear | 0.0030 | 0.0000 | 0.0192 / 0.0190 |
| spatial (FSR1) | 0.0049 | 0.0000 | 0.0163 / 0.0162 |
| **temporal** | **0.0017** | 0.0002 | 0.0184 / 0.0168 |
| temporal, camera motion from depth | 0.0022 | 0.0002 | 0.0202 / 0.0173 |

The temporal path is the most stable under motion: 2.2× steadier than native and
1.8× steadier than bilinear. FSR1 is the least stable, because RCAS sharpens
aliasing that then crawls. On holds, temporal's 0.0002 is jitter churn, which the
convergence meters already track.

This metric complements `measure-reference-quality.mjs`'s temporal error rather
than replacing it. It needs no reference render, so it runs in the same frame,
on the GPU, on any footage: other engines, three's TRAA, or a consumer's
capture.

## 6. Cut detection (Q10 cut at frame 60; Q19 for false positives)

| Distance | At the cut | Q10 other frames (animated, still camera) | Q19 motion max | Margin |
|---|---|---|---|---|
| Jensen–Shannon (bits) | 0.115 | 0.000 | 0.037 | 3.1× |
| Earth mover's (bins) | **1.284** | 0.008 | 0.177 | **7.3×** |

With auto-reset at EMD > 0.5, the reset fires exactly at frame 60 and nowhere
else, and the output matches the scenario's own reset. Error against the SSAA
reference:

| Frames | No reset | Auto (EMD > 0.5) = scenario reset |
|---|---|---|
| 60–63 | 0.0142 | 0.0079 |
| 64–79 | 0.0113 | 0.0073 |
| 80–119 | 0.0095 | 0.0077 |

Without a reset, the previous view ghosts for ~1 s. Today the upscaler relies
on the app to call `resetHistory()` on cuts.

## 7. Phase 1: an exact oracle in the lab's own scenes (2026-11-14)

Every lab object now carries an **oracle**: a material output that re-evaluates
the scene's analytic state at the previous frame (its own unjittered camera
matrices, its own previous model matrices, deformations re-run at last frame's
time) and writes the exact contract value. Oracle and candidates are written for
the same rasterized point, so `motionCompare.ts` measures each candidate's error
in render pixels, with no warping, aliasing or occlusion in the way. The warp
residual (§2) stays for what the oracle can't see: shading motion.

1280×720, no jitter unless stated. "Moved" is the oracle's mean motion; errors
are means over the object's pixels (per-pixel errors capped at 64 px, so a capped
mean is a lower bound).

### The oracle is right where three is known to be

Courtyard camera track (Q19's motion types in the lab's own scene, up to
33 px/frame): three's `velocity` and motion from depth both read **0.000 px**
against the oracle on every camera segment, for static geometry and for
instrumented props. On moving props, motion from depth misses all of it
(1.68 px error = 1.68 px moved), as designed. This is the new bar for the camera
track; per-segment numbers are in the `track` experiment.

### three's `velocity` against the oracle

| Case | Moved | Zero motion | three | three > 1 px |
|---|---|---|---|---|
| Static `positionNode` displacement | 0 | 0 | **3.24 px** | 88 % |
| Animated displacement `sin(5x + 3t)` | 0.16 px | 0.16 | **3.14** | 85 % |
| Morph target, oscillating | 0.09 | 0.09 | **4.87** | 73 % |
| Rigid rotating box (control) | 2.37 | 2.37 | 0.000 | 0 % |
| Ball re-entering the frustum | 14.5 | 14.5 | 0.024 (64+ on frame 163) | 0 % |
| `positionNode` A→B, while moving | 3.12 | 3.12 | **51.9** | 98 % |
| … then holding at B | 0 | 0 | **64+ (cap)** | 100 % |
| Morph ramp 0→1, while ramping | 0.19 | 0.19 | **5.70** | 79 % |
| … then holding at 1 | 0 | 0 | **11.6** | 95 % |
| Rigid A→B, moving / holding (control) | 3.12 / 0 | | 0.000 / 0.000 | 0 % |
| Water swell (geometric) | 0.39 | 0.39 | **11.8** | 94 % |
| Bobbing buoy (rigid) | 0.29 | 0.29 | 0.000 | 0 % |

So for deformation, three is not just imprecise: it is **worse than reporting no
motion at all**, by 1–2 orders of magnitude, and the error doesn't fade when the
deformation stops. It reports the total offset from the undeformed geometry, so a
held pose or a static displacement looks like fast motion forever.

### Frame history and jitter

| Case | Moved | three | three > 0.25 px |
|---|---|---|---|
| Camera track, 1 render per tick | 7.47 px | 0.000 | 0 % |
| 2 renders per tick | 7.47 | **10.55** | 98 % |
| 4 renders per tick | 7.47 | **23.93** | 98 % |
| Still scene, jitter switched on at frame 10, one stable matrix | 0 | 0.000 | 0 % |
| Same, materials built under `setProjectionMatrix(null)` first | 0 | **0.364** | 90 % |

With several renders per tick it's worse than "stale": three rolls the previous
camera only on a new tick, so within a tick the previous camera stays pinned to
the tick before last while the current one keeps moving, and the error grows by
one frame of motion per render (≈ 1.5 frames of motion on average at 2 per tick).
The jitter trap reproduces §3's finding exactly: about half a pixel of jitter
reported as motion on every pixel of a still scene.

### Water: shading motion

On the water scene the oracle explains the geometry exactly, but its warp
residual is no better than zero motion's (0.0013 vs 0.0013; 1.06 % vs 1.01 %
unexplained): at 0.39 px/frame of swell, what changes in the image is the glint
and the scrolling ripples, which no motion vector carries. three's motion makes
the image *worse* (0.0058, 1.71 % unexplained). This is the D3 scene: flow is
justified only if it cuts that unexplained share.

### Cut detection: the histogram fails inside one scene

The lab's cut timeline cuts between views of the **same** courtyard, which is the
common case in practice (shot/reverse shot, a camera switch in a game). The
histogram can't tell those cuts from a lighting change:

| Event | EMD (bins) | JS (bits) | Pixels no candidate can reproject |
|---|---|---|---|
| Hard cut to another angle (frame 30) | 0.344 | 0.037 | **44.4 %** |
| Cut between similar shots (frame 60) | 0.355 | 0.039 | **66.5 %** |
| Cut back after a pan (frame 270) | 0.915 | 0.141 | **98.5 %** |
| Fade to 5 % and back (max per frame) | 0.346 | 0.228 | 0.0 % |
| One-frame ×6 flash | **14.19** | 0.748 | 0.0 % |
| Fast pan, 3°/frame | 0.066 | 0.004 | 1.3 % |
| Courtyard track, worst motion segment (fast dolly) | — | — | 4.95 % |

Phase 0's EMD threshold of 0.5 (fit on Q10, where the cut changes the whole
palette) misses both in-scene cuts and fires on the flash; no histogram threshold
separates cuts from fades here. The **depth-consistency share** does: the
fraction of pixels where neither the engine's motion nor zero motion lands on a
matching previous depth. It reads 44–99 % on every cut and at most 5 % on
everything else (≈ 9× margin), because a cut is exactly the frame where geometry
stops being continuous. Lighting changes don't touch depth at all. It needs
depth, so the histogram stays the fallback for depth-less inputs (pixi, video).

## 8. What's worth building next

The agreed spec and phased plan, with decision gates and the intended split
into its own package, is [MOTION-VECTORS-PLAN.md](MOTION-VECTORS-PLAN.md).

Ranked by value over cost. Each needs its cost measured (GPU timing) before it
ships.

1. **Automatic cut detection in the upscaler.** It's a clear win and cheap.
   Phase 1 (§7) changed the signal: key it on the depth-consistency share
   (pixels no motion candidate can reproject), not the luma histogram, which
   misses cuts inside one scene and fires on flashes. Compute it on the GPU (no
   readback; the reset feeds the next frame's history weight), behind an option.
   The upscaler's own disocclusion pass may already hold most of this signal.
2. **A depth-only motion mode** (`velocity` omitted → camera motion from depth)
   for static scenes. Measure the saved MRT and vertex cost, and document the
   object-motion limit.
3. **Warping error in the bench tooling**, as a motion counterpart to the
   still-scene convergence meters, so regressions under motion stop depending
   on eyeballing.
4. **File upstream #17/#18** with this lab as the repro.
5. **Optical flow (FidelityFX OF port)** is now justified only for what §2's
   shadow case shows: shading motion and inputs with no velocity at all
   (pixi, Gaussian splats, video). Next experiment: a block-matching pass as
   a fourth candidate. Does it cut "unexplained" on moving shadows and
   specular without raising "beaten" where three's motion is right? The FFX
   kernel's wave intrinsics assume 32/64 lanes (`ffxWaveSum`/`ffxWaveMin`), so
   the WGSL needs a workgroup-memory reduction where subgroups aren't
   available.
