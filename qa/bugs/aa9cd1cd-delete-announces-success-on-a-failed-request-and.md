---
fingerprint: aa9cd1cd
slug: delete-announces-success-on-a-failed-request-and
title: DELETE announces success on a failed request and leaves the row — same missing `resp.ok` check in ROUTINES, LOOPS and CONNECTORS
surface: world
severity: P2
status: fixed
found: 2026-07-28
lane: sweep/world
fix: 8e68bf5c
family: truthful-ack
---

# DELETE announces success on a failed request and leaves the row — same missing `resp.ok` check in ROUTINES, LOOPS and CONNECTORS

## Symptom

The two-step ✕ DELETE confirms, the station says "routine deleted" / "loop deleted" / "Connector "x" removed", and the row is still there after the list refreshes.

## Repro

Make the sidecar's routine store un-writable (read-only WORKSPACES) so `withCronWrite` throws → `/api/cron/remove` answers 500. In ROUTINES, arm ✕ DELETE and confirm: the "routine deleted" notification fires and the row reappears on refresh. Same with a loop via `/api/loops/remove` and a connector via `/api/connectors/remove`.

## Evidence

`frontend/app/windows/routines.js:298`

**Mechanism (read from the code):** Three instances of the identical shape, all using a bare `fetch` helper that resolves on 4xx/5xx: routines.js:298 `try { await post('/api/cron/remove', { id }); notify('routine deleted'); } catch (_) {} refresh();`; loops.js:364 `try { await post('/api/loops/remove', { id }); notify('loop deleted'); } catch (_) {} refresh();`; connectors.js:547 `if (act === 'remove') { await postJSON('/api/connectors/remove', { id }); notify('Connector "' + id + '" removed'); … ccRefresh(); }`. `handleCronRemove` (sidecar/index.js:7790) returns `json(500, {error:'could not save: …'})` when `withCronWrite` throws and `json(400,{error:'bad json'})` on a malformed body; a 403 from apiauth resolves the same way. Because the notify sits after the await inside the try, only a true network failure is caught. The trailing `refresh()`/`ccRefresh()` re-reads the server and re-renders the surviving row — the announce-success-and-leave-the-row shape. (Related, same file: connectors.js:564's ENABLE pill fires `sfx('tick')` on a 500 and only reverts because `refresh()` re-reads the flag.)

**Existing test coverage:** none found — grep of test/ for windows/routines.js, windows/loops.js, windows/connectors.js returns only test/autojobs-ui.test.js (the #rt-propose lock). No test asserts a response-status check in any of these three delete handlers.

**Adversarial verdict (survived refutation):** All three sites confirmed at the cited lines. routines.js:298 `sfx('bad'); try { await post('/api/cron/remove', { id }); notify('routine deleted'); } catch (_) {} refresh();` against the bare `post` at routines.js:95. loops.js:364 is the identical line against the bare `post` at loops.js:72. connectors.js:547 `if (act === 'remove') { await postJSON('/api/connectors/remove', { id }); notify('Connector "' + id + '" removed'); ... ccRefresh(); }` against the bare `postJSON` at connectors.js:535. The failure mode is reachable: sidecar/index.js handleCronRemove returns `json(500,{error:'could not save: …'})` when withCronWrite throws and `json(400,{error:'bad json'})` on a malformed body. harness.js:111's fetch wrapper adds a header only — it never rejects on non-ok, so nothing upstream normalizes this. The related note about connectors.js:564 firing `sfx('tick')` on a 500 is also accurate as written. No test in test/ exercises any of the three handlers. P2 is the right rank: it is one notification, and the trailing refresh()/ccRefresh() repaints server truth a beat later.

_Found by the `sweep/world` lane, 2026-07-28. Finder confidence: high. Severity claimed P2, after refutation P2._

## Verdict

Confirmed across all reported sites. `3f0d1205` closed routines and loops; `8e68bf5c` completed the connector delete and enable-toggle paths. Every handler now checks `Response.ok` before announcing or committing visible success; connector failures keep edit state and revert the optimistic toggle. The focused routines/connectors source regressions pass.

Truthful-ack family invariants: INV-3 fetch-truth ratchet, INV-5 proven-ack client, and INV-6 refusal-code readers. Shared regression anchors: `test/frontend-fetch-truth-ratchet.test.js`, `test/harness-api.contract.test.js`, and `test/station-refusal-readers.test.js`. Historical fix attribution above is unchanged; family registration is not new installed or recovery evidence.
