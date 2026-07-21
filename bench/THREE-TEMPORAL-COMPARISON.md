# three.js TRAA/TAAU comparison

## 1. Scope and executive answer

This audit compares the repository's **current** WebGPU temporal upscaler with the implementations installed in **three.js 0.185.1**:

- `TRAANode`: same-resolution temporal reprojection anti-aliasing.
- `TAAUNode`: reduced-resolution temporal anti-aliasing plus upscaling.

The exact installed version is pinned by `../package-lock.json:2717-2722` and `../node_modules/three/package.json:1-19`.

The local implementation facts in this document describe the code as it exists now. They are not claims that every behavior is permanent design intent.

### Executive answer

- **TRAA is not the general upscaling comparator.** It resolves at the input resolution, so it compares directly only with local `QualityMode.NativeAA` at a 1× ratio. See `../src/types.ts:12-24`.

- **TAAU is the closest reduced-resolution comparator.** It expects low-resolution beauty, depth, and velocity, then reconstructs an output-resolution image. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:10-30`.

- **The local resolver is feature-richer and structurally heavier.** It has a separate reconstruction pass, persistent age and lock state, reactive masks, generated reactivity, shading-change handling, exposure conditioning, debug views, and RCAS. TAAU and TRAA are simpler and are therefore likely lighter, but there is no controlled GPU benchmark here that proves a winner.

- **The local resolver can replace TRAA or TAAU for many WebGPU applications, but it is not a transparent drop-in.** The output color domain, logarithmic-depth support, render-graph hooks, resource footprint, reset controls, and APIs differ.

- **Shared jitter is directionally correct only at the pipeline level.** The preferred design is an application- or render-pipeline-owned temporal sampling context. SSGI, SSR, GTAO, and denoisers should not depend directly on the upscaler.

### Evidence labels used below

- **Current implementation fact** means the behavior is directly visible in the audited source.
- **Source-level estimate** means operation or resource cost inferred from source structure, not measured GPU performance.
- **Unverified concern** means the source suggests a possible problem that still needs a focused runtime test.
- **Recommendation** means a proposed direction, not current behavior.

The files under `node_modules` are useful evidence for the installed package, but they are addon/internal source, not a stable public API contract across future three.js releases.


## 2. Plain-language primer

### Projection jitter

**Projection jitter** moves the camera's projection by a fraction of one pixel before rendering a frame. Geometry then lands at a slightly different subpixel position each frame.

A temporal resolver combines those differently positioned samples into a cleaner or higher-resolution result. Exactly **one final temporal resolver** should own this camera movement for a given render.

This repository applies jitter with `camera.setViewOffset()`. The local frame lifecycle captures a stable projection first, applies jitter before rendering, and clears it afterward. See `../src/Upscaler.ts:260-297`.

### Stochastic shader noise

**Stochastic shader noise** changes where a shader samples within an AO, GI, reflection, or denoising kernel. It can rotate rays, shift a sampling pattern, or choose a new random direction.

It does **not** move the camera. It also does not need to use the upscaler's Halton distribution. An SSGI ray pattern and a camera-jitter pattern solve different sampling problems.

### Temporal history and reprojection

**Temporal history** is a texture containing information from previous frames.

**Reprojection** uses motion vectors and camera transforms to estimate where a previous-frame pixel belongs in the current frame. Without reprojection, camera or object motion would cause history to trail behind the scene.

### Disocclusion

A **disocclusion** is an area that becomes newly visible, such as background revealed when a foreground object moves away.

There is no trustworthy history for a newly revealed surface. A temporal resolver uses depth and motion to detect that case and reject or heavily reduce the old history.

### Rectification

**Rectification** constrains reprojected history to colors that are plausible in the current neighborhood.

It is a defense against stale history. If the old color lies far outside the range or variance of nearby current samples, the resolver clips it toward that neighborhood before blending.

### Reactive mask

A **reactive mask** identifies pixels where current color should dominate history.

Transparent surfaces, particles, animated emissives, and additive effects often lack reliable depth or motion. Marking those pixels as reactive reduces ghost trails. The local API accepts a mask or can generate one from opaque-only versus final color. See `../src/types.ts:119-156` and `../src/Upscaler.ts:421-448`.

### Why TRAA or TAAU must not run before the local resolver

Stacking TRAA/TAAU before the local temporal upscaler creates two owners of temporal sampling:

1. The upstream resolver jitters and temporally filters the scene.
2. The local resolver jitters or expects jitter again and temporally filters the already-resolved result.

That creates **double jitter** or a mismatch between the color buffer and the final resolver's expected sample position. It also creates **double temporal filtering**, which can blur detail, retain stale history longer, and suppress the per-frame variance the final upscaler needs for reconstruction.

Use one final AA/upscaling resolver per run: local Native AA, local temporal upscale, TRAA, or TAAU.


## 3. Exact implementations audited

### Local repository

- Low-level compute orchestration and frame lifecycle: `../src/Upscaler.ts:42-63`, `../src/Upscaler.ts:139-205`, and `../src/Upscaler.ts:260-339`.
- Composable graph node: `../src/UpscalerNode.ts:78-115` and `../src/UpscalerNode.ts:172-330`.
- High-level imperative scene driver: `../src/UpscalePass.ts:21-36` and `../src/UpscalePass.ts:88-172`.
- Jitter generation: `../src/math/halton.ts:1-41` and `../src/math/jitter.ts:3-68`.
- Temporal shaders: `../src/shaders/reconstruct.ts:4-105`, `../src/shaders/accumulate.ts:4-291`, and `../src/shaders/luminancePyramid.ts:4-95`.
- Output stages: `../src/shaders/rcas.ts:4-92`, `../src/shaders/blit.ts:4-46`, and `../src/shaders/common.ts:82-120`.
- Canonical bench integration: `./src/BenchPipeline.ts:14-22` and `./src/BenchPipeline.ts:125-162`.
- Visual fixtures: `../examples/04-aliasing-torture/main.ts:11-14`, `../examples/05-transparency/main.ts:12-18`, `../examples/06-screenspace-gi/main.ts:27-32`, `../examples/09-kitchen-sink/main.ts:25-37`, and `../examples/10-ssgi-denoise/main.ts:27-52`.

### Installed three.js 0.185.1

- TRAA: `../node_modules/three/examples/jsm/tsl/display/TRAANode.js`.
- TAAU: `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js`.
- SSGI: `../node_modules/three/examples/jsm/tsl/display/SSGINode.js`.
- GTAO: `../node_modules/three/examples/jsm/tsl/display/GTAONode.js`.
- SSR: `../node_modules/three/examples/jsm/tsl/display/SSRNode.js`.
- Spatial denoise: `../node_modules/three/examples/jsm/tsl/display/DenoiseNode.js`.
- Recurrent denoise: `../node_modules/three/examples/jsm/tsl/display/RecurrentDenoiseNode.js`.
- Temporal reprojection for effects: `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js`.
- Analytic R² noise: `../node_modules/three/examples/jsm/tsl/utils/RNoise.js`.
- Render-pipeline hook storage: `../node_modules/three/src/renderers/common/RenderPipeline.js`.
- Shared velocity node: `../node_modules/three/src/nodes/accessors/VelocityNode.js`.


## 4. Jitter comparison

### Local schedule

**Current implementation fact**

The local sequence is centered Halton(2,3): each generated value subtracts `0.5`, producing offsets in render-pixel units around zero. See `../src/math/halton.ts:29-41`.

The phase count adapts to the upscale ratio:

`round(8 × ratio²)`

with a minimum of one phase. See `../src/math/jitter.ts:3-17`.

Examples:

- 1×: 8 phases.
- 1.5×: 18 phases.
- 2×: 32 phases.
- 3×: 72 phases.

The upscaler:

- captures a stable unjittered projection;
- advances the sequence;
- reads the newly advanced sample;
- applies it through `camera.setViewOffset()`.

See `../src/Upscaler.ts:270-287`.

Because `advance()` occurs before `current` is read, the runtime order is a one-sample rotation of the generated array. This does not change the set of samples or cycle length, but it matters when comparing frame-by-frame sequences.

### three.js schedules

**Current implementation fact**

Both installed nodes generate 32 uncentered Halton(2,3) offsets and subtract `0.5` when applying them. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:735-754`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:803-822`

Both increment with:

`index % (_haltonOffsets.length - 1)`

That makes the effective runtime cycle **31 samples**, leaving the final generated offset unused. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:328-338`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:361-370`

TRAA and TAAU each install their own before/after render-pipeline callbacks to apply and clear camera jitter. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:443-464`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:502-527`

TAAU's source comments say its offset is reduced to an output-pixel footprint, but the installed implementation applies the centered `[-0.5, 0.5]` offset directly through an input-sized view offset. No input-to-output scale is visible in that code. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:318-354`.

