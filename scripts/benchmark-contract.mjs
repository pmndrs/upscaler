import { createHash } from 'node:crypto';

/**
 * Checks the aggregate E00 timing noise gate.
 *
 * Per-pass noise remains recorded for claim eligibility, but only the compute
 * sum controls the aggregate harness retry and blocker state.
 *
 * @param {Array<{ label: string; noiseFloorPass: boolean }>} analysis
 * @returns {boolean}
 */
export function computeSumNoiseFloorPasses(analysis) {
    const computeSums = analysis.filter((entry) => entry.label === 'compute-sum');
    return computeSums.length === 1 && computeSums[0].noiseFloorPass;
}

/**
 * Checks comparisons that are eligible to support authoritative claims.
 *
 * @param {Array<{
 *   label: string;
 *   individualClaimEligible: boolean;
 *   median: { passes: boolean };
 *   p95: { passes: boolean };
 * }>} analysis
 * @returns {boolean}
 */
export function authoritativeComparisonPasses(analysis) {
    return analysis
        .filter(
            (entry) =>
                entry.label === 'compute-sum' || entry.individualClaimEligible,
        )
        .every((entry) => entry.median.passes && entry.p95.passes);
}

/**
 * Hashes a complete non-ignored working-tree inventory.
 *
 * @param {Array<{ path: string; bytes: Buffer | null }>} entries
 * @returns {string}
 */
export function hashWorkingTreeEntries(entries) {
    const hash = createHash('sha256');
    for (const entry of entries.toSorted((a, b) => a.path.localeCompare(b.path))) {
        hash.update(entry.path);
        hash.update('\0');
        hash.update(entry.bytes ?? Buffer.from('<missing>'));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/**
 * Builds a review persistence key bound to one evidence set and record order.
 *
 * @param {{ manifestDigest: string; workingTreeDigest: string }} binding
 * @param {Array<{ id: string }>} records
 * @returns {string}
 */
export function reviewStorageKey(binding, records) {
    const digest = createHash('sha256')
        .update(binding.manifestDigest)
        .update('\0')
        .update(binding.workingTreeDigest)
        .update('\0')
        .update(records.map((record) => record.id).join('\0'))
        .digest('hex');
    return `fsr3-e00-review-${digest}`;
}

/**
 * Rejects review evidence that did not come from the active contract and tree.
 *
 * @param {{
 *   run: { manifestDigest?: string; workingTreeDigest?: string };
 *   analysis: {
 *     authoritative?: boolean;
 *     completeProtocol?: boolean;
 *     passes?: boolean;
 *     tupleCount?: number;
 *     expectedTupleCount?: number;
 *     failedPairCount?: number;
 *   };
 *   manifestDigest: string;
 *   workingTreeDigest: string;
 * }} input
 * @returns {void}
 */
export function assertCaptureEvidenceBinding({
    run,
    analysis,
    manifestDigest,
    workingTreeDigest,
}) {
    if (run.manifestDigest !== manifestDigest)
        throw new Error('Capture manifest digest does not match the active E00 contract.');
    if (run.workingTreeDigest !== workingTreeDigest)
        throw new Error('Capture working-tree digest does not match the active source state.');
    if (
        analysis.authoritative !== true ||
        analysis.completeProtocol !== true ||
        analysis.passes !== true ||
        analysis.tupleCount !== analysis.expectedTupleCount ||
        analysis.failedPairCount !== 0
    )
        throw new Error('Review requires a complete passing authoritative capture analysis.');
}

/**
 * Closes a target created inside a user-owned CDP browser and awaits removal.
 *
 * @param {string} cdpBase
 * @param {string} targetId
 * @param {{
 *   fetchImpl?: typeof fetch;
 *   wait?: (milliseconds: number) => Promise<void>;
 *   attempts?: number;
 * }} [options]
 * @returns {Promise<void>}
 */
export async function closeExternalCdpTarget(
    cdpBase,
    targetId,
    {
        fetchImpl = fetch,
        wait = (milliseconds) =>
            new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
        attempts = 20,
    } = {},
) {
    const closeResponse = await fetchImpl(`${cdpBase}/json/close/${targetId}`);
    if (!closeResponse.ok)
        throw new Error(`Unable to close CDP target ${targetId}: ${closeResponse.status}`);

    for (let attempt = 0; attempt < attempts; attempt++) {
        const listResponse = await fetchImpl(`${cdpBase}/json/list`);
        if (!listResponse.ok)
            throw new Error(`Unable to inspect CDP targets: ${listResponse.status}`);
        const targets = await listResponse.json();
        if (!targets.some((target) => target.id === targetId)) return;
        await wait(50);
    }
    throw new Error(`Timed out waiting for CDP target ${targetId} to close.`);
}
