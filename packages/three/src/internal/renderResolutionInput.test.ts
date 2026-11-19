import { DataTexture, FloatType, HalfFloatType, PerspectiveCamera, Scene, type Vector2 } from 'three';
import { mrt, output, pass, texture, vec4, velocity } from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { getPassRenderResolution } from '@pmndrs/upscaler-core/math/resolution';
import { upscale, upscaleSpatial } from '../UpscalerNode';
import {
    RenderResolutionInputNode,
    describeSizeReference,
    getInputRenderSize,
    materializeInput,
    type InputSizeRenderer,
} from './renderResolutionInput';

// GPU-free: three's node classes construct (and PassNode sizes its render
// target) without a device, so three itself is the oracle for the rounding.

function scenePass(scale: number, type?: number) {
    const p = pass(new Scene(), new PerspectiveCamera(), type === undefined ? {} : { type: type as never });
    p.setMRT(mrt({ output, velocity }));
    p.setResolutionScale(scale);
    return p;
}

function fakeRenderer(width: number, height: number, xr?: { width: number; height: number }): InputSizeRenderer {
    return {
        getDrawingBufferSize: (target: Vector2) => target.set(width, height),
        getOutputRenderTarget: () => (xr ? { isXRRenderTarget: true, ...xr } : null),
    };
}

// Canvas sizes whose scaled fraction lands on every side of .5, plus odd ones.
const SIZES: Array<[number, number]> = [[1280, 577], [1281, 721], [977, 555], [1252, 936], [39, 39], [3840, 2160], [1, 1]];
const SCALES = [1, 1 / 1.3, 1 / 1.5, 1 / 1.7, 0.5, 1 / 3, 0.37];

describe('getInputRenderSize', () => {
    it("matches three's PassNode sizing for the reference pass", () => {
        for (const scale of SCALES) {
            const p = scenePass(scale);
            for (const [w, h] of SIZES) {
                p.setSize(w, h);
                const expected = { width: p.renderTarget.width, height: p.renderTarget.height };
                if (expected.width === 0 || expected.height === 0) continue; // degenerate in three itself
                expect(getInputRenderSize({ width: w, height: h }, { kind: 'pass', scale }, 2), `${w}x${h} @ ${scale}`)
                    .toEqual(expected);
            }
        }
    });

    it('takes an explicit texture size as is', () => {
        expect(getInputRenderSize({ width: 1280, height: 720 }, { kind: 'texture', width: 333, height: 222 }, 2))
            .toEqual({ width: 333, height: 222 });
    });

    it('falls back to the ratio without a reference', () => {
        expect(getInputRenderSize({ width: 1252, height: 936 }, null, 1.5))
            .toEqual(getPassRenderResolution(1252, 936, 1.5));
    });
});

describe('describeSizeReference', () => {
    it('reads the pass scale from a pass texture node', () => {
        const p = scenePass(1 / 1.5);
        expect(describeSizeReference(p.getTextureNode('depth'))).toEqual({ kind: 'pass', scale: 1 / 1.5 });
    });

    it('reads a sized texture', () => {
        const tex = new DataTexture(new Uint8Array(4 * 6 * 5), 6, 5);
        expect(describeSizeReference(texture(tex))).toEqual({ kind: 'texture', width: 6, height: 5 });
    });

    it('has nothing to say about a missing reference', () => {
        expect(describeSizeReference(null)).toBeNull();
    });
});

describe('materializeInput', () => {
    it('passes texture nodes through untouched (no copy)', () => {
        const p = scenePass(0.5);
        const color = p.getTextureNode('output');
        expect(materializeInput(color, p.getTextureNode('depth'), 2)).toBe(color);
    });

    it("resolves a pass node to its output texture, like convertToTexture", () => {
        const p = scenePass(0.5);
        expect(materializeInput(p, p.getTextureNode('depth'), 2)).toBe(p.getTextureNode());
    });

    it('renders a composite into a half-float target', () => {
        const p = scenePass(0.5);
        const node = materializeInput(p.getTextureNode('output').add(vec4(1)), p.getTextureNode('depth'), 2);
        expect(node).toBeInstanceOf(RenderResolutionInputNode);
        expect(node.renderTarget.texture.type).toBe(HalfFloatType);
        expect(node.renderTarget.depthBuffer).toBe(false);
    });

    it('follows a full-float reference pass', () => {
        const p = scenePass(0.5, FloatType);
        const node = materializeInput(p.getTextureNode('output').add(vec4(1)), p.getTextureNode('depth'), 2);
        expect(node.renderTarget.texture.type).toBe(FloatType);
    });
});

describe('RenderResolutionInputNode.syncSize', () => {
    it('tracks the reference pass across resizes, matching its target', () => {
        const p = scenePass(1 / 1.5);
        const node = materializeInput(p.getTextureNode('output').add(vec4(1)), p.getTextureNode('depth'), 2);
        for (const [w, h] of SIZES) {
            node.syncSize(fakeRenderer(w, h));
            p.setSize(w, h);
            expect([node.renderTarget.width, node.renderTarget.height], `${w}x${h}`)
                .toEqual([p.renderTarget.width, p.renderTarget.height].map((v) => Math.max(1, v)));
        }
    });

    it('sizes an XR frame from the XR target, as PassNode does', () => {
        const p = scenePass(0.5);
        const node = materializeInput(p.getTextureNode('output').add(vec4(1)), p.getTextureNode('depth'), 2);
        expect(node.syncSize(fakeRenderer(1280, 720, { width: 2000, height: 1000 }))).toEqual({ width: 1000, height: 500 });
    });

    it('uses the ratio when there is no reference (spatial)', () => {
        const p = scenePass(0.5);
        const node = materializeInput(p.getTextureNode('output').add(vec4(1)), null, 1.5);
        expect(node.syncSize(fakeRenderer(1252, 936))).toEqual(getPassRenderResolution(1252, 936, 1.5));
    });
});

describe('upscale() / upscaleSpatial() inputs', () => {
    const color = (n: unknown) => (n as { _color: unknown })._color;
    const camera = new PerspectiveCamera();

    it('keep a texture colour input as the same node', () => {
        const p = scenePass(0.5);
        const out = p.getTextureNode('output');
        expect(color(upscale(out, p.getTextureNode('depth'), p.getTextureNode('velocity'), camera))).toBe(out);
        expect(color(upscaleSpatial(out))).toBe(out);
    });

    it('materialise a composite colour and reactive input at render resolution', () => {
        const p = scenePass(0.5);
        const node = upscale(p.getTextureNode('output').add(vec4(1)), p.getTextureNode('depth'), p.getTextureNode('velocity'), camera, {
            reactive: p.getTextureNode('output').r.mul(0.5),
        });
        expect(color(node)).toBeInstanceOf(RenderResolutionInputNode);
        expect((node as unknown as { _reactive: unknown })._reactive).toBeInstanceOf(RenderResolutionInputNode);
        const rendered = (color(node) as RenderResolutionInputNode).syncSize(fakeRenderer(1281, 721));
        expect(rendered).toEqual({ width: 640, height: 360 });
    });
});