That makes the intended TAAU jitter footprint internally inconsistent in the audited source. The benchmark should record the behavior as installed and treat any corrected output-pixel variant as a separate diagnostic.

### Practical conclusion

Both implementations use the same broad method: low-discrepancy Halton projection jitter and stable motion vectors.

Local adapts phase count to scale ratio, while installed TRAA/TAAU use an effective fixed 31-frame cycle. Installed TAAU also has the input-pixel/output-pixel inconsistency above.

For a **stock-product comparison**, preserve each resolver's own schedule. That compares what an application actually receives.

For a **diagnostic comparison**, a bench may inject one identical sequence into both resolvers to isolate reconstruction and accumulation behavior. That result must be labeled as a modified diagnostic configuration, not stock TRAA/TAAU behavior.


## 5. Feature comparison

### 5.1 Inputs and velocity convention

#### Local

The temporal path requires render-resolution color, depth, and velocity. Velocity is three's NDC delta, `current - previous`. Local multiplies it by `(0.5, -0.5)` to convert to UV delta and reprojects with `previousUV = uv - motion`. See `../src/types.ts:119-129`, `../src/Upscaler.ts:620-622`, and `../src/shaders/reconstruct.ts:86-100`.

**Pros**

- Matches three's velocity convention.
- Supports explicit reactive and exposure inputs.
- The low-level API makes frame reset and cadence explicit.

**Cons**

- Requires correct raw texture access and WebGPU-only integration.
- The current composable node mutates the shared three velocity singleton.
- Public documentation is inconsistent: `UpscalerConfig.jitter` says composable `upscale()` defaults off, but the node constructor currently defaults it on. Compare `../src/types.ts:91-111` with `../src/UpscalerNode.ts:129-165`.

#### three TRAA/TAAU

Both consume beauty, depth, velocity, and camera. Both use the same NDC-to-UV conversion and `historyUV = uv - offset`. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:647-681`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:663-679`

**Pros**

- Natural TSL graph integration.
- Returns a graph texture that can feed later post-processing.
- TRAA can use a velocity node from builder context rather than always assuming only the exported singleton. See `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:466-480`.

**Cons**

- Camera and shared velocity state are still modified through node-owned hooks.
- TAAU's jitter setup directly uses the exported global `velocity` singleton, even though its shader accepts a velocity input node. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:327-365`.

#### Replacement implication

The motion convention is compatible. The ownership and lifecycle APIs are not. Replacing one resolver with another requires rewiring render ownership, reset behavior, and output transformation rather than only swapping a function call.


### 5.2 Depth/motion dilation and disocclusion

#### Local

Local fuses nearest-depth motion dilation and depth rejection into one render-resolution compute pass. It searches a 3×3 depth neighborhood, chooses the nearest sample, carries that sample's motion, and compares current versus reprojected previous linear depth. See `../src/shaders/reconstruct.ts:4-25` and `../src/shaders/reconstruct.ts:60-104`.

Local explicitly supports:

- standard depth;
- reversed depth;
- perspective cameras;
- orthographic cameras.

See `../src/shaders/common.ts:122-140` and flag staging in `../src/Upscaler.ts:598-645`.

**Pros**

- Strong current support for reversed and orthographic depth.
- Dilation is separated from output-resolution accumulation and reused there.
- Debug views expose motion, depth, and disocclusion.

