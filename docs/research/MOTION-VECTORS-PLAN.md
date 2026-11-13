# Motion vectors — spec and plan

**Status: incubating in this repo, intended to split (2026-11-14).** The working
name is `@pmndrs/motion-vectors`; the final name is open (§9). The evidence this
plan builds on is the motion lab, [MOTION.md](MOTION.md). Until decision gate
**D2** (§6) passes, nothing here ships in the published `@pmndrs/upscaler`.

## 1. Why a shared package

Several of our tools reproject history through motion vectors: the upscaler, the
denoiser (`pmndrs/denoiser`, which has its own three/WebGPU packages), and the GI
and reflection work. three's `velocity` node, the usual source, is wrong in
measurable ways (MOTION.md §2–§3):

- Vertex deformation (`positionNode`, morph targets, `displacementMap`) is
  compared against the *undeformed* geometry. A static deformed mesh reports
  motion on every frame, and an animated one (an ocean, a ripple) reports its
  total offset instead of its per-frame movement.
- The previous camera rolls once per animation-loop tick, not once per render.
- `setProjectionMatrix()` is baked in when each material's shader builds, so
  materials built before TAA or the upscaler is switched on carry jitter.

**There must be one motion source per renderer.** If each tool fixed this on its
own, an app using two of them would get two nodes fighting over the same
`velocity` render output, two camera histories and two projection matrices. A
shared package gives every tool the same correct motion. That's the reason to
split, more than code reuse.

## 2. Goals and non-goals

**Goals**

- A written **motion contract** every tool and adapter agrees on (§3.1).
- A **three velocity node** that is correct for every case three gets wrong, at
  no measurable extra cost.
- **Engine-free products** on a bare `GPUDevice`: motion from depth, cut
  detection, and the warping-error metric.
- One adapter per engine, behind subpath exports: three first, then raw WebGPU,
  Babylon and pixi.
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
| Per engine | Engines whose native convention differs (Babylon: linear `0.5·(prev − cur)`, Y-flipped render targets) are documented with their `motionScale`. The source of truth is today's [engine-contract.md](../engine-contract.md), which moves with the package. |

Reserved channels: `.z` is a confidence/source flag (exact geometric, depth-derived
camera-only, estimated), `.w` is the previous linear depth. Both are specified
during Phase 2 and must be settled before **D2**.

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
| R10 | One instance per renderer, even if two tools bundle different copies of the package. | A registry keyed on the renderer under a global `Symbol.for(...)`, so duplicate installs still share one node. The package is a **peer dependency** of its consumers. |
| R11 | Cost: no more than three's `velocity` + 5 % on the scene render, measured. | Bench A/B (§4). |

### 3.3 Engine-free products (`/core`)

| Product | Spec |
|---|---|
| Motion from depth | Depth + jittered inverse view-projection + current/previous unjittered view-projection → the §3.1 contract. Exact for static geometry, zero for object motion (flagged). Works for every engine that has depth. Built: `cameraMotion.ts`. |
| Cut detection | A luma histogram compared with earth mover's distance, **entirely on the GPU** (no readback). Writes a 1×1 flag a consumer reads in the same frame to reset its history. Default threshold from the lab (EMD 0.5; the cut read 1.28, camera motion at most 0.18), re-measured on more cut types. Built today with a CPU comparison: `lumaHistogram.ts`. |
| Warping error | A reference-free temporal-stability metric with an occlusion mask, as a measurement export for benches. Not a runtime feature. Built: `motionResidual.ts`. |
| Motion audit | Score candidate motion fields against the image (zero / engine / depth-derived / future flow). The lab's oracle; also usable by consumers to validate an engine. Built. |

### 3.4 Adapters

