import { expect, test } from 'vitest';

import { checkImportGraph, importSpecifiers, parseArguments } from './verify-packed-subpaths.mjs';

const CLEAN = {
    'index.js': 'export * from "./three.js";',
    'three.js': 'import { a } from "./chunks/shared.js";\nimport { Vector2 } from "three/webgpu";\nimport { uniform } from "three/tsl";',
    'core.js': 'import { a } from "./chunks/shared.js";',
    'babylon.js': 'import { a } from "./chunks/shared.js";\nimport { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask.js";',
    'pixi.js': 'import { a } from "./chunks/shared.js";\nimport { TextureSource } from "pixi.js";',
    'chunks/shared.js': 'export const a = 1;',
    'index.d.ts': "import { Camera } from 'three/webgpu';",
    'three.d.ts': "export * from './index.js';\nimport 'three';",
    'core.d.ts': 'export declare const a: number;',
    'babylon.d.ts': "import type { Scene } from '@babylonjs/core/scene.js';",
    'pixi.d.ts': "import type { Texture } from 'pixi.js';",
};

function reader(files) {
    return (path) => {
        const key = path.replaceAll('\\', '/').replace(/^.*\/dist\//, '');
        if (!(key in files)) throw new Error(`unexpected read: ${key}`);
        return files[key];
    };
}

test('collects static, side-effect, re-export and dynamic specifiers', () => {
    const source = [
        'import { a } from "./a.js";',
        "import 'three';",
        "export * from './b.js';",
        'const m = import("pixi.js");',
        'import { c } from "./a.js";',
    ].join('\n');
    expect(importSpecifiers(source)).toEqual(['./a.js', 'three', './b.js', 'pixi.js']);
});

test('a clean artifact passes', () => {
    expect(checkImportGraph('/pkg', reader(CLEAN))).toEqual([]);
});

test('an engine reached through a shared chunk fails the entry that imports it', () => {
    const files = { ...CLEAN, 'chunks/shared.js': 'import { Vector2 } from "three/webgpu";\nexport const a = 1;' };
    expect(checkImportGraph('/pkg', reader(files))).toEqual([
        "dist/core.js reaches 'three/webgpu', outside its engine",
        "dist/babylon.js reaches 'three/webgpu', outside its engine",
        "dist/pixi.js reaches 'three/webgpu', outside its engine",
    ]);
});

test('declarations are checked too', () => {
    const files = { ...CLEAN, 'pixi.d.ts': "import type { Texture } from 'pixi.js';\nimport type { Camera } from 'three';" };
    expect(checkImportGraph('/pkg', reader(files))).toEqual(["dist/pixi.d.ts reaches 'three', outside its engine"]);
});

test('parses options and rejects unknown ones', () => {
    expect(parseArguments([])).toEqual({ skipBuild: false, keepTemp: false, help: false });
    expect(parseArguments(['--skip-build', '--keep-temp'])).toMatchObject({ skipBuild: true, keepTemp: true });
    expect(parseArguments(['-h']).help).toBe(true);
    expect(() => parseArguments(['--'])).toThrow(/Unknown option --/);
});