**Cons**

- Previous depth is stored as last frame's positive linearized view-space depth and compared with current linearized view-space depth after motion reprojection.
- It does **not** transform the previous depth sample from previous view space to world space and then into current view space.
- It has no logarithmic-depth conversion path.

The missing cross-frame camera transform is a quality risk during camera translation or rotation, especially on large depth gradients. It is a source-level difference, not a demonstrated failure in every scene.

#### three TRAA/TAAU

Both installed nodes reconstruct the previous depth sample using the previous projection, transform previous view position to world space, then transform it into the current camera view before comparing depth. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:536-548`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:572-581`

TRAA additionally handles:

- reversed depth;
- logarithmic depth;
- orthographic depth.

See `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:466-486`, `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:498-546`.

Installed TAAU does not show equivalent branches in its current-depth sampling, and its previous-depth conversion always calls `viewZToPerspectiveDepth()`. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:537-579`.

**Pros**

- Matrix-transformed previous depth better accounts for camera motion.
- TRAA has the broadest depth-mode handling of the three audited paths.

**Cons**

- TAAU's installed depth path appears perspective-oriented and lacks explicit reversed/logarithmic handling.
- Depth rejection uses mutable scalar properties with fixed defaults; those defaults still require scene validation.

#### Replacement implication

Local explicitly handles reversed-depth and orthographic WebGPU scenes in ways that are not visible in installed TAAU's depth branches.

TRAA remains safer where logarithmic depth is required. Local should not claim log-depth replacement until that path exists and is tested.


### 5.3 Current reconstruction and history filtering

#### Local

The current frame is reconstructed with a jitter-aware separable Lanczos2 kernel over a 3×3 render-texel footprint. History uses five filtered Catmull-Rom fetches. See:

- `../src/shaders/accumulate.ts:83-120`
- `../src/shaders/accumulate.ts:149-201`

**Pros**

- Explicitly accounts for where the jittered input sample landed.
- Sharper history reconstruction than a single bilinear sample.
- Current reconstruction, moments, and min/max reuse the same 3×3 color loads.

**Cons**

- More filtering work and more source texture operations.
- Negative Lanczos lobes require deringing.
- The exact quality/performance tradeoff has not been benchmarked against installed TAAU.

#### three TAAU

TAAU reconstructs current color from a 3×3 input neighborhood with `exp(-2.29 × distance²)`, described in source as a Blackman-Harris Gaussian approximation. It reads one filtered history sample. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:629-715` and `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:717-728`.

TRAA is same-resolution and therefore samples current color directly rather than running a reduced-to-output reconstruction kernel. See `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:647-681`.

**Pros**

- Simpler history path.
- TAAU reuses its nine current samples for both reconstruction and variance moments.

**Cons**

- One filtered history sample may blur or under-reconstruct compared with a sharper bicubic history filter.
- The fixed 3×3 current filter may not scale optimally across every upscale ratio.

#### Replacement implication

TAAU is the correct comparator for local reduced-resolution reconstruction. TRAA is not.

The visual comparison should focus on thin geometry, moiré, camera motion, and newly revealed surfaces rather than treating filter names as proof of quality.


### 5.4 Rectification and accumulation

#### Local

Local:

- computes neighborhood moments in YCoCg;
- clips history toward a variance box;
- stores accumulation age in history alpha;
- caps age with `maxAccumulation`;
- ages history under disocclusion, heavy clipping, shading change, and reactivity;
- lets stable thin-feature locks relax clipping and favor history.

See `../src/shaders/accumulate.ts:204-290`.

**Pros**

- Rich control over stale-history rejection.
- Explicit age makes reset and convergence behavior inspectable.
- YCoCg usually creates a tighter color-aligned rectification box than RGB.

**Cons**

- More persistent state and more interacting tuning constants.
- More ways to over-reject history, protect bad history, or trade shimmer for ghosting.
- Many constants are shader constants rather than convenient diagnostic controls.

#### three TAAU/TRAA

TAAU computes RGB moments, narrows variance gamma under motion, clips history, and raises current-frame weight with motion. Its baseline current weight is `0.025`. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:123-132` and `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:717-755`.

TRAA uses a `0.05` baseline, adds motion weighting, and can add subpixel-motion correction before the same broad variance/flicker-reduction blend. See `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:613-643` and `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:683-704`.

Neither node stores the same explicit normalized age used locally. With valid stationary history and stable luminance, their baseline current weights produce an exponential-like response; motion and flicker reduction alter the effective weights.

**Pros**

- Fewer interacting state channels.
- Motion-responsive current weighting is direct and easy to tune.
- TRAA's optional subpixel correction is a focused anti-blur mechanism.

**Cons**

- Less explicit convergence control.
- No local-equivalent reactive, shading-change, or exposure-conditioned age policy.
- RGB variance can be less color-aligned than YCoCg.

#### Replacement implication

Local has broader controls for difficult content. Three's motion weighting and TRAA subpixel correction are still valuable experiments for local variants; they should be tested behind internal flags rather than assumed superior.


### 5.5 Reactive masks, locks, shading, and exposure

#### Local

These are mostly local-only features:

- explicit reactive mask;
- generated reactivity from opaque/final color difference;
- persistent luminance locks;
- shading-change detection;
- automatic, fixed, or external exposure conditioning;
- debug views for each major signal.

See `../src/Upscaler.ts:394-553`, `../src/shaders/accumulate.ts:211-290`, and `../src/shaders/luminancePyramid.ts:4-30`.

**Pros**

- Better tools for transparents, particles, thin features, and HDR stability.
- Caller can explicitly reset and inspect temporal state.

**Cons**

- Additional passes, textures, branches, and tuning surface.
- The current scalar exposure analysis is deliberately simpler than a full luminance pyramid.

#### three

TRAA has no equivalent reactive-mask, exposure, lock, or shading-change input.

TAAU contains a thin-feature lock calculation and allocates two history attachments: color and lock. See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:153-163` and `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:736-758`.

**Unverified concerns: TAAU lock path**

