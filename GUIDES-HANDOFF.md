# Temporal guides — consumer handoff

Audience: the agent building the guides-fed labs (demo-10 SSGI temporal A/B,
demo-14/15 SVGF) as a **linked-build consumer** of this repo.
State: branch `feat-temporal-guides`, all raw-path milestones landed and
GPU-verified. This doc is the integration entry point; the normative
contract stays [TEMPORAL-GUIDES-SPEC.md](TEMPORAL-GUIDES-SPEC.md) (your M0
review [GUIDES-SPEC-RESPONSE.md](GUIDES-SPEC-RESPONSE.md) is folded in as
§10).

## What is ready for you

| Capability | Status | Where |
|---|---|---|
| Guides bundle (`upscaler.guides`) — dilated motion/depth, prev depth, disocclusion, reactive, shading change, exposure, locks, history as ordinary three textures | ✅ M2 | `Upscaler.guides`, contracts on the `TemporalGuides` type |
| Split frame: `dispatchGuides({depth, velocity})` post-G-buffer → effects → `dispatchUpscale({color})` | ✅ M2 | `Upscaler` |
| Guides-only mode (no upscale at all) | ✅ M2 | `configure({ path: 'guides' })` |
| Reactive merge-not-overwrite (+ effect-writable `guides.reactive`) | ✅ M3 | `DispatchInputs.reactive` docs |
| `MomentsPass` — signal-agnostic (E[x], E[x²]) + one coarse level, linear or YCoCg-Y | ✅ M5 | `MomentsPass` export |
| Grazing-angle disocclusion stability fix | ✅ | commit `b16274a` — **baseline your lab on this or later**; earlier disocclusion flickered on grazing planes |
| TSL node surface (`temporalGuides()` node, `upscale({guides})`) | ⏳ M4, deferred | per your answer 5 (raw first); design sketch in spec §8. Tell us when composite-side consumption is actually next and it moves up |

Everything guides-related is `@experimental`: the contract is frozen (M0)
but may still shift until your integration (M6) accepts. Flag friction in a
response doc rather than working around it.

## Linked build

Two options; (a) is what this repo's own bench/examples do and gives you
shader hot-reload while we iterate.

**(a) Vite alias straight at the source (recommended for the labs):**

```ts
// vite.config.ts in your repo (block verified by the demo-16 integration)
resolve: {
    alias: [
        { find: '@pmndrs/upscaler', replacement: '/Users/dex/Developer/fsr3/src/index.ts' },
        { find: /^three$/, replacement: 'three/webgpu' }, // collapse dual-entry core
    ],
    dedupe: ['three'], // pin to YOUR copy, not fsr3/node_modules
},
optimizeDeps: { exclude: ['three'] }, // else vite's pre-bundle shortcut beats the alias
build: { target: 'esnext' },   // the lib uses modern syntax; examples use TLA
```

The bare-imports design means the library *can* use your three instance —
but an out-of-root consumer does NOT get that for free: vite resolves our
`three` and your `three/webgpu` from two different `node_modules` (two core
copies → the "Multiple instances of Three.js" warning, and worse, two
backend maps). All three extra lines above are load-bearing; they came out
of the first real integration (GUIDES-HANDOFF-RESPONSE.md).

TypeScript path (for editor types): point `paths` at the **built
declarations**, not the source — `"paths": { "@pmndrs/upscaler":
["/Users/dex/Developer/fsr3/dist/index.d.ts"] }`. Aliasing at `src/`
pulls our sources into your program and subjects them to your compiler
flags (the first integration hit `noUnusedLocals` on our code). The trade:
your tsc sees `dist/` while runtime uses live `src/` — **we keep `npm run
build` current whenever the public surface moves** (it's part of our commit
gate for API changes); if you hit a type error that looks stale, re-run the
build here first.

