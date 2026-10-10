# Documentation

The documentation is split by how authoritative it is. The guides below are
maintained against the shipped code and are the public contract. Research records
explain *why* the implementation looks the way it does. The archive is history. Where
they disagree, the guides and the source win.

## Using the library

- [WebGPU core](webgpu-core.md), [Babylon Frame Graph](babylon-framegraph.md) and [validation](webgpu-validation.md).

Maintained, normative, for anyone integrating `@pmndrs/upscaler`:

- [Getting started](getting-started.md): requirements, choosing between
  `upscaleScene()`, `upscale()`, `upscaleSpatial()`, `UpscalePass` and the raw
  `Upscaler`, and runtime settings.
- [Inputs and contracts](inputs-and-contracts.md): what color, depth, velocity, jitter,
  reactive masks and exposure must contain; the output domain; alpha (including the
  0.2 behaviour change).
- [Temporal guides](temporal-guides.md): the published motion/depth/disocclusion
  bundle, the split frame, `temporalGuides()`, and `MomentsPass`.
- [Debugging](debugging.md): the debug views in order, symptoms to causes, and
  verifying on a real GPU.
- [Compatibility and limitations](compatibility.md): supported three.js versions,
  WebGPU requirements, and what is out of scope.

The [examples](../examples/README.md) are the executable references; each guide links
the ones for its integration path.

## Working on the library

Maintained, for contributors:

- [Contributing](contributing.md): the dev loop, the bench, verifying on a real GPU,
  and how releases are cut.
- [Windows audit and roadmap](windows-audit.md): async startup evidence, browser/demo coverage, native tooling gaps and prioritized follow-ups.
- [Architecture](architecture.md): the layers, the pass graph, color domains and the
  shared constants buffer.
- [`src/shaders/README.md`](../src/shaders/README.md): the per-pass audit against
  FidelityFX FSR 3.1.5 and the operational notes for each pass.
- [`bench/docs/BENCHMARKING.md`](../bench/docs/BENCHMARKING.md): how to run and read a
  benchmark.
- [Releasing](releasing.md): releasing from the Run workflow button or a `vX.Y.Z` tag
  (both in CI, no local step), prereleases, re-runs, the optional `npm run release`,
  and the npm Trusted Publishing setup.
- [`CLAUDE.md`](../CLAUDE.md): working notes for agents and maintainers, including
  the landmines a change must not re-break.

## Research

Live records, kept current as findings land:

- [Async initialization migration](async-init-migration.md): before/after examples
  for the draft #83 API change and preparation/readiness rules.
- [Windows cross-device audit](windows-cross-device.md): adapter metadata, NVIDIA
  and Intel verification, lifecycle fixes and remaining measurement limits.

- [FSR 3.1.5 parity report](research/PARITY.md): where this implementation matches
  and diverges from FSR 3.1.5, and the measurements behind each choice.
- [Paper notes](research/PAPER-NOTES.md): a running tracker of write-up-worthy
  findings (*surprised us + measured + others would hit it*) and what each still needs
  for publication ([#10](https://github.com/pmndrs/upscaler/issues/10)).
- [Upstream candidates](research/UPSTREAM-CANDIDATES.md): ranked findings worth
  contributing to three.js's own temporal/post nodes, with evidence and owners
  ([#35](https://github.com/pmndrs/upscaler/issues/35)).
- Benchmark evidence: [`bench/docs/NEXT-STEPS.md`](../bench/docs/NEXT-STEPS.md)
  (adoption record), [`bench/docs/PARITY-DECISIONS.md`](../bench/docs/PARITY-DECISIONS.md),
  [`bench/docs/PARITY-CANDIDATES.md`](../bench/docs/PARITY-CANDIDATES.md),
  [`bench/docs/THREE-TEMPORAL-COMPARISON.md`](../bench/docs/THREE-TEMPORAL-COMPARISON.md).

## Archive

Implementation-era specifications, handoffs and plans. They are kept as historical
context and are **not** the current contract: details have drifted since (for
example, the archived guides spec predates alpha passthrough and lists a
`historyAge` product that ships as `history`). The maintained replacement for the
temporal-guides material is [Temporal guides](temporal-guides.md).

### Temporal guides

- [Temporal guides specification](archive/temporal-guides/TEMPORAL-GUIDES-SPEC.md)
- [Consumer specification response](archive/temporal-guides/GUIDES-SPEC-RESPONSE.md)
- [Integration handoff](archive/temporal-guides/GUIDES-HANDOFF.md)
- [Integration handoff response](archive/temporal-guides/GUIDES-HANDOFF-RESPONSE.md)

### Plans

- [Issue 11 release design](archive/plans/ISSUE-11-RELEASES-DESIGN.md)
- [Issue 11 release implementation plan](archive/plans/ISSUE-11-RELEASES-PLAN.md)
