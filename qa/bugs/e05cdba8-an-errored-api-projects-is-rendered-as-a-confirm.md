---
fingerprint: e05cdba8
slug: an-errored-api-projects-is-rendered-as-a-confirm
title: An errored /api/projects is rendered as a CONFIRMED EMPTY trust ledger ("NO TRUSTED PROJECTS") and silently wipes the persisted project scope
surface: safecell
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/safecell
fix: ed200caa
family: truthful-ack
---

# An errored /api/projects is rendered as a CONFIRMED EMPTY trust ledger ("NO TRUSTED PROJECTS") and silently wipes the persisted project scope

## Symptom

When /api/projects answers with any non-2xx status — 403 'forbidden token' after a sidecar restart mints a new per-launch API_TOKEN while the webview holds the old one, or a 5xx — the PROJECTS rail confidently prints the empty hero: "NO TRUSTED PROJECTS · + ADD blesses a folder, or tell an agent to 'work in C:\path\to\project'." The blessed roots are all still on disk and still enforced by pathtrust on every run. Additionally, a Commander who was inside a project scope is silently kicked to the overview and the remembered scope is erased from localStorage.

## Repro

1. Boot the station, bless a project folder, enter it (rail is in PROJECTS scope).
2. Make /api/projects answer non-2xx without killing the socket — in DevTools: `const f=window.fetch; window.fetch=(u,o)=>String(u).startsWith('/api/projects')&&!String(u).includes('/')? new Response('forbidden token',{status:403}) : f(u,o);` (or restart the sidecar so the token rotates, which is the field trigger).
3. Toggle SESSIONS → PROJECTS.
Observed: "NO TRUSTED PROJECTS", the project scope is gone, and localStorage 'starnet.projscope' has been removed.
Expected (the permissions-panel behavior): an UNKNOWN state — "could not load projects" — with the scope left intact.

## Evidence

`frontend/app/app.js:3360`

**Mechanism (read from the code):** renderProjects() does `.then(r => r.ok ? r.json() : { projects: [] })` (app.js:3360). A synthesized empty success is indistinguishable from a real empty store: rows = [] → renderProjectsOverview → `if (!rows.length)` → the NO TRUSTED PROJECTS hero (app.js:3383-3388). The `.catch()` at :3375 only covers a rejected fetch (sidecar wholly down), which does render honestly as "Could not load projects." — so the honest path exists and the non-ok branch simply skips it. A bad token is a 403, not a rejection: rejectBadApiToken does `res.writeHead(403); res.end('forbidden token')` (index.js:258). The scope wipe is at :3364-3368: `if (!row) { setProjScope(null); ... }`, and setProjScope does `localStorage.removeItem('starnet.projscope')` (:3316). This is the same class as the shipped "No standing approvals" bug — and the sibling surface already got the fix: permissionsstore.js:44-53 keeps `loaded:false` + `error` on a bad response, and stationui.js:4942/4946 render "standing approvals could not be verified" instead of an empty ledger. The Projects rail never received it.

**Existing test coverage:** none found — test/projects-view.test.js asserts the rail's blessed/revoked shaping and the remove-vs-forget endpoints by source inspection (lines 90-121) but never touches the fetch's non-ok branch; `grep -rn "projects: \[\]\|NO TRUSTED\|Could not load projects" test/` returns no hits outside nightfocus fixtures.

**Adversarial verdict (survived refutation):** Read directly. frontend/app/app.js:3360 is `.then(r => r.ok ? r.json() : { projects: [] })` — a synthesized empty success on ANY non-2xx; the honest branch exists only for a rejected fetch (:3375 'Could not load projects.'), which a 403 never reaches. rows=[] flows to renderProjectsOverview and :3383-3388 prints the '<b>NO TRUSTED PROJECTS</b>' hero. The scope wipe is real: :3364-3368 `if (!row) { setProjScope(null); … }` and setProjScope at :3316 does `localStorage.removeItem('starnet.projscope')`. The 403 trigger is real and reachable: sidecar/index.js:250-258 rejectBadApiToken answers `res.writeHead(403); res.end('forbidden token')`, and frontend/app/harness.js:109-116 attaches the per-launch token to every /api/ fetch, so a rotated token after a sidecar restart is a 403, not a rejection. The sibling surface already has the fix the finder cites: frontend/app/permissionsstore.js:44-47 keeps loaded:false + error on a bad payload and frontend/app/stationui.js:4942/4946 render 'standing approvals could not be verified'. No test covers it — test/projects-view.test.js:96-122 asserts blessed/revoked shaping and the remove-vs-forget endpoints by source inspection only, and grep for 'projects: []'/'NO TRUSTED'/'Could not load projects' across test/ hits nothing but nightfocus fixtures. Bumped P2→P1: it is the same truthful-telemetry class as the shipped 'No standing approvals' bug (the rail asserts a trust ledger it could not read), plus it destroys persisted state — but unlike claim 1 it is transient and self-heals on the next successful fetch, so it is not P0.

_Found by the `sweep/safecell` lane, 2026-07-28. Finder confidence: high. Severity claimed P2, after refutation P1._

## Verdict

Historical fix ed200caa is retained. The projects reader rejects a non-OK response and renders unavailable without replacing the selected scope with a fabricated empty ledger. The truthful-ack continuation preserves this distinction; no new installed acceptance is claimed.

Truthful-ack family invariants: INV-3 fetch-truth ratchet, INV-5 proven-ack client, and INV-6 refusal-code readers. Shared regression anchors: `test/frontend-fetch-truth-ratchet.test.js`, `test/harness-api.contract.test.js`, and `test/station-refusal-readers.test.js`. Historical fix attribution above is unchanged; family registration is not new installed or recovery evidence.
