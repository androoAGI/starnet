---
fingerprint: f6b8f1aa
slug: pre-update-bundles-carry-forensic-copies-and-leg
title: Pre-update bundles carry forensic copies and legacy temps as records, and can drop a repaired journal's damage evidence
surface: release
severity: P2
status: fixed
found: 2026-11-03
lane: agent/persist-module-1103
fix: d05241c24
origin: audit
family: save-lifecycle
---

# Pre-update bundles carry forensic copies and legacy temps as records, and can drop a repaired journal's damage evidence

## Symptom

The station-recovery bundle classifier recognised a temp, a `.bak` and a numbered quarantine with three inline rules.
Everything else beside a store rode in the bundle raw: bare `<file>.corrupt` copies (run-journal and the deliverables
journal), `.unseen-<n>` copies, and the legacy temps `<file>.tmp-<pid>-<now>-<seq>` and `<file>.repair-<hex>`. In the
other direction, a run journal's damage-evidence copy `<hash>.jsonl.corrupt-<10 hex>` whose nonce happened to be all
digits matched the numbered-quarantine rule and was dropped, so the restored journal lost the mark that says it was
repaired.

## Repro

1. Ask `sidecar/station-recovery.js` classifyPolicy for each sibling name of a store and a run journal:
   `agent.save.json.corrupt`, `agent.save.json.unseen-1`, `agent.save.json.tmp-4242-1700000000000-1`,
   `agent.save.json.repair-ab12cd34ef` and `.run-journal/<64 hex>.jsonl.corrupt-0123456789`.
2. The first four come back include, the last one skip.

## Evidence

At 0b8441064, `sidecar/station-recovery.js:435` and `:438` hold the inline rules:
`(store && /\.tmp(?:$|\.)/.test(p.toLowerCase()))` and `/\.corrupt-[\d-]+$/.test(p.toLowerCase())`.

`test/persist.conformance.test.js` at 0b8441064 (27 INV-6 rows), among them:

```
FAIL: INV-6 [bundle] agent.save.json.tmp-4242-1700000000000-1 (temp): skip — expected "skip", got "include"
FAIL: INV-6 [bundle] agent.save.json.repair-ab12cd34ef (temp): skip — expected "skip", got "include"
FAIL: INV-6 [bundle] agent.save.json.unseen-1 (forensic): skip — expected "skip", got "include"
FAIL: INV-6 [bundle] agent.save.json.corrupt (forensic): skip — expected "skip", got "include"
FAIL: INV-6 [bundle] .run-journal/abab…abab.jsonl.corrupt-0123456789 (evidence): include — expected "include", got "skip"
FAIL: INV-6 a repair's evidence copy is .torn-r<hex>: its nonce carries a letter, so it never reads as a numbered quarantine
```

## Verdict

Fixed in d05241c24 (lane persist-module, step S3; decision D6). classifyPolicy and workspace-lineage read one sibling
name grammar, `sidecar/persist/names.js`: temps (own and legacy) are never bundled or counted as evidence; numbered
quarantines, `.unseen-<n>` and legacy bare `.corrupt` copies are skipped like `.bak`; a run journal's damage evidence
(persist's `.corrupt-r<hex>` and `.torn-r<hex>`, and the base repair's bare 10-hex nonce, told apart by the journal's
name and the nonce's width) still rides with its journal. Proof: `test/persist.conformance.test.js` INV-6 (the names
golden table), RED at 0b8441064 and GREEN at d05241c24.
