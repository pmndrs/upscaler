# Denoising direction

## Status

This document captures the current denoising discussion and a possible direction
for future experiments. It is an outline, not an approved implementation plan.

The immediate recommendation is:

- keep the upscaler as the only final-image temporal resolver;
- keep noisy SSGI and SSR signals separate long enough to denoise them with
  effect-specific information;
- make any effect-level temporal reprojection aware of the exact projection
  jitter used by the upscaler;
- apply spatial denoising primarily where temporal history is weak;
- consider a learned filter only after a conventional implementation provides a
  measured baseline.


## The terms that are easy to conflate

### Projection jitter

Projection jitter moves the camera projection by a fraction of a pixel. It lets
the final temporal resolver collect different subpixel samples over multiple
frames.

Exactly one component should own projection jitter for a render. In this
repository, that should normally be the upscaler.

### Effect sampling noise

SSGI, GTAO, stochastic SSR, and denoisers can rotate or shift their own sampling
patterns each frame. This changes ray or filter-tap locations without moving the
camera.

These patterns do not need to use the upscaler's Halton sequence. They only need
predictable frame identity, reset behavior, and rendered cadence.

### Spatial denoising

A spatial denoiser combines neighboring pixels from the current frame. Depth,
normals, roughness, albedo, and ray metadata can prevent filtering across
unrelated surfaces.

Spatial denoising helps immediately, including on the first frame, but excessive
filtering blurs detail and can create halos.

### Temporal denoising

A temporal denoiser reprojects an effect's previous result into the current
frame and accumulates it over time.

It needs motion, depth, history rejection, and reset handling. In a jittered
pipeline it must also account for the current and previous projection offsets.

### Final temporal AA/upscaling

TRAA, TAAU, and this library's temporal path accumulate the final image. They
reduce aliasing and can average moderate effect noise, but they do not have the
effect-specific inputs needed to be ideal GI or reflection denoisers.


## What the repository currently uses

### Examples 06 and 09

`examples/06-screenspace-gi` and `examples/09-kitchen-sink` use three's ordinary
`DenoiseNode` for SSGI and SSR.

That node is spatial-only:

- it filters the current frame;
- it uses depth and normals for edge stopping;
- it does not reproject history;
- it does not consume velocity;
- it does not jitter the camera.

The resulting signal is composited into scene color and then accumulated by the
upscaler.

### Example 10

`examples/10-ssgi-denoise` is explicitly experimental and compares three SSGI
paths:

#### `builtin`

Raw, temporally varying SSGI is composited into scene color. The upscaler owns
all temporal accumulation.

This is the default path.

#### `spatial`

`RecurrentDenoiseNode` is used with:

`accumulate: false`

There is no `TemporalReprojectNode`, so the class runs as a spatial denoiser
despite its name. The upscaler remains the only temporal stage.

#### `recurrent`

The full chain is:

```text
Raw SSGI
  -> TemporalReprojectNode
  -> RecurrentDenoiseNode { accumulate: true }
  -> denoised output fed back as effect history
  -> scene composite
  -> temporal upscaler
```

This is genuinely temporal.

The experiment produced the worst result under the upscaler's projection
jitter. Its velocity-only reprojection did not account for the changing
subpixel projection offset, so effect history could be misaligned before the
final temporal resolve.

The experiment also exposes a separate integration risk: `UpscalerNode` and
`TemporalReprojectNode` assign the same scalar render-pipeline hooks and touch
shared velocity state.

The current result does not prove that effect-level temporal denoising is
inherently incompatible with temporal upscaling. It shows that a second resolver
must share the projection-jitter and lifecycle contract.


## How SSGI temporal filtering relates to the upscaler

`SSGINode.useTemporalFiltering` does not maintain SSGI history. It changes the
SSGI ray pattern over time so a downstream temporal resolver can average the
samples.

The flow is:

```text
Jittered scene render
  -> SSGI produces a different noisy estimate
  -> SSGI is composited into scene color
  -> final temporal resolver reprojects previous scene color
  -> noisy GI contribution is averaged with the rest of the pixel
```

SSGI's sample generation does not require velocity. The downstream temporal
resolver uses velocity to align the composited result.

This can reduce the amount of spatial filtering required, but it does not
guarantee that spatial denoising becomes unnecessary. Newly revealed areas,
moving surfaces, rejected history, and the first frame still have little or no
usable temporal history.


## What `RecurrentDenoiseNode` contributes

The current three.js implementation contains useful effect-specific ideas:

- separate diffuse and specular modes;
- depth-, normal-, roughness-, and albedo-aware edge stopping;
- SSR ray-length handling;
- spatial radius based on history confidence;
- stronger filtering for young or unreliable history;
- firefly suppression;
- disocclusion smoothing;
- temporally varying analytic R² kernel rotation;
- optional temporal blending.

