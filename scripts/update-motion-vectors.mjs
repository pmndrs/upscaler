#!/usr/bin/env node
/**
 * Vendors a packed `@pmndrs/motion-vectors` for the bench (its Phase 4: the
 * upscaler consumes the package from a packed tarball, not a link). The
 * package is private until 0.x, so CI can only install it from a tarball in
 * this repo. Packs a motion-vectors checkout (`npm pack` runs its build),
 * names the tarball after the commit it came from, replaces any older one in
 * vendor/motion-vectors/ and points the devDependency at it.
 *
 * Usage:
 *   node scripts/update-motion-vectors.mjs --from ../motion-vectors
 *   pnpm install
 *
 * Once 0.x is on npm, the devDependency becomes a version range and
 * vendor/motion-vectors/ goes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseCliOrExit } from './cli-flags.mjs';
import { npmInvocation } from './npm-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const VENDOR = join(ROOT, 'vendor/motion-vectors');
const USAGE = `Usage: node scripts/update-motion-vectors.mjs --from <motion-vectors checkout>
Packs that checkout into vendor/motion-vectors/ and points the devDependency at it; then run pnpm install.`;
const cli = parseCliOrExit(process.argv.slice(2), ['from'], USAGE);
if (!cli.from) {
    console.error(USAGE);
    process.exit(1);
}
const source = resolve(cli.from);

const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--short=10', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
if (dirty) console.warn(`warning: ${source} has uncommitted changes; the tarball won't match commit ${sha}.`);

mkdirSync(VENDOR, { recursive: true });
const [command, args] = npmInvocation(['pack', '--json', '--pack-destination', VENDOR]);
const [packed] = JSON.parse(execFileSync(command, args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const name = `pmndrs-motion-vectors-${packed.version}-${sha}${dirty ? '-dirty' : ''}.tgz`;
for (const file of readdirSync(VENDOR)) if (file.endsWith('.tgz') && file !== packed.filename) rmSync(join(VENDOR, file));
renameSync(join(VENDOR, packed.filename), join(VENDOR, name));

const manifestPath = join(ROOT, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.devDependencies['@pmndrs/motion-vectors'] = `file:vendor/motion-vectors/${name}`;
manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`vendor/motion-vectors/${name} (${packed.files.length} files, ${packed.size} bytes, from ${sha}). Now run: pnpm install`);
