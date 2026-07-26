## What's in this beta

One new capability for agent use, on top of beta5's settings overhaul.

## MCP reads can now ask for a fresh cache

Until now the MCP server's use of the plugin's incremental cache was passive:
it used the cache if Obsidian happened to have synced it, and otherwise fell
through to REST. Fine for browsing, but not dependable right after you've
changed something — freshness depended on focus/interval timing.

`marvin_categories` and `marvin_children` now accept an optional
**`refresh: true`** parameter. When set, the MCP server asks the running
plugin to sync and waits briefly (default 5s, via
`AMAZING_MARVIN_REFRESH_TIMEOUT_MS`) before answering.

It's a **per-call parameter, defaulting to false**, because the caller is the
one who knows whether a given question needs current data ("did my task
land?") versus tolerating a cached answer ("what's in Work?"). Passive,
zero-latency reads stay the default.

**How it works, and why:** the MCP server drops a small request file next to
the cache file it already reads; the plugin polls for it, syncs, and clears
it. A file rather than a socket, deliberately — the plugin keeps sole custody
of the database credentials under either design, but this way nothing opens an
inbound network listener on your note-taking app and there's no shared secret
between the two processes.

**It's best-effort, not a guarantee.** If Obsidian isn't running, the plugin
is disabled, or the sync fails, the wait ends and the read answers from cache
or REST exactly as before. Repeated calls also won't pile up waiting on a
plugin that isn't answering — an unclaimed request file is treated as evidence
nothing is listening, so subsequent calls skip the wait until the plugin picks
up again.

## Reminder from beta5: settings were reorganized

The settings tab is now grouped by what each setting does rather than by loose
verbs — **Connection**, **Category and project import**, **Today's tasks**,
**Automatic refresh**, **How imported tasks are written**, **Sending changes
to Marvin**, then two collapsed **Advanced** sections. Incremental sync is
desktop-only. See the beta5 notes for the full list.

## How to test

### The new refresh parameter

1. Update your MCP checkout to this tag and rebuild — the MCP server is built
   from this repo, not from the BRAT-installed plugin:
   ```sh
   git -C /path/to/obsidian-am fetch --tags
   git -C /path/to/obsidian-am checkout 0.11.0-beta6
   npm --prefix /path/to/obsidian-am ci
   npm --prefix /path/to/obsidian-am run build
   ```
2. With Obsidian running and incremental sync configured, create a task in
   Marvin (or via `marvin_create_task`), then immediately call
   `marvin_children` with `refresh: true` for its parent. The new task should
   be there without you touching "Sync now" or waiting out the interval.
3. Call the same tool **without** `refresh` and confirm it still answers
   instantly from cache.
4. **Quit Obsidian entirely**, then call with `refresh: true` a few times in a
   row. The first call should wait out the timeout at most once; subsequent
   calls should return promptly rather than each waiting the full 5s, and all
   of them should still answer correctly via REST.
5. Restart Obsidian and confirm `refresh: true` starts working again without
   any intervention.

### Still uncovered

Rename / move / delete propagation (the MCP doesn't expose those routes),
reset-cache rehydration, and disabling incremental sync then running the
regular importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for
test results; a new issue for anything that looks like a distinct bug.
