# GUIDES-HANDOFF response — consumer integration report 1

Consumer: ssgiDev bench, demo `16-fsr` (first full-pipeline consumer).
Against: `feat-temporal-guides` @ `34f784d`. Format per the M0 feedback loop:
accepted / friction / blocked per item.

## Linked build (handoff option a) — ACCEPTED, one real hazard

The vite alias works, but the handoff's "no duplicate-three hazard" claim is
**wrong for out-of-root consumers**: your source imports bare `three` while
our app imports `three/webgpu`, and vite resolved them to two copies of core
(from two different node_modules — your 0.185.0, our 0.185.1) → the
"Multiple instances of Three.js" warning. All three of these were needed in
the consumer's vite config:

```ts
resolve: {
  alias: [
    { find: '@pmndrs/upscaler', replacement: '/Users/dex/Developer/fsr3/src/index.ts' },
    { find: /^three$/, replacement: 'three/webgpu' }, // collapse dual-entry core
  ],
  dedupe: ['three'], // pin to the CONSUMER's copy, not fsr3/node_modules
},
optimizeDeps: { exclude: ['three'] }, // vite pre-alias shortcut otherwise
                                      // beats the bare->bare alias
```

Suggest folding this block into GUIDES-HANDOFF.md §Linked build — anyone
consuming from outside your repo root will hit it.

## TypeScript surface — FRICTION (worked around)

- Aliasing tsconfig `paths` at `src/index.ts` pulls your sources into the
  consumer's program, where our `noUnusedLocals` fails on a genuinely dead
  field: `UpscalerNode.ts:141` `_renderer` is assigned (line 175) and never
  read. We now point `paths` at `dist/index.d.ts` instead — cleaner
  separation anyway — but the field is worth deleting.
- Consequence of the dist workaround: our tsc checks against your **built**
  declarations while runtime uses live src. Please keep `npm run build`
  current when the public surface moves, or flag the change in the handoff
  doc; a silent skew will surface on our side as confusing type errors.

## Guides bundle + split dispatch (M2) — ACCEPTED, verified live

Demo 16 drives the exact contract frame shape (beginFrame → MRT
color+velocity+float-depth at render res → endFrame → dispatchGuides →
dispatchUpscale → present). Headed verification on cornell + sponza, WGSL
console clean:

- temporal 2× reconstructs far-field detail bilinear 2× destroys (sponza
  hall: lion relief, banner fringes, floor tiling) — no ghosting observed
  on static + slow-orbit content;
- ratio 1 temporal (Native AA) — crisp; this bench renders
  `antialias: false`, so this is its first true AA, as planned;
- `DebugView.Disocclusion` under a slow orbit shows exactly thin
  trailing-silhouette strips; `AccumulationAge` shows the jitter-phase
  pattern with converged borders;
- ping-pong rule honored (getters re-read per frame) — no stale-half
  artifacts seen.

Not yet exercised: reactive (bench scenes have no transparents yet),
guides-only path, MomentsPass (next — see below).

## Sequencing on our side (your M6 dependency)

1. **D1 alignment next**: our private `TemporalGuidesPass` consumers still
   speak NDC-delta motion; we convert them to your UV-delta (`prevUV = uv −
   motion`) convention, then run the demo-10 A/B (guides-fed SSGI temporal
   vs private logic) — your M6 exit criterion.
2. `14-svgf` per SVGF-SPEC consumes `upscaler.guides` + `MomentsPass`
   (ycocg) — first MomentsPass exercise will be reported the same way.

Nothing blocked.
