# Motion vectors — spec and plan

**Status (2026-11-14): decided — its own repo, extracted right after Phase 1.**
Phase 1 runs here; everything after it runs in the new repo,
[pmndrs/motion-vectors](https://github.com/pmndrs/motion-vectors) (created
2026-11-14, private and empty until Phase E), published as
`@pmndrs/motion-vectors`. The evidence this plan
builds on is the motion lab, [MOTION.md](MOTION.md). Nothing here ships in the
published `@pmndrs/upscaler`.

## 1. Why a shared package, in its own repo

Several of our tools reproject history through motion vectors: the upscaler, the
denoiser (`pmndrs/denoiser`), and the GI and reflection work. three's `velocity`
node, the usual source, is wrong in measurable ways (MOTION.md §2–§3):

- Vertex deformation (`positionNode`, morph targets, `displacementMap`) is
  compared against the *undeformed* geometry. A static deformed mesh reports
  motion on every frame, and an animated one (an ocean, a ripple) reports its
  total offset instead of its per-frame movement.
- The previous camera rolls once per animation-loop tick, not once per render.
- `setProjectionMatrix()` is baked in when each material's shader builds, so
  materials built before TAA or the upscaler is switched on carry jitter.

Why its own repo rather than a package inside the upscaler (decided 2026-11-14):

- **One motion source per renderer.** If each tool fixed this on its own, an app
  using two of them would get two nodes fighting over the same `velocity` render
  output, two camera histories and two projection matrices. Only one package that
  every tool takes as a peer dependency guarantees one source.
- **Dependency direction.** Motion is a lower layer the other tools share. They
  must not import it from the upscaler, one of its consumers.
- **Its own release cadence.** three will change slowly; our fix ships on its own schedule.
- **Clean partial retirement.** If three fixes its velocity node, the three node
  retires and the rest stays (§3.5). A separate repo makes that a small change
  rather than surgery on another project.

It stays separate from the downsampler too (§3.6): merging would tie their
releases together and make retiring the motion part awkward. They compose
through dependencies instead.

## 2. Goals and non-goals

**Goals**

- A written **motion contract** every tool and adapter agrees on (§3.1).
- A **three velocity node** that is correct for every case three gets wrong, at
  no measurable extra cost.
- **Engine-free products** on a bare `GPUDevice`: motion from depth, cut
  detection, and the warping-error metric.
- One package with a subpath per engine: raw WebGPU and three first, then Babylon and pixi.
- A **GPU acceptance harness** (the motion lab) that turns every claim into a number.

**Non-goals**

- Frame generation. It needs swapchain pacing browsers don't expose.
- Replacing an engine's velocity where the audit shows it's correct.
- Optical flow before gate **D3** (§6). It stays an experiment until a scene
  shows motion vectors can't do the job.

## 3. Spec

### 3.1 Motion contract

