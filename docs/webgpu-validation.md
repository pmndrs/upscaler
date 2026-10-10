# Shared WebGPU validation

Prepared against v0.5.0 (`5821d91`). Publication and host application migrations
remain separate work.

## Evidence

- October 9, 2026, prepared upstream contribution based on source fork `1d6fde2`:
  39 files / 603 CPU tests passed after package normalization, plus lint, typecheck
  and library/gallery builds. Packed-consumer results are listed below.
- Release-workflow fixtures disable commit/tag signing in every temporary clone.
  Seed-local Git settings do not survive cloning; personal Git settings are unchanged.
- CPU: descriptors, odd dimensions, stage order, separate uniforms,
  reset/cancellation, aliases, reactive masks, variants, jitter and split guides.
- `verify:packed-entrypoints`: isolated core without engines, Babylon without
  Three, root/Three without Babylon; runtime imports and strict NodeNext consumers.
  Core declarations compile without `skipLibCheck` under TypeScript 5.7.
- `verify:packed-guides:gpu`: packaged Three, 16 split frames, two backing histories,
  no monolithic fallback.
- `verify:core:gpu`: independent/combined exposure changes, finite HDR/alpha,
  odd resize, NativeAA, Babylon aliasing on/off and disabled/reenabled output.
  `verify:packed-core:gpu` repeats against packaged exports.
