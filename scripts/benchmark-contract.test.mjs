import { describe, expect, test } from 'vitest';

import {
    assertCaptureEvidenceBinding,
    authoritativeComparisonPasses,
    closeExternalCdpTarget,
    computeSumNoiseFloorPasses,
    hashWorkingTreeEntries,
    reviewStorageKey,
} from './benchmark-contract.mjs';

describe('E00 timing contract', () => {
    test('accepts a stable compute sum while preserving ineligible per-pass evidence', () => {
        const analysis = [
            { label: 'accumulate', noiseFloorPass: false },
            { label: 'compute-sum', noiseFloorPass: true },
        ];

        expect(computeSumNoiseFloorPasses(analysis)).toBe(true);
        expect(analysis[0].noiseFloorPass).toBe(false);
    });

    test('rejects a missing or unstable compute sum', () => {
        expect(computeSumNoiseFloorPasses([])).toBe(false);
        expect(
            computeSumNoiseFloorPasses([
                { label: 'compute-sum', noiseFloorPass: false },
            ]),
        ).toBe(false);
    });

    test('gates aggregate and eligible pass comparisons without claiming noisy passes', () => {
        expect(
            authoritativeComparisonPasses([
                {
                    label: 'accumulate',
                    individualClaimEligible: false,
                    median: { passes: false },
                    p95: { passes: false },
                },
                {
                    label: 'rcas',
                    individualClaimEligible: true,
                    median: { passes: true },
                    p95: { passes: true },
                },
                {
                    label: 'compute-sum',
                    individualClaimEligible: true,
                    median: { passes: true },
                    p95: { passes: true },
                },
            ]),
        ).toBe(true);
    });

});

describe('E00 evidence binding', () => {
    const run = {
        manifestDigest: 'manifest-a',
        workingTreeDigest: 'tree-a',
    };
    const analysis = {
        authoritative: true,
        completeProtocol: true,
        passes: true,
        tupleCount: 264,
        expectedTupleCount: 264,
        failedPairCount: 0,
    };

    test('accepts only a complete passing capture from the current contract and tree', () => {
        expect(() =>
            assertCaptureEvidenceBinding({
                run,
                analysis,
                manifestDigest: 'manifest-a',
                workingTreeDigest: 'tree-a',
            }),
        ).not.toThrow();
    });

    test('rejects stale manifests, changed trees, and incomplete capture evidence', () => {
        expect(() =>
            assertCaptureEvidenceBinding({
                run,
                analysis,
                manifestDigest: 'manifest-b',
                workingTreeDigest: 'tree-a',
            }),
        ).toThrow(/manifest digest/i);
        expect(() =>
            assertCaptureEvidenceBinding({
                run,
                analysis,
                manifestDigest: 'manifest-a',
                workingTreeDigest: 'tree-b',
            }),
        ).toThrow(/working-tree digest/i);
        expect(() =>
            assertCaptureEvidenceBinding({
                run,
                analysis: { ...analysis, completeProtocol: false },
                manifestDigest: 'manifest-a',
                workingTreeDigest: 'tree-a',
            }),
        ).toThrow(/complete passing authoritative capture/i);
    });

    test('isolates persisted review state by evidence and record identity', () => {
        const records = [{ id: 'first' }, { id: 'second' }];
        const baseline = reviewStorageKey(run, records);

        expect(reviewStorageKey(run, records)).toBe(baseline);
        expect(reviewStorageKey({ ...run, manifestDigest: 'manifest-b' }, records)).not.toBe(
            baseline,
        );
        expect(reviewStorageKey({ ...run, workingTreeDigest: 'tree-b' }, records)).not.toBe(
            baseline,
        );
        expect(reviewStorageKey(run, records.toReversed())).not.toBe(baseline);
    });

    test('hashes working-tree entries independently of enumeration order', () => {
        const entries = [
            { path: 'b.ts', bytes: Buffer.from('b') },
            { path: 'a.ts', bytes: Buffer.from('a') },
        ];

        expect(hashWorkingTreeEntries(entries)).toBe(
            hashWorkingTreeEntries(entries.toReversed()),
        );
        expect(
            hashWorkingTreeEntries([
                entries[0],
                { path: 'a.ts', bytes: Buffer.from('changed') },
            ]),
        ).not.toBe(hashWorkingTreeEntries(entries));
    });
});

describe('external CDP cleanup', () => {
    test('closes the created target and waits until it disappears', async () => {
        const calls = [];
        let listCount = 0;
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/json/close/target-1')) return { ok: true, status: 200 };
            listCount++;
            return {
                ok: true,
                status: 200,
                async json() {
                    return listCount === 1 ? [{ id: 'target-1' }] : [];
                },
            };
        };

        await closeExternalCdpTarget('http://127.0.0.1:9333', 'target-1', {
            fetchImpl,
            wait: async () => {},
        });

        expect(calls).toEqual([
            'http://127.0.0.1:9333/json/close/target-1',
            'http://127.0.0.1:9333/json/list',
            'http://127.0.0.1:9333/json/list',
        ]);
    });
});