**(b) Packed dependency (for anything that shouldn't track our working tree):**

```bash
cd /Users/dex/Developer/fsr3 && npm run build   # dist/ + declarations
# your repo:
npm install /Users/dex/Developer/fsr3           # file: dependency
```

Peer requirement: `three >= 0.184`. We verify internals against r184; your
r185 harness uses the same `renderer.backend.get(...)` shape, and our bridge
(`internal/threeWebGPU.ts`) throws loudly if a three bump ever changes it.

## Consuming the bundle (raw path)

```ts
import { Upscaler } from '@pmndrs/upscaler';

const upscaler = new Upscaler({ renderer });
upscaler.init();
upscaler.configure({ displayWidth, displayHeight, customUpscaleRatio: 2, path: 'temporal' });
// jitter-free velocity (only relevant when you jitter — temporal path):
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

// per frame
upscaler.beginFrame(camera);
/* render G-buffer / depth+velocity MRT */
upscaler.endFrame(camera);
upscaler.dispatchGuides({ depth, velocity, deltaTime }, camera);
/* your effects: bind upscaler.guides.* — valid from here */
upscaler.dispatchUpscale({ color, deltaTime }, camera);
```

- Guides are three `Texture`s. For raw WGSL passes, resolve the `GPUTexture`
  with your own bridge (`renderer.backend.get(tex).texture`) — same shape as
  your harness's `three-internals.ts`.
- **Re-read the getters every frame.** Ping-ponged products (`dilatedDepth`
  / `previousDepth`, `exposure`, `lockStatus`, `history`) resolve to the
  most-recently-written half; caching a texture reference across frames
  gives you a stale half every other frame.
- `r32float` products (`dilatedDepth`, `previousDepth`, `shadingChange`)
  are non-filterable: `textureLoad` or a nearest sampler only. They ship
  with `NearestFilter` set for TSL use.
- Motion convention (your accepted D1): `.xy` is a **UV delta**, y-flip
  applied — `prevUV = uv - motion`. Align your harness pass before the swap,
  as planned.
- Late products consumed by render-stage effects are **frame N−1 priors**
  (your accepted D2). Early products are same-frame after `dispatchGuides`.
- Undocumented channels are reserved (you acknowledged this) — e.g. locks
  `.b` already carries shading age.
- Guides-only apps: `path: 'guides'`, then `dispatchGuides` is the whole
  frame (~0.04 ms at 1080p render). No color, no output texture (the
  accessor throws with an explanation), no jitter.

Reactive is bidirectional: write reactivity into `guides.reactive` between
the two dispatches and pass that same texture as `dispatchUpscale`'s
`reactive` input — or, when also using `reactiveOpaqueColor`, pass a
*different* texture and it max-merges with the generated diff (passing
`guides.reactive` itself in that combination throws: the generator writes
that texture).

## MomentsPass (SVGF statistics half)

```ts
import { MomentsPass } from '@pmndrs/upscaler';
const moments = new MomentsPass({ renderer });
moments.configure({ width, height, space: 'ycocg' });  // your §8 decision 1
moments.dispatch({ source: giIrradiance });            // any float texture, per frame
// moments.moments        rgba16float, source size:   .r = E[x], .g = E[x²]
// moments.coarseMoments  rgba16float, ceil(size/4):  4×4 block means
```

- Signal-agnostic by construction: no exposure/tonemap/albedo assumption;
  a single-channel source (r32float GI luma) reads through unchanged in
  `'linear'` space.
- One deviation from the spec's sketch: outputs are **rgba16float with
  `.rg` used** — `rg16float` is not a core WebGPU storage format. `.ba`
  reserved.
- One coarse level only (your answer 4: nothing reads deeper).
- GPU-verified against a CPU reference in both spaces (<0.1% rel. error,
  f16); the `Var = E[x²] − E[x]²` identity check your spec §E asks for is
  the same harness — rerun it in your lab if you want it in your evidence
  chain (`scripts` equivalent lives in this repo's session notes; the pass
  itself is deterministic).

## Verification expectations on your side

- Your demo-10 A/B (guides-fed SSGI temporal vs private logic) is **M6 —
  the program's exit criterion**. The guides API drops `@experimental` when
  it passes.
- `examples/12-temporal-guides` (npm run examples → :5300) is the live
  reference: split dispatch + the guide views, and it exposes
  `window.__guidesExample` (upscaler, renderer, camera, `Upscaler`,
  `MomentsPass`, `THREE`, `getRenderTarget`) for headless CDP harnesses.
- Headless WebGPU on this machine works with
  `--headless=new --enable-unsafe-webgpu --use-angle=metal` (our harness
  drives it over CDP; screenshots + `Log.entryAdded` catch WGSL errors).
- If disocclusion misbehaves in your scenes: check `DebugView.Disocclusion`
  expectations in CLAUDE.md first, and note the grazing-angle fix landed
  `b16274a` — re-pull before debugging on your side.

## Feedback loop

Respond the way M0 worked: a doc in this repo (or a note pointing at one in
yours) with accepted/friction/blocked per item. Known-open items on our
side: M4 (TSL surface, deferred per your priority), the bench merged-mask
capture scenario (deferred to your lab exercising the real merge), and the
`@experimental` freeze pending your M6.

**Report 1 received** ([GUIDES-HANDOFF-RESPONSE.md](GUIDES-HANDOFF-RESPONSE.md),
demo-16, against `34f784d`): linked build + M2 contract accepted and verified
live on cornell/sponza; nothing blocked. Both friction items are resolved
here — the vite block above is theirs, the dead `UpscalerNode._renderer`
field is deleted, and the tsconfig-`paths` guidance now points at `dist/`.
Next on their side: D1 motion-convention alignment, then the demo-10 A/B (M6).
