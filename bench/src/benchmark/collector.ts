function percentile(values: readonly number[], quantile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const position = quantile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizePass(
    label: string,
    samples: number[],
    expectedFrames: number,
): BenchmarkPassSummary {
    return {
        label,
        samples,
        median: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        missingCount: expectedFrames - samples.length,
    };
}

/**
 * Collects complete fresh frame samples and derives manifest statistics.
 */
export class BenchmarkCollector {
    private readonly _expectedFrameTags: readonly number[];
    private readonly _expectedPassLabels: readonly string[] | null;
    private readonly _samples: BenchmarkGpuFrameSample[] = [];

    constructor(expectedFrameTags: readonly number[], expectedPassLabels?: readonly string[]) {
        this._expectedFrameTags = [...expectedFrameTags];
        this._expectedPassLabels = expectedPassLabels
            ? [...expectedPassLabels].sort()
            : null;
    }

    /**
     * Adds fresh samples returned by the resolver timer.
     * @param samples - Complete frame-tagged samples
     */
    add(samples: readonly BenchmarkGpuFrameSample[]): void {
        this._samples.push(
            ...samples.map((sample) => ({
                ...sample,
                passes: sample.passes.map((pass) => ({ ...pass })),
            })),
        );
    }

    /** Builds raw, missing, per-pass, and compute-sum statistics. */
    summarize(): BenchmarkTimingSummary {
        const expected = new Set(this._expectedFrameTags);
        const candidates = new Map<number, BenchmarkGpuFrameSample>();
        const invalidSamples: BenchmarkInvalidTimingSample[] = [];
        const sequences = new Set<number>();
        let duplicateFrameCount = 0;
        let duplicateSequenceCount = 0;
        let unexpectedFrameCount = 0;
        let duplicatePassLabelCount = 0;
        let invalidValueCount = 0;

        for (const sample of this._samples) {
            if (sequences.has(sample.sequence)) {
                duplicateSequenceCount++;
                invalidSamples.push({
                    frameTag: sample.frameTag,
                    sequence: sample.sequence,
                    reason: 'duplicate-sequence',
                    detail: `Sequence ${sample.sequence} was received more than once.`,
                });
                continue;
            }
            sequences.add(sample.sequence);
            if (!expected.has(sample.frameTag)) {
                unexpectedFrameCount++;
                invalidSamples.push({
                    frameTag: sample.frameTag,
                    sequence: sample.sequence,
                    reason: 'unexpected-frame',
                    detail: `Frame ${sample.frameTag} was not requested.`,
                });
                continue;
            }
            if (candidates.has(sample.frameTag)) {
                duplicateFrameCount++;
                invalidSamples.push({
                    frameTag: sample.frameTag,
                    sequence: sample.sequence,
                    reason: 'duplicate-frame',
                    detail: `Frame ${sample.frameTag} was received more than once.`,
                });
                continue;
            }

            const labels = new Set<string>();
            let structurallyValid = true;
            for (const pass of sample.passes) {
                if (labels.has(pass.label)) {
                    duplicatePassLabelCount++;
                    structurallyValid = false;
                    invalidSamples.push({
                        frameTag: sample.frameTag,
                        sequence: sample.sequence,
                        reason: 'duplicate-pass-label',
                        detail: `Pass label ${pass.label} occurs more than once.`,
                    });
                }
                labels.add(pass.label);
                if (!Number.isFinite(pass.milliseconds) || pass.milliseconds < 0) {
                    invalidValueCount++;
                    structurallyValid = false;
                    invalidSamples.push({
                        frameTag: sample.frameTag,
                        sequence: sample.sequence,
                        reason: 'invalid-pass-value',
                        detail: `${pass.label} has invalid duration ${pass.milliseconds}.`,
                    });
                }
            }
            if (structurallyValid) candidates.set(sample.frameTag, sample);
        }

        // The modal sorted label signature is the complete measured graph. This
        // avoids allowing one malformed first/last frame to define completeness.
        const signatureCounts = new Map<string, number>();
        for (const sample of candidates.values()) {
            const signature = sample.passes.map((pass) => pass.label).sort().join('\u0000');
            signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
        }
        const expectedSignature = this._expectedPassLabels
            ? this._expectedPassLabels.join('\u0000')
            : ([...signatureCounts].sort(
                  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
              )[0]?.[0] ?? '');
        const expectedPassLabels = this._expectedPassLabels
            ? [...this._expectedPassLabels]
            : expectedSignature
              ? expectedSignature.split('\u0000')
              : [];
        const byFrame = new Map<number, BenchmarkGpuFrameSample>();
        let inconsistentPassSetCount = 0;
        for (const [frameTag, sample] of candidates) {
            const signature = sample.passes.map((pass) => pass.label).sort().join('\u0000');
            if (signature !== expectedSignature || expectedPassLabels.length === 0) {
                inconsistentPassSetCount++;
                invalidSamples.push({
                    frameTag,
                    sequence: sample.sequence,
                    reason: 'inconsistent-pass-set',
                    detail: `Expected [${expectedPassLabels.join(', ')}], received [${sample.passes
                        .map((pass) => pass.label)
                        .sort()
                        .join(', ')}].`,
                });
                continue;
            }
            byFrame.set(frameTag, sample);
        }

        const passes = expectedPassLabels.map((label) => {
            const values: number[] = [];
            for (const frameTag of this._expectedFrameTags) {
                const value = byFrame
                    .get(frameTag)
                    ?.passes.find((pass) => pass.label === label)?.milliseconds;
                if (value !== undefined) values.push(value);
            }
            return summarizePass(label, values, this._expectedFrameTags.length);
        });

        const computeSums: number[] = [];
        for (const frameTag of this._expectedFrameTags) {
            const sample = byFrame.get(frameTag);
            if (sample) computeSums.push(
                sample.passes.reduce((sum, pass) => sum + pass.milliseconds, 0),
            );
        }

        return {
            expectedFrames: this._expectedFrameTags.length,
            receivedFrames: byFrame.size,
            missingFrameCount: this._expectedFrameTags.length - byFrame.size,
            duplicateFrameCount,
            duplicateSequenceCount,
            unexpectedFrameCount,
            duplicatePassLabelCount,
            invalidValueCount,
            inconsistentPassSetCount,
            invalidityCount:
                duplicateFrameCount +
                duplicateSequenceCount +
                unexpectedFrameCount +
                duplicatePassLabelCount +
                invalidValueCount +
                inconsistentPassSetCount +
                (this._expectedFrameTags.length - byFrame.size),
            expectedPassLabels,
            invalidSamples,
            passes,
            computeSum: summarizePass(
                'compute-sum',
                computeSums,
                this._expectedFrameTags.length,
            ),
            raw: [...byFrame.values()].sort((a, b) => a.frameTag - b.frameTag),
        };
    }
}

/**
 * Serializes a timing result without dropping raw evidence.
 * @param summary - Collector summary
 * @returns Pretty JSON
 */
export function timingSummaryToJson(summary: BenchmarkTimingSummary): string {
    return JSON.stringify(summary, null, 2);
}

/**
 * Serializes one row per fresh frame/pass plus compute sum.
 * @param summary - Collector summary
 * @returns RFC-4180-compatible CSV text
 */
export function timingSummaryToCsv(summary: BenchmarkTimingSummary): string {
    const rows = ['frame,sequence,label,milliseconds'];
    for (const sample of summary.raw) {
        for (const pass of sample.passes)
            rows.push(`${sample.frameTag},${sample.sequence},${pass.label},${pass.milliseconds}`);
        const sum = sample.passes.reduce((total, pass) => total + pass.milliseconds, 0);
        rows.push(`${sample.frameTag},${sample.sequence},compute-sum,${sum}`);
    }
    return `${rows.join('\n')}\n`;
}
