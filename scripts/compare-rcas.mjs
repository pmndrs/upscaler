import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = join(ROOT, 'scripts/run-benchmark.mjs');

//* Arguments ================================================================

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('--')) continue;
        const name = value.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) options[name] = argv[++index];
        else options[name] = true;
    }
    return options;
}

const options = parseArguments(process.argv.slice(2));
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = resolve(
    options.reuse ??
        options.output ??
        join(ROOT, 'bench/results/raw/E01', `rcas-comparison-${stamp}`),
);

//* Benchmark execution ======================================================

function runBenchmark(mode, output, arguments_) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(
            process.execPath,
            [
                RUNNER,
                '--mode',
                mode,
                '--smoke',
                '--output',
                output,
                ...arguments_,
            ],
            {
                cwd: ROOT,
                stdio: 'inherit',
            },
        );
        child.once('error', rejectRun);
        child.once('exit', (code, signal) => {
            if (code === 0) resolveRun();
            else rejectRun(
                new Error(
                    `Benchmark ${relative(ROOT, output)} stopped with ${signal ?? `code ${code}`}.`,
                ),
            );
        });
    });
}

const sharedTiming = [
    '--ratios',
    '2',
    '--blocks',
    '3',
    '--warmup',
    '240',
    '--samples',
    '300',
];
const sharedCapture = [
    '--ratios',
    '2',
    '--frames',
    '0,120',
    '--views',
    'final',
    '--reloads',
    '1',
    '--allow-differences',
    '--review-all',
];

