# Temporal Guides — opening the upscaler's internals (spec)

Status: **M0 resolved — contract frozen for build** (2026-07-21, branch
`feat-temporal-guides`; consumer review in
[GUIDES-SPEC-RESPONSE.md](GUIDES-SPEC-RESPONSE.md), resolution in §10).
Request: [bench/docs/FSR3-BRIEF.md](bench/docs/FSR3-BRIEF.md) — the consuming
pipeline (SSGI temporal pass, an SVGF-style denoiser, any TAA-class effect)
wants the upscaler's early data products as first-class outputs instead of
re-deriving worse versions privately. This spec maps that request onto what
this codebase actually is, states where we deviate from the brief and why, and
lays out the delivery plan.

Non-negotiable constraint: **nothing on `feat-match-fsr3` regresses.** Every
change here is additive; the existing `dispatch()` path must stay
byte-identical and perf-identical (bench A/B gated) when no guide is consumed.

---

## 1. The good news: the products already exist

The brief assumes the port is a monolith that must be split. It isn't — the
pipeline is already discrete compute passes over named internal textures, and
**every texture the brief's "temporal guides" bundle names is already
allocated and written every temporal frame** (`Upscaler._allocateTextures`):

| Brief asks for | We already have | Where it's produced |
|---|---|---|
| `dilatedVelocity` | `_dilatedMotion` (rgba16float, **UV** delta in .xy) | `reconstruct.ts` (fused dilate + depth-clip) |
| `dilatedDepth` | `_dilatedDepth[cur]` (r32float, linear view depth) | `reconstruct.ts` |
| `prevDepth` | `_dilatedDepth[prev]` — the ping-pong's other half | free (kept for depth-clip) |
| `disocclusion` (graded 0..1) | `_masks.r` (rgba8unorm) — AMD's confidence-voted grade | `reconstruct.ts` |
| `reactive` | `_reactiveGenerated` / caller's mask | `generateReactive.ts` or app |
| `lockStatus` | `_locks[cur]` (rgba16float: r = lifetime, g = locked luma, b = shading) | `accumulate.ts` |
| `historyLength` | history `.a` (accumulation age, display res) | `accumulate.ts` |
| luminance statistics | *(does not exist — see §5)* | — |

So the deliverable is **contracts and plumbing, not new algorithms**: make
these textures reachable from outside (raw-WebGPU and TSL), make the
geometry-only subset runnable without the upscale, and document each
product's space, resolution, and latency so a consumer can't mis-apply it.

## 2. Design principle: publish products, not pass boundaries

