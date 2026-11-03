---
fingerprint: 778080b7
slug: an-e-stop-mid-night-shift-beat-records-the-parti
title: An E-STOP mid night-shift beat records the partial stream as a delivered draft
surface: autonomy
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 4fc2117d7
origin: audit
family: run-lifecycle
---

# An E-STOP mid night-shift beat records the partial stream as a delivered draft

## Symptom

Press the E-STOP while a night-shift beat is mid-way: the morning report and SETTINGS › AUTONOMY then show a DELIVERED draft — titled from the beat's plan, with a body that is just the few words that had streamed before the stop ("Working on it"). The ledger records the stopped beat as delivered.

## Repro

1. Boot with `SKYNET_NIGHTSHIFT_AWAY_MS=1`, dial at leash/observe with hot beliefs; the mock answers the propose call with one grounded `JOB:` block and hangs the next (DO) call after one token.
2. When the DO call arrives, `POST /api/halt`.
3. Read `GET /api/nightshift/drafts` and `GET /api/autonomy/ledger?source=nightshift`.
Regression: `test/nightshift-halt-no-fake-draft.e2e.test.js`.

## Evidence

Live (scratchpad probeI `halt`, before): `drafts: [{ title:"Automate the release notes", archetype:"kill-pain", body:"Working on it" }]`, autonomy ledger `{ kind:"note", reason:"delivered", detail:{ phase:"outcome", delivered:true } }`, run row for the DO call `reason:"cancelled"`. Root cause: `nightshiftChat` in `sidecar/index.js` read only `agent.token` / `agent.run.error` and returned `{ text: state.buf }` for any end — a cancelled call has no error event — so `parseDeliverable` built a draft from the partial text and the (already aborted, empty) critique defaulted to `ship`. The same path took any budget/limit stop as a finished reply. Test RED (2 problems) before, GREEN after; all 24 nightshift/autopilot/nightreport tests still pass.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: only a run whose terminal reason is 'done' is a reply; anything else returns an error and the beat stands down undelivered.

Family run-lifecycle (run-table lane S2, 2026-11-03): the family is "a cut run read as delivered". A run whose host throws is now ended once by runOnce's belt, with an 'error' end (failed / no_terminal_outcome) and never 'done', so a beat whose run throws still stands down undelivered. test/run-lifecycle.invariants.http.test.js pins one start and one end per run on every surface, and test/nightshift-halt-no-fake-draft.e2e.test.js stays green. Status unchanged.