Its changing R² kernel is effect sampling noise, not camera projection jitter.

For temporal operation, the node relies on a reprojected input and feedback
history. The important transferable idea is not to insert this node unchanged,
but to coordinate effect history with the same jitter, motion, reset, and frame
identity used by the upscaler.


## What n8AO's neural denoiser does

Source:

- [NeuralDenoise.js](https://github.com/N8python/n8ao/blob/master/src/NeuralDenoise.js)
- [PoissionBlur.js](https://github.com/N8python/n8ao/blob/master/src/PoissionBlur.js)

n8AO's neural stage is not a temporal neural denoiser. It is a compact learned
spatial correction inside the second Poisson blur iteration.

At a high level it:

1. gathers 4, 8, or 16 neighboring AO samples;
2. encodes local position, normal, occlusion, and distance features;
3. runs a small int8 attention model;
4. predicts a scalar residual;
5. adds that residual to the conventionally filtered AO result.

The model does not use:

- motion vectors;
- previous-frame textures;
- camera projection jitter;
- temporal reprojection.

n8AO has a separate accumulation path, but it accumulates only while camera
matrices remain unchanged. Camera movement resets that history instead of
reprojecting it.

The bundled neural weights are specific to n8AO's AO estimator, feature layout,
sample counts, and training distribution. Reusing those weights for SSGI, SSR,
or final scene color would not be valid.

The implementation also does not receive special neural hardware acceleration.
Its int8 weights are emitted into a generated GLSL program and evaluated as
ordinary shader math. Actual cost depends on shader compilation, register
pressure, generated instruction count, and GPU scheduling.


## Where denoising could improve this project

### Final scene color

A general denoiser over final scene color is not the recommended first step.

After SSGI or SSR has been composited into RGB, the upscaler cannot reliably
distinguish stochastic noise from:

- texture detail;
- foliage;
- thin geometry;
- specular highlights;
- particles;
- intentional film grain.

A generic filter would risk blur, haloing, and lost material detail across every
application, even when no noisy effect is present.

### Separate noisy effect signals

Effect-specific denoising has a clearer potential gain.

Keeping SSGI or SSR separate allows the resolver to use information that final
RGB no longer contains:

- normal;
- depth;
- roughness and metalness;
- albedo;
- AO value;
- reflection ray length;
- effect-specific variance;
- effect history age.

That can improve quality or permit fewer expensive SSGI/SSR samples.

### Low-confidence pixels

The most promising spatial-denoise policy is to spend filtering work where
temporal history is weak:

- newly disoccluded pixels;
- rejected history;
- low accumulation age;
- high local variance;
- reactive or rapidly changing pixels;
- pixels whose history was heavily clipped.

Stable pixels with strong history should need less spatial filtering and a
smaller radius.


## Recommended experimental architecture

The preferred experimental flow is:

```text
Raw SSGI or SSR
  -> jitter-aware effect reprojection
  -> effect-specific temporal history and rejection
  -> confidence-driven spatial denoise
  -> composite with scene color
  -> final temporal AA/upscale
```

This keeps effect denoising and final image reconstruction as separate concerns
while placing both on the same temporal timeline.

### Required effect inputs

Common:

- raw effect color or scalar;
- depth;
- normal;
- velocity;
- current and previous projection jitter;
- reset generation;
- render dimensions;
- frame/sample identity.

For SSGI:

- albedo or diffuse color;
- optional direct/indirect separation;
- effect variance or confidence.

For SSR:

- roughness;
- metalness;
- hit distance or ray length;
- optional environment-hit classification.

### Required temporal state

Each independently denoised effect would need:

- effect history;
- history age or confidence;
- previous depth;
- current and previous camera transforms;
- current and previous projection offsets.

The effect resolver must use the same motion convention and reset cadence as the
final upscaler.

### Spatial fallback

Start with a small conventional kernel:

- 5 to 8 taps;
- depth/plane-distance rejection;
- normal rejection;
- effect-specific material rejection;
- radius controlled by history confidence;
- stronger firefly suppression for young history;
- no filtering across disocclusions.

This establishes a readable and tunable baseline before considering a learned
filter.


## Integration options

### Option A: separate jitter-aware effect resolver

Build a small reusable effect-history stage that consumes the application's
shared temporal context.

**Advantages**

- Clear separation from final AA/upscaling.
- Can use effect-specific inputs.
- Easier to compare or disable.
- Matches how dedicated GI/reflection denoisers are commonly structured.

**Risks**

- Additional history textures and passes.
- Requires careful scheduling.
- Can still create double-history lag if both stages are overly conservative.

### Option B: fuse effect history into the upscaler

Add dedicated SSGI or SSR inputs and resolve their histories inside the
upscaler's temporal pipeline.

**Advantages**

- One jitter and motion implementation.
- One reset lifecycle.
- Can share disocclusion and confidence signals.

**Risks**

- Couples the general upscaler to specific rendering effects.
- Adds inputs, textures, passes, and tuning to the core path.
- Makes the API harder to use for applications without those effects.
- Diffuse GI and specular reflection need materially different filtering.

This should be treated as a focused research path, not a default extension.

### Option C: final-color denoising

Filter the accumulated or reconstructed final scene color.

**Advantages**

- Simple integration.
- No additional effect buffers.

**Risks**

- Cannot distinguish noise from detail.
- Applies cost and blur to applications that do not need denoising.
- Lacks normal, roughness, ray, and effect-confidence information.

This is not recommended as the initial direction.


## Neural filtering considerations

A neural filter becomes interesting if a conventional filter cannot provide the
desired quality at an acceptable tap count.

Before pursuing it, the project would need:

- a narrowly defined signal, such as diffuse GI or AO;
- representative training scenes and camera motion;
- noisy input and high-sample reference pairs;
- HDR-aware feature normalization;
- jitter-aware temporal examples;
- disocclusion and transparency coverage;
- separate training or features for diffuse and specular signals;
- a WebGPU implementation with measured shader size and register pressure.

Potential benefits:

- better edge preservation at a fixed tap count;
- learned rejection of recurring noise patterns;
- fewer SSGI/SSR rays for similar output quality.

Potential costs:

- model-training and dataset maintenance;
- content-dependent failure modes;
- difficult debugging;
- shader compilation and register pressure;
- no guarantee of being cheaper than a small hand-written kernel;
- new provenance, packaging, and model-version responsibilities.

The n8AO implementation is evidence that a compact shader-resident model is
possible. It is not evidence that its model or architecture will generalize to
this upscaler.


## Benchmark outline

Compare one change at a time.

### Baselines

1. Raw SSGI/SSR into the temporal upscaler.
2. Existing spatial `DenoiseNode` into the temporal upscaler.
3. `RecurrentDenoiseNode` with `accumulate: false`.
4. Current full recurrent experiment.

### Proposed variants

5. Jitter-aware temporal effect reprojection without spatial filtering.
6. Jitter-aware reprojection plus confidence-driven spatial filtering.
7. Reduced effect sample count plus the proposed denoiser.
8. Learned spatial correction only after the conventional path is understood.

### Required scenes

- static convergence;
- slow camera movement;
- fast translation;
- rotating camera;
- independently moving objects;
- disocclusion;
- thin geometry;
- glossy and rough reflections;
- diffuse GI around depth and normal edges;
- bright fireflies;
- camera cuts and reset;
- transparency where relevant.

### Measurements

- effect pass GPU time;
- denoiser GPU time;
- final temporal-upscale GPU time;
- combined frame GPU cost;
- temporal variance after convergence;
- disocclusion recovery time;
- visible trail length;
- retained edge/detail contrast;
- required SSGI/SSR sample count;
- memory footprint;
- compile and first-frame cost.

Quality comparisons should use deterministic camera paths, fixed random seeds,
matched effect settings, clean history, and identical output transforms.


## Suggested next steps

1. Preserve example 10 as the documented baseline for the current recurrent
   conflict.

2. Make a bench-only effect reprojection experiment that consumes exact current
   and previous projection jitter.

3. Verify reprojection in isolation before adding temporal blending or spatial
   denoising.

4. Add effect-specific history age, rejection, and reset behavior.

5. Add a small confidence-driven spatial kernel.

6. Compare raw, spatial-only, recurrent, and jitter-aware variants at equal
   SSGI/SSR sample counts.

7. Reduce effect samples and determine whether denoising produces a net GPU
   saving rather than only an image-quality improvement.

8. Decide between a separate reusable effect resolver and a fused experimental
   path.

9. Investigate a learned filter only if the conventional kernel is a measured
   quality or performance bottleneck.


## Current recommendation

There is a plausible quality and performance gain in actual denoising, especially
if it permits lower SSGI or stochastic SSR sample counts.

The highest-value target is not a general denoiser over the upscaler's final
color. It is a jitter-aware, effect-specific temporal resolver with spatial
filtering concentrated on low-confidence pixels.

The RecurrentDenoise implementation provides useful filtering ideas. The n8AO
model provides a useful example of compact learned spatial correction. Neither
should be inserted into the current temporal path unchanged.
