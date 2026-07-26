---
target: src/settings.ts
total_score: 19
max_score: 36
na_heuristics: 7
p0_count: 1
p1_count: 2
timestamp: 2026-07-26T20-44-59Z
slug: src-settings-ts
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | ~25 of 30 fields autosave silently on onChange; only 2 buttons show a Notice |
| 2 | Match System / Real World | 3 | Strong Marvin vocabulary; "Moment format" and Cloudant assumed without explanation |
| 3 | User Control and Freedom | 3 | Good escape hatches (remove root, reset cache); no confirm before either |
| 4 | Consistency and Standards | 2 | Three different idioms for attaching descriptions; inconsistent desc coverage between sibling fields |
| 5 | Error Prevention | 1 | Zero validation on the 4 credential fields; "Reset cache" fires with no confirm |
| 6 | Recognition Rather Than Recall | 2 | Two of four credential fields have no placeholder |
| 7 | Flexibility and Efficiency | n/a | Flat native settings list — no fair shortcut/power-user axis |
| 8 | Aesthetic and Minimalist Design | 1 | One undifferentiated scroll mixing everyday and advanced/experimental config |
| 9 | Error Recovery | 2 | Two async paths show real errors well; most others have no error path at all |
| 10 | Help and Documentation | 3 | API Token and Local Server both link out; incremental sync's disclaimer doesn't |

Total: 19/36 (9 heuristics scored) — Acceptable (53%)

## Design Specificity Verdict

Specific content, generic design. Copy is genuinely product-specific (throttling disclaimer, 4-field credential split mirroring Marvin's own page) but the structure is new Setting().setName().setDesc().addX() repeated ~30 times with bold text as the only divider — indistinguishable from the Obsidian sample-plugin template.

## Overall Impression

The reported bug is real but not what it looks like: nothing is broken, it's a discoverability failure from a destructive re-render pattern that's inconsistent within this same file.

## What's Working

- 4-field credential split mirrors Marvin's own page, explicitly documented, for copy-paste convenience
- Real error paths (sync-root loading, incremental sync) catch/log/surface Notice text, not silent failure
- Documented edge-case discipline (Reset Cache rendering outside the enabled-gate on purpose)

## Priority Issues

[P0] The reported bug's actual cause: destructive full-tab re-render with zero visual continuity. Toggling "Enable incremental sync" calls this.display(), tearing down and rebuilding the entire ~30-row tab. The 4 credential fields do get created, in the right place — but no scroll, no focus management, no visual distinction from unrelated rows. Fix: use the Local Server section's own better pattern in this same file — .setDisabled() on already-rendered fields, no teardown. Suggested command: /impeccable layout

[P1] No progressive disclosure across a file that has outgrown a flat list. Nine sections, one scroll, bold text as the only divider. Fix: collapsed-by-default disclosure element for Experimental incremental sync and Local Server. Suggested command: /impeccable distill

[P1] Zero validation/confirmation on the highest-risk actions. No format check on credential fields despite the file's own "grants full read access" admission; Reset cache fires instantly with no confirm. Suggested command: /impeccable harden

[P2] Inconsistent description coverage breaks scanning rhythm — Database name/user have no description while siblings do; three different idioms for attaching descriptions exist in this file. Suggested command: /impeccable clarify

[P2] The disclaimer explaining why credentials are needed renders as unlabeled body text (Setting with no .setName()) — doesn't read as a warning, breaks screen-reader name/description pairing. Suggested command: /impeccable clarify

## Persona Red Flags

Jordan (first-timer): flips the toggle expecting inline expansion, gets a silent full rebuild instead — the exact reported bug. Disclaimer paragraph doesn't read as a warning (no name). Database server gets no help link unlike API Token two sections up.

Sam (accessibility): nameless Setting breaks name+description pairing. Every this.display() call (6 places) drops keyboard focus with no restoration. Database password has no autocomplete attribute.

## Minor Observations

Reset cache and the status line sit outside the enabled-gate on purpose (documented, good) but nothing tells a first-timer why it's visible when the feature looks off.

## Questions to Consider

- Does incremental sync actually need a full-tab teardown, or was this.display() just the path of least resistance?
- If this tab keeps growing, does it stay one flat list, or is it time for real sectioning?
