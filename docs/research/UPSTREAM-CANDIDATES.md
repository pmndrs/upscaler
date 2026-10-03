# Upstream (three.js) contribution candidates

Findings from this project that could improve three.js's own temporal and
post-processing nodes, ranked by value to us × likelihood of acceptance.
three's core devs are actively working in this area (TRAA/TAAU, TemporalReproject,
RecurrentDenoise, FSR1Node, RenderPipeline events), so good evidence here can
steer it. Tracking issue: [pmndrs/upscaler#35](https://github.com/pmndrs/upscaler/issues/35).

Compiled 2026-10-02 against three `dev` (187dev, f0f1455). **Nothing has been
filed upstream yet.** Line refs are on `dev` and will drift. Re-check each one
before filing. "Unverified" means source-level reading only; it needs a GPU repro
before filing. `three#N` = mrdoob/three.js; `#N` = this repo.

| Rank | Candidate | Evidence | Effort | Form | People |
|---|---|---|---|---|---|
| 1 | **TAAU lock history never persisted.** The resolve RT has one attachment, but the shader writes `(color, lock)`, and only `textures[0]` is copied to history, so the lock decay path is dead. Also: the lock is sampled at the current UV rather than `historyUV`, and `div(meanLuma)` has no zero guard. Unverified on GPU. | `TAAUNode.js:161,172,439,626,637`; three#33359 | S–M | Issue + GPU readback, then PR | Mugen87, shotamatsuda |
| 2 | **Migration Guide is missing the r186 `RenderPipeline.context` removal**, which broke third-party nodes like ours (#19). A `get context()` + `warnOnce` shim would fit three's deprecation policy. | three#34025; wiki "185 → 186" section | S | Wiki edit + small PR | Mugen87, sunag |
| 3 | **RenderPipeline event lifecycle.** `EventNode.setup` pushes callbacks unconditionally, and `getSharedContext()` shares the arrays into internal RTT materials, so callbacks can double-register. That's Mugen87's unanswered review comment on three#34025. On a rebuild frame, the before/after hooks also fire unpaired. We guard against both in #21. | `EventNode.js:72-92`, `RenderPipeline.js:136,158,181-188`, `NodeBuilder.js:1055`, `RTTNode.js:163` | M | Issue + minimal repro, then PR | sunag |
| 4 | **`viewOffsetOwner` is denied silently, and the wrong node may win it** after three#34565, which builds inputs before claiming ownership. A `TemporalReprojectNode` inside TRAA's input could claim first and leave TRAA unjittered. The ordering is unverified. A `warnOnce` on denial is uncontroversial on its own. | `TRAANode.js` setup, `TemporalReprojectNode.js:732`; our owner-claim handling in #21 | S | Runtime check, then issue + `warnOnce` PR | Mugen87, sunag |
| 5 | **FSR1Node/SharpenNode run RCAS on linear HDR.** The `hitMax` limiter turns sharpening off whenever a tap is above 1, and divides 0/0 at exactly 1. Fix: sharpen in invertible-tonemap space and invert once (−34% RCAS cost on our temporal path). **Caveat from #30:** naive conditioning on un-pre-exposed input clips highlights near 1000 and turns lone peaks into fireflies (0.5 → 1303). A correct port needs #30's centre anchor and gain cap. | `FSR1Node.js:399`, `SharpenNode.js:212`; our #30 | M | PR with A/B captures | Mugen87 |
| 6 | **A supported accessor for the GPUTexture behind a three texture** (the outbound counterpart of `ExternalTexture`). It would replace our private `backend.get(tex).texture`. `backend.device` is already documented. | Inbound import: three#31595, #31653, #33816. Also +1 three#33710. | S | Feature-request issue | Mugen87, donmccurdy, sunag |
| 7 | **TRAA/TAAU still-scene convergence.** The stored clipped history is re-snapped by each jitter phase's variance box. Fix: relax the clamp on still, converged, non-disoccluded pixels. We measured both sides of the tradeoff: phase-locked diff 0.182 → 0.018, and the drift-lag cost is a one-time step, not a slope. | `bench/docs/NEXT-STEPS.md` §5 and §8; `docs/research/PAPER-NOTES.md` §6–7; three#33359, three#31892 | M–L | Issue with the phase-locked metric measured on `webgpu_upscaling_taau`, then PR | Mugen87, shotamatsuda |
| 8 | **TAAU jitter.** The docstring says "one output pixel", but the code (correctly) uses input pixels. It also uses a fixed 32 phases, where FSR2 uses 8·ratio². | `TAAUNode.js:~311-345` | S (doc) / M (phases) | PR | Mugen87 |
| 9 | **TAAU/TemporalReproject use the global `velocity`** instead of `builder.context.velocity`. TRAA already uses the context one (three#32274). | `TAAUNode.js:327,358`, `TemporalReprojectNode.js:634,640` | S | PR | Mugen87, shotamatsuda |
| 10 | **VelocityNode docs:** state the convention: current − previous, NDC y-up, UV = ×(0.5, −0.5), `prevUV = uv − v`, and the override must be jitter-free. Also fix the "vertex color node" JSDoc typo. | `VelocityNode.js` | S | PR | Mugen87 |
| 11 | **Previous-depth sampling lacks jitter-delta compensation**, which causes grazing-plane disocclusion flicker. Unverified in three: TAAU's `isEdge` may hide it. | `TAAUtils.samplePreviousDepth`; PAPER-NOTES §2 | M | Issue after repro | Mugen87, shotamatsuda |
| 12 | **Document how custom nodes register graph dependencies.** `_`-prefixed props are skipped by `_getChildren`, so inputs must be built in `setup()` or registered via `getNodeProperties`. | `Node.js:383-395`, `FSR1Node.js:442` | S | Forum post / wiki | sunag, Mugen87 |
| 13 | **TRAA/TAAU clobber an app-set `camera.view` offset** (tiling, multi-screen). We fixed the same flaw in our own code in #28: compose the jitter on top of the app's offset, then restore the snapshot. | `setViewOffset`/`clearViewOffset` in both nodes; our #28 | S | Issue (+ PR modelled on #28) | Mugen87 |
| 14 | **TemporalReprojectNode with reduced-resolution input** copies a 640×400 depth into a 1280×800 `Depth24Plus` history, producing a stream of `GPUValidationError`s. Seen in our example 10 `recurrent` mode. | `examples/10-ssgi-denoise`; `bench/docs/THREE-TEMPORAL-COMPARISON.md` | S | Issue + repro | 0beqz, Mugen87 |
| 15 | **`recurrentDenoise({ accumulate: false })` still re-rolls its à-trous kernel rotation every frame** (`_noiseIndex = frame.frameId`). A "spatial-only" setup therefore feeds fresh per-frame noise into any downstream temporal resolver. Fix with docs, or an option to pin the rotation. | #29; `bench/docs/NEXT-STEPS.md` §7 (Q14: same-phase 1.83 vs 0.03 with `DenoiseNode`) | S | Issue / docs PR | 0beqz, Mugen87 |
| 16 | **SSGI `useTemporalFiltering` docs:** add "TAAU / third-party temporal resolver → set false". The docs already say it requires TRAA. | `SSGINode.js:180-193`; #14 | S | Fold into another docs PR | Mugen87 |

## Suggested order

1. **Cheap wins:** #2, #10, #9. They're near-certain to land, and they build reviewer trust.
2. **GPU-confirmed bug fixes:** #1 and #5, confirmed with our CDP harness, plus #13 with the #28 fix as the model.
3. **Repro-backed issues** for sunag and 0beqz: #3, #4, #14, #15.
4. **The high-value one, #7.** Maintainers are asking for exactly this evidence in three#33359 (closed) and three#31892 (open, TRAA ghosting).

## Who owns what upstream

- **Mugen87:** TAAU, TAAUtils, FSR1Node, SharpenNode. Also maintains the Migration Guide.
- **sunag:** the RenderPipeline, EventNode and context design (three#34025, three#34607).
- **shotamatsuda:** the TRAA velocity source, depth modes, and the TAAU lock prototype.
- **0beqz:** TemporalReproject and RecurrentDenoise (three#33843).
- **cabanier:** DirectRenderPipeline (three#34166).

## Status of our own follow-ups from this survey

- `TempNode` is deprecated in r187 (three#34607), and `UpscalerNode`/`TemporalGuidesNode` extend it. Tracked in #23.
- `Upscaler.endFrame` clobbering an app-set `camera.view` offset: fixed in #28.
- The spatial EASU→RCAS path had the HDR limiter flaw from item 5: fixed in #30.
- `getDevice` could use the documented `backend.device`. Only `getGPUTexture` truly depends on internals (item 6).
