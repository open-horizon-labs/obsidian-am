## What's in this beta

Two things, both from beta6 feedback.

## `refresh: true` now tells you what it did

beta6 added an optional `refresh: true` parameter to `marvin_categories` and
`marvin_children`, asking the running plugin to sync before answering. But it
was a black box: the surrounding `freshness`/`origin` fields say where an
answer came from, not whether the requested refresh actually ran. A cache hit
that was *newly synchronized* and one that *silently timed out and fell back*
looked identical.

Reads that request a refresh now carry a `refresh` object:

```json
"refresh": { "requested": true, "outcome": "synced", "waitedMs": 820 }
```

- **`synced`** — the plugin's checkpoint advanced; this data is current
- **`timed_out`** — the request was written, but no sync happened inside the
  window
- **`skipped`** — nothing was attempted, with a `reason` saying why

That `reason` is the useful part when something's wrong: "no incremental cache
is configured for this server" is permanent, while "an earlier request is still
unclaimed, so nothing is listening" clears the moment Obsidian comes back.
Different decisions for a caller.

The object is absent entirely when `refresh` wasn't requested, so passive reads
are unchanged.

## Incremental sync is now desktop-only at the runtime, not just in settings

beta5 hid the incremental sync settings section on mobile, because
full-database credentials are the wrong thing to type on a phone keyboard.
That was half a change, and the half I shipped was the worse one: plugin
settings sync between devices, so mobile kept **running** a background sync
with those credentials while having no UI at all to see its status, read its
errors, trigger a sync, or reset its cache.

An invisible background process with no controls is worse than not having the
optimization. Mobile now skips incremental sync entirely and uses the REST
importer, which works there and remains the default on every platform anyway.

If you'd rather have incremental sync on mobile, say so — the fix would be to
un-hide the settings and add a reveal toggle to the password field, which
addresses the actual credential-entry concern rather than removing the feature.

## How to test

### Refresh diagnostics

1. Update your MCP checkout to this tag and rebuild — the MCP server builds
   from this repo, not from the BRAT-installed plugin:
   ```sh
   git -C /path/to/obsidian-am fetch --tags
   git -C /path/to/obsidian-am checkout 0.11.0-beta7
   npm --prefix /path/to/obsidian-am ci
   npm --prefix /path/to/obsidian-am run build
   ```
2. With Obsidian open and incremental sync configured, call `marvin_categories`
   with `refresh: true`. Expect `outcome: "synced"` and a plausible
   `waitedMs`.
3. Call it **without** `refresh` and confirm there's no `refresh` object at all.
4. Quit Obsidian, then call with `refresh: true` twice. Expect `timed_out` on
   the first and `skipped` on the second, with a reason mentioning nothing
   listening — and correct REST answers throughout, not errors.
5. Unset `AMAZING_MARVIN_INCREMENTAL_CACHE_PATH`, restart the server, and call
   with `refresh: true`. Expect `skipped` with a reason about no cache being
   configured.

### Desktop-only gating (plugin only — the MCP server is a desktop Node process)

6. On mobile, confirm the settings tab has no incremental sync section, and that
   the regular "Import categories and tasks" command still works there.
7. If you have a desktop vault whose settings sync to mobile with incremental
   sync enabled: on mobile, confirm `marvin-incremental-cache-v1.json` isn't
   being created or updated. (The `AmazingMarvin` folder *will* still change on
   mobile if you run the regular importer — that's expected; it's the cache
   file and background syncing that should be absent.)

### Still uncovered

Rename / move / delete propagation (the MCP doesn't expose those routes),
reset-cache rehydration, and disabling incremental sync then running the
regular importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for
test results; a new issue for anything that looks like a distinct bug.