The installed source deserves a focused GPU check:

- history has two attachments;
- the resolve target is created with one attachment;
- the resolve material declares two logical outputs;
- the per-frame copy visibly copies only `resolve.texture` into the first history texture.
- lock history is sampled at the current UV while color history is sampled at the reprojected `historyUV`;
- thin-feature normalization divides by mean luminance without a visible zero-luminance guard.

See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:160-172`, `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:460-462`, and `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:626-627`, `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:727-758`.

This source structure suggests persistence, reprojection, or dark-pixel stability may not behave as intended, but it is **not evidence that the lock path is definitely broken**. three's material/output handling and backend behavior need a runtime attachment inspection and visual lock test.

#### Replacement implication

Local offers explicit reactive-content controls that TAAU does not expose. Whether those controls produce the better image in a given scene still requires GPU comparison.

Do not copy or design around TAAU's current lock behavior until its second-output persistence is verified.


### 5.6 Sharpening and output color domain

#### Local

The default temporal output runs RCAS. Each tap is inverse-tonemapped, de-exposed, and
sharpened in the caller's linear/HDR domain before the pass writes `rgba16float`.
Presentation is deliberately outside the upscaler.

**Pros**

- Composable linear/HDR output.
- Caller-controlled tone mapping, output color space, and later post-processing.
- Built-in sharpening and optional RCAS denoise.

**Cons**

- Direct presentation requires the integration to configure its renderer/output transform.
- Fair resolver comparisons must apply the same presentation transform after each result.

#### three

TRAA and TAAU resolve into half-float render targets and return graph textures. The final `RenderPipeline` can apply tone mapping and output conversion later. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:139-172`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:153-216`
- `../node_modules/three/src/renderers/common/RenderPipeline.js:195-225`

**Pros**

- Better composability.
- Keeps the temporal result in the linear graph domain.
- Lets one final output transform serve the whole post stack.

**Cons**

- Direct presentation requires correct downstream output configuration.
- It does not include a local-equivalent RCAS stage.

#### Replacement implication

Linear half-float output is a clear three.js composability advantage. Local's fixed display output is simpler for direct presentation.

A future local linear/HDR output option would remove one of the largest replacement boundaries without requiring the direct-present mode to disappear.


### 5.7 Reset and resize behavior

#### Local

Local has an explicit public `resetHistory()` and a per-dispatch `reset` input. Reconfiguration reallocates textures and schedules reset. See `../src/Upscaler.ts:173-205`, `../src/Upscaler.ts:249-258`, and `../src/types.ts:157-160`.

**Pros**

- Camera cuts, teleports, cadence gaps, and app-level discontinuities can be explicit.

**Cons**

- The caller must use the reset contract correctly.

#### three

TRAA and TAAU recreate or resize targets and seed history after dimension changes. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:383-400`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:413-440`

No equivalent explicit public camera-cut reset is visible in the audited node APIs.

**Pros**

- Resize recovery is automatic.

**Cons**

- A camera cut at unchanged dimensions has no obvious public history-reset operation.

#### Replacement implication

Local is easier to integrate into applications with explicit scene cuts or discontinuous simulation.


### 5.8 Debug, tuning, and API surface

#### Local

The current API exposes:

- low-level `Upscaler`;
- high-level `UpscalePass`;
- composable `UpscalerNode` factories;
- runtime settings;
- eight diagnostic views;
- per-compute-pass timing where timestamp queries exist.

See `../src/types.ts:39-62`, `../src/Upscaler.ts:63-76`, and `../src/internal/GpuTimer.ts:1-24`.

**Pros**

- Strong integration diagnostics.
- Multiple ownership models.

**Cons**

- More API and more ways to combine incompatible ownership paths.
- Some tuning remains compile-time shader constants.
- Current jitter-default documentation conflicts with code.

#### three

TRAA/TAAU expose a smaller set of mutable thresholds and weights directly on node instances. TRAA also exposes subpixel correction. See:

- `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:88-120`
- `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:98-132`

**Pros**

- Compact API.
- Useful tuning values are directly mutable.

**Cons**

- No comparable built-in debug-view suite.
- No explicit reactive/exposure/reset API.


## 6. Replacement boundaries

### Correct comparison matrix

#### 1× input

Compare:

- local temporal with `QualityMode.NativeAA`;
- three `TRAANode`.

Both are same-resolution temporal AA. TAAU may technically operate near 1×, but it is not the primary product comparison for this case.

#### Reduced-resolution input

Compare:

- local temporal at 1.5×, 2×, and 3×;
- three `TAAUNode` at the same input and output dimensions.

The local preset ratios are defined in `../src/math/resolution.ts:3-13`.

### When local is a strong replacement

Local is a strong candidate when the application:

- is WebGPU-only;
- can provide three-compatible color, depth, and velocity;
- wants Native AA or temporal upscaling under one API;
- needs reactive-mask handling;
- benefits from thin-feature locks or shading-change aging;
- needs explicit reset;
- wants built-in RCAS and direct display output;
- needs reversed-depth or orthographic behavior beyond installed TAAU's visible branches;
- values debug views over graph simplicity.

### When TRAA/TAAU remain preferable

TRAA or TAAU may be preferable when the application:

- wants a native TSL graph texture in linear half-float space;
- needs later HDR effects or caller-owned output transformation;
- wants fewer persistent resources and a simpler resolver;
- wants three's renderer-state save/restore behavior;
- uses logarithmic depth and can choose TRAA at 1×;
- does not need reactive masks, explicit reset, local exposure conditioning, or RCAS;
- wants to avoid raw WebGPU/private-backend integration.

### What local should consider adopting

1. **Matrix-transformed previous depth.** Reconstruct previous view position, move it through world space, and compare in current view space.

2. **Motion-responsive current weighting.** Prototype a current-frame bias based on motion magnitude.

3. **TRAA subpixel-motion correction.** Test it as an internal experiment, including its documented square-pattern risk.

4. **Logarithmic-depth support if an actual integration requires it.**

5. **A linear/HDR output option.** Keep direct display output as an explicit integration mode.

6. **Renderer-state preservation in imperative helpers.** `UpscalePass.draw()` currently restores MRT and render target to `null`, not necessarily to the caller's previous state. See `../src/UpscalePass.ts:129-156`.

7. **Mutable internal benchmark thresholds.** Make depth, weighting, and correction parameters adjustable in bench variants before deciding whether any deserve public API.

### What local should not copy automatically

- The fixed effective 31-phase schedule.
- A simpler one-sample history path without visual evidence.
- The absence of reactive, exposure, and explicit-reset features.
- TAAU's installed lock persistence behavior before it is verified.
- Source constants merely because they are in three.js; they target a different resolver structure.


## 7. Performance comparison

Everything in this section is a **source-level structural estimate**, not a GPU measurement.

Texture-operation counts below count visible source sampling/loading expressions. They are not shader ISA counts. Hardware filtering, compiler common-subexpression elimination, cache behavior, format bandwidth, occupancy, and backend scheduling can change actual cost substantially.

### Local pass structure

The default temporal path encodes four compute passes:

1. exposure;
2. reconstruct;
3. accumulate;
4. RCAS, or blit when sharpening is disabled.

Generated reactivity adds a fifth pass. See `../src/Upscaler.ts:394-553`.

#### Exposure

The current exposure pass runs one 8×8 workgroup but only one invocation performs a serial 32×32 loop:

- 1,024 filtered scene-color samples;
- one previous-exposure load;
- one external-exposure load.

The 1,024 scene samples occur before the auto/manual/external selection, so they still run when fixed or external exposure is selected. See `../src/shaders/luminancePyramid.ts:42-94`.

This is a fixed per-frame cost, not a per-output-pixel count.

#### Reconstruct

Per render-resolution pixel, the visible source structure is approximately:

- nine current depth loads;
- one velocity load;
- up to four previous-depth loads for manual bilinear filtering.

That is about **14 source texture operations per render pixel**, except offscreen reprojections can return before previous-depth sampling. See `../src/shaders/reconstruct.ts:44-57` and `../src/shaders/reconstruct.ts:66-104`.

#### Accumulate

With default locks enabled and no reactive mask, the visible source structure is approximately:

- one motion load;
- one mask load;
- one exposure load;
- nine current-color loads;
- five filtered history samples;
- one lock-history sample.

That is about **17 source texture operations per output pixel**. An active reactive input adds one more, for about 18. See `../src/shaders/accumulate.ts:131-178`, `../src/shaders/accumulate.ts:191-201`, and `../src/shaders/accumulate.ts:221-250`.

#### RCAS or blit

RCAS visibly performs five input loads. Its helper also loads the same exposure texel per tap on the temporal path, giving ten source texture expressions. A compiler may hoist or merge the invariant exposure loads, so **five input plus one-to-five exposure operations** is the honest range. See `../src/shaders/rcas.ts:36-61`.

Blit has one filtered input sample and one exposure load on the temporal path. See `../src/shaders/blit.ts:30-45`.

#### Owned textures

The current temporal allocation owns **13 textures**, excluding caller inputs, scene render targets, sampler, UBO, and timing buffers:

- one output;
- two history;
- two locks;
- two dilated depth;
- one dilated motion;
- one mask;
- two exposure;
- one reactive dummy;
- one generated-reactive target.

This count follows `../src/Upscaler.ts:665-720`. Several are tiny or render-resolution resources; counting textures alone does not represent memory cost. The two display-resolution RGBA16F history textures and two display-resolution RGBA16F lock textures dominate this inventory.

### TAAU structure

TAAU performs one output-resolution fullscreen resolve, then:

- copies resolved output color into history;
- copies current input depth into previous-depth storage;
- performs an additional seed render only after resize.

See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:413-488`.

