// Drives publish.yml's shell steps end to end against throwaway Git
// repositories: a bare "origin" plus a fresh clone per run, with fake `npm`
// (real `npm version`, fake registry/publish) and fake `gh` on PATH, and a `git`
// wrapper that can inject a concurrent merge. Each step's `if:` and `env:` are
// read from the YAML and evaluated the way Actions would, so these tests break
// when the workflow drifts. GPU-free; nothing touches GitHub or npm.
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';
import { bash, shellEnvironment, shellPath, shellQuote, which } from './test-shell.mjs';
import { npmInvocation } from './npm-command.mjs';

const SLOW = 60_000;

// Every job runs on spawnSync, and vitest only yields microtasks between tests,
// so the worker can't read its RPC replies until the file ends; past ~60s that
// surfaces as an unhandled 'Timeout calling "onTaskUpdate"'. A macrotask turn
// between tests lets them through.
afterEach(() => new Promise((resolve) => setImmediate(resolve)));
const workflow = readFileSync(
    new URL('../.github/workflows/publish.yml', import.meta.url),
    'utf8',
).replaceAll('\r\n', '\n');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

//* Workflow Parsing ===

/**
 * Splits the single job's steps into { name, id, if, env, run } records.
 * Only the YAML shapes publish.yml uses are understood.
 */
function parseSteps(text) {
    const body = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
    return body.split(/\n(?= {6}- )/).map((chunk) => {
        const lines = chunk.split('\n');
        const step = { env: {} };
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].replace(/^ {6}- /, '        ');
            let match;
            if ((match = line.match(/^ {8}name: (.+)$/))) step.name = match[1];
            else if ((match = line.match(/^ {8}id: (.+)$/))) step.id = match[1];
            else if ((match = line.match(/^ {8}if: (.+)$/))) step.if = match[1];
            else if ((match = line.match(/^ {8}uses: (.+)$/))) step.uses = match[1];
            else if ((match = line.match(/^ {8}run: (?!\|)(.+)$/))) step.run = match[1];
            else if (/^ {8}run: \|$/.test(line)) {
                const script = [];
                while (index + 1 < lines.length && (lines[index + 1] === '' || /^ {10}/.test(lines[index + 1])))
                    script.push(lines[++index].slice(10));
                step.run = script.join('\n');
            } else if (/^ {8}env:$/.test(line)) {
                while (index + 1 < lines.length && /^ {10}\S/.test(lines[index + 1])) {
                    const [, key, value] = lines[++index].match(/^ {10}([A-Z_]+): (.+)$/);
                    step.env[key] = value;
                }
            }
        }
        return step;
    });
}

const steps = parseSteps(workflow);

function step(name) {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing workflow step: ${name}`);
    return found;
}

/** Evaluates the handful of `${{ }}` expressions the workflow uses. */
function evaluate(expression, context) {
    const trimmed = expression.trim();
    const match = trimmed.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/);
    if (match) return context.outputs[match[1]]?.[match[2]] ?? '';
    const values = {
        'github.event_name': context.event,
        'github.ref': context.ref,
        'inputs.version': context.inputs.version ?? '',
        'inputs.preid': context.inputs.preid ?? '',
        'github.token': 'test-token',
        'github.repository': 'pmndrs/upscaler',
    };
    if (trimmed in values) return values[trimmed];
    throw new Error(`Unsupported workflow expression: ${trimmed}`);
}

function interpolate(value, context) {
    return value.replace(/\$\{\{(.+?)\}\}/g, (_, expression) => evaluate(expression, context));
}

function condition(expression, context) {
    if (!expression) return true;
    const match = expression.match(/^steps\.([\w-]+)\.outputs\.([\w-]+) (==|!=) '([^']*)'$/);
    if (!match) throw new Error(`Unsupported workflow condition: ${expression}`);
    const equal = (context.outputs[match[1]]?.[match[2]] ?? '') === match[4];
    return match[3] === '==' ? equal : !equal;
}

//* Fixtures ===

function git(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
}

function configureUser(directory) {
    git(directory, ['config', 'user.name', 'Workflow Test']);
    git(directory, ['config', 'user.email', 'workflow@example.test']);
    // Fixtures must not launch the host's signing agent or interactive pinentry.
    git(directory, ['config', 'commit.gpgsign', 'false']);
    git(directory, ['config', 'tag.gpgsign', 'false']);
}

function writePackage(directory, version) {
    writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({ name: '@pmndrs/upscaler', version }, null, 4)}\n`,
    );
}

function commit(directory, message) {
    git(directory, ['add', '-A']);
    git(directory, ['commit', '-q', '--allow-empty', '-m', message]);
    return git(directory, ['rev-parse', 'HEAD']);
}


const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
    version) exec "$REAL_NPM" "$@" ;;