The brief prescribes a 4-pass decomposition ("pass boundaries, not a
monolith"). We decline the *dispatch* shape and keep the *data* shape:

- Our fusions are measured wins from the parity program (see `PARITY.md`):
  dilate + depth-clip fused is 0.035 ms where the source's split form costs
  ~3×; the shading detector is one fused dispatch at 0.044 ms vs the
  two-pass candidate's 0.231 ms. Splitting dispatches to mirror the brief's
  diagram would regress performance for zero consumer benefit — a consumer
  binds textures, not passes.
- What the brief *actually needs* from the split is (a) the products, and
  (b) the ability to produce the early ones **without running the upscale**.
  Both are satisfiable with the fusions intact.

The contract is therefore: **named textures with documented format, space,
resolution, and production stage.** Internally we stay free to fuse, reorder,
or re-derive as long as the contracts hold.

## 3. The two-stage frame contract

The real seam in the pipeline is not the brief's pass 1/2/3/4 — it's the line
the brief's own addendum draws ("signal & space"): **geometry products are
signal-agnostic and need only depth + velocity; everything else needs the
final beauty color.**

```
frame start
  │  (previousDepth, previous lockStatus, previous history already valid —
  │   last frame's products are readable before anything runs this frame)
  ├─ scene G-buffer/depth/velocity available
  ├─ ► dispatchGuides()            EARLY stage — geometry guides
  │      reconstruct.ts only: dilatedMotion, dilatedDepth, disocclusion
  ├─ effects run (SSGI march, SSGI temporal, denoiser…) consuming guides
  ├─ final beauty color available
  ├─ ► dispatchUpscale()           LATE stage — luma-dependent products + upscale
  │      exposure → shadingChange → generateReactive → accumulate → RCAS
  └─ present
```

- **`dispatchGuides(inputs)`** takes `{ depth, velocity }` (+ optional
  `reset`/`deltaTime`) and encodes *only* the reconstruct pass. Its three
  outputs plus `previousDepth` are then valid for every downstream effect —
  this is the brief's "pass 1 runnable without 3–4", at 0.035 ms.
- **`dispatchUpscale(inputs)`** encodes the rest. The existing monolithic
  `dispatch()` becomes exactly `dispatchGuides(); dispatchUpscale();` on one
  command encoder / one submit — the split must be observable only when the
  caller opts into calling the halves.
- **`path: 'guides'`** in `UpscalerConfig`: allocates only the early working
  set and never runs the late stage — the "app that never upscales" case.
  `outputTexture` throws on this path (there is no output).
- Queue ordering on three's shared device gives correctness for free, same
  as today: effects submitted after `dispatchGuides` see its writes.

**Late products have one-frame latency for render-stage consumers.** Locks,
history age, and shading change are computed *after* the effects that would
consume them have already run. This is not a defect to engineer away — FSR3's
own locks derive from the final color's luminance, so no implementation can
provide same-frame locks to a pass that runs before final color exists. The
brief's SVGF use ("anti-ghost / history-rejection prior") is a prior, and
frame N−1's lock state is the correct prior for frame N. The contract
publishes them as **previous-frame products** with that label.

## 4. The published bundle

Access: `upscaler.guides` — a `TemporalGuides` object of three `Texture`s
(consumable as TSL `texture()` nodes and by raw bind groups alike). Getters
resolve ping-pongs to the correct half for "current" vs "previous".

| product | resolution | format | space / convention | stage | notes |
|---|---|---|---|---|---|
| `dilatedMotion` | render | rgba16float (.xy) | **UV delta**, `prevUV = uv − motion`; y-flip (0.5, −0.5) already applied | early | see deviation D1 |
| `dilatedDepth` | render | r32float | linear view depth (eye-Z), reversed-depth already resolved | early | |
| `previousDepth` | render | r32float | linear view depth, frame N−1 | frame start | retires the consumer's ≥3 private depth copies |
| `disocclusion` | render | rgba8unorm (.r) | graded 0 (stable) → 1 (fresh), AMD confidence-voted | early | |
| `reactive` | render | rgba8unorm (.r) | 0..1 reactivity, post-merge (§6) | late | valid same frame *after* `dispatchUpscale` |
| `shadingChange` | ceil(render/2) | r32float | 0..1 response, block-mean metric | late | |
| `exposure` | 1×1 | rgba16float | r = conditioning pre-exposure, g = avg luma (**exposed beauty luma — not for GI**), b = host pre-exposure | late | space-labeled per the brief's one rule |
| `lockStatus` | **display** | rgba16float | r = lock lifetime, g = locked luma (conditioned tonemap space), b = shading age | late, frame N−1 | consumer downsamples or samples at display UV |
| `historyAge` | **display** | (history `.a`) | accumulated frame count, 0..maxAccumulation | late, frame N−1 | see deviation D3 |

Consumers MUST treat every field not listed here (e.g. `dilatedMotion.zw`,
`masks.gba`) as reserved — we keep the right to pack new signals into spare
channels, as we already did with locks `.b`.

### Implementation note: three-visible textures

Guide textures are currently raw `GPUTexture`s. To publish them we flip the
allocation to the same mechanism as `outputTexture`: allocate as three
`StorageTexture`s (with `generateMipmaps = false`), `renderer.initTexture()`,
and keep using the raw handle internally via `getGPUTexture()`. Zero shader
changes; the pipeline can't tell the difference. Ping-ponged products
(`dilatedDepth`, `locks`, exposure, history) allocate both halves this way
and the `TemporalGuides` getters return the right half per frame; the TSL
guide nodes update their texture reference in `updateBefore` (the same
per-frame re-point pattern `UpscalerNode` already uses internally). If a
consumer needs *stable* texture identity across frames (some graph setups
cache hard), the fallback is an opt-in copy into a stable target — spec'd but
not built until the lab shows it's needed.

## 5. The statistics primitive (SVGF addendum B) — new code, not a refactor

The brief assumes FSR3-style per-pixel luminance moments exist to refactor.
**They don't, here.** Our exposure pass is a single 1×1 log-average (no
pyramid, no per-pixel moments — `luminancePyramid.ts` deliberately computes
only what's consumed), and our variance clip computes its 3×3 YCoCg moments
inline in `accumulate.ts` in conditioned tonemap space — exactly the space
the brief forbids for GI variance.

So `MomentPyramid` is a **new, standalone, signal-agnostic pass**:

- in: any texture + `{ space: 'linear' | 'ycocg', channels }` — hardcodes no
  exposure/tonemap/albedo assumption, per the brief's contract.
- out: `moments` rg16float `(E[x], E[x²])` per pixel, plus one coarse level
  (mip-2-equivalent, 4× reduction) — the consumer's short-history fallback
  reads exactly one coarse neighborhood and nothing deeper (§10, answer 4).
  No full chain.
- Lives in its own files (`shaders/moments.ts` + a small `MomentsPass`
  driver / `moments()` node), exported `@experimental`. It touches nothing
  in the core pipeline — zero regression surface.
- Our own pipeline does **not** adopt it initially (accumulate's inline 3×3
  is fused and cheap; swapping it for a consumed pyramid is a perf/quality
  trade to measure separately, if ever). One primitive, external consumers
  first.
- Verification split: the CPU-reference `Var = E[x²]−E[x]²` check the brief
  asks for cannot run in our GPU-free CI; we ship the structural shader test
  + a bench-side scripted GPU check, and the consumer's SVGF lab is the
  acceptance test (their own stated criterion).

## 6. Reactive becomes bidirectional (merge, not overwrite)

Today: explicit `reactive` input wins, else auto-generate from
`reactiveOpaqueColor`, else zero dummy — mutually exclusive. New contract per
the brief:

- `generateReactive.ts` gains an optional incoming-mask binding; response =
  `max(generated, incoming)`. Supplying both inputs now composes instead of
  the explicit mask silencing the generator.
- The published `guides.reactive` texture is storage-writable: an effect
  (SVGF flagging high-variance GI) can write into it between `dispatchGuides`
  and `dispatchUpscale`, and the late stage consumes the merged result.
- This is the only production-shader change in the whole program
  (`generateReactive` hash pin updates; GPU re-verify on example 05, which is
  the reactive acceptance demo).

## 7. Deviations from the brief (flagged for the consumer's review)

- **D1 — motion is a UV delta, not an NDC delta.** We publish the
  already-converted form (`velocity.xy · (0.5, −0.5)`, `prevUV = uv − m`).
  Rationale: the brief's own trap list says the y-mirror seam "cost us the
  demo 03 speckle hunt" — publishing the convention-free, directly-usable
  form deletes that seam for every consumer. If the raw NDC delta is truly
  needed, the consumer already owns the velocity MRT it came from.
- **D2 — locks/reactivity are late-stage, not "early-mid".** See §3; locks
  need final color by construction. Published as frame N−1 priors.
- **D3 — `historyLength` is display-res history `.a`, not a render-res
  r16float.** The brief itself allows the consumer to keep producing its own
  (demo 03 already does). We publish what exists; a dedicated render-res
  count texture is added only if the guides lab shows sampling display-res
  age is insufficient.
- **D4 — formats are ours, not the brief's suggestions** (rgba16float
  motion vs rg16float, rgba8unorm disocclusion vs r16float). The suggested
  formats save memory, not correctness; we won't fork allocations for it.
  Revisit under real memory pressure.
