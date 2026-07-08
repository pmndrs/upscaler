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
| `rcas.ts`              | Faithful port of `FsrRcasF` (analytic lobe bound, `exp2` sharpness mapping) + optional `FSR_RCAS_DENOISE` variant                                 | —                                                                                                                                                                                   |
| `dilate.ts`            | Same intent as _reconstruct & dilate_                                                                                                             | No scatter-based "reconstructed previous depth"; outputs linearized depth directly                                                                                                  |
| `depthClip.ts`         | Same intent as _depth clip_                                                                                                                       | Compares against last frame's dilated depth (classic TAA style) rather than the reconstructed buffer; relative-depth threshold instead of plane-fit `Ksep`                          |
| `accumulate.ts`        | Same structure as _reproject & accumulate_ (Lanczos2 upsample, kernel-confidence weighting, history rectification, accumulation counter in alpha) + luminance-stability **locks** protecting thin features + **auto-exposed** pre-tonemap + **shading-change** history aging | Variance clipping (Playdead) as the base rectifier; shading-change measured on the 3×3 neighborhood mean vs history luma rather than a dedicated coarse pyramid mip; Catmull-Rom (Jimenez 5-fetch) history filter |
| `luminancePyramid.ts`  | Same intent as _compute luminance pyramid_ (log-average luminance → auto-exposure with eye-adaptation)                                            | Single-workgroup reduction of a 32×32 tap grid instead of an atomic SPD mip chain; intermediate mips not yet produced (the shading-change detector will need them)                  |
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
still dim.

**Auto-exposure** (Phase 3, done) conditions the invertible-tonemap accumulation.
`luminancePyramid.ts` reduces the scene to a single log-average luminance in one workgroup,
maps it to a pre-exposure that lands the average on middle grey, and eases toward it over
time (eye-adaptation). `accumulate.ts` multiplies the input by that exposure before the
invertible tonemap; the output pass (`rcas.ts` / `blit.ts`) divides it back out before the
display transform — so a very bright or very dark HDR scene accumulates in the same working
range (steadier variance clip + firefly guard) **without changing final brightness**. Toggle
via `settings.autoExposure` (the `FLAG_AUTO_EXPOSURE` bit); with it off, the fixed
`settings.exposure` is published through the same path. Inspect via `FSRDebugView.Exposure`
(the exposed scene luminance should read near mid-grey everywhere).

**Shading-change detection** (Phase 3, done) tells a genuine shading change (a light
turning on, an animated material) apart from mere motion, so the changed surface
re-converges to its new look instead of ghosting the old one. It compares the reprojected
history's luma against the current 3×3 neighborhood mean, normalized by how much the
neighborhood itself varies — a coherent disagreement the local variance can't explain.
Where it fires, non-locked history is aged (`SHADING_AGE`); a lock fully suppresses the
aging (aliasing on a thin feature is not a shading change — and by construction the
background-dominated neighborhood mean always disagrees with a thin feature's history, so
the detector must not touch locked pixels or drive lock-breaking; locks break on their own
self-referential luma term). Toggle via `settings.detectShadingChanges` (`FLAG_SHADING_CHANGE`); inspect via
`FSRDebugView.ShadingChange`. **Simplification vs FSR2:** the comparison uses the 3×3
neighborhood mean rather than a dedicated coarse luminance-pyramid mip — cheaper, and
jitter-robust enough in practice, but a true SPD mip would be steadier on high-frequency
content (a Phase-5 refinement). Constants (`SHADING_LO/HI/AGE` at the top of
`accumulate.ts`) are conservative defaults — raise `SHADING_LO` if stable surfaces shimmer,
lower it if changed shading ghosts.

**Reactive mask** (Phase 3, done) is the caller-authored escape hatch for geometry that has
no reliable depth or motion — additive particles, transparent/animated surfaces — which
would otherwise ghost through the history. Pass a render-res mask as `dispatch({ reactive })`
(red channel `[0,1]`); flagged pixels suppress lock formation, keep almost no accumulation,
and snap toward the current frame in the blend (`REACTIVE_STRENGTH`). No mask → a 1×1 zero
texture is bound and the whole path is flag-gated off, so there's zero cost when unused.
Author the mask however you like (render your transparents' coverage — see
`examples/05-transparency`); inspect via `FSRDebugView.Reactivity`.

## Debugging

Set `settings.debugView` (`FSRDebugView`) to render pipeline internals instead of the final image: motion vectors, disocclusion mask, linearized depth, accumulation age, locks, auto-exposed luminance, or the shading-change factor. When integrating a new scene, check in this order:

1. **Motion vectors** — static scene + moving camera should produce smooth gradients, no per-object noise (if objects flash, their previous model matrices aren't tracked — did you bypass the `velocity` node?).
2. **Disocclusion** — should outline moving silhouettes, thin and stable. Full-screen flashing means depth linearization flags are wrong (reversed-depth mismatch).
3. **Accumulation age** — should saturate to white within ~a second when still, and reset along disocclusion trails.
4. **Locks** — should light up on thin high-contrast features (grid lines, wire/fence edges, specular silhouettes) and stay black on flat surfaces. Locks everywhere ⇒ thresholds too low (expect ghosting); nothing lit ⇒ thresholds too high (thin features will dim).
5. **Exposure** — the exposed scene luminance should read near an even mid-grey regardless of how bright/dark the scene is (that is auto-exposure normalizing it). All-black ⇒ exposure driven to its floor (scene far too bright), all-white ⇒ driven to its ceiling (scene far too dark).
6. **Shading change** — black on a static, steadily-lit scene; lights up (and fades over a few frames) on surfaces whose shading actually changes — a moving specular highlight, a light animating, a material shifting. Lit everywhere on a still scene ⇒ `SHADING_LO` too low (stable surfaces will re-converge needlessly and shimmer); never lighting up on an obvious lighting change ⇒ too high.
7. **Reactivity** — the caller's reactive mask, as accumulate sees it: white where you flagged transparents/particles, black on opaque geometry. If it's misaligned or empty, the mask isn't being authored/passed correctly (wrong resolution, not set before `dispatch`).
