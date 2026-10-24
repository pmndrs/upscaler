import { npmInvocation } from './npm-command.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parsePackJson } from './npm-pack-json.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Packs the repo's (already built) package with `npm pack`, the same tool
 * publish.yml uses, so the archive holds exactly what npm would ship.
 * @param {string} archiveDirectory - Where the .tgz is written
 * @returns {string} The archive path
 */
export function packLibrary(archiveDirectory) {
    const result = spawnSync(
        ...npmInvocation(['pack', '--ignore-scripts', '--json', '--pack-destination', archiveDirectory]),
        {
            cwd: ROOT,
            encoding: 'utf8',
        },
    );
    if (result.status !== 0)
        throw new Error(`npm pack failed:\n${result.stderr || result.stdout}`);

    const filename = parsePackJson(result.stdout)[0].filename;
    if (!filename) throw new Error('npm pack did not report an artifact filename.');
    const archive = join(archiveDirectory, filename);
    if (existsSync(archive)) return archive;
    // npm 8 on Windows reports a scoped filename that differs from the actual tarball.
    const tarballs = readdirSync(archiveDirectory).filter(name => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('npm pack did not create one identifiable archive.');
    return join(archiveDirectory, tarballs[0]);
}