- **D5 — no dispatch-level 4-pass split** (§2). Contract is textures.
- **D6 — environment notes in the brief that don't apply here:** we bridge
  three internals via `internal/threeWebGPU.ts` (not the bench harness path),
  RCAS is already tonemap-agnostic (the ACES-in-RCAS bug is fixed and E03 in
  `bench/docs/PARITY-DECISIONS.md` is its record), and `RenderPipeline`
  naming is already handled in the node docs.

## 8. Delivery plan

Branch `feat-temporal-guides` off `feat-match-fsr3`; each milestone lands
green (165 unit tests / typecheck / lint), GPU-verified per the CLAUDE.md
headless-CDP protocol, and bench-A/B'd where perf could move. Merge back only
when the consumer lab has accepted.

- **M0 — contract review (this document).** Send to the SSGI/SVGF side;
  resolve D1–D5 and the open questions (§9) before code.
- **M1 — internal seam. DONE (`3603a14`, 2026-07-21).** Split
  `_encodeTemporal` into `_encodeGuides` / `_encodeLate` private halves
  composed on one encoder; no public API change. Gates met (evidence:
  `bench/results/raw/GUIDES-M1/`): worktree-vs-worktree smoke A/B vs
  `005de6d` — compute-sum −2.7%, within the <3% noise policy; Q0 captures
  (3 frames × final + motion-vectors/disocclusion/accumulation-age)
  byte-identical except frame-119 `final`, where the *pre-M1 run's own two
  arms already disagree (harness nondeterminism at deep accumulation,
  0.098% px, max 23/255) while the M1 run's arms agree. Bench caveat
  learned: runs launched from a scratchpad worktree read ~3× slower
  absolute (GPU stays in a low power state; likely cold-vite frame
  delivery) — uniform across passes, so A/B *within* that environment is
  valid, but never compare worktree absolutes against repo-run records.
