---
fingerprint: d50f704b
slug: a-torn-store-with-no-usable-backup-is-overwritte
title: A torn store with no usable backup is overwritten with no copy of its bytes
surface: sessions
severity: P2
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: 9d4f5ff13 b1b0be499 cb6ff28fa
origin: audit
family: save-lifecycle
---

# A torn store with no usable backup is overwritten with no copy of its bytes

## Symptom

A store file that is present but torn or unparseable loads as empty, and the next write replaces it without keeping
its bytes anywhere. The channel stores (chat map and channel history) never kept them. A general durable store kept
them only when its read-time quarantine ran and succeeded: a blind `set()`, a store composed without an onCorrupt
handler, or a quarantine whose rename failed (a locked file) let the write go over the torn bytes. The station save
did the same when its quarantine rename failed: it answered ok:true and wrote over the torn file. With a good `.bak`,
durable-store and the channel stores recovered the `.bak`'s value but dropped the torn main's bytes on the next write,
and those bytes can hold the newest write.

## Repro

1. Write `{"k":"torn` with no `.bak` as a store file of each kind (a general store, a full-state store, the chat map,
   the station save), and make the read-time move aside fail (rename EPERM).
2. Read it (it loads as empty), then write a new value.
3. List the folder: no copy of the torn bytes remains.

## Evidence

At 0b8441064, `sidecar/durable-store.js:142` writeJsonResilient keeps only a good main (as the `.bak`) and replaces a
present-but-bad one as it is; `sidecar/channels/store.js:210` writeJsonAtomic: "A corrupt current main is NOT kept";
`sidecar/savestore.js:147` quarantine returns null when its rename fails ("leave it"), and the save then writes over the
file.

`test/persist.conformance.test.js` at 0b8441064:

```
FAIL: INV-1 [channels chatmap | link link] torn main, no .bak — expected {"afterRead":["corrupt-1={\"k\":\"torn"],…,"main":"V2","read":"empty",…}, got {"afterRead":[],"bak":"-","forensic":[],"main":"V2","read":"empty","temps":[],"write":"ok"}
FAIL: INV-1 [general | link link] move-aside fails — expected {…"forensic":["corrupt-1={\"k\":\"torn"],"main":"V2","mainAfterRead":"{\"k\":\"torn",…}, got {…"forensic":[],"main":"V2","mainAfterRead":"{\"k\":\"torn",…"write":"ok"}
FAIL: INV-1 [general | link link] preserve fails — expected {…"main":"{\"k\":\"torn",…"write":"refused:corrupt"}, got {…"main":"V2",…"write":"ok"}
FAIL: INV-1 [general | link link] torn main + good .bak — expected {"afterRead":["corrupt-1={\"k\":\"torn"],…}, got {"afterRead":[],"bak":"V1","forensic":[],…
FAIL: INV-1 [savestore | link link] move-aside fails — expected {…"forensic":["corrupt-1={\"k\":\"torn"],…}, got {…"forensic":[],"main":"V2",…"write":"ok"}
FAIL: INV-1 [savestore | link link] preserve fails — expected {…"main":"{\"k\":\"torn",…"write":"refused:corrupt"}, got {…"main":"V2",…"write":"ok"}
```

## Verdict

Fixed by the persist-module lane: 9d4f5ff13 (sidecar/persist, the general and full-state stores), b1b0be499 (the
channel stores) and cb6ff28fa (the station save). Every store replaces through persist's replaceJson: a present-but-bad
main is kept byte-exact as the first free `<file>.corrupt-<n>` before the replace, and when that copy cannot be made the
write is refused with ESTORE_CORRUPT and the bytes stay untouched. The one read policy also moves a torn main aside when
a good `.bak` recovers the store. Proof: `test/persist.conformance.test.js` (the torn, move-aside-fails and
preserve-fails rows for every store, each again with hard links failing EPERM, ENOTSUP, ENOSYS, EXDEV, EINVAL and
EISDIR), RED at 0b8441064 and GREEN at the lane tip. This is the write side of 34c58f4f's family.