The visible resolve is approximately **22 source texture operations per output pixel**:

- nine current depth loads;
- one velocity load;
- one previous-depth sample;
- nine current beauty loads;
- one history sample;
- one lock-history sample.

See `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:537-579` and `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:629-755`.

That estimate does not resolve the lock-attachment concern described earlier.

### TRAA structure

At 1×, TRAA's visible resolve is approximately **21 source texture operations per output pixel**:

- nine current depth loads;
- one velocity load;
- one previous-depth sample;
- one current color sample;
- one history sample;
- eight additional current-neighborhood samples for variance.

It then copies output color and input depth into history resources. See `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:498-609` and `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:647-704`.

### Structural interpretation

Local is likely to have higher pass, state, and resource cost than installed TAAU/TRAA.

That does **not** prove it is slower:

- local reconstruct runs at render resolution;
- local compute passes may schedule differently from TSL fullscreen draws;
- TAAU/TRAA perform full texture copies;
- filterable samples and explicit loads have different costs;
- local and three currently produce different output domains and feature sets.

Local `GpuTimer` measures only the compute passes encoded by `Upscaler`. It does not include the scene render, final present, TAAU/TRAA resolve, or their history/depth copies. See `../src/internal/GpuTimer.ts:45-98`.

Therefore, a local `gpuTimings` total is **not comparable** with an untimed three resolver.

### Compute ping-pong versus render/copy

#### Local compute ping-pong

**Pros**

- Explicit pass boundaries and timestamp scopes.
- Direct storage writes into history/output resources.
- Flexible formats and debug-output routing.
- No full output-to-history color copy after accumulation; accumulation writes the next history directly.

**Cons**

- More bind groups, dispatches, barriers, and owned intermediate textures.
- Depends on raw WebGPU access through three internals.
- Fixed storage output format constrains composability.

#### three render/copy path

**Pros**

- Fits TSL and renderer resource management.
- Produces linear half-float graph textures.
- Simpler visible pass graph.
- Uses renderer state save/restore.

**Cons**

- Fullscreen resolve plus full texture copies.
- Copy cost is easy to omit accidentally from profiling.
- Scalar pipeline hooks and global velocity state complicate nesting.

### Fair-comparison requirement

Output transforms must be normalized:

- same linear/HDR input;
- same exposure;
- same tone map;
- same output transfer function;
- same sharpening policy;
- same target format where practical.