| Property | Contract |
|---|---|
| Value | NDC delta, **current − previous**, y up (three's `velocity` convention). A consumer converts to UV with `motionScale` (three: `(0.5, −0.5)`), and `prevUV = uv − motion · scale`. |
| Jitter | **Jitter-free.** Both endpoints use the unjittered projection. |
| Format | `rgba16float` at render resolution. `.xy` carries motion; `.zw` are reserved (see below) and consumers must ignore them. |
| Meaning | For each pixel: where the surface point under it was on screen last frame. Not "where the pixel's colour came from" (that's shading motion, out of contract). |
| Unknown | A point with no previous position (it was behind the previous camera, or newly spawned) reports **0** and must be flagged in `.z` once the flag is specified. |
| Per engine | Engines whose native convention differs (Babylon: linear `0.5·(prev − cur)`, Y-flipped render targets) are documented with their `motionScale`. The source today is the upscaler's [engine-contract.md](../engine-contract.md); its motion part moves to the new repo at extraction. |

Reserved channels: `.z` is a confidence/source flag (exact geometric, depth-derived
camera-only, estimated), `.w` is the previous linear depth. Both are specified
during Phase 2 and must be settled before the **P** gate (§6).

### 3.2 Three velocity node

Requirements. Each one maps to a measured failure (MOTION.md) and a lab test (§4).

| ID | Requirement | Mechanism |
|---|---|---|
| R1 | Camera history is per **frame**, not per animation-loop tick. | The node owns the previous view-projection. It advances on an explicit `beginFrame()` (the Upscaler already has one) and falls back to `renderId` bookkeeping when nothing drives it. |
| R2 | The projection is **always unjittered**, without the build-time trap. | One stable `Matrix4` per renderer, set before any material builds. Callers write into it and never swap it. |
| R3 | Skinning, `InstancedMesh` and `BatchedMesh` stay exact. | Reuse three's `positionPrevious`. three fills it whenever the MRT has an output **named `velocity`**, so our node must take that slot name. |
| R4 | Object history is per frame, not per draw. | A previous model matrix keyed on our frame counter. A second draw in the same frame (shadow pass, second view) must not overwrite it. |
| R5 | Morph targets are exact. | Keep last frame's morph influences per mesh and compute the previous morphed position. |
| R6 | `positionNode` is exact when the displacement depends only on uniforms (time, offsets, wave parameters). | Re-evaluate the `positionNode` graph with `positionLocal` → previous position and each uniform → last frame's value. three applies `positionNode` **last** (after morph, skinning, `displacementMap`, batching and instancing), so the previous position fed in is exactly the result of R3–R5. **Feasibility unverified: gate D1.** |
| R7 | Deformation the node can't see (texture- or storage-driven `positionNode`, compute-written positions) gets an author hook. | An opt-in previous-position node per material, so the author supplies last frame's value. |
| R8 | Anything still unknown is flagged, not guessed silently. | Rigid fallback (deformed position for both frames, which removes false motion but misses deformation motion), marked in `.z` and in a debug view. |
| R9 | `displacementMap` is handled like R6, with the map treated as a uniform input. | Same mechanism. A static map is exact; an animated map texture falls under R7. |
| R10 | One instance per renderer, even if two tools resolve different copies of the package. | A registry keyed on the renderer under a global `Symbol.for(...)`, so duplicate installs still share one node. The package is a **peer dependency** of its consumers. |
| R11 | Cost: no more than three's `velocity` + 5 % on the scene render, measured. | Bench A/B (§4). |
| R12 | Each fix can defer to three once upstream handles that case. | Per-case feature detection (or a pinned three range per fix), so the node shrinks as three improves (§3.5). |

### 3.3 Engine-free products (`/webgpu`)

| Product | Spec |
|---|---|
| Motion from depth | Depth + jittered inverse view-projection + current/previous unjittered view-projection → the §3.1 contract. Exact for static geometry, zero for object motion (flagged). Works for every engine that has depth. Built: `cameraMotion.ts`. |
| Cut detection | A luma histogram compared with earth mover's distance, **entirely on the GPU** (no readback). Writes a 1×1 flag a consumer reads in the same frame to reset its history. Default threshold from the lab (EMD 0.5; the cut read 1.28, camera motion at most 0.18), re-measured on more cut types. Built today with a CPU comparison: `lumaHistogram.ts`. |
| Warping error | A reference-free temporal-stability metric with an occlusion mask, as a measurement export for benches. Not a runtime feature. Built: `motionResidual.ts`. |
| Motion audit | Score candidate motion fields against the image (zero / engine / depth-derived / future flow). The lab's oracle; also usable by consumers to validate an engine. Built. |

### 3.4 Package shape (modelled on the downsampler)

One package, not the upscaler's workspace of private packages bundled into one
build. The downsampler's shape is the template:

| Entry | Holds |
|---|---|
| `@pmndrs/motion-vectors` | Backend-neutral core: the contract types, planning, CPU reference implementations (oracles) |
| `@pmndrs/motion-vectors/webgpu` | The §3.3 products on a bare `GPUDevice` |
| `@pmndrs/motion-vectors/three` | The §3.2 node and a three texture allocator |
| `@pmndrs/motion-vectors/babylon`, `/pixi` | Later (§6, Phase 5) |

- No runtime dependencies. `three` (and later `@babylonjs/core`, `pixi.js`) are optional peers.
- CI runs GPU tests on SwiftShader against CPU oracles, as the downsampler's does,
  next to the GPU-free unit tests. The real-GPU CDP harness (the lab) stays the
  acceptance oracle.
- Small shared glue (the GPU texture behind a three texture, the texture
  allocator) is **copied**, not shared, alongside the upscaler and downsampler
  copies. Revisit only if the copies start to drift.

### 3.5 Partial retirement

The three node exists because three is wrong today (§1). As upstream fixes land,
each R-requirement defers to three (R12) and the node shrinks. The engine-free
products, the audit and the contract stay useful either way. "Archived" therefore
most likely means the `/three` node retires while the package stays.

### 3.6 Relationship to the downsampler

Motion needs image reductions and pyramids: the cut-detection histogram now, and
a luma pyramid if optical flow lands (D3). That's the downsampler's job, so motion
may depend on it (as a dependency, or vendored like its self-contained `/mipmap`
file) rather than writing its own reductions.

### 3.7 Adapters

| Adapter | First version |
|---|---|
| `/three` | The §3.2 node, plus helpers to allocate published textures as three textures. |
| `/webgpu` | No engine: motion from depth plus the contract; the app supplies matrices. |
| `/babylon` | Babylon has its own velocity; run the same audit before wrapping or fixing anything. |
| `/pixi` | 2D usually has no depth, so the first version is app-supplied motion in the contract format. Optical flow is the long-term answer (D3). |

## 4. Acceptance harness

The motion lab (here: `bench/motion-lab.html`, `scripts/measure-motion.mjs`;
in the new repo: its own bench) is the oracle. Every requirement passes only on a
measured number.

Cases to add in Phase 1, each with a **hand-written oracle velocity** (the
correct previous position written analytically for that scene):

- **Animated wave** (`sin(kx + t)`): the node's motion matches the oracle and beats zero motion.
- **A→B move through `positionNode`, then a hold at B**: the per-frame step while moving, 0 while holding.
- **Morph weight ramp, then a hold**: matches the oracle; 0 while holding.
- **Several renders in one animation-loop tick**: matches a one-render-per-tick run.
- **Turning jitter on after warm-up**: no motion on a still scene.
- **Water**: an animated wave plane with a sun glint and a scrolling normal map. This splits geometric motion from shading motion, and it is the scene for D3.
- **A Q19-style camera track** (dolly, orbit, slide, scene receding) in the lab's
  own scene, replacing today's reuse of the upscaler's bench scenes.

Pass bars carried over from MOTION.md: on camera motion, three's velocity and
motion from depth agree (0.0040 on Q19's dolly/orbit segments); on the rigid box,
three's velocity beats zero motion (0.0004 vs 0.0010). The new camera track's own
numbers become the bar from Phase 1 on.

Cut detection adds a fade, a flash, a fast pan and a cut between similar shots,
with zero false positives on the camera track.

## 5. Code layout

**Until extraction (Phase 1, here):**

```
packages/motion/          → the new repo's src/ (core + /webgpu)
bench/motion-lab.html …   → the new repo's bench
scripts/measure-motion.mjs
```

- `packages/motion` **never imports `@pmndrs/upscaler-*`**. The one existing
  import (the `TextureAllocator` type) gets its own copy in Phase 1; an eslint
  rule enforces it.
- Nothing in the published upscaler `dist/` touches it.

**After extraction:** the new repo in the §3.4 shape. The upscaler keeps no copy;
its bench takes the package as a dev dependency, and only takes it as a peer
dependency once it ships a feature that uses it.

## 6. Plan and gates

### Phase 0: lab (done, 2026-11-13)
Motion from depth, the audit, warping error and CPU cut detection built and
GPU-verified. Findings are in MOTION.md. Committed `f2e6b0b`.

### Phase 1: get ready to leave (here; size: S)
- Copy the allocator type; add the eslint rule from §5.
- Give the lab its own scenes: the §4 oracle cases, water, and the Q19-style
  camera track, so nothing depends on the upscaler's `BenchScene` or scenarios.
- Write the contract (§3.1) as a draft doc next to the package.
- ~~Decide the name and scope (§9).~~ Done 2026-11-14: `pmndrs/motion-vectors`.

**Exit:** the lab runs every §4 case on its own scenes, three's numbers next to
each oracle; `packages/motion` and the lab import nothing from the upscaler.

### Phase E: extraction (size: S–M)
1. Scaffold the (already created, empty) repo like the downsampler (§3.4): one package,
   subpath exports, optional peers, typecheck → test (GPU-free + SwiftShader GPU)
   → build → pack check in CI, plus the CDP harness for real-GPU runs.
2. Move `packages/motion`, the lab and `measure-motion.mjs` **with history**
   (`git filter-repo` or a subtree split).
3. Move MOTION.md, this plan and the motion part of `engine-contract.md`;
   leave links in the upscaler.
4. Remove the incubating copies from the upscaler. Its motion experiments
   (warping error on upscaler output) run against the new repo as a dev dependency.

**Exit:** the new repo's CI is green and the lab reproduces Phase 1's numbers
there; upscaler CI is green without `packages/motion`.

### ⛳ D1: is automatic `positionNode` previous feasible? (new repo, start of Phase 2)
A time-boxed spike (about two days) on R6: clone a `positionNode` graph with
uniforms and `positionLocal` substituted, on r186.1.
- **Feasible:** build R6 as specified.
- **Partial** (works for some graph shapes): R6 for those, R7 hook for the rest, documented.
- **Infeasible:** R7 hook plus the R8 flag. Animated displacement becomes opt-in.

### Phase 2: three velocity node (new repo; size: M)
- `/three`: R1–R12.
- Settle the reserved channels.

**Exit:** every §4 case meets its oracle; the carried-over pass bars hold; the R11 cost is measured.

### Phase 3: core products (new repo; size: M)
- Cut detection on the GPU with the 1×1 flag (building on the downsampler for the reduction if it fits, §3.6).
- Motion from depth packaged as a drop-in velocity source.
- Warping error exported as a measurement tool.

**Exit:** cut cases pass with zero false positives; every cost measured.

### Phase 4: consumers (size: M)
- The upscaler bench consumes the node and the cut flag from a packed tarball (not a link).
- The denoiser does the same.
- Run the audit on Babylon's velocity with the deformers scene.
- File upstream #17/#18 with the lab as the repro
  ([UPSTREAM-CANDIDATES.md](UPSTREAM-CANDIDATES.md)).

**Exit:** both consumers render correctly on the packed package; Babylon findings recorded.

### ⛳ P: ready to publish 0.x (after Phase 4; review no later than **2026-12-15**, proposed)

Publish when all of these hold:
1. Phase 2 and 3 exits passed.
2. The contract (§3.1, including `.zw`) hasn't changed through Phase 4.
3. Two consumers (upscaler, denoiser) integrated from a packed tarball.
4. Costs measured for the node, cut detection and motion from depth.
5. Upstream checked: anything three already fixed defers to three (R12).

If one fails: name it, fix it, and set a new review date. The upscaler and the
denoiser then take the published package as a **peer dependency** (R10), and any
upscaler feature built on it (an auto-reset option, a depth-only motion mode)
ships from there.

### Phase 5: after 0.x
- Babylon, pixi and raw-WebGPU adapters past their first versions (§3.7).
- Retire node pieces as three fixes land upstream; keep the audit as the regression test.
- ⛳ **D3: optical flow go/no-go.** On the water scene, a block-matching flow
  candidate (FidelityFX Optical Flow port, with a workgroup-memory fallback for
  its 32/64-lane wave intrinsics, and pyramids from the downsampler) must cut
  "unexplained" on glints and scrolling detail without raising "beaten" where
  geometric motion is right. Go → a flow product in `/webgpu`, aimed at pixi,
  splats and video. No-go → recorded and closed.

## 7. Risks

| Risk | Mitigation |
|---|---|
| R6 graph substitution isn't possible in TSL | D1 decides early; R7 + R8 cover it. |
| Reusing `positionPrevious` ties us to three internals | It's a public TSL export, unlike the backend accessors we already depend on. Pin a three range and re-verify on each bump. |
| Two installed copies of the package | Peer dependency plus a `Symbol.for` registry per renderer (R10). |
| The contract changes after consumers adopt it | Gate P criterion 2; `.zw` reserved from the start. |
| Extracting early, before the node exists, means building it without the upscaler's bench next to it | Phase 1 moves every scene the lab needs; the upscaler is a dev dependency of the new repo for output-quality runs. |
| Glue copies drift between repos | Kept tiny; revisit a shared package only on observed drift (§3.4). |

## 8. Decision log

| Date | Decision | Status |
|---|---|---|
| 2026-11-13 | Measure before building: motion lab built, findings in MOTION.md | Done |
| 2026-11-14 | Own velocity node instead of patching three; upstream fixes in parallel | Agreed |
| 2026-11-14 | Own repo, separate from the upscaler and the downsampler; extract right after Phase 1 | Agreed |
| 2026-11-14 | Package shape follows the downsampler: one package, subpath per engine, optional peers | Agreed |
| 2026-11-14 | Name: repo `pmndrs/motion-vectors`, package `@pmndrs/motion-vectors`; repo created under `pmndrs`, private until 0.x | Done |
| — | D1: `positionNode` previous feasibility | Pending (Phase 2) |
| — | P: publish 0.x | Pending (review by 2026-12-15, proposed) |
| — | D3: optical flow | Pending (Phase 5) |

## 9. Open questions

- ~~Name and scope; repo owner.~~ Settled 2026-11-14 (§8): `pmndrs/motion-vectors`,
  scoped like the upscaler and denoiser. `motion` alone collides with the Motion
  animation library; `reprojection` was the alternative for a broader scope.
  `@pmndrs/motion-vectors` was unpublished on npm that day; claim it at gate P.
- **Downsampler as a dependency or vendored** for the reductions (§3.6)?
- **Second consumer order.** Is the denoiser the right first non-upscaler consumer, or is the GI work closer?
