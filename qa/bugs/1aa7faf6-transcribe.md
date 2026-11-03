---
fingerprint: 1aa7faf6
slug: transcribe
title: transcribe() never checks r.ok, so any non-JSON /api/stt error (stale-token 403, 5xx, HTML) is laundered into a confirmed-empty transcript and the spoken senten
surface: voice
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/voice
fix: 50a8b07b
family: truthful-ack
---

# transcribe() never checks r.ok, so any non-JSON /api/stt error (stale-token 403, 5xx, HTML) is laundered into a confirmed-empty transcript and the spoken senten

## Symptom

The sidecar crashes and respawns (a documented state — friendlyerror.js:106 exists solely for it: the page still holds the OLD X-StarNet-Token so every /api/* call 403s). The user holds the mic, speaks a full sentence, releases. Nothing appears in the composer, nothing is sent, no error, and the status line returns to 'online' — byte-identical to having said nothing into a dead room. In hands-free it retries silently three times and then reports 'voice mode — tap 🎤 when ready', still never naming the real problem.

## Repro

rig with the recorder path; /api/stt returns {ok:false, status:403, json:() => Promise.reject(SyntaxError)} exactly as a plain-text 403 does. Push-to-talk: 1 /api/stt call, Chat.send never called, statusLog = ['listening…','online'] — no diagnostic written at all. Control (the documented 200 degrade envelope {text:'',reason:'groq: … 500'}) does write 'voice: groq: …'. Hands-free: 3 calls, nothing sent, final status 'voice mode — tap 🎤 when ready'.

## Evidence

`frontend/app/voice.js:893`

**Mechanism (read from the code):** `transcribe()` never inspects `r.ok`: `const r = await fetch('/api/stt', …); const j = await r.json().catch(() => ({})); return { text: (j && j.text) || '', reason: j && j.reason };`. rejectBadApiToken (sidecar/index.js:257) fires BEFORE routing and writes `res.writeHead(403); res.end('forbidden token')` — plain text, so it never reaches the route's sttFailOpenPolicy 200-JSON envelope (index.js:6118). `r.json()` throws, the catch yields `{}`, and the failure is laundered into `{text:'', reason:undefined}`. finish() (line 903) then gates its only diagnostic on `if (!text && reason)`, which is false, so it calls `cb.onFinal('')` → submitTranscript('') → `if (!t) return;`. An unreachable endpoint is rendered as CONFIRMED EMPTY instead of UNKNOWN. Same laundering applies to any 5xx/HTML/empty error body.

**Existing test coverage:** none found — test/voice.draftguard.test.js drives /api/stt only on the success path (grep for 'reason', '403', 'ok: false' in it returns nothing). test/sidecar.http.test.js:820-828 covers the SERVER's 200-degrade shapes, never a 403 or a non-JSON body reaching the client.

**Adversarial verdict (survived refutation):** frontend/app/voice.js:893-896 is verbatim as claimed: `const r = await fetch('/api/stt', …); const j = await r.json().catch(() => ({})); … return { text: (j && j.text) || '', reason: j && j.reason };` — r.ok is never inspected anywhere in transcribe(). The 403 is genuinely reachable and genuinely non-JSON: sidecar/index.js:6075 runs `if (isApi && rejectBadApiToken(req, res)) return;` BEFORE the route table (the /api/stt entry is at 6156 with sttFailOpenPolicy), and rejectBadApiToken at index.js:258 does `res.writeHead(403); res.end('forbidden token');` — plain text, so the route's 200-JSON envelope (6118 / handleStt:13250-13251) is never reached. apiauth.js:59-65 confirms /api/stt is NOT in TOKEN_EXEMPT, and harness.js:109-116 monkey-patches window.fetch to attach X-StarNet-Token to every same-origin /api/ call, so voice.js's bare fetch does carry the stale token after a respawn — the exact state friendlyerror.js:105-106 and :185-187 are written for. r.json() then rejects on 'forbidden token', the catch yields {}, and voice.js:905 `if (!text && reason)` is false (reason === undefined), so no diagnostic and no maybeFallbackToWebSpeech; 906 calls onFinal('') → submitTranscript:1053 → `if (!t) return;` at 1061. In hands-free, endListening:1045 routes to handleEmptyListen:746-749 which burns emptyStreak up to MAX_EMPTY=3 and lands on 'voice mode — tap 🎤 when ready'. Test claim verified: voice.draftguard.test.js has zero occurrences of reason/403/ok:false, and sidecar.http.test.js:820-828 only asserts the SERVER's 200-degrade shapes. Note the trigger is broader than 403 — any 5xx/HTML/empty error body launders identically; a fully-down sidecar is fine because the fetch rejection is caught at 908-911. Keeping P1 for the silent data loss, but retitling to the root cause rather than one trigger.

_Found by the `sweep/voice` lane, 2026-07-28. Finder confidence: medium. Severity claimed P1, after refutation P1._

## Verdict

Historical fix 50a8b07b is retained. The transcription reader checks HTTP success and returns an explicit failed reason on refusal, including non-JSON error bodies; unavailable speech is not confirmed silence. The truthful-ack continuation preserves that failure distinction and reads station refusal identity through the existing classifier. No new installed acceptance is claimed.

Truthful-ack family invariants: INV-3 fetch-truth ratchet, INV-5 proven-ack client, and INV-6 refusal-code readers. Shared regression anchors: `test/frontend-fetch-truth-ratchet.test.js`, `test/harness-api.contract.test.js`, and `test/station-refusal-readers.test.js`. Historical fix attribution above is unchanged; family registration is not new installed or recovery evidence.
