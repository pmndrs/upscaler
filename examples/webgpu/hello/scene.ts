import { compose, type Mat4 } from './mat4';

/**
 * A tiny raw-WebGPU scene that writes exactly what the upscaler core wants:
 * linear HDR color, depth, and jitter-free motion vectors (NDC delta, current
 * − previous). Geometry is generated in the vertex shader (36-vertex cubes;
 * the floor is a flattened one), so there are no vertex buffers.
 */

const SCENE_WGSL = /* wgsl */ `
struct Frame {
    viewProj : mat4x4f,      // unjittered, this frame
    prevViewProj : mat4x4f,  // unjittered, last frame
    jitterClip : vec4f,      // xy: clip-space projection offset (× w)
    lightDir : vec4f,
}
struct Instance {
    model : mat4x4f,
    prevModel : mat4x4f,
    albedo : vec4f,          // rgb, a = pattern (0 floor grid, 1 cube checker)
}
@group(0) @binding(0) var<uniform> F : Frame;
@group(0) @binding(1) var<storage, read> I : array<Instance>;

struct VsOut {
    @builtin(position) position : vec4f,
    @location(0) curClip : vec4f,
    @location(1) prevClip : vec4f,
    @location(2) world : vec3f,
    @location(3) normal : vec3f,
    @location(4) faceUV : vec2f,
    @location(5) @interpolate(flat) instance : u32,
}

const NORMALS = array<vec3f, 6>(
    vec3f(1, 0, 0), vec3f(-1, 0, 0), vec3f(0, 1, 0), vec3f(0, -1, 0), vec3f(0, 0, 1), vec3f(0, 0, -1));
const TANGENTS = array<vec3f, 6>(
    vec3f(0, 0, -1), vec3f(0, 0, 1), vec3f(1, 0, 0), vec3f(1, 0, 0), vec3f(1, 0, 0), vec3f(-1, 0, 0));
const CORNERS = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
    let face = vi / 6u;
    let c = CORNERS[vi % 6u];
    let n = NORMALS[face];
    let t = TANGENTS[face];
    let b = cross(n, t);
    let local = vec4f(n + t * c.x + b * c.y, 1.0);

    let inst = I[ii];
    let world = inst.model * local;
    let prevWorld = inst.prevModel * local;

    var out : VsOut;
    out.curClip = F.viewProj * world;
    out.prevClip = F.prevViewProj * prevWorld;
    // Jitter only the rasterized position; the motion endpoints stay unjittered.
    out.position = out.curClip + vec4f(F.jitterClip.xy * out.curClip.w, 0.0, 0.0);
    out.world = world.xyz;
    out.normal = normalize((inst.model * vec4f(n, 0.0)).xyz);
    out.faceUV = c * 0.5 + 0.5;
    out.instance = ii;
    return out;
}

struct FsOut {
    @location(0) color : vec4f,
    @location(1) velocity : vec2f,
}

fn floorPattern(p : vec2f) -> f32 {
    // A 1-unit checker under a fine 1/8-unit line grid: plenty to alias on.
    let checker = f32((i32(floor(p.x)) + i32(floor(p.y))) & 1);
    let g = abs(fract(p * 8.0) - 0.5);
    let line = select(0.0, 1.0, max(g.x, g.y) > 0.46);
    return mix(0.25 + 0.5 * checker, 0.05, line);
}

@fragment
fn fs(v : VsOut) -> FsOut {
    let inst = I[v.instance];
    var albedo = inst.albedo.rgb;
    if (inst.albedo.a < 0.5) {
        albedo *= floorPattern(v.world.xz);
    } else {
        let q = floor(v.faceUV * 4.0);
        albedo *= select(0.35, 1.0, (i32(q.x + q.y) & 1) == 0);
    }
    let ndl = max(dot(normalize(v.normal), F.lightDir.xyz), 0.0);
    // Linear HDR out: the sun term goes well above 1 on purpose.
    let lit = albedo * (0.08 + 3.0 * ndl);

    var out : FsOut;
    out.color = vec4f(lit, 1.0);
    out.velocity = v.curClip.xy / v.curClip.w - v.prevClip.xy / v.prevClip.w;
    return out;
}
`;

const INSTANCE_FLOATS = 36; // 2 × mat4 + vec4
const CUBES = 7;
export const SCENE_NEAR = 0.1;
export const SCENE_FAR = 100;

/** The render-resolution targets the scene draws into (the upscaler's inputs). */
export interface SceneTargets {
    color: GPUTexture;
    depth: GPUTexture;
    velocity: GPUTexture;
}