Without that normalization, both visual quality and performance results mix resolver behavior with output processing.


## 8. Other screen-space nodes and temporal ownership

Projection jitter and effect noise should not be conflated.

### SSGI

`SSGINode.useTemporalFiltering` changes ray direction and initial offsets from `frame.frameId`. It does not own camera jitter and does not store or reproject its own image history. See `../node_modules/three/examples/jsm/tsl/display/SSGINode.js:181-193` and `../node_modules/three/examples/jsm/tsl/display/SSGINode.js:352-382`.

Its shader combines:

- interleaved gradient noise;
- a hash-like `rand`;
- six temporal rotations;
- four spatial offsets.

See `../node_modules/three/examples/jsm/tsl/display/SSGINode.js:7-9` and `../node_modules/three/examples/jsm/tsl/display/SSGINode.js:576-610`.

The installed documentation says temporal filtering expects TRAA, but the local resolver can be the one final temporal resolver if the SSGI signal is composited into its input.

### GTAO

GTAO optionally rotates its sampling directions by frame ID. It does not move the camera or maintain image history. See `../node_modules/three/examples/jsm/tsl/display/GTAONode.js:157-169` and `../node_modules/three/examples/jsm/tsl/display/GTAONode.js:265-288`.

Its spatial pattern comes from a generated magic-square texture, not conventional blue noise. See `../node_modules/three/examples/jsm/tsl/display/GTAONode.js:171-177` and `../node_modules/three/examples/jsm/tsl/display/GTAONode.js:487-521`.

### SSR

Installed SSR defaults `stochastic` to `false`. See `../node_modules/three/examples/jsm/tsl/display/SSRNode.js:15-25` and `../node_modules/three/examples/jsm/tsl/display/SSRNode.js:52-76`.

The repository's examples 06 and 09 do not enable stochastic SSR. See:

- `../examples/06-screenspace-gi/main.ts:165-173`
- `../examples/09-kitchen-sink/main.ts:140-147`

When stochastic mode is enabled, SSR advances an independent noise index and uses analytic R² noise. See `../node_modules/three/examples/jsm/tsl/display/SSRNode.js:737-760` and `../node_modules/three/examples/jsm/tsl/display/SSRNode.js:863-892`.

SSR has optional multibounce history through `setHistory()`, but the audited examples do not wire it. See `../node_modules/three/examples/jsm/tsl/display/SSRNode.js:661-678`.

### DenoiseNode

`DenoiseNode` is spatial. It uses a 16-sample rotating kernel and a generated simplex-noise texture, but it owns no temporal image history and does not projection-jitter the camera. See `../node_modules/three/examples/jsm/tsl/display/DenoiseNode.js:118-132`, `../node_modules/three/examples/jsm/tsl/display/DenoiseNode.js:184-239`, and `../node_modules/three/examples/jsm/tsl/display/DenoiseNode.js:284-319`.

### RecurrentDenoiseNode and TemporalReprojectNode

`RecurrentDenoiseNode` can temporally accumulate a reprojected input and uses analytic R² noise to rotate its spatial kernel. See `../node_modules/three/examples/jsm/tsl/display/RecurrentDenoiseNode.js:321-386` and `../node_modules/three/examples/jsm/tsl/display/RecurrentDenoiseNode.js:466-518`.

`TemporalReprojectNode` owns history or accepts external history. It explicitly states that it does not apply camera subpixel jitter; it reprojects with motion and camera matrices. See `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js:489-518` and `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js:535-609`.

Neither node moves the camera projection. Their temporal state can still overlap with the final resolver's history, and `TemporalReprojectNode` still participates in velocity-hook ownership.

It still installs render-pipeline hooks to bind and later clear the shared velocity projection. That ownership collision is discussed next.

### Noise taxonomy

No conventional blue-noise texture is used by these audited paths.

The distinct mechanisms are:

- **IGN/hash:** SSGI interleaved gradient noise and `rand`.
- **Magic square:** GTAO's tiled direction texture.
- **Simplex:** `DenoiseNode`'s generated noise texture.
- **Analytic R²:** SSR stochastic sampling and recurrent-denoise rotation through `RNoise`.

See `../node_modules/three/examples/jsm/tsl/utils/RNoise.js:3-49`.

Sharing temporal identity can coordinate when these patterns advance. It does not imply replacing all of them with the upscaler's Halton samples.


## 9. Hook and velocity collision

### Scalar render-pipeline hooks

`RenderPipeline` stores one `onBeforeRenderPipeline` callback and one `onAfterRenderPipeline` callback. They are scalar properties, not callback lists. See `../node_modules/three/src/renderers/common/RenderPipeline.js:195-204`.

The pipeline calls each scalar once around its graph render. See `../node_modules/three/src/renderers/common/RenderPipeline.js:121-150`.

These nodes assign those scalar properties directly:

- local `UpscalerNode`: `../src/UpscalerNode.ts:206-217`;
- TRAA: `../node_modules/three/examples/jsm/tsl/display/TRAANode.js:443-464`;
- TAAU: `../node_modules/three/examples/jsm/tsl/display/TAAUNode.js:502-527`;
- `TemporalReprojectNode`: `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js:728-748`.

If more than one is nested in a graph, setup order can overwrite an earlier callback.

### Global mutable velocity

three exports one shared singleton named `velocity`, created through `nodeImmutable()`. The wrapper is shared, while its internal `projectionMatrix` remains mutable through `setProjectionMatrix()`. See `../node_modules/three/src/nodes/accessors/VelocityNode.js:24-98` and `../node_modules/three/src/nodes/accessors/VelocityNode.js:218-224`.

When both lifecycles are coordinated, the required frame ordering is:

1. capture the stable, unjittered camera projection;
2. bind that projection for velocity generation;
3. apply projection jitter to the scene camera;
4. render all velocity/color/depth inputs;
5. clear camera jitter;
6. release or restore velocity ownership only after all dependent passes are done.

Another node must not replace or clear the stable velocity projection between steps 2 and 4.

### Example 10 risk

