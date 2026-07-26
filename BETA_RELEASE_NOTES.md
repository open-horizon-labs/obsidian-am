## What's in this beta

Opt-in incremental Amazing Marvin sync — an alternative to the REST importer
that reads Marvin's CouchDB `_changes` feed instead of repeatedly rebuilding
the whole imported tree. Off by default; the existing REST importer remains
the default and fallback either way.

- **Obsidian plugin:** an "Experimental incremental sync" section in
  settings (collapsed by default — click to expand). Enabling it hydrates a
  local cache from Amazing Marvin's database, then keeps it current via the
  changes feed, updating only the notes that actually changed.
- **MCP server:** `marvin_categories`/`marvin_children` can read the same
  cache the plugin maintains, skipping a REST round trip when it's fresh.
  Opt-in via an environment variable; no new credentials needed there.

## Fixed since beta3

**The MCP cache wrapper broke every other tool.** With a cache path
configured, `marvin_today`, `marvin_due`, `marvin_labels`,
`marvin_create_task`, and `marvin_mark_done` all failed with
`... is not a function` — only categories and children worked. Cause: the
wrapper spread a class instance, and object spread doesn't copy prototype
methods. Now uses explicit per-method delegation, with regression tests
built on a real class fixture (the old fixture was an object literal, which
structurally could not catch this). Thanks to the beta3 tester who found and
diagnosed this precisely — see
[#81](https://github.com/open-horizon-labs/obsidian-am/issues/81).

**MCP setup instructions were misleading.** Updating the plugin via BRAT
does *not* update the repository checkout the MCP server is built from, so
setting the cache-path variable against an older checkout was silently
ignored — no warning, it just kept using REST. The README now spells out the
fetch/checkout/build steps and how to verify a real cache hit.

## Fixed in earlier betas

- **beta3:** the settings tab tore itself down and rebuilt on every toggle,
  so the credential fields rendered below the fold with no cue — the cause
  of "there's no place to put the additional creds." Fields now render in
  place; both experimental sections collapse by default.
- **beta2:** database credentials now match Amazing Marvin's own API
  settings page (server, database name, user, password as four fields).

**Known limitation:** the plugin's note-writing path still hasn't been
exercised end-to-end in a real vault — the beta3 tester deliberately
stopped short of creating a test task, because the bug above had broken the
task-writing tools needed to clean it up afterward. That path (create /
rename / move / complete / delete propagation, cache reset, and the
REST-importer-still-works check) is the most valuable thing to test now.

## How to test

### Obsidian plugin

1. In Amazing Marvin, go to the API settings page and find the **database**
   server, database name, user, and password (a different credential from
   the plugin's limited API token — these grant full database read access,
   so treat them accordingly).
2. In Obsidian settings, expand "Experimental incremental sync," enable the
   toggle, and copy each of those four fields into the matching field.
3. Click "Sync now" (disabled with an inline reason until all four fields
   are filled). Confirm the resulting notes match what the regular "Import
   categories and tasks" command produces.
4. **The priority test:** in Marvin, create a task, rename it, move it to
   another category, complete it, then delete it — one change at a time.
   Confirm each lands in the vault within about a minute, or immediately via
   "Sync now" / the "Sync Amazing Marvin now (incremental)" command.
5. Click "Reset cache" (twice within 4 seconds to confirm), then sync again
   — confirm it re-hydrates cleanly.
6. Disable incremental sync and confirm the regular REST importer still
   works unchanged.

### MCP server (for agent use)

1. **Update the checkout first.** The MCP server is built from this
   repository, not from the BRAT-installed plugin — an older checkout has no
   code reading the cache variable and will silently ignore it:
   ```sh
   git -C /path/to/obsidian-am fetch --tags
   git -C /path/to/obsidian-am checkout 0.11.0-beta4
   npm --prefix /path/to/obsidian-am ci
   npm --prefix /path/to/obsidian-am run build
   ```
2. Set `AMAZING_MARVIN_INCREMENTAL_CACHE_PATH` to
   `<vault>/.obsidian/plugins/<plugin-id>/marvin-incremental-cache-v1.json`
   (exists only after incremental sync has run at least once), alongside the
   existing `AMAZING_MARVIN_API_TOKEN`. Restart the MCP server/session.
3. Call `marvin_categories` and `marvin_children` — a cache hit reports
   `"freshness": "cached"` and `"origin": "local"`.
4. Point the variable at a nonexistent file and confirm a clean fallback to
   `"freshness": "fresh"` / `"origin": "public"`. Restore the real path.
5. **Now verify the beta3 regression is gone:** with a valid cache path set,
   call `marvin_today`, `marvin_due`, and `marvin_labels`. All three must
   work and report `origin: "public"` (they intentionally never use the
   cache). `marvin_create_task` and `marvin_mark_done` should work too.

## Feedback

Please leave test results on
[issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55).
For anything that looks like a distinct bug, open a new issue instead.
