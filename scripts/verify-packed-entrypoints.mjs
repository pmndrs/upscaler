import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { npmInvocation } from './npm-command.mjs';
import { parsePackJson } from './npm-pack-json.mjs';
import { removeTempDirectory } from './local-processes.mjs';

const root = resolve(import.meta.dirname, '..');
function run(args, cwd) {
    const result = spawnSync(...npmInvocation(args), { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}
const temporary = mkdtempSync(join(tmpdir(), 'upscaler-entrypoints-'));
try {
    const [packed] = parsePackJson(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
    const archive = join(temporary, packed.filename);
    for (const [entry, dependencies, forbidden] of [
        ['core', [], ['three', '@babylonjs/core']],
        ['babylon', ['@babylonjs/core@9.29.0'], ['three']],
        ['', ['three@0.186.1', '@types/three@0.186.0'], ['@babylonjs/core']],
    ]) {
        const directory = mkdtempSync(join(temporary, `${entry || 'three'}-`));
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module' }));
        run(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, 'typescript@5.7.3', ...dependencies], directory);
        for (const engine of forbidden) if (existsSync(join(directory, 'node_modules', engine))) throw new Error(`${entry}: unexpected engine dependency ${engine}`);
        const specifier = `@pmndrs/upscaler${entry ? '/' + entry : ''}`;
        const code = entry === 'core'
            ? `import { UpscalerCore, getResourceDescriptors } from '${specifier}';\nconst requirements = getResourceDescriptors({renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8});\nexport type Core = UpscalerCore; console.log(requirements.length);`
            : entry === 'babylon' ? `import { FrameGraphUpscaleTask } from '${specifier}'; console.log(FrameGraphUpscaleTask.name);`
            : `import { Upscaler, UpscalerNode, TemporalGuidesNode } from '${specifier}'; import * as facade from '@pmndrs/upscaler/three'; console.log(Upscaler === facade.Upscaler, UpscalerNode.name, TemporalGuidesNode.name);`;
        writeFileSync(join(directory, 'consumer.ts'), code);
        const tsc = spawnSync(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', ...(entry === 'core' ? [] : ['--skipLibCheck']), '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.ts'], { cwd: directory, encoding: 'utf8' });
        if (tsc.status !== 0) throw new Error(`${entry} declarations failed:\n${tsc.stdout}\n${tsc.stderr}`);
        const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('${specifier}');`], { cwd: directory, encoding: 'utf8' });
        if (runtime.status !== 0) throw new Error(`${entry} runtime import failed:\n${runtime.stderr}`);
        console.log(`Packed ${entry || 'root + /three'}: runtime and strict NodeNext consumer pass${entry === 'core' ? ' (including library declarations)' : ' (skipLibCheck for engine globals)'}; ${forbidden.join(', ')} absent.`);
    }
} finally { await removeTempDirectory(temporary, 'isolated package consumers'); }
