# Shared WebGPU core

The root export and `/three` preserve the existing Three API. `/core` has no
engine dependency; `/babylon` depends only on Babylon.js, initially `~9.29.0`.
See [validation](webgpu-validation.md) for measured coverage and remaining limits.

## Encoding and ownership

`UpscalerCore({ device })` owns pipelines, samplers, constants and scatter buffers.
The pure `getResourceDescriptors(configuration)` function describes dimensions,
formats, complete usage flags, history, sampling and initialization without
creating an instance or accessing a GPU.

The host allocates all textures, including histories and dummy inputs. Each
resolved resource supplies its `GPUTexture` and `GPUTextureView`. The core checks
accessible dimensions, format, usage, sample count and forbidden aliases.
Resource origins and view subranges remain the host's responsibility; WebGPU
validation completes the checks available to JavaScript.

`configure()` validates synchronously; await `prepare()` before encoding.
`isReady` covers mandatory pipelines. The core records commands in the supplied
encoder; it never creates or finishes it, submits work or waits for completion.
CPU constant uploads use the device queue before submission; ordered clears are
encoded in the host encoder. Guides and upscale use separate constant buffers.

## Split frames and history

`encode()` composes `encodeGuides()` and `encodeUpscale()`. One split frame may be
active. Index, jitter, geometry, reset and working resource identities must agree
between stages. Color and exposure may be finalized at the last stage.
`maxAccumulation` stays unchanged; delta time may differ between Three node clocks.

A second guides call, upscale without guides or reconfiguration mid-frame throws.
After abandoning a frame or encoder, call `resetHistory()` before reuse. Reset
invalidates color, locks, exposure and shading-change memory and restores scatter
to positive infinity. Resize, depth-contract changes, history replacement and
`maxAccumulation` changes also require reset.

The core never swaps textures. Their owner performs ping-pong; Babylon's texture
manager already rotates histories. `dispose()` only destroys core-owned resources.
An initialization generation prevents stale asynchronous preparation from
publishing after reconfiguration, disposal or device loss. Device loss requires
a new instance and resources on a new device.

## Depth, motion and jitter

- `depthMode: 'hardware'` preserves perspective, orthographic and reversed-depth
  conventions. `'linear'` reads positive R32F view depth directly, searches the
  minimum and computes relief in the same units. Background must be finite and
  positive; zero, negative depth and NaN are invalid. Logarithmic decoding is external.
- `motionScale` converts input motion to current-minus-previous UV displacement
  without jitter. Three uses `(0.5, -0.5)` for NDC deltas. The analytic examples
  supply previous-minus-current UV displacement and use `(-1, -1)`.
- Jitter uses render pixels, X right and Y down. Pixel `(i, j)` samples
  `(i + 0.5 + x, j + 0.5 + y)` in the unjittered image. Adapters compose jitter
  with the existing projection and restore it after rendering inputs. Motion
  uses unjittered projections.

## Independent exposure domains

`exposureMode: 'upstream'` keeps luminance measurement, adaptation and published
Three guide data. `exposureTexture` overrides conditioning exposure while upstream
luminance measurement still runs.

`'provided'` skips luminance measurement. A small pass publishes RGBA32F history:
R conditioning, G zero, B host pre-exposure, A zero. CPU sources are
`settings.exposure` and `frame.hostPreExposure`, both defaulting to one. Optional
1×1 `exposureTexture` and `preExposureTexture` independently override their CPU
counterparts. Sources must be positive and finite; GPU contents are a host
contract, without CPU readback validation.

Conditioning is applied before accumulation and divided out at output. Host
pre-exposure is already present in input color and stays in output. Host history
correction is active when supplied. `correctConditioningExposure` also includes
the conditioning ratio in linear history correction; it defaults to false.
Shading-change detection keeps its conditioning and corrects host exposure changes.

`rcasAgeKnee: 0` keeps existing sharpening. A positive knee multiplies the temporal
lobe by `smoothstep(0, knee, age)`; age is accumulated count normalized by
`maxAccumulation`. Spatial sharpening is unchanged. Changing the knee requires
`configure()` and `prepare()` and resets history. Analytic examples opt into `0.5`.

These options are also available through Three's `Upscaler.configure()` and
return to neutral defaults when omitted.

## Packaging and examples

Engine peers are optional; install only your entry point's engine. ESM declarations
use relative `.js` imports and depend on `@webgpu/types`. Babylon or TypeScript
versions with ambient WebGPU declarations may need `skipLibCheck` for dependency
declaration collisions; consumer code still compiles strictly. The isolated core
consumer is checked without `skipLibCheck`.

- [Raw WebGPU](https://github.com/pmndrs/upscaler/blob/main/examples/17-core-webgpu/main.ts): descriptor allocation, host
  submission and explicit ping-pong.
- [Analytic Babylon](https://github.com/pmndrs/upscaler/blob/main/examples/18-babylon-framegraph/main.ts): native allocation,
  visible dependencies, GPU exposures and defined disabled output.
- [Babylon contracts and mesh examples](babylon-framegraph.md).
