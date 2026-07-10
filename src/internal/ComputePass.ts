/**
 * Small wrapper around a WGSL compute pipeline with a single bind group.
 *
 * All FSR passes share the shape: one shader module, one auto-derived bind
 * group layout, 8×8 workgroups over a 2D grid. Bind groups are (re)built by
 * the upscaler whenever textures resize or ping-pong, so `dispatch` takes
 * the group per call instead of caching it here.
 */
export class ComputePass {
    static readonly WORKGROUP_SIZE = 8;

    readonly label: string;
    readonly pipeline: GPUComputePipeline;

    private readonly _device: GPUDevice;

    constructor(device: GPUDevice, label: string, code: string) {
        this._device = device;
        this.label = label;
        const module = device.createShaderModule({ label: `upscale-${label}`, code });
        // 'auto' layout keeps the TS side free of duplicated binding tables —
        // the WGSL source is the single source of truth for bindings.
        this.pipeline = device.createComputePipeline({
            label: `upscale-${label}`,
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
    }

    /**
     * Creates a bind group for this pass's group 0.
     * @param entries - Resources in binding order (buffer/view/sampler)
     * @returns The bind group, valid until any bound resource is destroyed
     */
    createBindGroup(entries: Array<GPUBindingResource>): GPUBindGroup {
        return this._device.createBindGroup({
            label: `upscale-${this.label}`,
            layout: this.pipeline.getBindGroupLayout(0),
            entries: entries.map((resource, binding) => ({ binding, resource })),
        });
    }

    /**
     * Encodes this pass covering `width`×`height` invocations.
     * @param encoder - Active compute pass encoder
     * @param bindGroup - Bind group created via {@link createBindGroup}
     * @param width - Grid width in pixels
     * @param height - Grid height in pixels
     */
    dispatch(
        encoder: GPUComputePassEncoder,
        bindGroup: GPUBindGroup,
        width: number,
        height: number,
    ): void {
        const wg = ComputePass.WORKGROUP_SIZE;
        encoder.setPipeline(this.pipeline);
        encoder.setBindGroup(0, bindGroup);
        encoder.dispatchWorkgroups(Math.ceil(width / wg), Math.ceil(height / wg));
    }
}