if (!options.reuse) {
    await mkdir(outputDirectory, { recursive: true });

    const limiterTiming = join(outputDirectory, 'lower-limiter-timing');
    const limiterCapture = join(outputDirectory, 'lower-limiter-review');
    const denoiseTiming = join(outputDirectory, 'denoise-default-timing');
    const denoiseCapture = join(outputDirectory, 'denoise-default-review');

    await runBenchmark('performance', limiterTiming, [
    '--variant',
    'local-baseline-5d6a65e',
    '--comparison',
    'rcas-fsr315-limiter',
    ...sharedTiming,
]);
    await runBenchmark('capture', limiterCapture, [
    '--variant',
    'local-baseline-5d6a65e',
    '--comparison',
    'rcas-fsr315-limiter',
    '--scenarios',
    'Q0,Q1,Q6',
    '--review-title',
    'RCAS: legacy vs FSR 3.1.5 lower limiter',
    ...sharedCapture,
]);
    await runBenchmark('performance', denoiseTiming, [
    '--variant',
    'rcas-fsr315-limiter',
    '--comparison',
    'rcas-fsr315-numeric',
    ...sharedTiming,
]);
    await runBenchmark('capture', denoiseCapture, [
    '--variant',
    'rcas-fsr315-limiter',
    '--comparison',
    'rcas-fsr315-numeric',
    '--scenarios',
    'Q0,Q1',
    '--review-title',
    'RCAS: lower limiter vs temporal denoise default',
    ...sharedCapture,
]);

//* Report ===================================================================

function median(values) {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function classify(delta) {
    const magnitude = Math.abs(delta);
    if (magnitude < 0.03) return 'tie / within practical noise';
    if (magnitude < 0.05) return 'uncertain';
    return delta > 0 ? 'candidate slower' : 'candidate faster';
}

async function timingRows(directory) {
    const analysis = JSON.parse(
        await readFile(join(directory, 'abba-analysis.json'), 'utf8'),
    );
    return ['rcas', 'compute-sum'].map((label) => {
        const entry = analysis.find((candidate) => candidate.label === label);
        const deltas = entry.median.rows.map(
            (row) => (row.meanB - row.meanA) / row.meanA,
        );
        const result = median(deltas);
        return {
            label,
            deltas,
            median: result,
            classification: classify(result),
        };
    });
}

async function captureRows(directory) {
    const analysis = JSON.parse(
        await readFile(join(directory, 'capture-analysis.json'), 'utf8'),
    );
    return analysis.pairs.map((pair) => ({
        tuple: pair.tuple,
        max255: pair.metrics.full.maxAbsolute * 255,
        rmse255: pair.metrics.full.rmse * 255,
    }));
}

function timingTable(rows) {
    return rows
        .map(
            (row) => `<tr>
<td>${row.label}</td>
<td>${row.deltas.map((value) => `${(value * 100).toFixed(2)}%`).join(', ')}</td>
<td>${(row.median * 100).toFixed(2)}%</td>
<td>${row.classification}</td>
</tr>`,
        )
        .join('');
}

function captureTable(rows) {
    return rows
        .map(
            (row) => `<tr>
<td>${row.tuple}</td>
<td>${row.max255.toFixed(2)} / 255</td>
<td>${row.rmse255.toFixed(3)} / 255</td>
</tr>`,
        )
        .join('');
}

    const limiterTimingRows = await timingRows(limiterTiming);
    const denoiseTimingRows = await timingRows(denoiseTiming);
    const limiterCaptureRows = await captureRows(limiterCapture);
    const denoiseCaptureRows = await captureRows(denoiseCapture);

    const report = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RCAS comparison</title>
<style>
    :root { color-scheme: dark; font: 15px/1.5 system-ui, sans-serif; background: #111; color: #eee; }
    body { max-width: 1100px; margin: 0 auto; padding: 28px; }
    section { margin: 28px 0; padding: 20px; border: 1px solid #444; border-radius: 8px; background: #181818; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; }
    a { color: #8cc8ff; }
    code { padding: 2px 5px; background: #292929; border-radius: 3px; }
    .note { color: #bbb; }
</style>
</head>
<body>
<h1>FSR 3.1.5 RCAS comparison</h1>
<p>This is a directional engineering comparison, not a publication-grade benchmark. Candidate B deltas below 3% are treated as tied, 3–5% as uncertain, and at least 5% as actionable.</p>
<section>
<h2>1. Legacy RCAS vs lower limiter</h2>
<p><a href="lower-limiter-review/review.html">Open blinded visual review</a></p>
<table><thead><tr><th>Timing</th><th>Three A/B repetitions</th><th>Median</th><th>Interpretation</th></tr></thead>
<tbody>${timingTable(limiterTimingRows)}</tbody></table>
<h3>Pixel differences</h3>
<table><thead><tr><th>Capture</th><th>Maximum</th><th>RMSE</th></tr></thead>
<tbody>${captureTable(limiterCaptureRows)}</tbody></table>
</section>
<section>
<h2>2. Lower limiter vs temporal denoise default</h2>
<p><a href="denoise-default-review/review.html">Open blinded visual review</a></p>
<table><thead><tr><th>Timing</th><th>Three A/B repetitions</th><th>Median</th><th>Interpretation</th></tr></thead>
<tbody>${timingTable(denoiseTimingRows)}</tbody></table>
<h3>Pixel differences</h3>
<table><thead><tr><th>Capture</th><th>Maximum</th><th>RMSE</th></tr></thead>
<tbody>${captureTable(denoiseCaptureRows)}</tbody></table>
</section>
<p class="note">The review orientation is deterministically blinded. Use the ROI overlay and 4× zoom; visual regressions override timing wins. Raw JSON, PNGs, and heatmaps are retained beside this report.</p>
</body>
</html>`;

    await writeFile(join(outputDirectory, 'index.html'), report);
}

//* Local review server ======================================================

if (options['no-serve']) {
    console.log(`RCAS comparison written to ${outputDirectory}`);
    process.exit(0);
}

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
};
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(
            new URL(request.url ?? '/', 'http://localhost').pathname,
        );
        const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = resolve(outputDirectory, requested);
        if (file !== outputDirectory && !file.startsWith(`${outputDirectory}${sep}`))
            throw new Error('Invalid review path.');
        const body = await readFile(file);
        response.writeHead(200, {
            'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
        });
        response.end(body);
    } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    }
});

await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(Number(options.port ?? 0), '127.0.0.1', resolveListen);
});
const address = server.address();
const url = `http://127.0.0.1:${address.port}/`;
console.log(`RCAS comparison ready: ${url}`);
console.log('Press Ctrl+C when review is complete.');

if (!options['no-open'] && process.platform === 'darwin') {
    const opener = spawn('open', [url], { detached: true, stdio: 'ignore' });
    opener.unref();
}