esac
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
    install|ci) exit 0 ;;
    publish)
        [[ "$NPM_PUBLISH_MODE" == "fail" ]] && { printf 'npm error code E403\\n' >&2; exit 1; }
        printf 'published %s\\n' "$(node -p "require('./package.json').version")" >> "$NPM_LOG"
        exit 0
        ;;
    view)
        if [[ "\${3:-}" == "dist-tags.latest" ]]; then
            case "$NPM_LATEST_MODE" in
                none) printf 'npm error code E404\\n' >&2; exit 1 ;;
                empty) exit 0 ;;
                auth) printf 'npm error code E401\\n' >&2; exit 1 ;;
                network) printf 'npm error code ECONNRESET\\n' >&2; exit 1 ;;
                server) printf 'npm error code E500\\n' >&2; exit 1 ;;
                indeterminate) printf 'unexpected registry response\\n' >&2; exit 1 ;;
                *) printf '%s\\n' "$NPM_LATEST_MODE" ;;
            esac
            exit 0
        fi
        version="\${2##*@}"
        case "$NPM_MODE" in
            published) printf '%s\\n' "$version" ;;
            absent) printf 'npm error code E404\\n' >&2; exit 1 ;;
            auth) printf 'npm error code E401\\n' >&2; exit 1 ;;
            network) printf 'npm error code ECONNRESET\\n' >&2; exit 1 ;;
            server) printf 'npm error code E500\\n' >&2; exit 1 ;;
            indeterminate) printf 'unexpected registry response\\n' >&2; exit 1 ;;
            *) printf 'unexpected NPM_MODE: %s\\n' "$NPM_MODE" >&2; exit 2 ;;
        esac
        ;;
    *) printf 'unexpected npm command: %s\\n' "$*" >&2; exit 2 ;;
esac
`;

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "release" && "$2" == "create" ]]; then
    printf '%s\\n' "$*" >> "$GH_LOG"
    exit 0
fi
[[ "$1 $2 $3" == "api --paginate repos/pmndrs/upscaler/releases" ]] || { printf 'unexpected gh: %s\\n' "$*" >&2; exit 2; }
case "$GH_MODE" in
    missing) printf 'v0.0.1\\tfalse\\n' ;;
    published) printf 'v0.0.1\\tfalse\\n%s\\tfalse\\n' "$TAG" ;;
    draft) printf '%s\\ttrue\\n' "$TAG" ;;
    forbidden) printf 'HTTP 403: Resource not accessible by integration\\n' >&2; exit 1 ;;
    network) printf 'dial tcp: network unreachable\\n' >&2; exit 1 ;;
    *) printf 'unexpected GH_MODE: %s\\n' "$GH_MODE" >&2; exit 2 ;;
esac
`;

// On the first push while RACE_FILE exists, land a concurrent merge on origin
// first, so that push is rejected as a non-fast-forward.
const GIT_WRAPPER = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "push" && -n "\${RACE_FILE:-}" && -f "$RACE_FILE" ]]; then
    rm -f "$RACE_FILE"
    "$REAL_GIT" -C "$RACE_CLONE" pull -q --ff-only origin main
    "$REAL_GIT" -C "$RACE_CLONE" commit -q --allow-empty -m "fix: a concurrent merge"
    "$REAL_GIT" -C "$RACE_CLONE" push -q origin HEAD:refs/heads/main