Example 10 can nest `TemporalReprojectNode` inside the local `UpscalerNode` graph. See `../examples/10-ssgi-denoise/main.ts:161-192` and `../examples/10-ssgi-denoise/main.ts:213-221`.

Both nodes assign the same scalar hooks. `UpscalerNode` uses them for camera-jitter begin/end, while `TemporalReprojectNode` uses them to bind and clear the shared velocity projection.

Setup order deterministically leaves only the last callback pair installed. Depending on build order, either the local camera-jitter lifecycle or `TemporalReprojectNode`'s velocity-projection lifecycle may not run as intended. `TemporalReprojectNode` also has a one-time `updateBefore()` fallback, so the first frame may differ from steady state.

The exact runtime consequence is an **unverified, source-derived integration risk**, not a confirmed failure from this audit. The example's documented GPU-observed quality conflict concerns stacked temporal accumulation under FSR jitter; it does not prove this hook collision itself occurred. See `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js:630-659`, `../node_modules/three/examples/jsm/tsl/display/TemporalReprojectNode.js:728-748`, and `../examples/10-ssgi-denoise/main.ts:32-52`.


## 10. Shared temporal sampling options

### A. Application/render-pipeline-owned `TemporalSamplingContext`

The application or render pipeline owns frame identity, projection jitter, reset generation, and ordered begin/end behavior. Resolvers and effects consume the context.

**Pros**

- Avoids direct SSGI/SSR dependency on one upscaler.
- Supports local FSR, TRAA, TAAU, or a future resolver as alternatives.
- Creates one authoritative projection-jitter owner.
- Coordinates reset and rendered cadence across effects.
- Provides a natural place to compose hooks.

**Cons**

- Requires integration work above individual nodes.
- Needs careful behavior when a pass renders less often than the display loop.
- Public API should wait until the bench proves the contract.

**Recommendation:** preferred direction to prototype before considering a public API.

### B. Upscaler-owned provider

The local upscaler publishes jitter and frame state for SSGI/SSR/denoisers.

**Pros**

- Smaller immediate change.
- Reuses data the upscaler already computes.

**Cons**

- Couples unrelated effects to one resolver.
- Makes TRAA/TAAU substitution harder.
- Encourages the upscaler to own application scheduling.
- Risks turning implementation details into public API too early.

**Recommendation:** not preferred.

### C. Independent noise, one projection-jitter owner

Keep SSGI/GTAO/SSR/denoiser noise schedules independent. Ensure only the final resolver moves the camera.

**Pros**

- Minimal change.
- Preserves each shader's optimized distribution.
- Avoids double projection jitter.

**Cons**

- Reset and frame cadence can drift.
- Debugging cross-pass temporal behavior remains harder.
- Effects may advance noise on frames where their output was not rendered.

**Recommendation:** acceptable short-term state.

### Conceptual context fields

A future context should be able to provide:

- `frameId` and `sampleIndex`;
- current and previous jitter;
- stable unjittered projection;
- current and previous jittered projections;
- render and display dimensions;
- history/reset generation token;
- whether jitter was actually applied for this render;
- `beginFrame()` and `endFrame()` lifecycle boundaries.

The context should synchronize **identity, reset, and cadence**. It should not require every shader to derive its samples from one distribution.


## 11. Integration design

This is a recommendation, not current API.

### 11.1 External-jitter mode for `Upscaler`

Add an external mode in which:

- the coordinator passes exact current and previous offsets to dispatch;
- offsets are explicitly defined in render-pixel units and top-left convention;
- the upscaler does not internally advance `JitterSequence`;
- `beginFrame()` does not independently move the camera;
- a reset-generation token invalidates history exactly once.

The internal schedule remains the default for existing imperative users.

### 11.2 Ordered hook coordinator

Replace scalar callback assignment with ordered participants:

1. capture stable camera state;
2. prepare velocity providers;
3. apply projection jitter;
4. render graph dependencies;
5. clear projection jitter;
6. finalize temporal state.

The coordinator can adapt to three's scalar hook by installing one callback that runs an ordered list.

### 11.3 Dedicated velocity projection provider

Do not rely only on the exported global `velocity` singleton.

Provide an explicit velocity projection/provider per render pipeline or camera so nested temporal effects cannot clear one another's state accidentally.

### 11.4 Optional identity for noisy effects

SSGI, GTAO, SSR, and denoisers may receive:

- sample/frame identity;
- reset generation;
- whether this effect actually rendered this frame.

They should retain their own IGN, magic-square, simplex, R², or domain-specific distributions.

### 11.5 TemporalReproject integration

Allow `TemporalReprojectNode` to consume a stable projection provider and disable its own before/after hook ownership.

It can still own effect history without becoming a projection-jitter owner.

### 11.6 TRAA/TAAU diagnostics

TRAA/TAAU may optionally consume externally supplied jitter in bench-only diagnostic variants.

They remain **alternative final resolvers**. They must never run upstream of local FSR in a product comparison.

### 11.7 What must synchronize

Synchronize:

- frame identity;
- reset generation;
- rendered cadence;
- current/previous projection state;
- exactly one camera-jitter application.

Do not automatically synchronize every noise distribution.


## 12. Benchmark plan

Use `bench` as the canonical timing harness. It already controls render/display resolution, shares one display transform across its current modes, and surfaces local timestamp results. See `./src/BenchPipeline.ts:75-161` and `./src/main.ts:86-120`.

Use examples as visual fixtures:

- `../examples/04-aliasing-torture`: thin geometry, moiré, slow camera motion.
- `../examples/05-transparency`: transparents, particles, reactive-mask behavior.
- `../examples/06-screenspace-gi`: reduced-resolution GTAO/SSR/SSGI feeding the raw upscaler.
- `../examples/09-kitchen-sink`: in-graph SSGI/SSR composition and local node jitter.
- `../examples/10-ssgi-denoise`: stacked effect-history experiments and hook-collision characterization.

### 12.1 Two comparison classes

#### Stock-product comparison

Preserve:

- each resolver's stock jitter schedule;
- stock reconstruction and history filtering;
- stock public defaults;
- one resolver per run.

