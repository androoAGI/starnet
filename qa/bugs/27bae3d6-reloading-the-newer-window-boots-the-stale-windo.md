---
fingerprint: 27bae3d6
slug: reloading-the-newer-window-boots-the-stale-windo
title: Reloading the newer window boots the stale window's cached station and calls it this window's work
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 923f03a98
origin: audit
---

# Reloading the newer window boots the stale window's cached station and calls it this window's work

## Symptom

Two windows are open on one station (same origin, so one shared `localStorage` cache). Window B renames session X
and deletes session C, and those changes are confirmed in the station file (revision 50). Window A, still on
revision 46, then renames C. Its save is correctly refused as a conflict and preserved as
`agent.save-conflict-<client>.json`, and A shows the conflict banner. But A wrote its stale snapshot into the shared
cache first. When B reloads, it boots that stale, dirty cache instead of the station file it had just confirmed:
- session C, which B deleted, is back in the rail as "Charlie From Stale Tab";
- B's rename of X is reverted;
- B's banner says "Your work from this window was preserved separately", although the work on screen came from the other window.

The station file stays correct (rev 50) until the Commander clicks "Reload current station".

## Repro

1. Load the station in tab A, then open tab B (both on the same revision).
2. In B: rename session X, delete session C, and wait for the save to confirm.
3. In A (no reload): rename session C, and wait for the save attempt. A shows the conflict banner.
4. Reload B.

## Evidence

Live on 2026-10-20 (two CDP tabs on one headless Chrome profile):

```
shared cache after A's attempt: {"rev":46,"dirty":true,"C":true,"B":"Bravo Renamed"}
B after reload: {"rev":46,"C":true,"Ctitle":"Charlie From Stale Tab","B":"Bravo Renamed","conflict":true,"banner":true,
                 "server":{"rev":50,"C":false}}
```

Cause: `frontend/app/cloudsave.js:346`, the reconcile branch `if (isSave(local) && local._saveDirty)`, boots any dirty
local snapshot as this window's offline edits. The cache key `starnet.save` is shared by every window, so another
live window's stale snapshot can't be told apart from this window's own offline work. `_saveClient` is per page load
and is not compared.

## Verdict

Fixed in source on the wave-1 candidate. 923f03a98 (save-latch-kill): each window's browser copy is its own crash journal ('starnet.save' for the first window, 'starnet.save.w.<window>' for another live tab), and cloudsave.js openJournal() picks it first at boot (frontend/app/app.js). A reload continues its own journal (sessionStorage) and never takes a live window's, so the newer window boots its own confirmed state, never the stale window's snapshot. A dead window's dirty journal is merged into the station (POST /api/save/adopt) before boot, which keeps offline edits across a restart, the other side of the fork the Notes named. c28d7ed0d and 7cffe0352 make the behind window merge three-way instead of latching a conflict. Regression tests green on the merged tree: save-interleave.seeded (81, including its named 27bae3d6 block: two tabs of one browser, B reloads, continues its own journal, holds both tabs' work, shows no merge notice) and save-journal (42). Not live-proven in two real browser tabs; not released.

## Notes

Not fixed: this is a product fork (offline edits across an app restart versus a concurrent stale window). Nothing
is silently lost, because the station file and the conflict file both survive. The defect is that the newer window
shows, and attributes to itself, a state it never made.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

Closed 2026-10-27 on the wave-1 candidate, where `923f03a98`, `c28d7ed0d` and `7cffe0352` are ancestors. The per-window
journal keeps both sides of the fork above: a live window's snapshot is never booted by another, and a dead window's
offline edits are merged into the station at the next boot.
