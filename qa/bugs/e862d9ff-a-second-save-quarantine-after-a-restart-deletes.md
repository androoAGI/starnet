---
fingerprint: e862d9ff
slug: a-second-save-quarantine-after-a-restart-deletes
title: A second save quarantine after a restart deletes the first quarantined copy the recovery notice points to
surface: sessions
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: dd8662b5c 9d4f5ff13 d05241c24 95d71f8c5
origin: audit
family: save-lifecycle
---

# A second save quarantine after a restart deletes the first quarantined copy the recovery notice points to

## Symptom

When the station save is torn and has no usable `.bak`, the store moves the bytes aside to
`agent.save.json.corrupt-<n>` and writes a recovery notice naming that file. That file is the only remaining copy of
the lost station. If a second unrecoverable incident happens after a restart, the second quarantine reuses the name
`.corrupt-1`, deletes the first copy and puts the new bytes in its place. The first incident's bytes are permanently
gone.

## Repro

1. Write a torn `agent.save.json` (unparseable, no `.bak`) and load it through `makeSaveStore`. It is quarantined to `.corrupt-1`.
2. Restart: create a new store instance on the same directory (the quarantine counter starts at 0 again).
3. Write another torn `agent.save.json` with no `.bak` and load it.
4. List `*.corrupt-*` and read their bytes.

## Evidence

Deterministic harness against the real `sidecar/savestore.js`, before the fix:

```
boot1 load -> corrupt notice {"kind":"quarantined",…"quarantinedTo":"…\\agent.save.json.corrupt-1"}
files after boot1: agent.save.json.corrupt-1 agent.save.recovery.json
boot2 load -> corrupt notice {"kind":"quarantined",…"quarantinedTo":"…\\agent.save.json.corrupt-1"}
files after boot2: agent.save.json.corrupt-1 agent.save.recovery.json
agent.save.json.corrupt-1 => [ 'SECOND-INCIDENT-BYTES' ]
```

Cause: `sidecar/savestore.js` quarantine named the copy `file + '.corrupt-' + (++tmpSeq)` (per-process counter) and
then ran `fs.unlinkSync(dead)` before `renameSync`. Regression: `test/save.test.js` block J2 (red before the fix,
green after).

After the fix: `agent.save.json.corrupt-1 => FIRST-INCIDENT-BYTES`, `agent.save.json.corrupt-2 => SECOND-INCIDENT-BYTES`,
and the notice names `.corrupt-2`.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

## Verdict

Fixed. The quarantine steps to the first free `.corrupt-<n>` name and never unlinks an existing copy. The general
stores already avoided this (`index.js` quarantineCorrupt names copies `<file>.corrupt-<pid>-<seq>`); the save store
did not. The name keeps the `.corrupt-<digits>` shape existing readers match.

The family is repaired for the stores migrated by persist-module (2026-11-03). The sentence above about the general stores
was too strong: index.js quarantineCorrupt renamed onto `<file>.corrupt-<pid>-<seq>` with a per-process counter, so a
restart that reused a pid replaced an earlier copy; and the run journal (`<hash>.jsonl.corrupt`) and the deliverables
journal (`deliverables.library.jsonl.corrupt`) used one fixed name, so their second incident always replaced the first.
Every quarantine now goes through sidecar/persist's moveAside or preserve (`sidecar/persist/quarantine.js`): the first
free `<file>.corrupt-<n>` by hard link (EEXIST steps to the next n; without hard links, an exclusively opened and
flushed copy followed by unlink), never onto an existing name, and a move that cannot be made reports ok:false and leaves the bytes where they
were. Legacy copies are kept, and the numbering steps over them. Fixed for the general and full-state stores in
9d4f5ff13, and for the run journal and the deliverables library in d05241c24 (records c836f3f7 and 06a5fb9e). Proof:
`test/persist.conformance.test.js` INV-3 (two incidents across a restart give `.corrupt-1` and `.corrupt-2`,
byte-exact, for every store and journal, each again with hard links failing EPERM, ENOTSUP, ENOSYS, EXDEV, EINVAL and
EISDIR) and `test/persist-seam.http.test.js` S2 (station.widgets.json through index.js), RED at 0b8441064:

```
FAIL: INV-3 [run journal | link link] two incidents across a restart are .corrupt-1 and .corrupt-2
FAIL: INV-3 [run journal | link link] byte-exact, and nothing is left at the journal's name — expected ["FIRST-INCIDENT{","SECOND-INCIDENT{","-"], got ["-","-","-"]
FAIL: INV-3 [deliverables journal | link link] two torn incidents across a restart are .corrupt-1 and .corrupt-2, byte-exact
FAIL: S2: the first torn station.widgets.json is kept byte-exact as station.widgets.json.corrupt-1 (have: … station.widgets.json.corrupt-40768-1)
```

and GREEN at the lane tip.

Review follow-up 95d71f8c5 also closes competing-name and failed-copy ownership gaps. A copy may fail before opening
its destination, so that error never authorizes deleting the path. Persist and run-journal now share the same
exclusive-FD-owned copy; only a destination this call opened is cleaned up. Unknown file or directory flush errors
keep the original. Windows EPERM/EISDIR directory-flush capability limits retain the existing explicit fallback.

The exact 6ed58a52c control is RED26/3800 for the added preservation cases (including the live-temp sibling).
The pre-strict directory-flush control is RED7/3839, one case per link mode. Final conformance is GREEN3846.
These use real scratch files with deterministic filesystem faults, not a claim of a newly observed customer race.
General stores retain their one-sidecar-writer contract; combined landing gates and installed acceptance are separate.

Batch3 lifecycle-owner integration (2026-11-03): station-record's torn-record preservation still used exists-check then rename, so a competing forensic copy could be replaced. The owner now calls persist.moveAside's exclusive naming and retains failure truth. Actual ensure control against saved prior source failed2/10 (competing copy overwritten), repaired owner passed10; station-record842, persistence conformance4217 and real lifecycle HTTP80 passed. An earlier control7/10 included an unlink-only fault that did not reach the older rename implementation; it is superseded by the control that denies original removal on both implementations. Historical status unchanged; combined gate remains owed.
