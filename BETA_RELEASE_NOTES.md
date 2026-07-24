## What's in this beta

Opt-in incremental Amazing Marvin sync — an alternative to the REST importer
that reads Marvin's CouchDB `_changes` feed instead of repeatedly rebuilding
the whole imported tree. Off by default; the existing REST importer remains
the default and fallback either way.

- **Obsidian plugin:** a new "Experimental incremental sync" section in
  settings. Enabling it hydrates a local cache from Amazing Marvin's
  database, then keeps it current via the changes feed, updating only the
  notes that actually changed instead of rebuilding everything.
- **MCP server:** `marvin_categories`/`marvin_children` can read the same
  cache the plugin maintains, avoiding a REST round trip when it's fresh.
  Opt-in and separate from the plugin toggle — set an environment variable,
  no new credentials needed.

**Fixed since 0.11.0-beta1:** the database credential fields now match
Amazing Marvin's own API settings page exactly — server, database name,
user, password as four separate fields, instead of one hand-assembled URI.
Direct copy-paste now, reported by a beta1 tester within minutes of trying
it.

**Known limitation:** the plugin side has not yet been run inside a real
Obsidian vault by anyone other than beta testers reading this. It's been
verified end-to-end against a real local CouchDB instance and a real Marvin
database export, and every module has unit tests, but the actual "does it
render notes correctly in your vault" step still needs real testers. That's
what this beta is for.

## How to test

### Obsidian plugin

1. In Amazing Marvin, go to the API settings page and find the **database**
   server, database name, user, and password (a different credential from
   the plugin's existing limited API token — these grant full database read
   access, so treat them accordingly).
2. In Obsidian, open the plugin settings and find "Experimental incremental
   sync." Enable it and copy each of those four fields into the matching
   field in settings — same server/database/user/password layout as
   Amazing Marvin's own page.
3. Click "Sync now." Confirm the resulting category/task notes match what
   the regular "Import categories and tasks" command produces.
4. In Marvin (web, mobile, or desktop), create, rename, move, complete, and
   delete a task or category. Confirm each change lands in the vault after
   a sync (automatic — on window focus, roughly once a minute, and on
   network reconnect — or manual, via the "Sync now" button or the "Sync
   Amazing Marvin now (incremental)" command).
5. Try "Reset cache" in settings, then sync again — confirm it re-hydrates
   cleanly instead of erroring.
6. Disable incremental sync and confirm the regular REST importer still
   works exactly as before.

### MCP server (for agent use)

1. Get the plugin's cache file path: it's
   `<vault>/.obsidian/plugins/<plugin-id>/marvin-incremental-cache-v1.json`
   once incremental sync has run at least once.
2. Set `AMAZING_MARVIN_INCREMENTAL_CACHE_PATH` to that path in whatever
   launches the MCP server for your agent (alongside the existing
   `AMAZING_MARVIN_API_TOKEN`) — no new credentials needed here, this is a
   read-only reader of the plugin's own cache file.
3. Restart the MCP server/agent session so it picks up the new environment
   variable.
4. Ask your agent to call `marvin_categories` or `marvin_children` and
   check the response — cache hits report `"freshness": "cached"` and
   `"origin": "local"`; a REST fallback (empty/missing/stale cache) reports
   `"freshness": "fresh"` and `"origin": "public"` as before.
5. Everything else (`marvin_today`, `marvin_due`, `marvin_create_task`,
   etc.) is unaffected — only the two read tools above ever consult the
   cache, and only if you set the path.

## Feedback

Please leave test results, questions, or anything that looks wrong on
[issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) —
that's the tracking issue this beta implements. For anything that looks
like a distinct bug rather than feedback on this feature specifically,
open a new issue instead.
