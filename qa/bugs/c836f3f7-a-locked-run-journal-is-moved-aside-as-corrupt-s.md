---
fingerprint: c836f3f7
slug: a-locked-run-journal-is-moved-aside-as-corrupt-s
title: A locked run journal is moved aside as corrupt, so its run drops out of the run list
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: d05241c24
origin: audit
family: save-lifecycle
---

# A locked run journal is moved aside as corrupt, so its run drops out of the run list

## Symptom

When the sidecar reads a run journal while another process holds it (antivirus, a backup tool or an indexer: EBUSY,
EACCES or EPERM on Windows), it treats the failed read as a journal with no records and moves the file aside to
`<hash>.jsonl.corrupt`. The run leaves the run list and can no longer be resumed or resolved, although nothing was
wrong with its bytes. The copy has a fixed name, so the next incident on the same journal replaces the first copy, and
a move that fails is still reported as made.

## Repro

1. Write a run journal whose final record is torn under `.run-journal/`.
2. Make the journal store's `readFile` of that file fail with EBUSY and run its recovery pass (`recoverFile`).
3. List the folder: the journal is gone and `<hash>.jsonl.corrupt` holds its bytes. Clear the lock and run the pass
   again: the run is not listed.

## Evidence

At 0b8441064, `sidecar/run-journal.js:570` turns any read error into an empty, corrupt parse:

```
try { parsed = parseRecords(rawText != null ? rawText : io.readFile(file)); }
catch (_) { parsed = { records: [], corrupt: true, damage: 'corrupt' }; }
```

and `sidecar/run-journal.js:225` moves the file to a fixed name, returning the destination even when the rename failed:

```
quarantine(filePath) {
  const to = filePath + '.corrupt';
  try { fs.renameSync(filePath, to); } catch (_) {}
  return to;
},
```

`test/persist.conformance.test.js` at 0b8441064:

```
FAIL: INV-3 [run journal | EBUSY] a torn journal it cannot read is unreadable: neither repaired nor moved aside, and refused for every action — expected [true,"",null,null,true], got [false,"","…\04b073b8….jsonl.corrupt",null,false]
FAIL: INV-3 [run journal | EBUSY] its bytes stay where they are: no copy, no evidence, no temp
FAIL: INV-5 [run journal | EBUSY] the listing carries both as unreadable rows with no identity (the boot walk skips them)
FAIL: INV-5 [run journal | EBUSY] once the lock clears the next pass reads the journal and repairs its torn tail
FAIL: INV-3 [run journal | link link] two incidents across a restart are .corrupt-1 and .corrupt-2
FAIL: INV-3 [run journal | link link] a move that cannot be made reports quarantinedTo null and leaves the journal where it was, with no copy
```

## Verdict

Fixed in d05241c24 (lane persist-module, step S3). The journal is read through sidecar/persist's tagged text read, so
a read that fails with anything but ENOENT or ENOTDIR is unreadable: the journal is neither repaired nor moved, its
state carries a repairError so every action gate (resolve, continuation, adopt) refuses it, and the first pass after
the lock clears reads and repairs it. A journal that really is unparseable goes to the first free
`<hash>.jsonl.corrupt-<n>` through persist's moveAside, which reports `quarantinedTo: null` and leaves the file where it
was when the move cannot be made. Proof: `test/persist.conformance.test.js` INV-3 and INV-5, RED at 0b8441064 and
GREEN at d05241c24. The class (an unreadable file read as empty or corrupt) is 34c58f4f's family; the fixed-name copy
is e862d9ff's.
