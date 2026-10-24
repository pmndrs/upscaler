import { npmInvocation } from './npm-command.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeTempDirectory } from './local-processes.mjs';
import { packLibrary } from './pack-library.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc');

export const USAGE = `Usage: node scripts/verify-packed-subpaths.mjs [options]
Builds + packs the library, then checks every public subpath against the packed
artifact (GPU-free; CI runs it):
  1. each entry's import graph (JS and .d.ts) names only its own engine;
  2. a fresh consumer per engine, with ONLY that engine installed, typechecks
     and bundles an import of its subpath.
  --skip-build   pack the existing dist/ instead of rebuilding it
  --keep-temp    keep the consumers for inspection
  --help, -h     print this message and exit`;

/**
 * The bare specifiers each published entry may import. A specifier outside
 * its list is an engine leaking across subpaths: `/core` must install with no
 * engine at all, `/babylon` and `/pixi` without three.
 */
const THREE = [/^three$/, /^three\/(tsl|webgpu)$/];
export const SUBPATHS = {
    index: { specifier: '@pmndrs/upscaler', allowed: THREE },
    three: { specifier: '@pmndrs/upscaler/three', allowed: THREE },
    core: { specifier: '@pmndrs/upscaler/core', allowed: [] },
    babylon: { specifier: '@pmndrs/upscaler/babylon', allowed: [/^@babylonjs\/core\//] },
    pixi: { specifier: '@pmndrs/upscaler/pixi', allowed: [/^pixi\.js$/] },
};

/**
 * One consumer project per engine: the packages it installs next to the
 * packed library, and a source file that imports and uses its subpaths.
 */
export const CONSUMERS = {
    three: {
        packages: ['three', '@types/three'],
        source: `import type { Camera, Scene } from 'three/webgpu';
import { QualityMode, Upscaler, upscaleScene } from '@pmndrs/upscaler';
import { Upscaler as ThreeUpscaler, UpscalePass } from '@pmndrs/upscaler/three';

export function node(scene: Scene, camera: Camera) {
    return upscaleScene(scene, camera, { quality: QualityMode.Quality });
}
// One shared chunk: the root and /three entries export the same class.
export const sameClass: boolean = (Upscaler as unknown) === ThreeUpscaler;
export { UpscalePass };
`,
    },
    core: {
        packages: [],
        source: `import { QualityMode, UpscalerCore } from '@pmndrs/upscaler/core';

export function create(device: GPUDevice) {
    const core = new UpscalerCore({ device });
    core.configure({ displayWidth: 1920, displayHeight: 1080, qualityMode: QualityMode.Quality });
    return core;
}
`,
    },
    babylon: {
        packages: ['@babylonjs/core'],
        source: `import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { BABYLON_MOTION_SCALE, FrameGraphUpscaleTask, Upscaler } from '@pmndrs/upscaler/babylon';

export function create(engine: AbstractEngine, scene: Scene) {
    return new Upscaler({ engine, scene });
}
export { BABYLON_MOTION_SCALE, FrameGraphUpscaleTask };
`,
    },
    pixi: {
        packages: ['pixi.js'],
        source: `import type { Renderer } from 'pixi.js';
import { QualityMode, Upscaler } from '@pmndrs/upscaler/pixi';

export function create(renderer: Renderer) {
    const upscaler = new Upscaler({ renderer });
    upscaler.configure({ displayWidth: 1920, displayHeight: 1080, path: 'spatial', qualityMode: QualityMode.Quality });
    return upscaler;
}
`,
    },
};

const CONSUMER_TSCONFIG = {
    compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['@webgpu/types'],
        // The engines' own declarations aren't ours to check; ours are walked
        // specifier by specifier in checkImportGraph.
        skipLibCheck: true,
        noEmit: true,
    },
    include: ['main.ts'],
};

export function parseArguments(argv) {
    const options = { skipBuild: false, keepTemp: false, help: false };
    for (const argument of argv) {
        if (argument === '--skip-build') options.skipBuild = true;
        else if (argument === '--keep-temp') options.keepTemp = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else throw new Error(`Unknown option ${argument}.\n\n${USAGE}`);
    }
    return options;
}

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * The module specifiers a JS or .d.ts file imports or re-exports.
 * @param {string} source - File contents
 * @returns {string[]} Specifiers in order of appearance, deduplicated
 */
export function importSpecifiers(source) {
    return [...new Set([...source.matchAll(IMPORT_PATTERN)].map(match => match[1]))];
}

/**
 * Follows an entry's relative imports through the package and collects every
 * bare specifier the graph reaches.
 * @param {string} entry - Absolute path of a dist entry (.js or .d.ts)
 * @param {(path: string) => string} [read] - File reader (tests inject one)
 * @returns {Set<string>} The bare specifiers
 */
export function bareImports(entry, read = path => readFileSync(path, 'utf8')) {
    const bare = new Set();
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        for (const specifier of importSpecifiers(read(file))) {
            if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
            else bare.add(specifier);
        }
    }
    return bare;
}

