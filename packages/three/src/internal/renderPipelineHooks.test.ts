import { describe, expect, it, vi } from 'vitest';
import { TSL } from 'three/webgpu';

import {
    getPipelineEvents,
    installRenderPipelineHooks,
    type PipelineEvents,
    type PipelineHooks,
} from './renderPipelineHooks';

//* Fixtures — r186 RenderPipeline._updateContext() / r185 RenderPipeline.context shapes

function r186Context() {
    const contextData = {
        renderPipeline: {},
        renderPipelineState: { viewOffsetOwner: null as unknown },
        onBeforePipelineCallbacks: [] as Array<() => void>,
        onAfterPipelineCallbacks: [] as Array<() => void>,
    };
    // Mirrors EventNode.setup: the event factories push into the context arrays.
    const events: PipelineEvents = {
        onBefore: (cb) => contextData.onBeforePipelineCallbacks.push(cb),
        onAfter: (cb) => contextData.onAfterPipelineCallbacks.push(cb),
    };
    return { contextData, events };
}

function r185Context() {
    const legacy = {
        onBeforeRenderPipeline: null as (() => void) | null,
        onAfterRenderPipeline: null as (() => void) | null,
    };
    return { legacy, context: { renderPipeline: { context: legacy } } };
}

function hooks(): PipelineHooks {
    return { before: vi.fn(), after: vi.fn() };
}

describe('getPipelineEvents', () => {
    it('detects the r186 events on the installed three', () => {
        const events = getPipelineEvents(TSL as unknown as Record<string, unknown>);
        expect(events).not.toBeNull();
    });

    it('returns null on a TSL namespace that predates them (r184/r185)', () => {
        expect(getPipelineEvents({})).toBeNull();
        expect(getPipelineEvents({ OnBeforeRenderPipeline: () => {} })).toBeNull();
    });
});

describe('installRenderPipelineHooks — r186 events', () => {
    it('registers exactly one callback per array and claims the view offset', () => {
        const { contextData, events } = r186Context();
        const owner = {};
        const h = hooks();

        expect(installRenderPipelineHooks(contextData, owner, h, events)).toBe('events');
        expect(contextData.onBeforePipelineCallbacks).toEqual([h.before]);
        expect(contextData.onAfterPipelineCallbacks).toEqual([h.after]);
        expect(contextData.renderPipelineState.viewOffsetOwner).toBe(owner);
    });

    it('does not double-register when setup re-runs against the same context data', () => {
        const { contextData, events } = r186Context();
        const owner = {};
        const h = hooks();

        installRenderPipelineHooks(contextData, owner, h, events);
        expect(installRenderPipelineHooks(contextData, owner, h, events)).toBe('installed');
        expect(contextData.onBeforePipelineCallbacks).toHaveLength(1);
        expect(contextData.onAfterPipelineCallbacks).toHaveLength(1);
    });

    it('re-registers on fresh context data (a pipeline rebuild)', () => {
        const owner = {};
        const h = hooks();
        installRenderPipelineHooks(r186Context().contextData, owner, h, r186Context().events);

        const rebuilt = r186Context();
        expect(installRenderPipelineHooks(rebuilt.contextData, owner, h, rebuilt.events)).toBe('events');
        expect(rebuilt.contextData.onBeforePipelineCallbacks).toHaveLength(1);
    });

    it('backs off when another node (TRAA/TAAU) already owns the view offset', () => {
        const { contextData, events } = r186Context();
        const traa = {};
        contextData.renderPipelineState.viewOffsetOwner = traa;

        expect(installRenderPipelineHooks(contextData, {}, hooks(), events)).toBe('conflict');
        expect(contextData.onBeforePipelineCallbacks).toHaveLength(0);
        expect(contextData.onAfterPipelineCallbacks).toHaveLength(0);
        expect(contextData.renderPipelineState.viewOffsetOwner).toBe(traa);
    });

    it('does nothing outside a render pipeline', () => {
        const { events } = r186Context();
        expect(installRenderPipelineHooks({}, {}, hooks(), events)).toBe('none');
        expect(installRenderPipelineHooks(undefined, {}, hooks(), events)).toBe('none');
    });
});

describe('installRenderPipelineHooks — r184/r185 legacy context', () => {
    it('assigns the context slots', () => {
        const { legacy, context } = r185Context();
        const h = hooks();

        expect(installRenderPipelineHooks(context, {}, h, null)).toBe('legacy');
        expect(legacy.onBeforeRenderPipeline).toBe(h.before);
        expect(legacy.onAfterRenderPipeline).toBe(h.after);
    });

    it('recognises its own earlier assignment', () => {
        const { context } = r185Context();
        const owner = {};
        const h = hooks();
        installRenderPipelineHooks(context, owner, h, null);
        expect(installRenderPipelineHooks(context, owner, h, null)).toBe('installed');
    });

    it("never overwrites another node's slots", () => {
        const { legacy, context } = r185Context();
        const theirs = () => {};
        legacy.onBeforeRenderPipeline = theirs;

        expect(installRenderPipelineHooks(context, {}, hooks(), null)).toBe('conflict');
        expect(legacy.onBeforeRenderPipeline).toBe(theirs);
        expect(legacy.onAfterRenderPipeline).toBeNull();
    });
});
