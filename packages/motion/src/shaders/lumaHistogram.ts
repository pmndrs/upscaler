/**
 * Conditioned-luma histogram (EXPERIMENTAL, motion lab) — the input to cut
 * detection. FidelityFX Optical Flow's scene-change detector compares luma
 * histograms across frames; this is the cheapest form of that signal: 64 bins
 * of `l / (1 + l)`, reduced per workgroup, added atomically into one slot of
 * `HISTOGRAM_BINS` u32. The comparison itself runs on the CPU in the lab.
 */
export const HISTOGRAM_BINS = 64;

export const LUMA_HISTOGRAM_SHADER = /* wgsl */ `
struct HistogramConstants {
    size : vec2f,
    slot : u32,
    pad : u32,
};

const BINS : u32 = ${HISTOGRAM_BINS}u;

@group(0) @binding(0) var<uniform> H : HistogramConstants;
@group(0) @binding(1) var color : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histogram : array<atomic<u32>>;

var<workgroup> local : array<atomic<u32>, BINS>;

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_index) lid : u32,
) {
    atomicStore(&local[lid], 0u);
    workgroupBarrier();
    if (all(vec2f(gid.xy) < H.size)) {
        let c = max(textureLoad(color, vec2i(gid.xy), 0).rgb, vec3f(0.0));
        let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
        let bin = min(u32((l / (1.0 + l)) * f32(BINS)), BINS - 1u);
        atomicAdd(&local[bin], 1u);
    }
    workgroupBarrier();
    let value = atomicLoad(&local[lid]);
    if (value != 0u) { atomicAdd(&histogram[H.slot * BINS + lid], value); }
}
`;
