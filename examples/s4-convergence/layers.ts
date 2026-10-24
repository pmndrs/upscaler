import * as THREE from 'three/webgpu';
import {
    abs,
    acesFilmicToneMapping,
    clamp,
    dot,
    float,
    floor,
    fract,
    fwidth,
    ivec2,
    length,
    log2,
    max,
    min,
    mix,
    sqrt,
    step,
    textureLoad,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';

//* Layers — what the main view and the magnifier can show.
// Every pipeline layer is read straight out of the upscaler's published
// working set (`upscaler.guides`) rather than through `settings.debugView`.
// The library's debug views are drawn by the frame's output pass, so they only
// change when a frame is dispatched — but an explainer must let you flip
// between age, locks and disocclusion of the *same* paused frame. The mappings
// below are the ones in packages/core/src/shaders/debug.ts, case for case, so a layer here
// reads exactly like the matching `DebugView`.

/** The selectable layers, in the order the UI lists them. */
export const LAYERS = [
    { id: 'output', label: 'Output', note: 'final upscale (after RCAS)' },
    { id: 'input', label: 'Input', note: 'low-res jittered render, nearest-upsampled' },
    { id: 'history', label: 'History', note: 'accumulated history, before RCAS' },
    { id: 'motion', label: 'Motion vectors', note: 'DebugView.MotionVectors · olive = still, hue = direction' },
    { id: 'disocclusion', label: 'Disocclusion', note: 'DebugView.Disocclusion · white = history rejected' },
    { id: 'depth', label: 'Depth', note: 'DebugView.Depth · log-scaled view depth' },
    { id: 'age', label: 'Accumulation age', note: 'DebugView.AccumulationAge · white = full history' },
    { id: 'locks', label: 'Locks', note: 'DebugView.Locks · white = locked thin feature' },
    { id: 'shading', label: 'Shading change', note: 'DebugView.ShadingChange · white = history aged' },
    { id: 'exposure', label: 'Exposure', note: 'DebugView.Exposure · exposed luma, ~mid-grey' },
] as const;

/** A layer id from {@link LAYERS}. */
export type LayerId = (typeof LAYERS)[number]['id'];

/** The textures a frame's layers are read from — re-supplied every frame (ping-pong). */
export interface LayerSources {
    /** `upscaler.outputTexture` (display res, linear/HDR). */
    output: THREE.Texture;
    /** The scene color render target attachment (render res, linear/HDR). */
    input: THREE.Texture;
    /** `guides.history` — rgb conditioned, `.a` = age (display res). */
    history: THREE.Texture;
    /** `guides.lockStatus` — r = lock life, b = shading change (display res). */
    locks: THREE.Texture;
    /** `guides.exposure` — 1×1, r = conditioning exposure. */
    exposure: THREE.Texture;
    /** `guides.dilatedMotion` — UV-delta motion (render res). */
    motion: THREE.Texture;
    /** `guides.disocclusion` — r = disocclusion (render res). */
    disocclusion: THREE.Texture;
    /** `guides.dilatedDepth` — linear view depth (render res). */
    depth: THREE.Texture;
}

type TexNode = THREE.TextureNode;
type FloatNode = THREE.Node<'float'>;
type Vec2Node = THREE.Node<'vec2'>;
type Vec3Node = THREE.Node<'vec3'>;
type Vec4Node = THREE.Node<'vec4'>;

/**
 * The full-screen present: the main view (one selectable layer) plus the
 * two-panel magnifier, all in one quad so a paused frame can be re-presented
 * without touching the pipeline.
 */
export class ConvergenceView {
    /** Index into {@link LAYERS} shown in the main view. */
    readonly layer = uniform(0);
    /** Index into {@link LAYERS} shown in the magnifier's right panel. */
    readonly magLayer = uniform(0);
    readonly renderSize = uniform(new THREE.Vector2(1, 1));
    readonly displaySize = uniform(new THREE.Vector2(1, 1));
    /** This frame's jitter in render pixels (the camera view offset). */
    readonly jitter = uniform(new THREE.Vector2());
    /** Magnifier focus, in display pixels. */
    readonly magCenter = uniform(new THREE.Vector2());
    /** Magnifier width/height, in display pixels. */
    readonly magSpan = uniform(32);
    /** Canvas-uv rects (x0, y0, x1, y1) of the two magnifier panels. */
    readonly magInputRect = uniform(new THREE.Vector4(-1, -1, -1, -1));
    readonly magOutputRect = uniform(new THREE.Vector4(-1, -1, -1, -1));
    /**
     * 1 while the library's own debug pass owns the output texture
     * (`settings.debugView`), so the Output layer shows it raw instead of
     * tone-mapping a data view — used to cross-check these layers against it.
     */
    readonly outputIsData = uniform(0);

    private readonly _quad: THREE.QuadMesh;
    private readonly _loads: Array<{ node: TexNode; key: keyof LayerSources }> = [];

    constructor(private _sources: LayerSources) {
        const material = new THREE.NodeMaterial();
        material.colorNode = this._build();
        material.depthTest = false;
        material.depthWrite = false;
        material.fog = false;
        this._quad = new THREE.QuadMesh(material);
    }

    /**
     * Re-points every texture read at this frame's textures. Ping-ponged guides
     * (history, locks, exposure, depth) alternate halves each frame, and a
     * reconfigure reallocates all of them.
     *
     * @param sources - The current frame's textures
     */
    setSources(sources: LayerSources): void {
        this._sources = sources;
        for (const { node, key } of this._loads) node.value = sources[key];
    }

    /**
     * Draws the view into the current render target (the canvas).
     *
     * @param renderer - The renderer
     */
    render(renderer: THREE.WebGPURenderer): void {
        this._quad.render(renderer);
    }

    //* Graph

    private _load(key: keyof LayerSources, coord: THREE.Node<'ivec2'>): TexNode {
        const node = textureLoad(this._sources[key], coord);
        this._loads.push({ node, key });
        return node;
    }

    // Color for one layer index at a continuous display-pixel position. Built
    // per call site (main view, magnifier), each with its own texture reads.
    private _layerColor(displayPx: Vec2Node, layer: FloatNode): Vec3Node {
        // Same pixel mapping as debug.ts: display texel → its center uv →
        // the render texel that uv falls in.
        const dTexel = clamp(floor(displayPx), vec2(0), this.displaySize.sub(1));
        const uvc = dTexel.add(0.5).div(this.displaySize);
        const rTexel = clamp(floor(uvc.mul(this.renderSize)), vec2(0), this.renderSize.sub(1));
        const di = ivec2(dTexel);
        const ri = ivec2(rTexel);

        const exposure = this._load('exposure', ivec2(0, 0)).r;
        const input = this._load('input', ri).rgb;
        const history = this._load('history', di);
        const locks = this._load('locks', di);

        // Color layers stay in linear/HDR until here and get the examples'
        // presentation (ACES; the renderer adds the sRGB encode). Data layers
        // are shown raw, as the library's debug pass writes them.
        const aces = (c: Vec3Node): Vec3Node => acesFilmicToneMapping(c, float(1)) as Vec3Node;

        const outputRaw = this._load('output', di).rgb;
        const output = mix(aces(outputRaw), outputRaw, this.outputIsData);
        const inputColor = aces(input);
        // Undo accumulate's conditioning (common.ts tonemapInvert, then the
        // pre-exposure) — the history as RCAS receives it, minus the sharpening.
        const hMax = min(max(max(history.r, history.g), max(history.b, 0.0)), 0.999);
        const historyColor = aces(history.rgb.div(float(1).sub(hMax)).div(max(exposure, 1e-6)));

        // debug.ts motionToColor — sqrt response so slow motion stays visible.
        const m = this._load('motion', ri).xy;
        const mLen = length(m);
        const mag = clamp(sqrt(mLen.mul(8.0)), 0.0, 1.0);
        const dir = mix(m.div(max(mLen, 1e-6)), vec2(1, 0), step(mLen, 1e-6));
        const motion = vec3(dir.x.mul(mag).mul(0.5).add(0.5), dir.y.mul(mag).mul(0.5).add(0.5), mag);

        const disocclusion = vec3(this._load('disocclusion', ri).r);
        const depth = vec3(clamp(log2(this._load('depth', ri).r.add(1.0)).div(8.0), 0.0, 1.0));
        const age = vec3(history.a);
        const lockLife = vec3(locks.r);
        const shading = vec3(locks.b);
        // common.ts luma (Rec. 709 weights) of the exposed input.
        const exposed = vec3(clamp(dot(input, vec3(0.2126, 0.7152, 0.0722)).mul(exposure), 0.0, 1.0));

        const byIndex: Vec3Node[] = [
            output,
            inputColor,
            historyColor,
            motion,
            disocclusion,
            depth,
            age,
            lockLife,
            shading,
            exposed,
        ];
        // Blended by one-hot weights rather than select(): TSL lowers a select
        // over non-trivial branches to if/else and declares shared
        // subexpressions inside the first branch that uses them, so the other
        // branches (and everything after) would read them unassigned. Plain
        // arithmetic keeps every read at the top level; the cost is a handful
        // of texel fetches per pixel, nothing at these sizes.
        let color: Vec3Node = vec3(0);
        byIndex.forEach((c, i) => {
            const weight = float(1).sub(step(0.5, abs(layer.sub(i))));
            color = color.add(c.mul(weight));
        });
        return color;
    }

    private _build(): Vec4Node {
        const screen = uv();
        const displayPx = screen.mul(this.displaySize);
        const main = this._layerColor(displayPx, this.layer);

        // Magnifier focus outline on the main view (1.5 screen px wide).
        const half = vec2(this.magSpan.mul(0.5));
        const lo = this.magCenter.sub(half);
        const hi = this.magCenter.add(half);
        const px = fwidth(displayPx);
        const d = min(abs(displayPx.sub(lo)), abs(displayPx.sub(hi))).div(px);
        const inside = step(lo.x, displayPx.x)
            .mul(step(displayPx.x, hi.x))
            .mul(step(lo.y, displayPx.y))
            .mul(step(displayPx.y, hi.y));
        const nearEdge = step(min(d.x, d.y), 1.5);
        const outline = inside.mul(nearEdge);
        const mainWithOutline = mix(main, vec3(0.49, 0.83, 0.99), outline);

        //* Magnifier panels
        const panel = (rect: THREE.Node<'vec4'>): { within: FloatNode; p: Vec2Node } => {
            const t = screen.sub(rect.xy).div(rect.zw.sub(rect.xy));
            const within = step(0.0, t.x).mul(step(t.x, 1.0)).mul(step(0.0, t.y)).mul(step(t.y, 1.0));
            const p = lo.add(t.mul(this.magSpan));
            return { within, p };
        };

        // Left: the raw input, one block per render pixel, with the render-pixel
        // grid and a dot where this frame's jittered sample landed in each.
        const left = panel(this.magInputRect);
        const leftColor = this._layerColor(left.p, float(1));
        const rc = left.p.mul(this.renderSize).div(this.displaySize); // continuous render px
        const rcw = fwidth(rc);
        const rf = fract(rc);
        const gridDist = min(min(rf.x, float(1).sub(rf.x)).div(rcw.x), min(rf.y, float(1).sub(rf.y)).div(rcw.y));
        const showGrid = step(rcw.x, 0.2); // only once a cell spans ≥ 5 screen px
        const leftGrid = step(gridDist, 0.75).mul(showGrid).mul(0.55);
        const samplePos = floor(rc).add(0.5).add(this.jitter);
        const dotDist = length(rc.sub(samplePos).div(rcw));
        // ~2 screen px, but never more than a fifth of a cell (ratio 1 cells are small).
        const dotMask = step(dotDist, min(2.2, float(0.2).div(rcw.x))).mul(showGrid);
        let leftFinal = mix(leftColor, vec3(0.03), leftGrid);
        leftFinal = mix(leftFinal, vec3(0.13, 0.83, 0.93), dotMask);

        // Right: the output (or the followed layer), display-pixel grid.
        const right = panel(this.magOutputRect);
        const rightColor = this._layerColor(right.p, this.magLayer);
        const dw = fwidth(right.p);
        const df = fract(right.p);
        const dGridDist = min(min(df.x, float(1).sub(df.x)).div(dw.x), min(df.y, float(1).sub(df.y)).div(dw.y));
        const rightGrid = step(dGridDist, 0.6).mul(step(dw.x, 0.2)).mul(0.35);
        const rightFinal = mix(rightColor, vec3(0.03), rightGrid);

        let color = mix(mainWithOutline, leftFinal, left.within);
        color = mix(color, rightFinal, right.within);
        return vec4(color, 1.0);
    }
}