| Adapter | First version |
|---|---|
| `/three` | The §3.2 node, plus helpers to allocate published textures as three textures (as the upscaler's allocator does). |
| `/webgpu` | No engine: motion from depth plus the contract; the app supplies matrices. |
| `/babylon` | Babylon has its own velocity; run the same audit before wrapping or fixing anything. |
| `/pixi` | 2D usually has no depth, so the first version is app-supplied motion in the contract format. Optical flow is the long-term answer (D3). |

## 4. Acceptance harness

The motion lab (`bench/motion-lab.html`, `scripts/measure-motion.mjs`) is the
oracle. Every requirement passes only on a measured number.

Cases to add during Phase 1, each with a **hand-written oracle velocity** (the
correct previous position written analytically for that scene):

- **Animated wave** (`sin(kx + t)`): the node's motion matches the oracle and beats zero motion.
- **A→B move through `positionNode`, then a hold at B**: the per-frame step while moving, 0 while holding.
- **Morph weight ramp, then a hold**: matches the oracle; 0 while holding.
- **Several renders in one animation-loop tick**: matches a one-render-per-tick run.
- **Turning jitter on after warm-up**: no motion on a still scene.
- **Water**: an animated wave plane with a sun glint and a scrolling normal map. This splits geometric motion from shading motion, and it is the scene for D3.

Existing pass bars that must not move: Q19 camera segments (residual 0.0040,
equal to motion from depth) and the rigid box (0.0004 against zero motion's 0.0010).

Cut detection adds a fade, a flash, a fast pan and a cut between similar shots,
with zero false positives on Q19.

## 5. Where the code lives while incubating

The layout mirrors the eventual repo, so extraction is a move, not a refactor:

```
packages/motion/          → becomes the new repo's core package (engine-free)
packages/motion-three/    → becomes its /three adapter (Phase 2)
bench/motion-lab.html …   → the harness; split between both repos at extraction
```

Rules from today:
- `packages/motion*` **never imports `@pmndrs/upscaler-*`**. The one existing
  import (the `TextureAllocator` type) gets its own copy in Phase 1. An eslint
  rule enforces it.
- The upscaler may import `packages/motion*` **only from the bench** until D2.
  Nothing reaches the published `dist/`.

## 6. Plan and decision gates

### Phase 0: lab (done, 2026-11-13)
Motion from depth, the audit, warping error and CPU cut detection built and
GPU-verified. Findings are in MOTION.md.

### Phase 1: boundary and harness (size: S)
- Copy the allocator type; add the eslint rule from §5.
- Add the §4 scenes and their oracles.
- Write the contract (§3.1) as a draft doc next to the package.

**Exit:** every §4 case runs and reports three's numbers next to the oracle.

### ⛳ D1: is automatic `positionNode` previous feasible? (start of Phase 2)
A time-boxed spike (about two days) on R6: clone a `positionNode` graph with
uniforms and `positionLocal` substituted, on r186.1.
- **Feasible:** build R6 as specified.
- **Partial** (works for some graph shapes): R6 for those, R7 hook for the rest, documented.
- **Infeasible:** R7 hook plus the R8 flag. Animated displacement becomes opt-in.

### Phase 2: three velocity node (size: M)
- `packages/motion-three`: R1–R11.
- Settle the reserved channels.
- Wire the node into the upscaler bench as an alternative input.

**Exit:** every §4 case meets its oracle; Q19 and the rigid box are unchanged; the R11 cost is measured.

### Phase 3: core products (size: M)
- Cut detection on the GPU with the 1×1 flag, plus the upscaler option behind a `_`-prefixed bench knob.
- Motion from depth as an upscaler input mode (bench only); measure what dropping the velocity render output saves.
- Warping error into the bench tooling as a motion regression meter.

**Exit:** cut cases pass with zero false positives; every cost measured.

### Phase 4: second consumer and Babylon audit (size: M)
- The denoiser consumes the node through a packed tarball, not a workspace link,
  so the package boundary is tested for real.
- Run the audit on Babylon's velocity with the deformers scene.
- File upstream #17/#18 with the lab as the repro
  ([UPSTREAM-CANDIDATES.md](UPSTREAM-CANDIDATES.md)).

**Exit:** the denoiser renders correctly on our motion; Babylon findings recorded.

### ⛳ D2: split decision (after Phase 4; review no later than **2026-12-15**, proposed)

Split when all of these hold:
1. Phase 2 and 3 exits passed.
2. The contract (§3.1, including `.zw`) hasn't changed through Phase 4.
3. One non-upscaler consumer (the denoiser) integrated from a packed tarball.
4. Costs measured for the node, cut detection and motion from depth.
5. Upstream checked: if three has already fixed part of §1, scope shrinks to what's still wrong.

Outcomes:
- **Split** → Phase 5.
- **Not yet** → name the failing criterion, fix it, and set a new review date.
- **Keep here** → publish as a second package from this repo. Only if the release
  tooling can publish two packages cleanly; it publishes one today.
- **Stop** → three fixed enough upstream; keep core products only.

### Phase 5: extraction (size: M)
1. Create the repo (named per §9) with the upscaler's scaffolding: pnpm
   workspace, core + adapter packages, subpath exports, lint → typecheck → test →
   build → packed-subpaths CI, GPU-free tests, and the CDP GPU harness.
2. Move `packages/motion*` **with history** (`git filter-repo` or a subtree split).
3. Move the motion lab with its own scenes (deformers, water, the §4 oracles,
   a Q19-like motion track). The upscaler keeps its own bench and its warping-error
   runs through the package's metric export.
4. Move the contract from `docs/engine-contract.md` (motion part) and MOTION.md;
   leave links behind.
5. Publish 0.x. The upscaler and the denoiser take it as a **peer dependency**
   (one copy per app, R10).
6. Upscaler: switch the bench, then any shipped feature (cut detection, depth
   motion), to the published package; drop the incubating copies.

**Exit:** both consumers on the published package, upscaler CI green, packed-subpaths
verified in both repos.

### Phase 6: after the split
- Babylon, raw WebGPU and pixi adapters (§3.4).
- Retire node pieces as three fixes land upstream; keep the audit as the regression test.
- ⛳ **D3: optical flow go/no-go.** On the water scene, a block-matching flow
  candidate (FidelityFX Optical Flow port, with a workgroup-memory fallback for
  its 32/64-lane wave intrinsics) must cut "unexplained" on glints and scrolling
  detail without raising "beaten" where geometric motion is right. Go → a flow
  product in core, aimed at pixi, splats and video. No-go → recorded and closed.

## 7. Risks

| Risk | Mitigation |
|---|---|
| R6 graph substitution isn't possible in TSL | D1 decides early; R7 + R8 cover it. |
| Reusing `positionPrevious` ties us to three internals | It's a public TSL export, unlike the backend accessors we already depend on. Pin a three range and re-verify on each bump, as the upscaler does. |
| Two installed copies of the package | Peer dependency plus a `Symbol.for` registry per renderer (R10). |
| The contract changes after consumers adopt it | D2 criterion 2; `.zw` reserved from the start. |
| Extraction loses lab context | The lab moves with the package; MOTION.md stays as the record. |
| Release tooling is single-package | The new repo gets its own; "Keep here" at D2 is only viable if that is solved. |

## 8. Decision log

| Date | Decision | Status |
|---|---|---|
| 2026-11-13 | Measure before building: motion lab built, findings in MOTION.md | Done |
| 2026-11-14 | Own velocity node instead of patching three; upstream fixes in parallel | Agreed |
| 2026-11-14 | Incubate here, intend to split; gate D2 decides | Agreed |
| — | D1: `positionNode` previous feasibility | Pending (Phase 2) |
| — | D2: split | Pending (review by 2026-12-15, proposed) |
| — | D3: optical flow | Pending (Phase 6) |

## 9. Open questions

- **Name.** `@pmndrs/motion-vectors` is the working name; `motion` alone collides
  with the Motion animation library.
- **Repo owner.** Under `pmndrs` from the start, or private until 0.x?
- **Is the denoiser the right first second consumer?** Or is the GI work closer?
- **Should cut detection ship in the upscaler before the split** if it's ready
  early? That conflicts with the "nothing ships before D2" rule; decide at Phase 3 exit.