- Production mesh coverage: [Babylon verification](babylon-framegraph.md#verification).

RTX 5080 Q0 captures, ratio 1.5, frames 8/32, matched clean upstream pixel for pixel.
This is baseline-harness evidence, not the entire visual matrix. The October 9
cross-build measurements and their limits are recorded below; they do not establish
isolated per-pass GPU performance.

## RX 580 functional verification

On October 9, 2026, the prepared package passed the reused GPU assertions on the
RX 580: raw WebGPU and analytic Babylon from the npm archive, all twelve production
Babylon mesh pages, and packaged Three split guides (16 frames, two backing
histories, zero monolithic fallbacks). Tests cover finite HDR/alpha/depth, separate
and combined exposures, camera/mesh motion, jitter removal, reactive coverage,
spatial/temporal/bilinear, effects, shared guides, reset, disabled/reenabled output,
odd dimensions, NativeAA, alias optimization on/off and mobile layout.

Machine: Windows 11 Pro build 26200, Ryzen 5 2400G, Radeon RX 580 Series driver
31.0.21925.1001. The remote Playwright browser is Chromium 153.0.8010.12, in the
active console session. Its WebGPU adapter reported AMD / gcn-4, hardware, with
BC compression available. Launch arguments were checked before each accepted run.
Sources and servers stayed on the development PC; only the browser/GPU ran remotely.
The remote CDP bridge reused the existing assertions; no assertion was relaxed.

## Cross-build performance, October 9

Both devices compared clean upstream v0.5.0 with the prepared contribution at
1280x720, temporal dispatch, ratios 1/1.5/2/3, four ABBA blocks, 240 warmup and 600
measured frames per leg, three frames in flight. Acceptance uses only the two
library-profiling-disabled legs from each upstream timer probe. Raw on/off probe
results are retained, but on-leg GPU timestamps are not treated as profiling-off
acceptance. Paired total-time deltas are compared with median same-arm drift.

| Device / ratio | Paired total-time delta | Observed drift/noise | Qualification |
| --- | ---: | ---: | --- |
| RX 580 / 1 | +0.13% | 0.47% | No regression above observed noise |
| RX 580 / 1.5 | +0.65% | 2.05% | No regression above observed noise |
| RX 580 / 2 | +2.35% | 1.63% | Repeat required |
| RX 580 / 3 | +1.45% | 2.94% | No regression above observed noise |
| RTX 5080 / 1 | -18.25% | 54.20% | Inconclusive: high noise |
| RTX 5080 / 1.5 | +10.79% | 46.70% | Inconclusive: high noise |
| RTX 5080 / 2 | -2.44% | 4.61% | No regression above observed noise |
| RTX 5080 / 3 | -1.11% | 3.05% | No regression above observed noise |
| RX 580 / 2, confirmation | +1.09% | 3.22% | Initial signal not confirmed above noise |

The initial RX 580 ratio-2 signal is retained. Its repeat used eight ABBA blocks
and 1200 samples per leg, with the same warmup and predefined drift threshold.
The smaller repeat delta did not exceed that threshold; this is not proof of zero
CPU overhead. The first two RTX ratios were too noisy for acceptance. CPU-only
release fixtures overlapped parts of these runs; no second GPU job shared either
device. Further controlled measurement is required before a blanket performance
claim. These are queue-synchronized total/CPU throughput measurements, not isolated
profiling-off GPU pass timings or whole-game FPS.

## Additional hardware checks, October 10

Both actual adapters passed a controlled `GPUDevice.destroy()` loss test: native
`device.lost`, old-instance invalidation, replacement device and rendered output.
The core was recreated; Babylon restored the same engine and the host recreated
the graph/task after awaiting actual WebGPU initialization. Babylon 9.29.0's
restoration observable fired before initialization completed on both devices.
This exercises real WebGPU loss handling, not an operating-system driver crash.
Three also passed old-instance invalidation and rejected preparation after loss
on both devices; caller-driven renderer recreation restored rendering. Automatic
Three renderer restoration is not claimed.

The same core and Babylon task each passed 24 size/ratio reconfigurations, including
odd dimensions and NativeAA. Babylon allocation aliasing alternated on/off. Two
host compute effects ran between guides and upscale with a separate late color
texture. A same-frame reset A/B comparison verified that the core consumed that
color; float32 history readback verified the supplied conditioning and host
exposure values. Both adapters rendered valid HDR/alpha output after restoration.

All twelve built Babylon mesh pages passed again on both devices. The camera
motion check now compares spatial regions against stationary jitter residue:
whole-frame averaging diluted valid motion in the mostly transparent canvas.
The absolute threshold remains unchanged, with an additional tenfold signal-to-
residue requirement. Captures were inspected for scene orientation, composition,
alpha backgrounds, guides and effects; this is a bounded capture review.

Eight ABBA blocks and 1200 samples per leg repeated the throughput checks below,
with profiling disabled in the accepted legs. The repository CPU suite started
only after these measurements finished.
No paired delta exceeded the predefined same-arm drift threshold. RTX variance
remains too high for a blanket performance claim; all samples are retained.

| Device / ratio | Paired total-time delta | Observed drift/noise |
| --- | ---: | ---: |
| RX 580 / 1 | +0.02% | 0.90% |
| RX 580 / 1.5 | +1.87% | 4.89% |
| RX 580 / 2 | +1.50% | 3.31% |
| RX 580 / 3 | +1.54% | 3.10% |
| RTX 5080 / 1 | -2.42% | 11.46% |
| RTX 5080 / 1.5 | +0.15% | 9.87% |

RTX Q0 convergence at ratio 1.5 after 180 settle frames matched upstream across
12 consecutive pairs: mean absolute RGB difference 0.0968 on the 0–255 scale.
Three alpha convergence at ratio 2 after 240 settle frames also matched upstream
exactly for all-pixel/coverage metrics and worst-pixel traces across two jitter
cycles. The alpha meter now closes its owned browser through CDP and verifies its
unique profile before creating a page; a busy-port regression confirms that a
browser with another profile remains open.

## Remaining acceptance work

- Resolve the inconclusive performance cases under controlled conditions, with
  library profiling disabled, recorded samples and a noise-derived threshold.
  Total/CPU throughput is distinct from isolated per-pass GPU timings.
- Exhaustive human visual review: still convergence, camera/object motion,
  transparency, HDR, NativeAA, presets and odd dimensions.
- OS/driver-triggered loss and exhaustive host-specific recovery remain outside
  the controlled device-loss checks above.

Reports are local in ignored `bench/results/windows-local/`, `output/playwright/`
and `artifacts/pr-preparation/`. Unexecuted checks are never reported as passing.
