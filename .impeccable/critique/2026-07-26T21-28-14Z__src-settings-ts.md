---
target: src/settings.ts
total_score: 18
max_score: 36
na_heuristics: 7
p0_count: 2
p1_count: 2
timestamp: 2026-07-26T21-28-14Z
slug: src-settings-ts
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Sync status/gated-button reasons exemplary; API token and import have no confirmation |
| 2 | Match System / Real World | 2 | "Managed folder", "import root", "projected" are internal vocabulary |
| 3 | User Control and Freedom | 2 | Per-root Remove has no confirm while safer Reset cache needs two clicks |
| 4 | Consistency and Standards | 1 | Six Title Case names against Obsidian convention and the file's own headings |
| 5 | Error Prevention | 3 | Four-field gate and confirm-again real; invalid refresh interval silently swallowed |
| 6 | Recognition Rather Than Recall | 1 | Moment tokens from memory; four settings co-produce one line with no preview |
| 7 | Flexibility and Efficiency | n/a | Obsidian owns settings chrome — no accelerators/search possible |
| 8 | Aesthetic and Minimalist | 1 | ~30 rows, two orphaned above any heading, 60-word paragraphs in rows |
| 9 | Error Recovery | 3 | Failure notices carry real error text; root-save failure hides detail in console |
| 10 | Help and Documentation | 3 | Two good doc links; nothing for Moment format or Tasks compatibility |

Total: 18/36 (9 scored) — Acceptable, bottom edge (50%). Down from 19/36: last pass flagged IA as one P1 and fixed disclosure mechanics; this pass graded naming/grouping properly.

## Design Specificity Verdict

Split, and diagnostically so. The bottom third (incremental-sync rationale, password blast-radius warning, "excluded notes are never deleted") could not have been written for another plugin. The top two-thirds is interchangeable with any Obsidian integration. The authored voice is buried behind the generic surface — backwards, since the section a first-timer never opens carries the personality.

## Priority Issues

[P0] Name collision 170 lines apart: "Tasks to Show" (L286) selects which TASKS; "Show Due Date" (L438) selects which DATE FIELDS. A user setting the first then seeing the second concludes one is broken. Fix: rename to "Tasks to include" and merge the date toggles into one "Dates to show" row.

[P0] Two orphan rows above any heading, one misfiled: "API Token" is a credential, "Mark tasks as done" is write-back behavior. Plus a possessive typo at L172. Fix: add a "Connection" heading; move the toggle into a "Sending changes to Marvin" section.

[P1] this.display() still tears down the whole tab on the import path (L206, L224, L253) — same class already fixed for the incremental toggle, and now also slams both <details> shut. Fix: render the roots list into its own div and re-render only that.

[P1] Three bare date toggles (L437-465) are the only rows with no setDesc(), governing output invisible from here. Fix: one "Dates to show" row with three labeled checkboxes in controlEl (chained addToggle won't work — Obsidian toggles carry no label).

[P2] Platform.isDesktopApp guards Local Server but not incremental sync, so full-DB credentials are offerable on mobile, with no reveal toggle on the password field.

[P3] Descriptions used as documentation — 60-word paragraphs inside settings rows.

## What's Working

- The incremental-sync section explains its own trade-off honestly rather than shipping a bare toggle.
- Gate-and-confirm discipline: "Sync now" states why it's disabled; "Reset cache" carries a source comment explaining why it isn't gated on the feature toggle.
- One decision per row, <=3 options per dropdown, everywhere. The atomic layer is disciplined; only grouping fails.

## Cognitive Load

FAIL: single focus, chunking (nine rows under one heading), visual hierarchy, working memory. PARTIAL: visual grouping (two rows have no group). PASS: one-thing-at-a-time, <=4 options per decision, progressive disclosure.

## Persona Red Flags

Jordan (first-timer): opens to two unheaded rows; no confirmation the token worked; "Show Due Date" has no description at all. The two rows a first-timer must get right have the least confirmation and the most prose respectively.

Casey (mobile): isDesktopOnly false, so ~30 rows is six swipes on a phone; Moment tokens and a leading-# tag fought against autocorrect; incremental sync ungated on mobile with no password reveal.

## Proposed Final Outline

1. Connection — API token
2. Category and project import — unchanged rows
3. Today's tasks — Tasks to include
4. Automatic refresh — auto-refresh toggle, interval
5. How imported tasks are written — Metadata format, Dates to show (merged), Dataview-only rows disabled in place
6. Sending changes to Marvin — Note link text, Obsidian link format, Mark tasks done in Marvin
7. <details> Advanced: incremental sync
8. <details> Advanced: local server (desktop only)

Collapse nothing new; disable four dependent rows in place instead. A closed <details> is invisible to scanning — over-collapsing repeats the bug class that already bit this file.
