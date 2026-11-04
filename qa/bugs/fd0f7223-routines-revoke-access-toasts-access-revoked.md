---
fingerprint: fd0f7223
slug: routines-revoke-access-toasts-access-revoked
title: ROUTINES › REVOKE ACCESS toasts "access revoked" (green) on a 4xx/5xx — bare `fetch` resolves, so the unattended grant survives its own success message
surface: world
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/world
fix: 3f0d1205
family: truthful-ack
---

# ROUTINES › REVOKE ACCESS toasts "access revoked" (green) on a 4xx/5xx — bare `fetch` resolves, so the unattended grant survives its own success message

## Symptom

The Commander clicks ⌫ REVOKE ACCESS on a routine holding an unattended terminal/connector grant, gets a green "access revoked" toast — and the row still shows the ⌘ terminal / ⧉ connected tools badge and still offers REVOKE. The routine can still run shell commands unattended.

## Repro

Open ROUTINES with a routine carrying `unattendedGrants` (the ⌘ terminal badge). Make `/api/cron/update` fail — e.g. make WORKSPACES read-only so `withCronWrite` throws and the handler returns 500, or delete the routine in another client first so it returns 404. Click ⌫ REVOKE ACCESS: a green "access revoked" notification appears and the badge/button remain after `refresh()`.

## Evidence

`frontend/app/windows/routines.js:304`

**Mechanism (read from the code):** `const post = (path, payload) => fetch(path, {...})` (routines.js:95) is a bare `fetch`, which resolves for 400/404/500 and rejects only on a network-layer failure. The handler is `try { await post('/api/cron/update', { id, patch: { unattendedGrants: [] } }); notify('access revoked', 'good'); } catch (_) {}` — the notify is inside the `try` but AFTER the await, so it fires on every resolved response regardless of status. `handleCronUpdate` (sidecar/index.js:7751) genuinely returns `json(404, {error:'no such routine'})` and `json(500, {error:'could not save: …'})` from `withCronWrite`, and apiauth returns 403 on a bad token — all of which land as a green success. The proof that this is an oversight and not a convention: the `run` branch of the SAME listener does check (`if (!resp.ok || !resp.body) …`, routines.js:317), and connectors.js:406 checks `if (!r.ok || j.error)`. The trailing `refresh()` then re-renders the grant badge from `Array.isArray(j.unattendedGrants)` (routines.js:164, 181), so the UI simultaneously toasts success and displays the un-revoked grant.

**Existing test coverage:** test/autojobs-ui.test.js is the only test that reads frontend/app/windows/routines.js and it only source-locks the #rt-propose button. test/routine-tools.test.js and test/cron*.test.js cover the sidecar/tool API, not this DOM handler. none found for the handler's response-status check.

**Adversarial verdict (survived refutation):** Verified verbatim. frontend/app/windows/routines.js:95 is `const post = (path, payload) => fetch(path, {...})` — a bare fetch. routines.js:304 is `try { await post('/api/cron/update', { id, patch: { unattendedGrants: [] } }); notify('access revoked', 'good'); } catch (_) {}` with the notify INSIDE the try but after the await, so any resolved response (400/403/404/500) lands as a green toast. I checked the one thing that could refute it — the harness fetch monkey-patch at frontend/app/harness.js:111 — and it only adds the X-StarNet-Token header for /api/ URLs (`return ensureApiToken().then(t => rawFetch(u, withApiToken(init, t)))`); it does not throw on non-ok. The failure codes are real: sidecar/index.js handleCronUpdate returns `json(404,{error:'no such routine'})` when getJob misses and `json(500,{error:'could not save: …'})` when withCronWrite throws. The oversight reading is right — the sibling `run` branch in the SAME listener does check (`if (!resp.ok || !resp.body)`, routines.js:317) and connectors.js:406 checks `if (!r.ok || j.error)`. Kept at P1 rather than raised to P0 because refresh() at :305 immediately re-reads the server and re-renders the ⌘ terminal badge from `Array.isArray(j.unattendedGrants)`, so the false assertion is a transient toast next to self-correcting state, not a persistent lie. No test drives this handler (test/autojobs-ui.test.js only source-locks #rt-propose).

_Found by the `sweep/world` lane, 2026-07-28. Finder confidence: high. Severity claimed P1, after refutation P1._

## Verdict

Confirmed and fixed in `3f0d1205`. REVOKE ACCESS checks the HTTP status before changing the row or emitting success; non-2xx responses retain the grant display and surface an error. The routines source regression is green alongside the real route/store suites.

Truthful-ack family invariants: INV-3 fetch-truth ratchet, INV-5 proven-ack client, and INV-6 refusal-code readers. Shared regression anchors: `test/frontend-fetch-truth-ratchet.test.js`, `test/harness-api.contract.test.js`, and `test/station-refusal-readers.test.js`. Historical fix attribution above is unchanged; family registration is not new installed or recovery evidence.
