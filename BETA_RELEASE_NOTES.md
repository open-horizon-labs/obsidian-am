## What's in this beta

A new MCP tool, plus a documented answer to "why can't the agent rename or
delete things?"

## `marvin_create_project`

An agent could create tasks but not a project to put them in. It can now.
Uses the same limited API token as everything else — no new credential.

Projects aren't quite tasks: they support `priority` (`high`/`mid`/`low`),
which tasks don't, and they don't take `plannedWeek`/`plannedMonth`.

One rough edge worth knowing about, and it's Marvin's, not ours: Marvin's docs
say the create response will include the new project's ID "in the future" —
meaning today a successful create can come back without one. When that happens
the tool reports `created: true` with `idUnavailable: true` and tells the caller
to look the project up rather than retry. **It deliberately does not report an
error**, because the project *was* created, and an agent treating it as a
failure would retry and make a second one.

## Why rename / move / delete still aren't exposed

Short version: Marvin's limited API can't do them, and the API that can is one
we're deliberately not touching.

The limited token's writes are create-task, create-project, create-event,
mark-done, time tracking, reward points, reminders, and habits. There's no
update or delete endpoint at all. Renaming, reparenting, or rescheduling
requires `/api/doc/update` and `/api/doc/delete`, which need a **third**
credential beyond the API token and the database credentials — and which
Marvin's own documentation warns about plainly: a wrong document shape "might
cause Marvin to crash on startup," and API deletes bypass Marvin's client-side
Trash, so "you won't be able to recover any documents deleted in this way."

Handing an autonomous agent a tool that can permanently destroy unrecoverable
data isn't worth a tidier CRUD surface. Edit and delete stay in Marvin's own
apps. The reasoning is now written down in
`docs/architecture/marvin-client-and-mcp.md` so it doesn't have to be
re-litigated from scratch.

**Correcting myself on the test plan:** several of these release notes have
listed "rename/move/delete propagation" as untestable because MCP lacks those
routes. That was wrong — the test never needed MCP. Rename or move something
**in Amazing Marvin**, then watch the plugin's incremental sync bring it into
the vault. That's both possible today and closer to how anyone actually uses
this.

## How to test

1. Update your MCP checkout and rebuild — the MCP server builds from this repo,
   not from the BRAT-installed plugin:
   ```sh
   git -C /path/to/obsidian-am fetch --tags
   git -C /path/to/obsidian-am checkout 0.11.0-beta8
   npm --prefix /path/to/obsidian-am ci
   npm --prefix /path/to/obsidian-am run build
   ```
2. Ask your agent to create a project with `marvin_create_project`, then create
   a task inside it with `marvin_create_task` using the returned `parentId`.
   Confirm both land in Marvin.
3. Note what the create returned: an `id`, or `idUnavailable: true`? Either is
   correct behavior — worth reporting which you got, since it tells us whether
   Marvin has shipped the ID in the response yet.
4. **The propagation test that was never actually blocked:** in Amazing Marvin,
   rename a task, move it to a different category, then delete it — one at a
   time. After each, confirm the vault catches up (automatically within about a
   minute, or immediately via "Sync now").

### Still genuinely uncovered

Reset-cache rehydration, and disabling incremental sync then running the
regular importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for test
results; a new issue for anything that looks like a distinct bug.
