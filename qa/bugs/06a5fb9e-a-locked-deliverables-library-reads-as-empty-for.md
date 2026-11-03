---
fingerprint: 06a5fb9e
slug: a-locked-deliverables-library-reads-as-empty-for
title: A locked deliverables library reads as empty for the whole session, and its torn-journal copy keeps only the last incident
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: d05241c24
origin: audit
family: save-lifecycle
---

# A locked deliverables library reads as empty for the whole session, and its torn-journal copy keeps only the last incident

## Symptom

When the deliverables library's snapshot (`deliverables.library.json`) or its journal (`deliverables.library.jsonl`)
cannot be read at load because another process holds it (EBUSY, EACCES or EPERM), the library loads as empty and keeps
that state for the whole session. It lists nothing, and the next deliverable the station records is written on top of
the empty state, so rows that were on disk are gone once the lock clears. Separately, a torn journal line is kept by
copying the journal to a fixed `deliverables.library.jsonl.corrupt`: a second torn incident overwrites the first
incident's copy, and a copy that fails does not stop the cut to the valid prefix.

## Repro

1. Record two deliverables (d1, d2) through `makeDeliverableStore`.
2. On a fresh store instance, make `readFileSync` of `deliverables.library.json` fail with EBUSY, list the library, then
   record d3.
3. Clear the lock and list the library on a fresh instance.

## Evidence

At 0b8441064, `sidecar/deliverable-store.js:117` and `:119` read an unreadable snapshot (`durable.get` answers
undefined) and an unreadable journal (`catch (_) {}`) as empty, and `load()` caches the result:

```
try { state = normalize(durable.get(KEY)); } catch (_) { state = normalize(null); }
let raw = '';
try { raw = fs.readFileSync(journalFile, 'utf8'); } catch (_) {}
```

`sidecar/deliverable-store.js:134` keeps a torn journal under one fixed name and cuts it whether or not the copy landed:
`try { fs.copyFileSync(journalFile, journalFile + '.corrupt'); } catch (e) { failNote('deliverables.journal.quarantine', e); }`.

`test/persist.conformance.test.js` at 0b8441064:

```
FAIL: INV-5 [deliverables | locked snapshot | EBUSY] the library is a typed refusal (the errno its cause), never empty — expected ["ESTORE_UNREADABLE","EBUSY"], got [null,null]
FAIL: INV-5 [deliverables | locked snapshot | EBUSY] and the write it would feed is refused — expected "ESTORE_UNREADABLE", got "ok"
FAIL: INV-5 [deliverables | locked snapshot | EBUSY] nothing was cached: the real rows read back once the lock clears — expected ["d1","d2"], got ["d2","d3"]
FAIL: INV-5 [deliverables | locked journal | EBUSY] the library is a typed refusal (the errno its cause), never empty — expected ["ESTORE_UNREADABLE","EBUSY"], got [null,null]
FAIL: INV-3 [deliverables journal | link link] two torn incidents across a restart are .corrupt-1 and .corrupt-2, byte-exact
```

d1 is lost in the third line: the write made during the lock replaced the snapshot that held it.

## Verdict

Fixed in d05241c24 (lane persist-module, step S3). The snapshot and the journal are read through sidecar/persist's
tagged reads. A lock is a typed ESTORE_UNREADABLE refusal with the errno as its cause: nothing is cached, appends are
refused, and the first load after the lock clears reads the real rows. A torn journal is kept at the first free
`deliverables.library.jsonl.corrupt-<n>` as a real copy (the journal is appended in place, so a shared inode would
change it) before the cut; a copy that fails, or a cut that fails after it, leaves the journal as it was and the next
load retries. Proof: `test/persist.conformance.test.js` INV-3 and INV-5, RED at 0b8441064 and GREEN at d05241c24.
