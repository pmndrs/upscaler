# Releasing

**Merging to `main` never publishes.** A release happens only when you ask for one,
and it never needs a local step. There are two ways to ask, and both run entirely in
GitHub Actions ([`publish.yml`](../.github/workflows/publish.yml)) with the same
guards, publish and GitHub Release steps.

The repo installs with **pnpm** (`pnpm install --frozen-lockfile`), but versioning and
publishing stay on the **npm CLI** (`npm version`, `npm view`, `npm publish`): npm
Trusted Publishing is an npm-CLI OIDC flow, and `npm version` edits only
`package.json` (there is no `package-lock.json`, and `pnpm-lock.yaml` records no root
version).

## Option A: the Run workflow button

**Actions → Publish to npm → Run workflow**, on branch `main`, with:

| `version`             | Releases                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `auto` (default)      | the next version from the Conventional Commits since the last stable tag |
| `patch` / `minor` / `major` | that bump, whatever the commits say                                |
| `X.Y.Z` (e.g. `0.4.0`) | exactly that version                                                    |
| an existing tag's version | a re-run of that tag (see [Re-running a release](#re-running-a-release)) |

`preid` is optional. Set it to `beta`, `rc` and so on to cut a prerelease of the
bumped version (`0.3.0-beta.0`, then `0.3.0-beta.1` on the next click with the same
`preid`). It can't be combined with an explicit `X.Y.Z`.

In one run, the workflow:

1. computes the version and refuses if nothing warrants a release (`auto` with only
   `docs:`/`chore:` commits), if the version isn't newer than `package.json`, or if
   the run wasn't started from `main`;
2. commits `release: vX.Y.Z [skip ci]` to `main` (only `package.json` changes),
   creates the annotated tag `vX.Y.Z` on it, and pushes
   both atomically. If `main` moved while the run was going, nothing is pushed: run
   it again;
3. publishes to npm and creates the GitHub Release, as for a tag push.

The commit and the tag are pushed with the workflow's `GITHUB_TOKEN`. Pushes made with
that token never trigger workflows, so the tag doesn't start a second publish run, and
`[skip ci]` keeps CI off the bump commit as well. The run that cut the tag publishes it.

## Option B: create a tag (including in the GitHub UI)

**Releases → Draft a new release → Choose a tag → type `vX.Y.Z` → Create new tag on
publish**. Keep the target as `main`, write notes if you like, then **Publish
release**. Pushing a `vX.Y.Z` tag on a `main` commit from anywhere works the same way.

**The tag is the version.** A tag made this way points at a commit whose
`package.json` still has the previous version. The workflow stamps the tag's version
into `package.json` in its own checkout (`npm version X.Y.Z --no-git-tag-version`) and
publishes that.

Afterwards it brings `main` up to date with a separate `release: vX.Y.Z [skip ci]`
commit that only bumps `package.json`. That commit is a plain
fast-forward push: no force-push, no new tag, and the release tag stays where you put
it. It is skipped when `main`'s version is already at or past the tag (for example,
after a re-run, or a tag for an older version). If a merge lands at the same moment,
the push is rejected and the step re-fetches `main` and retries, up to three times.

**Your Release notes are kept.** "Draft a new release" creates the GitHub Release
together with the tag, so the workflow finds it and leaves it exactly as you wrote it.
It only creates a Release, with notes generated from the commits, when the tag has
none. It never edits an existing Release, and it leaves a draft Release alone for you
to publish.

## What every release run checks and does

Before publishing anything, the run fails if:

- the tag is not `v` followed by a SemVer version;
- the tagged commit is not on `origin/main`, so a tag on a side branch never ships.

Then it:

- **chooses the npm dist-tag** (see [below](#versions-and-dist-tags)) and prints it.
  For a stable version this reads npm's current `latest` first; if that lookup fails
  for any reason other than a 404, the run stops before publishing.
- **publishes to npm** with `npm publish --access public --tag <dist-tag>`, whose
  `prepublishOnly` gate runs lint, typecheck, test and build again. A version that is
  already on npm is skipped, not republished.
- **creates the GitHub Release** if the tag has none. The notes come from
  [`scripts/release-notes.mjs`](../scripts/release-notes.mjs). Stable notes compare
  against the previous stable tag; prerelease notes compare against the previous tag
  of either kind. Preview them locally with
  `node scripts/release-notes.mjs --tag vX.Y.Z`.

### Versions and dist-tags

`auto` follows Conventional Commits since the last stable tag:

| Commits                                    | Bump    | Example       |
| ------------------------------------------ | ------- | ------------- |
| `fix:` / `perf:`                           | patch   | 0.2.0 → 0.2.1 |
| `feat:`                                    | minor   | 0.2.0 → 0.3.0 |
| `feat!:` / `<type>!:` / `BREAKING CHANGE:` | major\* | 0.2.0 → 0.3.0 |
| `docs:` / `chore:` / `ci:` / `refactor:` … | none    | —             |

\* While on `0.x`, `auto` turns a breaking change into a minor bump, so a stray `!`
can't cut `1.0.0`. Choosing `major` explicitly does cut `1.0.0`. The policy lives in
[`scripts/release-version.mjs`](../scripts/release-version.mjs).

| Version                            | npm dist-tag  | Install                              | GitHub Release |
| ---------------------------------- | ------------- | ------------------------------------ | -------------- |
| `0.3.0` (newest stable)            | `latest`      | `npm i @pmndrs/upscaler`             | latest         |
| `0.2.1` (after `0.3.0`)            | `v0.2-latest` | `npm i @pmndrs/upscaler@v0.2-latest` | not latest     |
| `0.3.0-beta.0`                     | `beta`        | `npm i @pmndrs/upscaler@beta`        | prerelease     |
| `1.0.0-rc.0`                       | `rc`          | `npm i @pmndrs/upscaler@rc`          | prerelease     |
| `0.3.0-0`                          | `next`        | `npm i @pmndrs/upscaler@next`        | prerelease     |

`latest` only ever moves forward. A stable version takes `latest` only when it is
at or above npm's current `latest` (`npm view @pmndrs/upscaler dist-tags.latest`),
or when npm has no `latest` yet (a first publish). An older stable version, such as
a maintenance release `0.2.1` published after `0.3.0`, goes to its **line tag**
`v<major>.<minor>-latest` (`v0.2-latest`), and `latest` stays on `0.3.0`. The run
uses `latest` or the line tag, never a guess: if npm's `latest` can't be read
(auth, network or registry errors, or a value that isn't a version), it fails
before publishing. Re-run it once npm is reachable.

A prerelease never moves `latest` and never reads it. A Release created for an
older tag never takes "latest" from a newer one, so npm and GitHub agree.

On a tag push, GitHub runs `publish.yml` from the tagged commit. A maintenance tag
on a commit from before this rule existed runs the older workflow, which still
assigns `latest` to every stable version. Tag a commit that has this workflow, or
fix the dist-tags by hand afterwards (`npm dist-tag add`).

`npm run release` prints the dist-tag it expects in its summary line, for example
`0.2.0 → 0.3.0 (npm dist-tag: latest; npm's latest is 0.2.0)`. If it can't read
npm, it warns and leaves the choice to the workflow.

## Re-running a release

Every step is safe to repeat. If a run failed after npm accepted the package (for
example, at the GitHub Release step):

- **Re-run jobs** on the failed run. A button run notices that its tag now exists and
  re-runs that tag instead of cutting a new one.
- Or **Run workflow** with `version` set to the existing tag's version (`0.3.0` or
  `v0.3.0`). When that tag exists, nothing is created: the run republishes only if npm
  doesn't have the version, creates the Release only if it's missing, and catches up
  `main`'s `package.json` only if it's behind.

The button always runs the release scripts from `main`, so it can also create Releases
for tags cut before those scripts existed. For example, `version: 0.2.0` creates the
missing v0.2.0 Release.

## Optional: from your checkout

`npm run release` does what the button does, locally: it refuses unless the tree is
clean, you're on `main` and `main` matches `origin/main`. It then prints the commits
and the version, runs the gate, and runs `npm version` to create the
`release: vX.Y.Z [skip ci]` commit and tag. It takes the same version argument as
the button (`auto`, `patch`/`minor`/`major`, `X.Y.Z`) and `--preid`.

```bash
npm run release -- --dry-run   # compute and print only
npm run release                # commit + tag locally; prints the push command
npm run release -- --push      # …and push main + tag atomically (that tag push publishes)
```

## One-time npm setup

Publishing uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC). There is no token or secret, and provenance is attached automatically. On
npmjs.com, under the package's **Settings → Trusted publishing**, register a GitHub
Actions publisher:

- Organization or user: `pmndrs`
- Repository: `upscaler`
- Workflow filename: `publish.yml`
- Environment: leave empty

The trusted publisher binds to the repository and the workflow filename, not to the
trigger, so tag pushes and button runs are both covered. Keep the file named
`.github/workflows/publish.yml`. Trusted Publishing also needs npm ≥ 11.5.1 (the
workflow pins `npm@^11.5.1`, the same as CI), Node ≥ 22.14.0, the `id-token: write`
permission, and `repository.url` in `package.json` to match the GitHub repository.

The workflow's `contents: write` permission covers the release commit and tag, the
`package.json` catch-up commit, and creating the GitHub Release. `main` has no branch
protection. If protection is added, the workflow's pushes to `main` must be allowed
(for example, with a bypass for GitHub Actions). Otherwise the button and the catch-up
commit fail, though tag-push publishing itself still works.
