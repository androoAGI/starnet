---
fingerprint: f366863e
slug: run-in-flight-keeps-sending-a-removed-key
title: A run in flight keeps sending a provider key that was removed or replaced mid-run
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: 028604d6b
origin: audit
family: B1-credential-sources
---

# A run in flight keeps sending a provider key that was removed or replaced mid-run

## Symptom

A routine, a chat or a worker that was already running when the Commander removed or rotated its provider key — under SETTINGS → AI & MODELS on the desktop, or in a browser page — kept going out on the old key for the rest of the run. Every later turn, a retry, a rotation onto a backup key, a fallback and a context-compaction fold carried the removed key, and the run ended "done" on it. A new run refused (desktop, since ec32cb8f) or picked up the new key, but a long run that was in flight did not notice.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and run `node test/credential-store.remove-rotate.e2e.test.js` from this lane in it (copy `test/helpers/env-probe.js` with it). Section 4 boots a browser-mode sidecar whose page saved a CUSTOM key and endpoint, and a recording upstream that holds the routine's first turn.
2. Run Now on the CUSTOM routine. While the first turn is held at the upstream, the page removes its CUSTOM copy (POST /api/providers/engine-key with an empty key).
3. Release the first turn with one tool call. The upstream then receives the second turn, carrying the removed key, and the run ends `done`.
4. Unit form: `node test/loop.credential-live.test.js` in the same checkout. The loop ignores `credentialGone`, so every row's next call goes out on the removed key.

## Evidence

- Mechanism at a3af8dafd: sidecar/loop.js re-checks only spend before each provider attempt (`stopForSpend`, sidecar/loop.js:1898, asked at 2046), never the credential, and index.js `runOnceCore` builds the run's adapters once, each with its key: the primary (`selectProvider({ provider: providerId, fetch: globalThis.fetch, key: runKey, baseUrl, reasoningEffort })`, sidecar/index.js:23373), the warm backup and each rotation entry (23439, 23446) and each provider fallback (23497). The compaction summarizer is called on the loop's current adapter (sidecar/loop.js:1801), the aux vision call streams on it, and the post-run passes (reflection, failure review, study, the skill review, the parked verdict review) ride it too.
- `test/credential-store.remove-rotate.e2e.test.js` in a scratch checkout of a3af8dafd: 49 problems, 49 ok. Its first in-flight failure is "in flight, browser: turn 2 never goes out (at trunk it carried the removed page key) — expected [true], got [true,true]": both requests the upstream saw for the routine carried the removed page key. The run ended `done`. The desktop REMOVE and rotation rows fail the same way (turn 2 went out on the removed keychain key and on the rotated-away OpenRouter key). The body-key row passes at trunk and is a guard. The other 37 problems are step S2's rows (ec32cb8f).
- `test/loop.credential-live.test.js` in the same checkout: 35 problems, 13 ok. The first is "1: turn 2 never goes out on the removed key — expected ["P"], got ["P","P"]". A model fallback after a rotation went back to the primary adapter and sent 7 more calls on its removed key; a retry ladder sent 6 more calls on a key removed during its first backoff; a fallback's preflight fold called the summarizer on a removed key.
- Related customer report: email E25, class (e) in the credential-store plan. Its own mechanism is not established, and this record does not claim it.

## Verdict

Fixed by 028604d6b on agent/credential-store-1031 (credential-store lane, step S3; decision 7; not merged yet).

The loop takes `credentialGone(adapter)` and asks it, with the adapter it is about to call, at the top of each turn and of each attempt, beside the spend stop: the first call, a retry, a rotation onto a backup key, a model or provider fallback. It asks again before a paid compaction fold and before the compress recovery folds. While the key that adapter sends is held the answer is empty and nothing changes. Once it is not, the run ends `error` with the in-flight sentence (`agent.run.error`, failureStage `credential`) before the request goes out. A stream already running finishes its tokens. No `shared/events.js` change: the stop uses the existing reason `error`.

`runOnceCore` answers from the credential store's `inFlight()` watch (sidecar/credential-store.js). Every adapter it builds on a key is watched on that key: the primary, the warm backup it may start on, each rotation entry, each provider fallback. A key is watched only when a station layer held it as the run resolved it, and the caller did not send it in this request. The primary's key is judged when it is resolved, because its adapter is built after the run's awaits (a pre-run script among them). `holds()` says whether the keychain, the environment or the page copy still holds that exact key, as its key or in its pool. So only a REMOVE or a rotation of that very key, in every layer that held it, stops a run. The aux vision call asks the same watch, and the post-run passes and the parked verdict review are skipped once the run's key is gone. The sentence is engine-credential.js `credentialError` kind `removed`: "the <PROVIDER> key this run started on was removed or replaced on this station, so it stopped before its next model call — run it again to use the key the station holds now, or add one under SETTINGS → AI & MODELS, or set <VAR> in the environment that starts StarNet".

The check is keyed by the adapter, not by the loop's `activeCredKey`. A model fallback after a rotation goes back to the primary adapter while `activeCredKey` still names the rotation key, and a keyless provider fallback leaves the previous key there. Asking about the adapter that sends the next call is exact by construction.

Never stopped: a key the caller sent in this request (an /api/run body key or pool, a fallback's own body key, a worker of such a run), a channel's own key the station never held, a keyless adapter, a sign-in, StarNet's linked account, and a run whose key moved into a pool or kept its key while its endpoint changed. A check that throws reads as held.

States it now refuses, each with its exit: a run in flight whose key was removed or replaced stops at its next call. Exit: run it again (it uses the key the station holds now), or add a key under SETTINGS → AI & MODELS.

Tests:
- `test/credential-store.remove-rotate.e2e.test.js` (http), section 4: RED at a3af8dafd (49 problems, 49 ok), GREEN at 028604d6b (98 assertions). It also catches the wiring: it fails 10 when the loop is not handed `credentialGone` or the primary adapter is not watched, 2 when a body key is not exempt, and 1 when the post-run passes are not skipped (a post-run pass then sent the rotated-away key).
- `test/loop.credential-live.test.js` (fast, new): RED at a3af8dafd (35 problems, 13 ok), GREEN at 028604d6b. Removing any one of the loop's four checks fails a row, so does failing closed when the check throws, and so do seven mutations of the store's `holds` and `inFlight`.
- `test/run-wire.request-key.test.js`: each fallback adapter is watched on its own key, never on a body key. `test/channels.station-key.test.js`: its census of `keyInRequest` counts the watch's two reads.

Not covered here: a removal in the instant between a caller's gate and the run resolving its key (a few disk reads); tool calls that read a key once, at the run's start (the image studio route's key, the web search rung's OpenRouter key: step S6 moved where they read it to the store, but each is still read once per run, so a run in flight keeps what it read until it ends, and the watch above covers only the keys its provider adapters send); a verdict review parked by an earlier run that finished before the removal.
