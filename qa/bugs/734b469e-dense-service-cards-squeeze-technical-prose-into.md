---
fingerprint: 734b469e
slug: dense-service-cards-squeeze-technical-prose-into
title: Dense service cards squeeze technical prose into tiny columns
surface: channels
severity: P2
status: fixed
found: 2026-09-07
lane: agent/ui-density-audit
fix: 221775a85
origin: owner
report: Owner screenshot and UI audit request, 2026-09-07
affected: 0.11.0 source; installed build in screenshot unknown
family: record-readability
installer: unverified
recovery: unconfirmed
---

# Dense service cards squeeze technical prose into tiny columns

## Symptom

Connected services squeeze names, URLs, account caveats, repeated release warnings and controls into competing tiny columns. The same record styling compresses API keys, loops, run history and restore points; explanatory copy across consoles is also too small.

## Repro

1. Open ABILITIES → CONNECTED SERVICES with saved Google Workspace services.
2. Read the repeated Google deferral explanation and account-identity caveat alongside each URL.
3. Open saved API connections, AUTOMATION → LOOPS, and AGENT DOSSIER → RECORD with populated records; inspect each record's computed layout.

## Evidence

Owner screenshot, 2026-09-07. Reproduced in the seeded live app at port 8967 using disposable read fixtures through production renderers. Before receipts in `.uishots/before/report.json` show service/key/loop/logbook/restore cards inheriting `flex-direction: row`, 11px account/release prose, and 12–13px explanatory copy. `frontend/css/style.css:547` supplies the legacy header rule; the record rule in `frontend/css/app.css` failed to override its direction. Regression coverage: `test/connectors-ui.test.js`.

## Verdict

Source-fixed in 221775a85. Live seeded before/after captures and eight interaction checks passed; the full fast gate is 729/729 green and customer journeys are 29/29 green. Installed executable and owner recovery remain unverified. Full scope and limits are recorded in `qa/digests/2026-09-07-ui-density-audit.md`.

## Regression

Production renderer assertions preserve deferred state, saved setup, rejected OAuth recovery actions, escaping and complete tool lists while folding secondary details. Shared record layout now stacks; connector footers use a two-column grid that stacks at narrow widths. The release explanation is deduplicated above the list. Live before/after screenshots and computed-layout receipts are recorded under `.uishots/` in the lane.

## Sibling coverage

{"adapters":[{"target":"HTTP, OAuth and stdio connector presentation","state":"covered","test":"test/connectors-ui.test.js","scenario":"manager transport threading and production service row state/detail rendering","gate":"fast"}],"entrypoints":[{"target":"connected services and saved API connections","state":"covered","test":"test/connectors-ui.test.js","scenario":"service management and platform key routing remain reachable","gate":"fast"}],"displays":[{"target":"seeded browser at 1440px and 760px","state":"blocked","reason":"Live fixture screenshots and DOM receipts exist in this lane; no registered browser geometry gate or installed artifact receipt yet."},{"target":"installed Windows and macOS desktop","state":"blocked","reason":"This source repair has not been packaged or tested on an installed desktop artifact."}],"lifecycle":[{"target":"connector refresh, expand and reopen","state":"blocked","reason":"Live browser interaction verification is tracked separately from the registered fast renderer suite."}]}
