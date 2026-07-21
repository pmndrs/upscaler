# Benchmark Results

E00 artifacts are produced by `npm run bench:run` and `npm run bench:capture`.
The immutable experiment contract remains in `experiments/e00-harness.json`.

## Layout

- `raw/E00/<timestamp>/run.json` records arguments, the manifest SHA-256, the
  baseline Git SHA, and a digest of every tracked or untracked non-ignored file
  in the working tree.
- Performance runs emit one JSON and CSV file per ratio, ABBA repetition, and
  block position. JSON retains every fresh frame-tagged sample, missing counts,
  per-pass median/p95, and compute-sum median/p95.
- Capture runs emit canvas-only lossless PNGs. Filenames identify blinded
  label, variant, reload, scenario, subrun, ratio, frame, and debug view.
- `capture-analysis.json` records all numerical reload pairs. Passing pairs stay
  in the aggregate file; failed pairs additionally emit standalone metrics and
  difference heatmaps.
- `review.html` presents the sampled A/B pairs without variant names, outlines
  every declared ROI, stores progress locally, and exports
  `rubric-reviewed.json`. Review state is isolated by manifest, working-tree,
  and ordered-record digests. Review-only validation rejects stale contracts,
  changed source trees, incomplete capture protocols, and failed numerical
  analyses before accepting grades. Validate an export without recapturing:

  ```bash
  node scripts/run-benchmark.mjs \
    --review-only \
    --output bench/results/raw/E00/<capture-run> \
    --rubric /path/to/rubric-reviewed.json
  ```

- Each run retains the required browser log channels. Any validation error,
  uncaught exception, or reported device loss invalidates the run.

Raw output is ignored by Git. Promote only controller-reviewed summaries or
small diagnostic artifacts under a separately authorized manifest.

The authored source-style bundles do not have result manifests yet. Their hypotheses,
cumulative ordering, and required later evidence are documented in
`bench/docs/PARITY-CANDIDATES.md`; do not store interactive or smoke output as adoption
evidence.

Q6-Q8 construct reduced-resolution three.js effect graphs for GTAO, SSR, SSGI,
the spatial denoiser, and the recurrent denoiser. Their readiness, source-owned
sampling state, node-frame maps, velocity history, and effect history are reset
before recorded frame zero as specified by the E00 manifest.

## Focused RCAS comparison

Run the practical E01 comparison with:

```bash
npm run bench:compare:rcas
```

It captures legacy RCAS versus the FSR 3.1.5 lower limiter, then the lower
limiter versus the temporal denoise default. It also records short ratio-2
timing blocks, writes a summary report, starts a local review server, and opens
the report in the default browser. Press Ctrl+C when review is complete.

To reopen an existing report without rerunning the GPU work:

```bash
npm run bench:compare:rcas -- --reuse bench/results/raw/E01/<result-directory>
```
