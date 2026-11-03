---
fingerprint: e055f56e
slug: the-start-fresh-marker-is-written-in-place-so-a
title: The START FRESH marker is written in place, so a crash mid-write leaves a torn receipt that refuses every re-seed
surface: sessions
severity: P2
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: d05241c24
origin: audit
family: save-lifecycle
---

# The START FRESH marker is written in place, so a crash mid-write leaves a torn receipt that refuses every re-seed

## Symptom

START FRESH ends by writing the new generation's `.fresh-start.json` receipt with a plain write in place. A crash or
power loss during that write leaves a zero-length or torn receipt. The station save reads a receipt it cannot parse as
"a reset happened at an unknown time" and refuses to re-seed the station file from any browser copy, so the fresh
station cannot get its save back until someone repairs the receipt by hand.

## Repro

1. Run START FRESH (`workspace-lineage.js` startFresh) with an fs facade that kills the process after the first write
   call to `.fresh-start.json`.
2. Reboot and read the receipt: it is torn.
3. POST a save of a station founded after the reset into the fresh generation: the re-seed is refused.

## Evidence

At 0b8441064, `sidecar/workspace-lineage.js:149`:
`fs.writeFileSync(path.join(current, FRESH_MARKER), JSON.stringify(marker, null, 2));`. In `sidecar/savestore.js:265`
resetReceiptAt answers NaN for a receipt that does not parse, and predatesReceipt treats NaN as "not provably after the
reset", so resetRefusesSeed refuses every seed.

`test/persist.conformance.test.js` at 0b8441064:

```
FAIL: START FRESH marker killed at write point 2/2: the reboot reads the old marker or the new one, never a torn one: "{\n  \"version\": 1,\n  \"at\": \"2026-11-03T00:00:00.000Z\",\n  \"ack"
FAIL: START FRESH marker killed at write point 2/2: the next START FRESH lands and leaves no temp
```

## Verdict

Fixed in d05241c24 (lane persist-module, step S3). The receipt is written through sidecar/persist's writeAtomic (temp,
fsync, rename, with no temp left by a failure and the dead writer's temp swept by the next write), so a crash leaves the
old receipt or the new one, never a torn one. Proof: `test/persist.conformance.test.js` (a crash at every write point
of the marker), RED at 0b8441064 and GREEN at d05241c24. The desktop shell's own marker write (src-tauri
fresh_start.rs) is outside this lane.

Batch3 integration (2026-11-03): station-lifecycle work moved the live marker writer into station-record.writeMirror, used by generation apply; workspace-lineage is request-only. The marker already uses durable-write, now the shared persist atomic writer. Conformance5h was reanchored to that live writer and native mirror fields, preserving every write-point crash/old-or-new/readback/temp-sweep assertion. Conformance4217, real start-fresh-generation HTTP80 and persist-seam HTTP14 passed on the combined WIP. No old immediate-reset writer was restored.