/**
 * Checks every subpath's JS and declaration graph against its allowlist.
 * @param {string} packageDirectory - The unpacked package root
 * @param {(path: string) => string} [read] - File reader (tests inject one)
 * @returns {string[]} Failures; empty when every graph is clean
 */
export function checkImportGraph(packageDirectory, read) {
    const failures = [];
    for (const [name, { allowed }] of Object.entries(SUBPATHS)) {
        for (const extension of ['.js', '.d.ts']) {
            const entry = join(packageDirectory, 'dist', name + extension);
            for (const specifier of bareImports(entry, read))
                if (!allowed.some(pattern => pattern.test(specifier)))
                    failures.push(`dist/${name}${extension} reaches '${specifier}', outside its engine`);
        }
    }
    return failures;
}

function run(command, args, options = {}) {
    const invocation = command === 'npm' ? npmInvocation(args) : [command, args];
    const result = spawnSync(...invocation, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...options });
    if (result.status !== 0)
        throw new Error(`${basename(command)} ${args.join(' ')} failed with status ${result.status}.`);
}

function link(name, modules) {
    const target = join(ROOT, 'node_modules', name);
    if (!existsSync(target)) throw new Error(`${name} is not installed in the repo; run pnpm install.`);
    const path = join(modules, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * A consumer directory that installs the packed library (a real copy, so its
 * bare imports resolve from the consumer's node_modules) plus only the
 * engine packages listed. A leaked import of another engine then fails to
 * resolve in both tsc and the bundle.
 */
function createConsumer(directory, archive, { packages, source }) {
    const modules = join(directory, 'node_modules');
    const packageDirectory = join(modules, '@pmndrs/upscaler');
    mkdirSync(packageDirectory, { recursive: true });
    run('tar', ['-xzf', archive, '-C', packageDirectory, '--strip-components=1']);
    for (const name of ['@webgpu/types', ...packages]) link(name, modules);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(CONSUMER_TSCONFIG, null, 4));
    writeFileSync(join(directory, 'main.ts'), source);
}

async function bundleConsumer(directory) {
    const { build } = await import('vite');
    // Library mode bundles every dependency, so each import must resolve.
    await build({
        root: directory,
        configFile: false,
        logLevel: 'warn',
        build: {
            lib: { entry: join(directory, 'main.ts'), formats: ['es'], fileName: 'consumer' },
            outDir: join(directory, 'dist'),
            minify: false,
            reportCompressedSize: false,
        },
    });
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return;
    }
    const temporaryRoot = mkdtempSync(join(tmpdir(), `upscaler-packed-subpaths-${process.pid}-`));
    try {
        if (!options.skipBuild) {
            console.log('Building @pmndrs/upscaler...');
            run('npm', ['run', 'build']);
        }
        const archive = packLibrary(temporaryRoot);

        const unpacked = join(temporaryRoot, 'unpacked');
        mkdirSync(unpacked);
        run('tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1']);
        const failures = checkImportGraph(unpacked);
        if (failures.length) throw new Error(`Subpath import graph:\n${failures.join('\n')}`);
        console.log(`Import graphs clean: ${Object.keys(SUBPATHS).join(', ')}.`);

        for (const [name, consumer] of Object.entries(CONSUMERS)) {
            const directory = join(temporaryRoot, `consumer-${name}`);
            mkdirSync(directory);
            createConsumer(directory, archive, consumer);
            const installed = consumer.packages.length ? consumer.packages.join(', ') : 'no engine';
            console.log(`Consumer '${name}' (${installed}): typecheck + bundle...`);
            run(process.execPath, [TSC_BIN, '-p', join(directory, 'tsconfig.json')], { cwd: directory });
            await bundleConsumer(directory);
        }
        console.log('Packed subpath verification passed.');
    } finally {
        if (options.keepTemp) console.log(`Kept packed consumers at ${temporaryRoot}`);
        else await removeTempDirectory(temporaryRoot, 'packed consumer directory');
    }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain)
    main().catch((error) => {
        console.error(error instanceof Error ? error.stack : error);
        process.exitCode = 1;
    });
