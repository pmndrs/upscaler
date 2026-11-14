# Motion contract (draft)

**Status: draft, 2026-11-14.** This is what every producer (an engine's velocity
output, our three node, motion from depth) and every consumer (the upscaler, the
denoiser, GI) agrees a motion vector means. It is checked by the motion lab's
oracle (`lab/`, `scripts/measure-motion.mjs`). The open items at the end must be
settled before the 0.x publish (gate P in
[MOTION-VECTORS-PLAN.md](../../docs/research/MOTION-VECTORS-PLAN.md)).

## The value

| Property | Contract |
|---|---|
| Meaning | For each pixel: where the **surface point** under it was on screen in the previous frame. A point that moves because its object moves, its camera moves, or its geometry deforms (skinning, morph targets, `positionNode`, displacement) has motion. Shading that moves across a still surface (a glint, a scrolling texture, a moving shadow) has none: that is shading motion, out of contract. |
| Value | NDC delta, **current − previous**, y up: three's `velocity` convention. |
| To UV | `motionUV = motion · motionScale`, and `previousUV = uv − motionUV`. three and raw WebGPU: `motionScale = (0.5, −0.5)`. |
| Jitter | **Jitter-free.** Both endpoints use the unjittered projection. A producer that renders under a jittered projection still reports the motion of the unjittered one. |
| Frame | "Previous" is the previous **frame** the consumer advanced, not the previous render, the previous animation-loop tick, or the last time the object was drawn. Several renders in one frame (shadows, second views) don't advance it; one render per frame from a loop that ticks less often still does. |
| First frame / reset | Zero motion, never garbage. |
| Format | `rgba16float` at render resolution, the same size as the colour and depth it describes. |
| `.xy` | The motion. |
| `.z` | Reserved: a confidence/source flag (exact geometric, depth-derived camera-only, rigid fallback, unknown). Consumers ignore it until it is specified. |
| `.w` | Reserved: the previous linear depth. Consumers ignore it until it is specified. |

## Unknown motion

A point with no previous position (it was behind the previous camera, or it
spawned this frame) reports **0** and, once `.z` is specified, a flag. A producer
that can't compute a deformation's previous position (texture- or
storage-driven displacement, compute-written vertices) must not guess silently:
it reports the rigid motion of the object (no false motion from the deformation
itself, but none of its real motion either) and flags it.

## Per engine

| Engine | Native convention | `motionScale` | Notes |
|---|---|---|---|
| three (WebGPU) | NDC current − previous, y up | `(0.5, −0.5)` | three's own `velocity` breaks the contract on deformation, on frame history and on jitter after a runtime switch; see "Conformance". |
| raw WebGPU (motion from depth) | the contract | `(0.5, −0.5)` | Exact for static geometry; zero for object motion (to be flagged in `.z`). |
| Babylon (WebGPU) | linear `0.5 · (previous − current)`, render targets Y-flipped | `(−1, −1)` | From the upscaler's `docs/engine-contract.md` and `docs/babylon.md`; moves here at extraction. The audit has not been run on Babylon yet. |

## Conformance

The lab renders an oracle next to each producer: per-object materials that
re-evaluate the scene's analytic state at the previous frame and write the exact
contract value for the same rasterized point. The comparison is per pixel, in
render pixels of endpoint error (`src/shaders/motionCompare.ts`), so it needs no
image warping and has no aliasing noise.

A conforming producer, at 1280×720:

- **Rigid, camera and object motion:** mean error below 0.01 px. three's
  `velocity` and motion from depth (static geometry) both read 0.000 px on
  every courtyard track segment, up to 33 px/frame of motion.
- **Holds:** exactly zero wherever nothing moved, including deformed geometry at rest.
- **Deformation:** below 0.01 px when the producer claims exact; flagged otherwise.
- **Jitter:** zero on a still scene with jitter on, however the jitter was switched on.
- **Frame history:** unchanged error with several renders per animation-loop tick.

What three r186.1's `velocity` reads against these (lab, 2026-11-14): 3.2 px on a
*static* displaced plane, 51.9 px while a `positionNode` moves an object and
64+ px (the cap) once it holds, 11.6 px on a morph target held at weight 1,
11.8 px on an animated water swell, 0.36 px of jitter on a still scene after a
runtime switch, and 10.6 / 23.9 px with 2 / 4 renders per tick. Rigid and
camera motion are exact. Skinning, instancing and batching use three's own
previous data and are not measured yet. Findings: [MOTION.md](../../docs/research/MOTION.md) §7.

## Open before 0.x

- Specify `.z` (flag values) and `.w` (linear depth: view-space or the engine's own).
- Whether "previous frame" is advanced by an explicit `beginFrame()` only, or
  also inferred (render id) when nothing drives it.
- Babylon and pixi rows: run the audit before claiming either.
