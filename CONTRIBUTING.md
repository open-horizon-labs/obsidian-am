# Contributing

Thanks for improving Amazing Marvin Integration. Keep each change focused and
preserve Amazing Marvin as the task system of record.

## Setup

Use Node.js 20 or later, then install the locked workspace dependencies:

```sh
npm ci
```

Run the fast verification set before opening a pull request:

```sh
npm test
npm run typecheck
npm run build
```

The plugin runs in Obsidian; the companion MCP is a separate local stdio
server. Do not commit Marvin tokens, CouchDB credentials, vault contents, or
generated `dist/` output.

## Changes

- Preserve user-owned Markdown outside plugin-managed regions.
- Prefer the shared `@open-horizon/marvin-client` package for Marvin API work.
- Add focused tests for import, projection, task-creation, or MCP behavior you
  change.
- Explain user-visible workflow changes in the README and release notes when
  relevant.

## Release

Maintainers cut releases from a clean `master` checkout:

- Stable: `./release.sh <plugin-version> <minimum-obsidian-version>`. The tag
  workflow builds the plugin and creates a GitHub release; verify its assets
  and notes before publishing it.
- Beta: `./release-beta.sh <plugin-version> <minimum-obsidian-version>` opens
  a `beta/<version>` PR. Merging it automatically tags, builds, and publishes
  the beta release (via `.github/workflows/release.yml`).

  To ship real release notes instead of the generic fallback message, add a
  `BETA_RELEASE_NOTES.md` at the repo root (on the `beta/<version>` branch,
  alongside the version bump commit) before merging — outcome, how to test,
  and where to send feedback. It's picked up automatically and is meant to
  be removed once used, not kept as a standing changelog.

### Beta version numbers are one-way

Obsidian's stock "Check for updates" does not support the full semver spec -
it only compares plain `number.number.number` versions and does not
understand pre-release suffixes at all. If a user installs `X.Y.Z-betaN` (via
BRAT) and you later publish the real `X.Y.Z` stable release, Obsidian's
updater will not offer it - the user is stuck reporting "up to date" forever,
with no path back to the stable channel short of a manual reinstall.

**Once any `X.Y.Z-betaN` has shipped, `X.Y.Z` is burned.** The real stable
release for that work must ship as a version *higher* than `X.Y.Z` - bump at
least the patch, and prefer a minor bump for a safer margin. Never reuse the
exact base version the betas were numbered against.

See [obsidian42-brat's developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
and this [forum thread](https://forum.obsidian.md/t/functional-update-to-brat-version-picker-github-pre-releases-and-frozen-version-updates/98951)
for the underlying mechanics.
