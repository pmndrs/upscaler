import { npmInvocation } from './npm-command.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parsePackJson } from './npm-pack-json.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const PRIVATE_PACKAGE_PREFIX = '@pmndrs/upscaler-';
const candidatePathPattern = /(?:^|\/)candidate[^/]*(?:\/|$)/i;
const candidateMarkers = [
    'transparencyAndComposition?:',
    'fn easuApproxRcp(v : f32) -> f32 {',
    'fn sampleHistoryLanczos(uv : vec2f) -> vec4f {',
    'var candidateMasks : texture_2d<f32>;',
    'REACTIVE_USE_COMPONENT_MAX',
    'PREPARE_STRUCTURAL_SIGNALS',
    'DEPTH_CLIP_MOTION_DIVERGENCE',
    'var transparencyCompositionMask : texture_2d<f32>;',
    'atomicMax(&reconstructedDepth.values[index], encoded);',
    'var externalConditioning : texture_2d<f32>;',
    'var shadingMip2 : texture_storage_2d<rgba16float, write>;',
    'var shadingPyramid : texture_2d<f32>;',
    'var instabilityOut : texture_storage_2d<r32float, write>;',
    'fsr315-source-resolver-v1',
];

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

function assertCleanFiles(files, source) {
    const failures = [];
    for (const file of files) {
        const packagePath = relative(root, file).replaceAll('\\', '/');
        if (candidatePathPattern.test(packagePath))
            failures.push(`${source} includes candidate path: ${packagePath}`);
        if (!statSync(file).isFile()) continue;

        const contents = readFileSync(file, 'utf8');
        for (const marker of candidateMarkers)
            if (contents.includes(marker))
                failures.push(`${source} includes candidate marker in ${packagePath}: ${marker}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
}

//* Dist Bundle ===

const distFiles = walk(dist);
assertCleanFiles(distFiles, 'dist');

//* Package Manifest ===

const packed = spawnSync(
    ...npmInvocation(['pack', '--dry-run', '--ignore-scripts', '--json']),
    { cwd: root, encoding: 'utf8' },
);
if (packed.status !== 0)
    throw new Error(`npm pack --dry-run failed:\n${packed.stderr || packed.stdout}`);

const [packResult] = parsePackJson(packed.stdout);
const packageFiles = packResult.files.map(({ path }) => resolve(root, path));
assertCleanFiles(packageFiles, 'npm package');

//* Private Workspace Packages ===

// packages/* are bundled in and never published, so the artifact must not name
// one: a consumer install could not resolve it.
const leaks = distFiles.filter((file) => readFileSync(file, 'utf8').includes(PRIVATE_PACKAGE_PREFIX));
if (leaks.length)
    throw new Error(`dist references a private workspace package (${PRIVATE_PACKAGE_PREFIX}*):\n${leaks.map((file) => relative(root, file)).join('\n')}`);

const jsBytes = distFiles.filter((file) => file.endsWith('.js')).reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`Verified candidate-free artifacts. dist/**/*.js: ${jsBytes} bytes.`);