fi
exec "$REAL_GIT" "$@"
`;

/**
 * Builds origin. History on main (all at package.json 0.2.0):
 *   v0.2.0 (no release scripts: a legacy tag) → "ci: add release tooling"
 *   → "feat: a feature"   ← main
 *
 * @param {{
 *   tag?: string;       // a tag on main's tip, as "Draft a new release" makes
 *   offMain?: string;   // a tag on a side-branch commit that never reached main
 * }} [options]
 */
function createFixture({ tag, offMain } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'release-workflow-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const bin = join(root, 'bin');
    for (const directory of [seed, bin]) mkdirSync(directory);
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);

    git(seed, ['init', '-q', '-b', 'main']);
    configureUser(seed);
    writePackage(seed, '0.2.0');
    commit(seed, 'release: v0.2.0 [skip ci]');
    git(seed, ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);

    mkdirSync(join(seed, 'scripts'));
    for (const script of ['release-notes.mjs', 'release-version.mjs'])
        copyFileSync(new URL(`./${script}`, import.meta.url), join(seed, 'scripts', script));
    commit(seed, 'ci: add release tooling');
    commit(seed, 'feat: a feature');
    if (tag) git(seed, ['tag', '-a', tag, '-m', tag]);

    if (offMain) {
        git(seed, ['checkout', '-q', '-b', 'side']);
        commit(seed, 'feat: unmerged work');
        git(seed, ['tag', '-a', offMain, '-m', offMain]);
        git(seed, ['checkout', '-q', 'main']);
    }

    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-q', 'origin', 'main', '--tags']);

    writeFileSync(join(bin, 'npm'), FAKE_NPM.replaceAll('\r\n', '\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), FAKE_GH.replaceAll('\r\n', '\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'git'), GIT_WRAPPER.replaceAll('\r\n', '\n'), { mode: 0o755 });
    const realNpm = process.platform === 'win32' ? join(bin, 'real-npm') : which('npm');
    if (process.platform === 'win32') {
        const [command, args] = npmInvocation([]);
        const script = '#!/usr/bin/env bash\nexec ' + [command, ...args].map(value => shellQuote(shellPath(value))).join(' ') + ' "$@"\n';
        writeFileSync(realNpm, script);
    }
    return { root, origin, seed, bin, realNpm, runs: 0 };
}

function withFixture(options, callback) {
    const fixture = createFixture(options);
    try {
        return callback(fixture);
    } finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
}

/** Lands a commit on origin's main from the seed checkout. */
function pushToMain(fixture, message, version) {
    git(fixture.seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
    if (version) writePackage(fixture.seed, version);
    commit(fixture.seed, message);
    git(fixture.seed, ['push', '-q', 'origin', 'main']);
}

const originGit = (fixture, args) => git(fixture.root, ['--git-dir', fixture.origin, ...args]);
const mainSubjects = (fixture) => originGit(fixture, ['log', '--format=%s', 'main']).split('\n');
const versionAt = (fixture, ref) => JSON.parse(originGit(fixture, ['show', `${ref}:package.json`])).version;

function readLog(path) {
    try {
        return readFileSync(path, 'utf8').split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Runs the job's `run:` steps in order, as Actions would after actions/checkout.
 *
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {{
 *   event?: 'push' | 'workflow_dispatch';
 *   tag?: string;                        // pushed tag (push events)
 *   ref?: string;                        // overrides github.ref
 *   inputs?: { version?: string; preid?: string };
 *   at?: string;                         // dispatch: check out this commit instead of main's tip
 *   npm?: string;                        // NPM_MODE for `npm view <name>@<version>`
 *   npmLatest?: string;                  // npm's latest version, or a NPM_LATEST_MODE failure mode
 *   gh?: string;                         // GH_MODE for the Release listing
 *   publish?: 'success' | 'fail';
 *   race?: boolean;                      // land a concurrent merge before the first push
 * }} [scenario]
 */
function runJob(
    fixture,
    {
        event = 'push',
        tag,
        ref,
        inputs = {},
        at,
        npm = 'absent',
        npmLatest = '0.2.0',
        gh = 'missing',
        publish = 'success',
        race = false,
    } = {},
) {
    const run = ++fixture.runs;
    const work = join(fixture.root, `work-${run}`);
    const temp = join(fixture.root, `runner-temp-${run}`);
    mkdirSync(temp);
    const context = {
        event,
        ref: ref ?? (event === 'push' ? `refs/tags/${tag}` : 'refs/heads/main'),
        inputs,
        outputs: {},
    };

    // actions/checkout: full history + tags; the pushed tag, or the dispatching branch.
    git(fixture.root, ['clone', '-q', fixture.origin, work]);
    // Cloning does not carry seed-local signing configuration into this checkout.
    configureUser(work);
    if (context.ref.startsWith('refs/tags/')) git(work, ['checkout', '-q', '--detach', context.ref]);
    else git(work, ['checkout', '-q', '-B', 'main', at ?? 'origin/main']);

    const raceFile = join(fixture.root, `race-${run}`);
    const raceClone = join(fixture.root, `race-clone-${run}`);
    if (race) {
        writeFileSync(raceFile, '');
        git(fixture.root, ['clone', '-q', fixture.origin, raceClone]);
        configureUser(raceClone);
    }

    if (process.platform === 'win32' && race) {
        // Native Git cannot execute the extensionless Bash shim.
        // Its pre-push hook injects the same race before refs are updated.
        const hooks = join(fixture.root, 'hooks-' + run);
        mkdirSync(hooks);
        const hook = GIT_WRAPPER.replace('if [[ "$1" == "push" && -n', 'if [[ -n')
            .replace('exec "$REAL_GIT" "$@"', 'exit 0').replaceAll('\r\n', '\n');
        writeFileSync(join(hooks, 'pre-push'), hook);
        git(work, ['config', 'core.hooksPath', hooks]);
    }

    const npmLog = join(fixture.root, `npm-${run}.log`);
    const ghLog = join(fixture.root, `gh-${run}.log`);
    let failed = null;
    let output = '';
    for (const [index, current] of steps.entries()) {
        if (!current.run || !condition(current.if, context)) continue;
        expect(current.run, `${current.name ?? current.run} must not inline expressions`).not.toMatch(/\$\{\{/);
        const outputPath = join(temp, `output-${index}`);
        writeFileSync(outputPath, '');
        const env = Object.fromEntries(
            Object.entries(current.env).map(([key, value]) => [key, interpolate(value, context)]),
        );
        const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', current.run], {
            cwd: work,
            encoding: 'utf8',
            env: shellEnvironment({
                ...env,
                REAL_GIT: which('git'),
                REAL_NPM: shellPath(fixture.realNpm),
                RUNNER_TEMP: shellPath(temp),
                GITHUB_OUTPUT: shellPath(outputPath),
                NPM_LOG: shellPath(npmLog),
                GH_LOG: shellPath(ghLog),
                NPM_MODE: npm,
                NPM_LATEST_MODE: npmLatest,
                GH_MODE: gh,
                NPM_PUBLISH_MODE: publish,
                RACE_FILE: race ? shellPath(raceFile) : '',
                RACE_CLONE: shellPath(raceClone),
            }, [fixture.bin]),
        });
        output += result.stdout + result.stderr;
        if (current.id)
            context.outputs[current.id] = Object.fromEntries(
                readFileSync(outputPath, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
            );
        if (result.status !== 0) {
            failed = current.name ?? current.run;
            break;
        }
    }

    const npmCalls = readLog(npmLog);
    const notesPath = join(temp, 'release-notes.md');
    return {
        failed,
        output,
        outputs: context.outputs,
        publishes: npmCalls.filter((line) => line.startsWith('publish ')),
        latestLookups: npmCalls.filter((line) => line.endsWith(' dist-tags.latest')),
        publishedVersions: npmCalls.filter((line) => line.startsWith('published ')).map((line) => line.slice(10)),
        installs: npmCalls.filter((line) => line === 'ci'),
        releases: readLog(ghLog),
        notes: existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : null,
    };
}

//* Trigger ===

describe('trigger', () => {
    const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));

    test('publishes on v* tag pushes and never on branch pushes', () => {
        expect(on).toMatch(/\n {2}push:\n {4}tags: \['v\*'\]\n/);
        expect(on).not.toMatch(/branches|pull_request|schedule/);
    });

    test('offers a Run workflow button with version (default auto) and preid inputs', () => {
        expect(on).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}version:\n/);
        expect(on).toMatch(/ {6}version:[\s\S]*?default: auto\n/);
        expect(on).toMatch(/ {6}preid:[\s\S]*?required: false\n/);
    });
});

//* Path 1: Tag Push ===

describe('tag push (including a tag made in the GitHub UI)', () => {
    test(
        'the tag is the version: stamps package.json, publishes, creates the Release, catches main up',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const tagged = originGit(fixture, ['rev-parse', 'v0.3.0^{commit}']);
                expect(versionAt(fixture, tagged)).toBe('0.2.0');

                const job = runJob(fixture, { tag: 'v0.3.0' });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain('package.json at v0.3.0 says 0.2.0; publishing it as 0.3.0');
                expect(job.outputs.resolve).toEqual({ tag: 'v0.3.0', mode: 'tag' });
                expect(job.outputs.release).toMatchObject({ version: '0.3.0', latest: 'true' });
                expect(job.outputs.dist).toEqual({ tag: 'latest' });
                expect(job.publishes).toEqual(['publish --access public --tag latest']);
                expect(job.publishedVersions).toEqual(['0.3.0']);
                expect(job.releases).toHaveLength(1);
                expect(job.releases[0]).toMatch(/^release create v0\.3\.0 .*--verify-tag.* --latest$/);
                expect(job.notes).toContain('a feature');
                expect(job.notes).toContain('compare/v0.2.0...v0.3.0');

                // Catch-up: one fast-forward commit, untagged; the tag never moves.
                expect(mainSubjects(fixture).slice(0, 2)).toEqual(['release: v0.3.0 [skip ci]', 'feat: a feature']);
                expect(versionAt(fixture, 'main')).toBe('0.3.0');
                expect(originGit(fixture, ['rev-parse', 'main~1'])).toBe(tagged);
                expect(originGit(fixture, ['rev-parse', 'v0.3.0^{commit}'])).toBe(tagged);
                expect(originGit(fixture, ['tag', '--points-at', 'main'])).toBe('');
            }),
        SLOW,
    );

    test.each([
        ['v0.3.0-beta.1', 'beta'],
        ['v0.3.0-rc.0', 'rc'],
        ['v0.3.0-0', 'next'],
    ])(
        'publishes prerelease %s to dist-tag %s as a GitHub prerelease',
        (tag, distTag) =>
            withFixture({ tag }, (fixture) => {
                const job = runJob(fixture, { tag });

                expect(job.failed, job.output).toBeNull();
                expect(job.publishes).toEqual([`publish --access public --tag ${distTag}`]);
                expect(job.publishedVersions).toEqual([tag.slice(1)]);
                expect(job.releases[0]).toMatch(/--prerelease --latest=false$/);
            }),
        SLOW,
    );

    test(
        'skips the catch-up when main has already moved past the tag',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                pushToMain(fixture, 'release: v0.4.0', '0.4.0');
                const before = originGit(fixture, ['rev-parse', 'main']);

                const job = runJob(fixture, { tag: 'v0.3.0' });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain("main's package.json is 0.4.0, not behind 0.3.0");
                expect(originGit(fixture, ['rev-parse', 'main'])).toBe(before);
            }),
        SLOW,
    );

    test(
        'retries the catch-up on top of a concurrent merge, without rewriting history',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', race: true });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain('main moved while catching up (attempt 1 of 3)');
                expect(mainSubjects(fixture).slice(0, 3)).toEqual([
                    'release: v0.3.0 [skip ci]',
                    'fix: a concurrent merge',
                    'feat: a feature',
                ]);
                expect(versionAt(fixture, 'main')).toBe('0.3.0');
            }),
        SLOW,
    );

    test(
        'a failed publish creates no Release and no catch-up commit',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', publish: 'fail' });

                expect(job.failed).toBe('Publish to npm');
                expect(job.releases).toEqual([]);
                expect(mainSubjects(fixture)[0]).toBe('feat: a feature');
            }),
        SLOW,
    );
});

//* npm Dist-Tag ===

describe('npm dist-tag', () => {
    test(
        'a stable version newer than npm\'s latest takes latest',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npmLatest: '0.2.0' });

                expect(job.failed, job.output).toBeNull();
                expect(job.latestLookups).toEqual(['view @pmndrs/upscaler dist-tags.latest']);
                expect(job.output).toContain("0.3.0 is at or above npm's latest (0.2.0): dist-tag 'latest'");
                expect(job.outputs.dist).toEqual({ tag: 'latest' });
                expect(job.publishes).toEqual(['publish --access public --tag latest']);
            }),
        SLOW,
    );

    test(
        'a maintenance release on an older line publishes under its line tag, never latest',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                // 0.3.0 shipped and main caught up; then v0.2.1 is cut on an older main commit.
                pushToMain(fixture, 'release: v0.3.0 [skip ci]', '0.3.0');
                git(fixture.seed, ['tag', '-a', 'v0.2.1', '-m', 'v0.2.1', 'main~2']);
                git(fixture.seed, ['push', '-q', 'origin', 'v0.2.1']);
                const main = originGit(fixture, ['rev-parse', 'main']);

                const job = runJob(fixture, { tag: 'v0.2.1', npmLatest: '0.3.0' });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain(
                    "0.2.1 is older than npm's latest (0.3.0): publishing under dist-tag 'v0.2-latest'; 'latest' stays on 0.3.0",
                );
                expect(job.outputs.dist).toEqual({ tag: 'v0.2-latest' });
                expect(job.publishes).toEqual(['publish --access public --tag v0.2-latest']);
                expect(job.publishedVersions).toEqual(['0.2.1']);
                // Mirrors the GitHub Release rule: the older tag doesn't take "latest" there either.
                expect(job.releases[0]).toMatch(/^release create v0\.2\.1 .* --latest=false$/);
                expect(originGit(fixture, ['rev-parse', 'main'])).toBe(main);
            }),
        SLOW,
    );

    test(
        're-running the version npm already calls latest keeps latest',
        () =>
            withFixture({}, (fixture) => {
                expect(dispatch(fixture, { version: 'auto' }, { npmLatest: '0.2.0', gh: 'network' }).failed).toBe(
                    'Create GitHub Release',
                );

                // Equal is not older: a repair that reaches the publish step while npm's
                // latest is already this version keeps `latest`, not v0.3-latest.
                const repair = dispatch(fixture, { version: '0.3.0' }, { npmLatest: '0.3.0' });

                expect(repair.failed, repair.output).toBeNull();
                expect(repair.outputs.dist).toEqual({ tag: 'latest' });
            }),
        SLOW,
    );

    test.each([
        ['a 404 (the package is not on npm yet)', 'none'],
        ['no latest dist-tag', 'empty'],
    ])(
        'a first publish with %s takes latest',
        (_scenario, npmLatest) =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npmLatest });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain("npm has no latest for this package yet: 0.3.0 takes dist-tag 'latest'");
                expect(job.publishes).toEqual(['publish --access public --tag latest']);
            }),
        SLOW,
    );

    test.each(['auth', 'network', 'server', 'indeterminate'])(
        'an npm %s failure reading latest stops the run before publishing',
        (npmLatest) =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npmLatest });

                expect(job.failed).toBe('Choose npm dist-tag');
                expect(job.output).toMatch(/unable to read npm's latest dist-tag for @pmndrs\/upscaler/i);
                expect(job.installs).toEqual([]);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toEqual([]);
                expect(mainSubjects(fixture)[0]).toBe('feat: a feature');
            }),
        SLOW,
    );

    test(
        'an npm latest that is not a version stops the run before publishing',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npmLatest: 'garbage' });

                expect(job.failed).toBe('Choose npm dist-tag');
                expect(job.output).toMatch(/not a SemVer version: "garbage"/);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toEqual([]);
            }),
        SLOW,
    );

    test.each([
        ['v0.3.0-beta.1', 'beta'],
        ['v0.3.0-rc.0', 'rc'],
        ['v0.3.0-0', 'next'],
    ])(
        'prerelease %s still publishes to %s, without reading npm\'s latest',
        (tag, distTag) =>
            withFixture({ tag }, (fixture) => {
                // npm's latest is newer and unreadable alike: neither matters for a prerelease.
                for (const npmLatest of ['0.4.0', 'network']) {
                    const job = runJob(fixture, { tag, npmLatest });

                    expect(job.failed, job.output).toBeNull();
                    expect(job.latestLookups).toEqual([]);
                    expect(job.outputs.dist).toEqual({ tag: distTag });
                    expect(job.publishes).toEqual([`publish --access public --tag ${distTag}`]);
                }
            }),
        SLOW,
    );

    test(
        'a version already on npm skips the lookup along with the publish',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npm: 'published', npmLatest: 'network' });

                expect(job.failed, job.output).toBeNull();
                expect(job.latestLookups).toEqual([]);
                expect(job.publishes).toEqual([]);
            }),
        SLOW,
    );
});

//* Guards ===

describe('guards', () => {
    test.each([
        ['a tag on a commit that never reached main', { offMain: 'v0.3.0' }, 'v0.3.0', /not on origin\/main/],
        ['a tag that is not SemVer', { tag: 'v0.3' }, 'v0.3', /not a v-prefixed SemVer/],
        ['a v-prefixed tag that is not a version', { tag: 'vnext' }, 'vnext', /not a v-prefixed SemVer/],
    ])(
        'rejects %s before publishing anything',
        (_scenario, options, tag, message) =>
            withFixture(options, (fixture) => {
                const job = runJob(fixture, { tag });

                expect(job.failed).toBe('Verify release tag');
                expect(job.output).toMatch(message);
                expect(job.outputs.release).toEqual({});
                expect(job.installs).toEqual([]);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toEqual([]);
                expect(mainSubjects(fixture)[0]).toBe('feat: a feature');
            }),
        SLOW,
    );

    test(
        'no longer requires package.json to equal the tag',
        () =>
            withFixture({ tag: 'v0.5.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.5.0' });

                expect(job.failed, job.output).toBeNull();
                expect(job.publishedVersions).toEqual(['0.5.0']);
            }),
        SLOW,
    );

    test(
        'rejects a branch push even if one were routed to it',
        () =>
            withFixture({}, (fixture) => {
                const job = runJob(fixture, { ref: 'refs/heads/main' });

                expect(job.failed).toBe('Resolve release');
                expect(job.output).toMatch(/only for tag pushes/);
            }),
        SLOW,
    );
});

//* Path 2: Run Workflow ===

const dispatch = (fixture, inputs, extra = {}) =>
    runJob(fixture, { event: 'workflow_dispatch', inputs, ...extra });

describe('Run workflow button', () => {
    test.each([
        [{ version: 'auto' }, '0.3.0', 'latest'],
        [{ version: '' }, '0.3.0', 'latest'],
        [{ version: 'patch' }, '0.2.1', 'latest'],
        [{ version: 'minor' }, '0.3.0', 'latest'],
        [{ version: 'major' }, '1.0.0', 'latest'],
        [{ version: '0.5.0' }, '0.5.0', 'latest'],
        [{ version: 'v0.5.0' }, '0.5.0', 'latest'],
        [{ version: 'auto', preid: 'beta' }, '0.3.0-beta.0', 'beta'],
        [{ version: 'minor', preid: 'rc' }, '0.3.0-rc.0', 'rc'],
    ])(
        '%j cuts %s: commit + annotated tag pushed atomically, published in the same run',
        (inputs, version, distTag) =>
            withFixture({}, (fixture) => {
                const job = dispatch(fixture, inputs);

                expect(job.failed, job.output).toBeNull();
                expect(job.outputs.resolve).toEqual({ tag: `v${version}`, mode: 'cut' });

                // main gained exactly the release commit, carrying the version and the tag.
                expect(mainSubjects(fixture).slice(0, 2)).toEqual([`release: v${version} [skip ci]`, 'feat: a feature']);
                expect(versionAt(fixture, 'main')).toBe(version);
                expect(originGit(fixture, ['cat-file', '-t', `refs/tags/v${version}`])).toBe('tag');
                expect(originGit(fixture, ['rev-parse', `v${version}^{commit}`])).toBe(
                    originGit(fixture, ['rev-parse', 'main']),
                );

                expect(job.publishes).toEqual([`publish --access public --tag ${distTag}`]);
                expect(job.publishedVersions).toEqual([version]);
                expect(job.releases).toHaveLength(1);
                expect(job.releases[0]).toMatch(new RegExp(`^release create v${version.replace(/\./g, '\\.')} `));
            }),
        SLOW,
    );

    test(
        'a second click with nothing new since refuses instead of re-releasing',
        () =>
            withFixture({}, (fixture) => {
                expect(dispatch(fixture, { version: 'auto' }).failed).toBeNull();

                const again = dispatch(fixture, { version: 'auto' });

                expect(again.failed).toBe('Resolve release');
                expect(again.output).toMatch(/nothing to release/);
                expect(again.publishes).toEqual([]);
            }),
        SLOW,
    );

    test.each([
        ['an explicit version with a preid', { version: '0.5.0', preid: 'beta' }, /cannot be combined/],
        ['an invalid version', { version: 'huge' }, /Expected auto, patch, minor, major or a version/],
        ['a version that is not newer', { version: '0.1.5' }, /not newer/],
        ['a numeric preid', { version: 'auto', preid: '1' }, /invalid --preid/i],
    ])(
        'refuses %s and creates nothing',
        (_scenario, inputs, message) =>
            withFixture({}, (fixture) => {
                const job = dispatch(fixture, inputs);

                expect(job.failed).toBe('Resolve release');
                expect(job.output).toMatch(message);
                expect(mainSubjects(fixture)[0]).toBe('feat: a feature');
                expect(originGit(fixture, ['tag', '--list'])).toBe('v0.2.0');
            }),
        SLOW,
    );

    test(
        'refuses to run from a branch other than main',
        () =>
            withFixture({}, (fixture) => {
                const job = dispatch(fixture, { version: 'auto' }, { ref: 'refs/heads/feature' });

                expect(job.failed).toBe('Resolve release');
                expect(job.output).toMatch(/Run this workflow from main/);
            }),
        SLOW,
    );

    test(
        'if main moves mid-run, pushes nothing and publishes nothing',
        () =>
            withFixture({}, (fixture) => {
                const job = dispatch(fixture, { version: 'auto' }, { race: true });

                expect(job.failed).toBe('Cut release commit and tag');
                expect(job.output).toMatch(/Nothing was pushed/);
                expect(originGit(fixture, ['tag', '--list'])).toBe('v0.2.0');
                expect(mainSubjects(fixture)[0]).toBe('fix: a concurrent merge');
                expect(job.publishes).toEqual([]);
            }),
        SLOW,
    );

    test('never cuts and catches up in the same run', () => {
        expect(step('Cut release commit and tag').if).toBe("steps.resolve.outputs.mode == 'cut'");
        expect(step("Catch main's package.json up to the release").if).toBe("steps.resolve.outputs.mode != 'cut'");
    });
});

//* Re-runs and Repair ===

describe('re-runs and repair', () => {
    test(
        'version: X.Y.Z with an existing tag repairs it and creates nothing',
        () =>
            withFixture({}, (fixture) => {
                expect(dispatch(fixture, { version: 'auto' }, { gh: 'forbidden' }).failed).toBe('Create GitHub Release');
                const main = originGit(fixture, ['rev-parse', 'main']);

                const repair = dispatch(fixture, { version: '0.3.0' }, { npm: 'published' });

                expect(repair.failed, repair.output).toBeNull();
                expect(repair.outputs.resolve).toEqual({ tag: 'v0.3.0', mode: 'existing' });
                expect(repair.publishes).toEqual([]);
                expect(repair.releases).toHaveLength(1);
                expect(originGit(fixture, ['rev-parse', 'main'])).toBe(main);
                expect(originGit(fixture, ['tag', '--list'])).toBe('v0.2.0\nv0.3.0');
            }),
        SLOW,
    );

    test(
        '"Re-run jobs" on a cut run (same inputs, original main) re-runs the tag it created',
        () =>
            withFixture({}, (fixture) => {
                const original = originGit(fixture, ['rev-parse', 'main']);
                expect(dispatch(fixture, { version: 'auto' }, { gh: 'network' }).failed).toBe('Create GitHub Release');

                const rerun = dispatch(fixture, { version: 'auto' }, { at: original, npm: 'published' });

                expect(rerun.failed, rerun.output).toBeNull();
                expect(rerun.outputs.resolve).toEqual({ tag: 'v0.3.0', mode: 'existing' });
                expect(rerun.releases).toHaveLength(1);
                expect(mainSubjects(fixture).filter((subject) => subject.startsWith('release: v0.3.0'))).toHaveLength(1);
            }),
        SLOW,
    );

    test(
        'repairs a legacy tag with main\'s scripts, without taking "latest" from a newer release',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                // v0.2.0's tree predates scripts/; the button runs main's copies.
                const job = dispatch(fixture, { version: 'v0.2.0' }, { npm: 'published' });

                expect(job.failed, job.output).toBeNull();
                expect(job.outputs.release.latest).toBe('false');
                expect(job.publishes).toEqual([]);
                expect(job.releases[0]).toMatch(/^release create v0\.2\.0 .* --latest=false$/);
                expect(mainSubjects(fixture)[0]).toBe('feat: a feature'); // 0.2.0 is not behind main
            }),
        SLOW,
    );

    test(
        'refuses a preid on an existing tag',
        () =>
            withFixture({}, (fixture) => {
                const job = dispatch(fixture, { version: '0.2.0', preid: 'beta' });

                expect(job.failed).toBe('Resolve release');
                expect(job.output).toMatch(/preid only applies when cutting/);
            }),
        SLOW,
    );

    test(
        'a version already on npm skips publish but still creates a missing Release',
        () =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npm: 'published' });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toContain('already on npm; skipping publish');
                expect(job.installs).toEqual([]);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toHaveLength(1);
            }),
        SLOW,
    );

    test.each(['auth', 'network', 'server', 'indeterminate'])(
        'an npm %s failure stops the run instead of publishing',
        (mode) =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npm: mode });

                expect(job.failed).toBe('Check npm for this version');
                expect(job.output).toMatch(/unable to determine whether .* exists on npm/i);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toEqual([]);
            }),
        SLOW,
    );
});

//* GitHub Release ===

describe('GitHub Release', () => {
    test.each([
        ['a published Release (e.g. your notes from "Draft a new release")', 'published', /leaving it and its notes unchanged/],
        ['a draft Release', 'draft', /draft GitHub Release for v0\.3\.0 exists; leaving it unchanged/],
    ])(
        'leaves %s untouched',
        (_scenario, gh, message) =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npm: 'published', gh });

                expect(job.failed, job.output).toBeNull();
                expect(job.output).toMatch(message);
                expect(job.releases).toEqual([]);
            }),
        SLOW,
    );

    test.each(['forbidden', 'network'])(
        'a GitHub %s failure creates no Release',
        (gh) =>
            withFixture({ tag: 'v0.3.0' }, (fixture) => {
                const job = runJob(fixture, { tag: 'v0.3.0', npm: 'published', gh });

                expect(job.failed).toBe('Create GitHub Release');
                expect(job.releases).toEqual([]);
            }),
        SLOW,
    );
});

//* Structure ===

describe('workflow structure', () => {
    test('keeps one least-privilege job on OIDC, with no token secrets', () => {
        const jobs = workflow.match(/^ {2}[A-Za-z0-9_-]+:\n {4}runs-on:/gm) ?? [];

        expect(jobs).toHaveLength(1);
        expect(workflow).toMatch(/permissions:\n {2}contents: write.*\n {2}id-token: write/);
        expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|personal.access.token|secrets\./i);
    });

    test('pushes only fast-forwards, from the cut and catch-up steps', () => {
        for (const current of steps) {
            const script = current.run ?? '';
            expect(script).not.toMatch(/--force|\+refs\/heads\/main(?!:refs\/remotes)|\bgit tag\b|push.*-f\b/);
            if (/\bgit push\b/.test(script))
                expect(['Cut release commit and tag', "Catch main's package.json up to the release"]).toContain(
                    current.name,
                );
        }
    });

    test('marks every bot commit [skip ci]', () => {
        expect(step('Cut release commit and tag').run).toContain('-m "release: v%s [skip ci]"');
        expect(step("Catch main's package.json up to the release").run).toContain('"release: v$VERSION [skip ci]"');
    });

    test('writes release notes outside the checkout', () => {
        expect(step('Generate GitHub Release notes').run).toContain('> "$RUNNER_TEMP/release-notes.md"');
        expect(step('Create GitHub Release').run).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    });
});

describe('npm version parity', () => {
    test('CI runs the same pinned npm that publishes', () => {
        const spec = (text) => text.match(/npm install -g (npm@\S+)/)?.[1];

        expect(spec(workflow)).toBeDefined();
        expect(spec(workflow)).not.toBe('npm@latest');
        expect(spec(ci)).toBe(spec(workflow));
    });
});
