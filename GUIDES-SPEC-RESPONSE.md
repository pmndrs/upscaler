# GUIDES-SPEC-RESPONSE.md — consumer-side M0 review (bench → FSR port)

Response to `TEMPORAL-GUIDES-SPEC.md` §7 (deviations) and §9 (open
questions), plus the pre-build decisions `SVGF-SPEC.md` §8 asks for.
Written 2026-07-21 from the bench/consumer side. Nothing here is code; per
M0, contract agreement precedes build on both sides.

## Verdict up front

The spec's central move — **publish products, not pass boundaries (D5)** —
is accepted and is better than what FSR3-BRIEF asked for. The brief wanted
the split because it wanted (a) the products and (b) early-stage-without-
upscale; `dispatchGuides()` / `path: 'guides'` delivers both while keeping
the port's measured fusions. Our own harness prototype went through the same
reasoning at smaller scale (one class, three dispatches, texture getters —
consumers bind textures, never passes), so the contract shapes already match
in spirit. FSR3-BRIEF's "Consumption requirements v2" section (commit
c7ba382) should be read with its pass-boundary language superseded by D5;
its Req-1 acceptance (the live demo 10 rig) stands unchanged and maps to
your M6.

## §9 answers

**1. D1 — UV-delta motion: ACCEPTED, and preferred.** Publishing the
directly-usable form (`prevUV = uv − motion`, y-flip pre-applied) deletes
the convention seam that cost us the demo 03 speckle hunt. Raw NDC is not
needed — every consumer that wants it owns the velocity MRT it came from.
Consumer-side consequence we own: our harness `TemporalGuidesPass` currently
publishes the raw-velocity convention (consumers apply `· (0.5, −0.5)`
themselves, e.g. `ssrt3-guides-temporal.wgsl`). Before the swap we will
align the harness pass to publish YOUR convention, so the port's bundle is
drop-in against unmodified consumer shaders. That alignment is bench-side
work, scheduled with the swap, not before.

**2. D2 — frame N−1 locks/age: SUFFICIENT.** A prior is previous-frame by
definition. Our only shipping consumer of history age (demo 13 `adaptive`)
already reads the *previous* frame's N — that is how it works today, at
3.17× — so N−1 latency is the semantics we validated, not a compromise.
Same for the SVGF history-rejection prior.

**3. D3 — display-res age sampling: fine for day one.** Accepted with one
recorded risk: our adaptive march reads N per march-res pixel (currently
half render-res); sampling display-res age at march UV is a filtered
approximation and may dilate age across silhouettes → transient over-effort
at edges (safe direction: over-effort, never under-quality). The guides lab
measures exactly that. Fallback exists and costs you nothing: demo 03/12/13
keep their own render-res counter (the brief always allowed the consumer to
produce `historyLength`); we only retire it if the lab shows display-res
sampling is clean.

**4. Moment pyramid: 3 levels.** SVGF's short-history fallback is one
coarse-neighborhood read (7×7-equivalent ≈ mip 2); nothing in the SVGF-SPEC
chain reads deeper. Allocate mip 0 + 2.

**5. Consumption mechanism: raw bind groups first, TSL second.** Every
hot-path consumer (march, temporal, à-trous) is raw WGSL; TSL consumption is
wanted only composite-side (display/debug and the bent-normal/spec-occlusion
env terms). Per-frame texture re-pointing is fine — our `RawComputePass`
re-binds per execute, and our TSL usage follows the same `updateBefore`
re-point pattern you cite — so the stable-identity copy can stay spec'd-only.
If M4 needs trimming, defer the TSL example, not the raw path.

**D4 (formats), D6 (environment):** accepted; format is read from the
texture at bind time on our side, channel conventions (.r reads) noted.
Reserved-channel rule acknowledged — we will never read unlisted fields.

**Producer-of-record confirmed:** the SVGF addendum (§A/§B/§E,
`MomentPyramid`, the signal-&-space rule) is present in this repo's
`FSR3-BRIEF.md` and matches what both specs cite. (An earlier draft of this
response flagged a sync gap — retracted; it was a stale read on the consumer
side.) One brief-side reconciliation was applied instead: the brief's
"Consumption requirements v2" and bundle table now note that the accepted
deviations D1 (UV-delta motion) and D4 (port-native formats) supersede the
brief's suggested convention/formats — see the brief's "Contract resolution"
note.

## SVGF-SPEC §8 pre-build decisions (recommendations)

1. **Moments: scalar luminance in YCoCg-Y** (spec default). Two channels;
   revisit RGB variance only if chroma noise visibly survives — the
   noiseinject arm will show it cheaply.
2. **History feedback: A/B it, default to the paper convention**
   (first-iteration output feeds history). The over-stabilization risk is
   real but it is exactly what the stability metric + reconvergence protocol
   measure — let the numbers pick.
3. **À-trous full-res first.** Clean H1/H5 read; half-res à-trous is a
   follow-up arm measured against the lab-09 chain it would ride.
4. **`svgf-noiseinject` first; the path tracer only if demo 14 is
   ambiguous.** Agree with the spec's own recommendation and scope-honesty:
   the PT is the largest build in the spec and is justified solely by
   unbiased-GT + noise knob. One addition: if the PT is built, its
   1024-spp accumulation doubles as the long-deferred *absolute* ground
   truth for cornell (the Cycles stand-in) — worth stating in 15-ptref's
   goals so the build buys two things.

Also endorsed explicitly: SVGF-lite as a first-class arm (H1 isolation at
bilateral cost is the likeliest shippable outcome if H0 holds on the SSGI
signal), and the honest H0 framing itself — a measured "no" on our
already-temporally-filtered signal would match our lab-10 experience and
would still leave demo 15 standing as an independent artifact.

## Sequencing from the consumer side

- Now: this M0 response goes to the port side; both sides resolve the
  addendum sync flag.
- Your M1+M2 unblock our guides lab (demo 10 rig, already live) — that A/B
  is the exit criterion and needs nothing new built here.
- Demo 14/15 build starts only after M2 (guides bundle) + M5
  (`MomentPyramid`) exist to consume — per SVGF-SPEC's own thesis, building
  it standalone would duplicate the front-end and invalidate the "small
  build" premise.
- Bench-side jitter/AA consumption (FSR3-BRIEF Req 2) remains post-pass-3;
  unaffected by this review.