Normalize only the surrounding application conditions needed for a fair output.

#### Normalized diagnostic comparison

Allow controlled substitutions such as:

- identical injected jitter sequence;
- identical current-frame input;
- identical output transform;
- sharpening disabled on both, or equivalent sharpening added to both;
- internal parameter sweeps.

Label these results as diagnostics, not stock product behavior.

### 12.2 Modes

At 1×:

- local Native AA;
- three TRAA.

At reduced resolution:

- local temporal at 1.5×;
- local temporal at 2×;
- local temporal at 3×;
- three TAAU at the same three ratios.

Do not put TRAA in the reduced-resolution result set as if it were an upscaler.

### 12.3 Deterministic setup

For each capture:

- fixed canvas physical dimensions and DPR;
- fixed camera path and animation time;
- fixed scene random seeds;
- fixed effect settings;
- fixed renderer features;
- MSAA off;
- one final temporal resolver;
- clean history at the start of each block;
- fixed warm-up frame count;
- fixed measured frame count;
- no UI interaction during the sample window.

Record:

- browser and version;
- OS;
- adapter name;
- WebGPU backend;
- three version;
- commit SHA;
- display and render dimensions;
- timestamp-query availability;
- power/thermal state where practical.

Local can use its explicit reset API. TRAA/TAAU do not expose an equivalent public camera-cut reset, so recreate their node/graph for each capture block or document a deliberately forced resize/reseed procedure.

### 12.4 Output normalization

For visual comparison:

- feed the same linear HDR scene;
- use the same tone map and sRGB conversion;
- compare the same output format where possible;
- disable local RCAS or add a matched sharpen after TAAU;
- keep exposure behavior equivalent;
- capture before browser scaling.

Keep a separate product-default gallery showing local RCAS/direct output versus three's normal graph output. Do not mix that gallery with resolver-isolation conclusions.

### 12.5 Timing

Measure at least:

- scene/G-buffer render;
- resolver work;
- history/depth copies;
- output transform;
- sharpening;
- final present where relevant;
- whole-frame GPU time.

Local `GpuTimer` alone is insufficient because it covers only local compute passes. Instrument three's resolve and copies with compatible GPU timestamps, or use a GPU trace that includes both implementations.

If per-copy timestamping is unavailable, use labeled command scopes or frame captures and report the limitation explicitly.

### 12.6 Sampling method

- Warm all pipelines and histories before measured sequences.
- Use repeated A/B/B/A or **ABBA** ordering to reduce thermal and drift bias.
- Report median and p95, not only average.
- Keep raw frame samples.
- Repeat enough blocks to show run-to-run spread.
- Treat CPU FPS as supporting information, not a substitute for GPU timing.

### 12.7 Scene scenarios

Include:

- static camera and static scene for convergence;
- slow camera pan;
- fast camera translation;
- rotating camera;
- independently moving foreground object;
- newly revealed background/disocclusion;
- thin fences and wires;
- high-frequency floor or foliage;
- bright HDR highlights;
- transparent/additive particles;
- noisy SSGI;
- glossy stochastic SSR if enabled;
- camera cut and explicit reset;
- resize and history seed.

### 12.8 Acceptance criteria

A benchmark configuration is valid only when:

- exactly one projection-jitter owner is active;
- velocity is generated from the stable projection;
- color, depth, velocity, and reactive inputs are aligned;
- history is clean at test start, using explicit local reset or three node/graph recreation;
- output transforms are documented and matched;
- no WebGPU validation errors occur;
- TAAU lock persistence has been independently characterized;
- hook assignment and clearing order are logged or inspected;
- timings include equivalent work or clearly identify exclusions.

Quality review should record:

- static convergence;
- edge shimmer;
- detail retention;
- motion blur;
- ghost trails;
- disocclusion recovery;
- thin-feature stability;
- transparency behavior;
- SSGI/SSR noise convergence;
- camera-cut recovery.

No winner should be declared from source operation counts alone.


## 13. Recommended next actions

### 1. Fix or document integration inconsistencies before benchmarking

- Correct the `../src/types.ts:91-111` jitter-default text to match current `UpscalerNode` behavior, or intentionally change the behavior and document that decision.
- Verify installed TAAU lock persistence on GPU.
- Characterize scalar hook overwrite and velocity clearing in example 10.

### 2. Add a bench-only TRAA/TAAU comparator

- Instantiate one final resolver at a time.
- Use identical scene inputs and output transform.
- Keep TRAA at 1× and TAAU at reduced resolution.
- Preserve stock schedules for the product test.

### 3. Harden timing and capture

- Time three resolve and copy work, not only local compute.
- Add deterministic camera/animation scripts.
- Record environment metadata.
- Store raw median/p95 samples and screenshots.

### 4. Prototype selected local algorithm variants

Behind internal or bench-only flags:

- matrix-transformed previous depth;
- motion-responsive current weighting;
- TRAA-style subpixel correction.

Do not expose public tuning until the variants have visual and performance evidence.

### 5. Prototype `TemporalSamplingContext` internally

Build it in bench/internal scope with:

- one projection-jitter owner;
- ordered hook composition;
- explicit stable velocity state;
- frame/reset generation;
- rendered cadence.

Avoid committing to public API shape yet.

### 6. Feed optional temporal identity to one noisy node

Start with SSGI:

- share frame/sample identity and reset generation;
- preserve SSGI's own ray distribution;
- verify that skipped renders do not advance its pattern incorrectly.

### 7. Decide public API after evidence

Only then decide whether to expose:

- external jitter;
- linear/HDR output;
- a temporal context;
- velocity providers;
- benchmark-proven tuning controls.

### Direct answer: is shared jitter the right move?

**Yes** to exactly one projection-jitter owner.

**No** to forcing SSGI, SSR, GTAO, or denoiser noise to derive from the FSR Halton sequence.

Shared frame/reset identity is a reasonable prototype for coordinating rendered cadence and history invalidation, but its benefit still needs to be demonstrated. Each shader should keep the sampling distribution suited to its own problem.
