## What's in this beta

Mostly a settings overhaul, plus the last round's sync fixes confirmed working
by a real-vault test.

Incremental sync itself is unchanged since beta4: an opt-in alternative to the
REST importer that reads Marvin's CouchDB `_changes` feed instead of rebuilding
the whole imported tree. Off by default; the REST importer stays the default and
fallback.

## Settings tab reorganized

A design critique pass found the tab had outgrown its structure — ~30 rows in
one scroll, two of them floating above any heading at all. It's now grouped by
what the setting actually *does* rather than by loose verbs:

- **Connection** — the API token, finally under a heading
- **Category and project import** — unchanged
- **Today's tasks** / **Automatic refresh** — split apart. Background file
  rewriting was previously filed under what read like a display preference; it
  now has its own heading, because it's the highest-consequence thing here.
- **How imported tasks are written** (was "Task formatting")
- **Sending changes to Marvin** (was "Task creation") — now also holds "Mark
  tasks done in Marvin," which used to sit at the very top next to the API
  token as if it were part of setup
- **Advanced: incremental sync** and **Advanced: local server**, both
  collapsed, both at the bottom

Specific fixes you may notice:

- **"Tasks to Show" is now "Tasks to include."** It collided with "Show Due
  Date" 170 lines further down — one picks which *tasks* appear, the other
  which *date fields* appear, and the old names read as contradicting each
  other.
- **The three bare "Show Due/Start/Scheduled Date" toggles are now one "Dates
  to show" row** with labeled checkboxes. They were the only rows in the whole
  tab with no description.
- **Settings that only apply to one metadata format now grey out** instead of
  sitting there looking active. Same for the label prefix when labels-as-tags
  is off. Nothing new was hidden — a row that vanishes is a row nobody knows
  exists.
- **Two more instances of the bug that caused "there's no place to put the
  creds"**: adding/removing an import root rebuilt the entire tab (collapsing
  both advanced sections), and a *background* sync could rebuild the tab while
  you were mid-typing in a credential field. Both now update in place.
- **"Remove" on an import root asks for a confirming second click** — it
  silently un-imports a whole subtree, and the much safer "Reset cache" already
  had that guard.
- Sentence case throughout, two copy errors fixed, and an invalid refresh
  interval now tells you it was rejected instead of silently ignoring you.

## Incremental sync is now desktop-only

The settings section is gated to desktop, matching the local server section.
It asks for full-database credentials, and a phone — autocorrecting keyboard,
no reveal toggle on the password field — is the wrong place to type one.

Note: this hides the *UI*, it doesn't disable an already-configured sync. If
you set it up on desktop and your settings sync to mobile, the sync still runs
there. Say so if you'd rather it didn't.

## Confirmed working since beta4

A tester verified the whole path in a real vault, which retires the "never run
in a real Obsidian vault" caveat these notes carried for four releases:

- The beta3 MCP regression is gone — `marvin_today`, `marvin_due`,
  `marvin_labels`, `marvin_create_task`, and `marvin_mark_done` all work with a
  cache path configured.
- A task created via MCP appeared in the cache *and* in `AmazingMarvin/Inbox.md`,
  then disappeared from both after completion and sync.
- Window-focus auto-sync works without touching "Sync now" — about a 20-second
  round trip, both directions.

## How to test

### Settings (new this round)

1. Open the plugin settings and read down the tab. Does the grouping make sense?
   Does anything feel like it's under the wrong heading?
2. Expand "Advanced: incremental sync," toggle it on, and confirm the four
   credential fields enable in place without the section collapsing.
3. With the settings tab open and the advanced section expanded, wait for a
   background sync (or switch focus away and back). The section should stay open
   and keep your cursor where it was.
4. Switch "Items to import" to "Selected roots," add and remove a root, and
   confirm the advanced sections stay expanded throughout.
5. Set "Metadata format" to a Tasks format and confirm "Put task title first"
   and "Date link format" grey out.
6. Type nonsense into "Refresh interval" and confirm it tells you it was
   rejected.

### Still uncovered

Rename / move / delete propagation (MCP doesn't expose those routes),
reset-cache rehydration, and disabling incremental sync then running the regular
importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for test
results; a new issue for anything that looks like a distinct bug.