- **M2 — publish the bundle. DONE (2026-07-22).** Three-visible allocation
  flip (`_createSharedTexture`: three `StorageTexture` + raw handle, one
  allocation), the `guides` accessor, `dispatchGuides`/`dispatchUpscale`
  public split, `path: 'guides'`, `@experimental` tags. New example
  `12-temporal-guides` (11 was taken) renders final + three geometry guides
  from the split frame — the GPU acceptance harness. Gates met: Q0 captures
  byte-identical vs M1 (24/24, incl. frame 119 and all debug views); example
  12 headless-verified (no validation errors, guides sampled as TSL nodes,
  split-frame timings read out); guides-only path CDP-driven under a
  validation error scope (clean across both ping-pong halves, API guards
  throw, late products null). Evidence: `bench/results/raw/GUIDES-M1/capture-m2`.
- **M3 — reactive merge (§6). DONE (`64a4e65`, 2026-07-22).** The generator
  max-merges an incoming mask (new binding, inert dummy when absent); the
  aliasing hazard (passing `guides.reactive` back while the generator writes
  it) throws. Gates met: fingerprint updated, 165 tests green, example 05
  GPU-verified across manual/auto/off modes with no validation errors. The
  bench merged-mask capture scenario is deferred to M6 (the consumer lab
  exercises the merge for real).
- **M4 — TSL surface.** `temporalGuides(depth, velocity, camera)` node
  producing guide texture nodes in-graph; `upscale(..., { guides })` to share
  one computation between the effect graph and the upscale. Gate: examples
  07/09 unchanged; new node demo consumes `disocclusion` in a toy effect.
  Priority per §10 answer 5: every hot-path consumer binds raw — if M4 needs
  trimming, defer the TSL example, never the raw path.
- **M5 — `MomentPyramid` (§5). DONE (`52c3b12`, 2026-07-22).** Shipped as
  `MomentsPass` + `shaders/moments.ts`, `@experimental`, zero coupling to
  the upscaling pipeline. Deviations recorded: outputs are rgba16float
  (`.rg` used — rg16float is not a core WebGPU storage format); the coarse
  level is the single 4×-reduction the consumer asked for (§10 answer 4).
  Gates met: structural tests + fingerprint (172 tests green); scripted GPU
  check vs CPU reference on a seeded DataTexture in BOTH linear and ycocg
  spaces — validation-clean, max rel. error <0.1% (f16 tol 1%), coarse
  variance non-negative.
- **M6 — cross-repo acceptance.** The consumer's demo-10 guides lab and SVGF
  lab run against a tarball/linked build; their A/B (guides-fed SSGI temporal
  vs private logic) is the program's exit criterion, per the brief.

Sequencing note: M1+M2 unblock the consumer's guides lab; M3–M5 can proceed
in parallel with their integration. The guides API ships marked
`@experimental` until M6 passes, so `main` never carries a frozen contract we
haven't seen consumed.

## 9. Open questions for the consumer side

1. Is the UV-delta motion convention (D1) acceptable, or is raw NDC needed?
2. Is frame N−1 lock/age latency (D2) sufficient for the SVGF prior?
3. Does the SSGI temporal pass need `historyLength` at render res on day
   one, or does display-res age sampling suffice (D3)?
4. Moment pyramid mip chain: how many levels does the short-history spatial
   fallback actually read? (We'd rather allocate 3 than "a full chain".)
5. Consumption mechanism: TSL `texture()` nodes, raw bind groups, or both?
   (Both are spec'd; if only one is consumed we defer the other's example.)

## 10. M0 resolution (2026-07-21)

Consumer review: [GUIDES-SPEC-RESPONSE.md](GUIDES-SPEC-RESPONSE.md). Every
deviation D1–D6 accepted; the brief's pass-boundary language and suggested
formats are superseded by D5/D1/D4 (reconciled on the brief side). §9
answers, now binding:

1. **UV-delta motion accepted and preferred.** The consumer harness will
   align its own guides pass to *our* convention before the swap (their
   work, scheduled with the swap) so the bundle is drop-in.
2. **Frame N−1 locks/age sufficient** — it is the semantics their shipping
   consumers already validated, not a compromise.
3. **Display-res age sampling accepted for day one**, with one recorded
   risk their guides lab measures: filtered age may dilate across
   silhouettes → transient over-effort at edges (fails safe). Their
   render-res counter remains as fallback; we build nothing extra unless
   the lab rejects display-res sampling.
4. **Moments: mip 0 + one coarse level (mip-2-equivalent) only.** Nothing
   reads deeper.
5. **Raw bind groups first; TSL second.** Per-frame texture re-pointing is
   fine on their side; the stable-identity copy (§4) stays spec'd-only.

Standing acceptance criteria unchanged: their live demo-10 guides rig is
M6's exit A/B; their SVGF/moments lab builds only after our M2 + M5 exist.