export class Scene {
    readonly instances = CUBES + 1;
    private readonly _pipeline: GPURenderPipeline;
    private readonly _frame: GPUBuffer;
    private readonly _instanceBuffer: GPUBuffer;
    private readonly _bindGroup: GPUBindGroup;
    private readonly _frameData = new Float32Array(40);
    private readonly _instanceData = new Float32Array(INSTANCE_FLOATS * (CUBES + 1));
    private _prevViewProj: Mat4 | null = null;
    private _primed = false;

    constructor(private readonly _device: GPUDevice) {
        const module = _device.createShaderModule({ label: 'hello-scene', code: SCENE_WGSL });
        this._pipeline = _device.createRenderPipeline({
            label: 'hello-scene',
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: {
                module,
                entryPoint: 'fs',
                targets: [{ format: 'rgba16float' }, { format: 'rg16float' }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });
        this._frame = _device.createBuffer({
            size: this._frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._instanceBuffer = _device.createBuffer({
            size: this._instanceData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._bindGroup = _device.createBindGroup({
            layout: this._pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._frame } },
                { binding: 1, resource: { buffer: this._instanceBuffer } },
            ],
        });
    }

    /**
     * Allocates render targets. Depth and velocity only need to be sampleable;
     * the core reads them, it never writes them.
     */
    createTargets(width: number, height: number): SceneTargets {
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
        const size = { width, height };
        return {
            color: this._device.createTexture({ label: 'hello-color', size, format: 'rgba16float', usage }),
            depth: this._device.createTexture({ label: 'hello-depth', size, format: 'depth32float', usage }),
            velocity: this._device.createTexture({ label: 'hello-velocity', size, format: 'rg16float', usage }),
        };
    }

    /**
     * Writes this frame's uniforms. `jitter` is the core's offset in render
     * pixels (x right, y down): the sample moves by +jitter, so the projection
     * shifts the other way — `−2x/w` in clip x, `+2y/h` in clip y (y up).
     */
    update(time: number, viewProj: Mat4, jitter: { x: number; y: number }, width: number, height: number): void {
        const f = this._frameData;
        // A camera cut (first frame) has no previous: zero motion.
        f.set(viewProj, 0);
        f.set(this._prevViewProj ?? viewProj, 16);
        f[32] = (-2 * jitter.x) / width;
        f[33] = (2 * jitter.y) / height;
        const l = [0.45, 0.8, 0.35];
        const ll = Math.hypot(l[0], l[1], l[2]);
        f[36] = l[0] / ll; f[37] = l[1] / ll; f[38] = l[2] / ll;
        this._device.queue.writeBuffer(this._frame, 0, f);
        this._prevViewProj = new Float32Array(viewProj);

        const d = this._instanceData;
        const floor = compose([0, -0.05, 0], 0, 0, [40, 0.05, 40]);
        this._writeInstance(0, floor, [0.9, 0.85, 0.8], 0);
        for (let i = 0; i < CUBES; i++) {
            const a = (i / CUBES) * Math.PI * 2 + time * 0.3;
            const r = 2.6 + (i % 2) * 0.9;
            const m = compose(
                [Math.cos(a) * r, 0.55 + 0.35 * Math.sin(time * 1.3 + i), Math.sin(a) * r],
                time * (0.6 + 0.15 * i),
                time * 0.4 + i,
                [0.45, 0.45, 0.45],
            );
            const hue = i / CUBES;
            this._writeInstance(i + 1, m, [0.5 + 0.5 * Math.cos(6.283 * hue), 0.5 + 0.5 * Math.cos(6.283 * (hue + 0.33)), 0.5 + 0.5 * Math.cos(6.283 * (hue + 0.67))], 1);
        }
        this._device.queue.writeBuffer(this._instanceBuffer, 0, d);
        this._primed = true;
    }

    private _writeInstance(index: number, model: Mat4, albedo: number[], pattern: number): void {
        const d = this._instanceData;
        const o = index * INSTANCE_FLOATS;
        // Last frame's model sits where this frame's will be written: copy it
        // over first (on the very first frame, prev = current).
        if (this._primed) d.copyWithin(o + 16, o, o + 16);
        else d.set(model, o + 16);
        d.set(model, o);
        d.set([...albedo, pattern], o + 32);
    }

    /** Encodes the scene pass into the caller's encoder. */
    encode(encoder: GPUCommandEncoder, targets: SceneTargets): void {
        const pass = encoder.beginRenderPass({
            label: 'hello-scene',
            colorAttachments: [
                { view: targets.color.createView(), clearValue: [0.03, 0.045, 0.07, 1], loadOp: 'clear', storeOp: 'store' },
                { view: targets.velocity.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
            ],
            depthStencilAttachment: {
                view: targets.depth.createView(),
                depthClearValue: 1,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.draw(36, this.instances);
        pass.end();
    }
}
