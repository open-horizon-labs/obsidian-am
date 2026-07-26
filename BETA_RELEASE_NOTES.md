## Completed tasks stay in your daily note

If you checked off a task in the managed Today region, the next refresh deleted
the line. Your daily note recorded only what you *hadn't* finished — which is
backwards for a record of the day.

Completed tasks now stay, checked off, in the position they were already in.

### Why it was happening

Marvin's Today and due reads only return **open** work. `/dueItems` is
documented as "open", `/todayItems` has no parameter for completed items, and
there is no endpoint at all that lists what you completed on a given day. So
once you checked a task, the refresh saw it missing from the read and removed
the line. The note renderer already knew how to draw a checked box — the data
just never survived long enough to reach it.

### What it does now

A checked Marvin line already in the region is kept, verbatim, when the current
read no longer returns it, and it holds its original position rather than
sliding to the bottom.

Kept deliberately narrow, because over-preserving would pin stale work into
notes forever:

- **Only checked lines are kept.** An unchecked task Marvin no longer returns
  has genuinely left your Today list — deleted, rescheduled, or unscheduled —
  so it still disappears, as before.
- **Marvin still wins.** If you un-complete a task in Marvin, it renders as open
  again on the next refresh rather than staying stuck as a checked line.
- **Nothing accumulates across days.** Preservation is scoped to each note's own
  dated region.

Needs no new credentials, and works whether or not you use incremental sync.

### One case this doesn't cover yet

A task you completed **in Marvin's app** that had never appeared in your note
won't show up — there's no line in the note to preserve. The CouchDB cache does
have completed tasks with their completion timestamps and could fill that gap;
it currently discards them. Worth doing as a follow-up if you find yourself
wanting it, and it'd be a second real payoff for the database credential beyond
avoiding throttling.

## How to test

1. Install `0.11.0-beta9` via BRAT.
2. Open today's daily note with an initialized Today region and some open tasks.
3. Check one off in Obsidian. Wait for the automatic refresh (window focus, or
   about a minute) or run "Refresh today's tasks".
4. **The task should still be there, checked, in the same spot.** Previously it
   vanished.
5. Let several refreshes run. The note should stop changing — no duplicates, no
   drift.
6. Complete a different task in Marvin's own app instead of in Obsidian. It
   should also stay in the note, checked.
7. Un-complete that task in Marvin. It should go back to an open checkbox.
8. In Marvin, reschedule a still-open task to a different day. It **should**
   disappear from today's note — that's intended, not a regression.

### Still uncovered

Reset-cache rehydration, and disabling incremental sync then running the regular
importer.

## Feedback

[Issue #55](https://github.com/open-horizon-labs/obsidian-am/issues/55) for
incremental-sync results. This Today-region change is better discussed on a new
issue if something's off, since it's independent of the sync work.
