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

Maintainers use `./release.sh <plugin-version> <minimum-obsidian-version>`
from a clean `master` checkout. The tag workflow builds the plugin and creates
a GitHub release; verify its assets and notes before publishing it.
