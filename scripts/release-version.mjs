// Computes the next release version from Conventional Commit messages since the
// last v* tag, and prints it to stdout — or "none" when nothing warrants a
// release. Used by .github/workflows/publish.yml for auto-bump-on-push.
//
//   feat:            -> minor      fix: / perf:     -> patch
//   <type>!: / BREAKING CHANGE:    -> major (capped to minor while 0.x, so a
//                                    stray breaking change can't jump to 1.0.0)
//   docs/chore/ci/refactor/test/…  -> no release
//
// Run locally to preview: `node scripts/release-version.mjs`
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const [maj, min, pat] = version.split('-')[0].split('.').map(Number);

// Commits since the most recent v* tag (all history if there is no tag yet).
let range = '';
try {
    const lastTag = execSync('git describe --tags --match "v*" --abbrev=0', {
        stdio: ['ignore', 'pipe', 'ignore'],
    })
        .toString()
        .trim();
    if (lastTag) range = `${lastTag}..HEAD`;
} catch {
    /* no tags yet — scan all history */
}

const log = execSync(`git log ${range} --format=%B%x00`, { encoding: 'utf8' });
const commits = log.split('\0').map((s) => s.trim()).filter(Boolean);

const rank = { none: 0, patch: 1, minor: 2, major: 3 };
let bump = 'none';
for (const commit of commits) {
    const subject = commit.split('\n')[0];
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:/);
    const breaking = (m && m[3] === '!') || /(^|\n)BREAKING CHANGE:/.test(commit);
    let level = 'none';
    if (breaking) level = 'major';
    else if (m && m[1] === 'feat') level = 'minor';
    else if (m && (m[1] === 'fix' || m[1] === 'perf')) level = 'patch';
    if (rank[level] > rank[bump]) bump = level;
}

if (bump === 'none') {
    console.log('none');
    process.exit(0);
}

// Stay in 0.x: a breaking change bumps minor rather than cutting 1.0.0.
if (maj === 0 && bump === 'major') bump = 'minor';

const next =
    bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
console.log(next);
