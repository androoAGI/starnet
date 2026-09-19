---
fingerprint: 1b9af0d7
slug: execution-and-disconnect-controls-confuse-transp
title: Execution and disconnect controls confuse transport success with action success
surface: safecell
severity: P1
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Execution and disconnect controls confuse transport success with action success

## Symptom

Five execution handlers read the HTTP wrapper instead of its JSON body; channel Disconnect ignored both response and persistence acknowledgement.

## Repro

Drive all five execution handlers with HTTP errors, refused/malformed/missing JSON and valid success; drive disconnect with refused, missing, non-durable and confirmed results. Before 37/55 passed; after 55/55 pass.

## Evidence

`test/control-acknowledgements.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

Execution controls use the actual body and preserve the saved-but-probe-failed distinction. Disconnect requires connected:false and persisted:true. A live settings click renders an injected server refusal instead of a saved confirmation. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
