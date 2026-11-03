---
fingerprint: ca42c717
slug: a-store-that-was-locked-at-boot-starts-empty-and
title: A store that was locked at boot starts empty, and its next save overwrites every entry it never read
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: 9d4f5ff13
origin: audit
family: save-lifecycle
---

# A store that was locked at boot starts empty, and its next save overwrites every entry it never read

## Symptom

About 40 full-state stores load once at boot through `loadResilient` and save their whole state through
`saveResilient`: channel secrets, connector service keys, OAuth tokens, the skill allowlist, the Commander dossier and
others. When one of those files is locked at boot (antivirus or a backup tool: EBUSY, EACCES or EPERM), the load is
silent and the store starts empty. The lock clears, the user changes one thing, and the save writes the store's
in-memory state over the file: every entry the boot read could not see is gone from the main, and survives only in the
`.bak` until the next save replaces that too. A general store used as get() then set() does the same.

## Repro

1. Write a full-state store file holding entries a and b.
2. Make the boot read of that file fail with EBUSY (`loadResilient` answers undefined), then clear the lock.
3. Add entry c and save (`saveResilient`), then save once more.
4. Read the file: it holds only c.

## Evidence

At 0b8441064, `sidecar/index.js:1124` loadResilient answers undefined for an unreadable file and says nothing:
`return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;`. `sidecar/index.js:1127` saveResilient
then replaces whatever is on disk with the in-memory state, and `sidecar/durable-store.js:195` get() does the same for a
general store (`undefined` for unreadable).

The planning probe (`readJsonResilient` + `writeJsonResilient`, the index.js pattern, after a boot EBUSY) left `{c}`
only; durable-store get() + set() left `{chanC}` only (chanA and chanB gone). `test/persist.conformance.test.js` at
0b8441064:

```
FAIL: INV-1 [full-state | link link] boot read unreadable, then a later write — expected {"afterRead":[],"bak":"V1","forensic":["bak.unseen-1=V0","unseen-1=V1"],"main":"V2","read":"refused:unreadable",…}, got {"afterRead":[],"bak":"V1","forensic":[],"main":"V2","read":"empty","temps":[],"write":"ok"}
```

Through the production wiring, `test/persist-seam.http.test.js` at 0b8441064 (the dossier locked at boot, unlocked,
then POST /api/dossier):

```
FAIL: S3: the dossier bytes the boot read could not see are kept byte-exact in _commander.dossier.json.unseen-1 (have: _commander.dossier.json _commander.dossier.json.bak …)
```

## Verdict

Fixed in 9d4f5ff13 (lane persist-module, step S1; decision D2). An unreadable read marks the file in sidecar/persist,
and loadResilient notes it (failNote persist.load.unreadable) instead of staying silent. A blind writer (saveResilient,
a plain set()) replacing a marked file first keeps every present copy byte-exact as `<file>.unseen-<n>` and
`<file>.bak.unseen-<n>`, then writes; if a copy cannot be made the write is refused with ESTORE_UNSEEN. Only a
successful replace clears the mark. Proof: `test/persist.conformance.test.js` ("boot read unreadable, then a later
write", every store and every link fault) and `test/persist-seam.http.test.js` S3 through index.js, RED at 0b8441064
and GREEN at the lane tip. Known limit: the mark lives in the process, and the store's in-memory state is still the
empty one it built; the unseen bytes are kept, and merging them back is the owning store's follow-up.
