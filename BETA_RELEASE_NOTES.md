## Fixes the plugin author shown in Obsidian

Every beta since the org rename has credited **Cloud Atlas** in Obsidian's
plugin list, with the old cloud-atlas.ai link. Stable releases were already
correct — only betas were wrong, which is why it went unnoticed.

The cause: the rename commit updated `manifest.json`, but the beta build ships
`manifest-beta.json`, and that file kept the old name. It now matches, and CI
fails if the two manifests ever disagree on anything except the version they're
releasing, so this can't drift again.

Nothing else changed in this release — same functionality as beta9.

### Why the plugin folder still says "cloudatlas"

The plugin's internal `id` is still `cloudatlas-o-am`, so the folder under
`.obsidian/plugins/` keeps the old name. That's deliberate: the id is the folder
name, so changing it would orphan your install — settings, and the incremental
sync cache, all live in that folder, and you'd get a fresh unconfigured plugin.
It's also the handle other plugins and scripts use to reach this one's API. Not
worth breaking working installs over an identifier nobody sees.

## How to test

1. Update to `0.11.0-beta10` via BRAT.
2. Open **Settings → Community plugins** and confirm "Amazing Marvin
   Integration" now shows **Open Horizon Labs** as the author, linking to
   openhorizonlabs.ai.

## Carried over from beta9

Completed tasks stay in the managed Today region instead of being deleted on the
next refresh. If you haven't exercised that yet, it's the more interesting thing
to test:

- Check a task off in Obsidian, let a refresh run, and confirm the line stays
  put and checked rather than vanishing.
- Complete one in Marvin's app instead — same result.
- Un-complete it in Marvin and confirm it goes back to an open checkbox.
- Reschedule a still-open task to another day in Marvin; it **should** leave
  today's note.

### Still uncovered

Reset-cache rehydration, and disabling incremental sync then running the regular
importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for
incremental-sync results; a new issue for anything else.
