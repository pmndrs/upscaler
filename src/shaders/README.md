# WGSL passes

Every pass is a WGSL compute module assembled from shared chunks (`common.ts` + pass body) by `wgsl.ts` — WGSL has no `#include`, so chunks are TS strings deduplicated by the assembler. All passes bind the same 96-byte `FsrConstants` UBO at `@group(0) @binding(0)` (layout mirrored by `internal/ConstantsBuffer.ts`), run as 8×8 workgroups, and write storage textures. Entry point is always `main`.

## Conventions

- **Coordinate space** — texel coordinates and UVs are top-left origin. Motion vectors arrive from three's `velocity` node as NDC deltas (`current − previous`) and are converted to UV deltas with `motionScale = (0.5, −0.5)`; reprojection is `prevUV = uv − motion`.
- **Jitter** — applied via `camera.setViewOffset`, so a render texel at index `i` holds scene content from unjittered position `i + jitter`. The accumulate pass measures kernel distances against `srcPos = uv·renderSize − 0.5 − jitter`.
- **Depth** — supports three's standard and reversed WebGPU depth conventions (flag bit + `linearizeDepth`, derived from `Matrix4.makePerspective`). Comparisons happen on positive view-space distances.
- **Color spaces** — the temporal pipeline accumulates in _invertible-tonemap space_ (`c / (1 + max(c))`, FSR2's trick) so a single HDR firefly can't swamp the history average. EASU/RCAS run display-referred per the FSR1 spec. Every path exits through the same ACES + sRGB `displayTransform`, so bench modes are comparable.

## Passes vs. the FidelityFX reference

| Pass                   | Fidelity to AMD's source                                                                                                                          | Simplifications (→ Phase 3+)                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `easu.ts`              | Faithful port of `FsrEasuF` (12-tap edge-rotated anisotropic Lanczos, deringing)                                                                  | Exact `1/x`/`inverseSqrt` instead of `APrxLo*` bit tricks; `textureLoad` instead of packed gathers                                                                                  |
| `rcas.ts`              | Faithful port of `FsrRcasF` (analytic lobe bound, `exp2` sharpness mapping)                                                                       | Denoise variant not wired up yet                                                                                                                                                    |
| `dilate.ts`            | Same intent as _reconstruct & dilate_                                                                                                             | No scatter-based "reconstructed previous depth"; outputs linearized depth directly                                                                                                  |
| `depthClip.ts`         | Same intent as _depth clip_                                                                                                                       | Compares against last frame's dilated depth (classic TAA style) rather than the reconstructed buffer; relative-depth threshold instead of plane-fit `Ksep`                          |
| `accumulate.ts`        | Same structure as _reproject & accumulate_ (Lanczos2 upsample, kernel-confidence weighting, history rectification, accumulation counter in alpha) + luminance-stability **locks** protecting thin features | Variance clipping (Playdead) as the base rectifier; no luminance pyramid/auto-exposure; no shading-change detector; Catmull-Rom (Jimenez 5-fetch) history filter |
| `blit.ts` / `debug.ts` | — (bench/output utilities)                                                                                                                        |                                                                                                                                                                                     |

**Luminance-stability locks** (Phase 3, done) protect thin sub-pixel features (wires,
fence pickets, foliage) from the variance clip that would otherwise drag their bright/dark
history toward the neighborhood mean — the cause of thin features dimming and shimmering
under motion. The accumulate pass keeps a persistent display-res lock buffer (r = lock
lifetime, g = locked luma), reprojected through motion like the color history: it detects
a thin feature as a luminance outlier vs its neighborhood (`peakiness` × `contrast`), grows
a lock while the feature is present, and breaks it on disocclusion or a shading change.
A locked pixel widens its rectification AABB (`LOCK_CLAMP_RELAX`) and leans on history in
the blend (`LOCK_HISTORY_BOOST`). Toggle via `settings.lockThinFeatures` (the `FLAG_LOCKS`
bit); inspect via `FSRDebugView.Locks`. The tuning constants at the top of `accumulate.ts`
are sensible defaults, not final — tighten if you see thin features ghost, loosen if they
still dim. Remaining accumulate gaps: luminance pyramid + auto-exposure and a shading-change
detector.

## Debugging

Set `settings.debugView` (`FSRDebugView`) to render pipeline internals instead of the final image: motion vectors, disocclusion mask, linearized depth, accumulation age, or locks. When integrating a new scene, check in this order:

1. **Motion vectors** — static scene + moving camera should produce smooth gradients, no per-object noise (if objects flash, their previous model matrices aren't tracked — did you bypass the `velocity` node?).
2. **Disocclusion** — should outline moving silhouettes, thin and stable. Full-screen flashing means depth linearization flags are wrong (reversed-depth mismatch).
3. **Accumulation age** — should saturate to white within ~a second when still, and reset along disocclusion trails.
4. **Locks** — should light up on thin high-contrast features (grid lines, wire/fence edges, specular silhouettes) and stay black on flat surfaces. Locks everywhere ⇒ thresholds too low (expect ghosting); nothing lit ⇒ thresholds too high (thin features will dim).
