---
fingerprint: f366863e
slug: run-in-flight-keeps-sending-a-removed-key
title: A run in flight keeps sending a provider key that was removed or replaced mid-run
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: 028604d6b bfca6be28 531c9ef2c efcc397ba 0c19e17c8 110c2660e
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

Fixed by 028604d6b on agent/credential-store-1031 (credential-store lane, step S3; decision 7; not merged yet). Review round 1 found two paths that fix left open, and closed them: bfca6be28 (a turn queued before the removal, with efcc397ba) and 531c9ef2c (the tools' keys). See "Review round 1" below.

The loop takes `credentialGone(adapter)` and asks it, with the adapter it is about to call, at the top of each turn and of each attempt, beside the spend stop: the first call, a retry, a rotation onto a backup key, a model or provider fallback. It asks again before a paid compaction fold and before the compress recovery folds. While the key that adapter sends is held the answer is empty and nothing changes. Once it is not, the run ends `error` with the in-flight sentence (`agent.run.error`, failureStage `credential`) before the request goes out. A stream already running finishes its tokens. No `shared/events.js` change: the stop uses the existing reason `error`.

`runOnceCore` answers from the credential store's `inFlight()` watch (sidecar/credential-store.js). Every adapter it builds on a key is watched on that key: the primary, the warm backup it may start on, each rotation entry, each provider fallback. A key is watched only when a station layer held it as the run resolved it, and the caller did not send it in this request. The primary's key is judged when it is resolved, because its adapter is built after the run's awaits (a pre-run script among them). `holds()` says whether the keychain, the environment or the page copy still holds that exact key, as its key or in its pool. So only a REMOVE or a rotation of that very key, in every layer that held it, stops a run. The aux vision call asks the same watch, and the post-run passes and the parked verdict review are skipped once the run's key is gone. The sentence is engine-credential.js `credentialError` kind `removed`: "the <PROVIDER> key this run started on was removed or replaced on this station, so it stopped before its next model call — run it again to use the key the station holds now, or add one under SETTINGS → AI & MODELS, or set <VAR> in the environment that starts StarNet".

The check is keyed by the adapter, not by the loop's `activeCredKey`. A model fallback after a rotation goes back to the primary adapter while `activeCredKey` still names the rotation key, and a keyless provider fallback leaves the previous key there. Asking about the adapter that sends the next call is exact by construction.

Never stopped: a key the caller sent in this request (an /api/run body key or pool, a fallback's own body key, a worker of such a run), a channel's own key the station never held, a keyless adapter, a sign-in, StarNet's linked account, and a run whose key moved into a pool or kept its key while its endpoint changed. A check that throws reads as held.

States it now refuses, each with its exit: a run in flight whose key was removed or replaced stops at its next call. Exit: run it again (it uses the key the station holds now), or add a key under SETTINGS → AI & MODELS.

Tests:
- `test/credential-store.remove-rotate.e2e.test.js` (http), section 4: RED at a3af8dafd (49 problems, 49 ok), GREEN at 028604d6b (98 assertions). It also catches the wiring: it fails 10 when the loop is not handed `credentialGone` or the primary adapter is not watched, 2 when a body key is not exempt, and 1 when the post-run passes are not skipped (a post-run pass then sent the rotated-away key).
- `test/loop.credential-live.test.js` (fast, new): RED at a3af8dafd (35 problems, 13 ok), GREEN at 028604d6b. Removing any one of the loop's four checks fails a row, so does failing closed when the check throws, and so do seven mutations of the store's `holds` and `inFlight`.
- `test/run-wire.request-key.test.js`: each fallback adapter is watched on its own key, never on a body key. `test/channels.station-key.test.js`: its census of `keyInRequest` counts the watch's two reads.

## Review round 1

Two paths stayed open after 028604d6b. Both were reproduced on a real sidecar at 86ff765db and are closed.

1. A turn queued before the removal (bfca6be28). handleRun on the desktop, the channel hubs, the workers and the scheduler resolve the station's key themselves and hand it to the run as `o.key`. They do this before runOnce's one-turn-at-a-time queue, where a turn waits as long as the turn ahead of it runs. runOnceCore judged the key held or not when it started. A key removed meanwhile was held by no layer, so it read as a caller's own key and was never watched, and the queued turn ran to `done` on the removed key. The record above called this window "a few disk reads"; the queue makes it as long as the previous turn. Now a push or a page save remembers each key it takes out of a layer, as a SHA-256 digest only. `fromStation(provider, key)` still knows such a key as the station's, and never counts a channel's own key. The watch takes it, and runOnceCore ends the run once its primary adapter is built, ahead of its catalog read and its first call, with the same sentence. The same change keeps a bot's own key from being stopped when a station pool happens to hold the same key (6f87a3894 keeps such a key as the bot's). efcc397ba keeps that exemption from reaching a key a station layer holds as its own key: while a conversion's record save has failed, a channel entry and the station hold the same key, and a station run on it is still watched.
2. The tools' keys (531c9ef2c; CS-FIN-10, E25 class (e) on its tool paths). runOnceCore read the image route's key (studioRouteFor) and web_search's paid OpenRouter rung (webRung) once, at the run's start, and makeImageTools and makeWebTools kept them. So a long CUSTOM or Anthropic routine kept sending a removed or rotated-away OpenRouter key from its next web_search fallback and its next image_generate, to the endpoint it was saved with. Now both credentials are watched like adapters (the run's own key on its own route takes the run key's verdict). Each keyed request asks first: openrouterSearch, and image.js's orPost, openAIImagePost and openAIEditPost. A gone key refuses that one call with "the OPENROUTER key this run started with was removed or replaced on this station, so web_search did not send it — run it again to use the key the station holds now, …" (for images: "so the STUDIO image route did not send it"). The run goes on; image_analyze falls back to the run's own model.

States it refuses, each with its exit: a run whose station key was removed or rotated away before it reached its adapter (a queued turn, a worker or a hub message resolved before the change) ends before its first call. Exit: send it again. One tool call on a key removed or rotated away mid-run is refused. Exit: run it again; it uses the key the station holds now.

Tests (review round 1):
- `test/credential-store.remove-rotate.e2e.test.js` section 4, row e (desktop, a turn queued behind a held one, the shell's REMOVE): RED at 0c9c1583f (3 problems, 112 ok: the queued turn ran to done and its request carried the removed key), GREEN at bfca6be28 (115).
- `test/loop.credential-live.test.js`: six queued-turn shapes over the real store with no `held` handed in (keychain REMOVE, rotation, cleared pool, page REMOVE of the key and of a backup, page rotation), `fromStation`, and a bot's own key that a station pool holds, never stopped. RED at 0c9c1583f: 8 problems. Section C's census also checks that every tool factory runOnceCore hands a credential gets its in-flight check and that the credential is watched. RED at bfca6be28: 3 problems. GREEN: 93.
- `test/credential-store.openrouter-consumers.e2e.test.js` section 7: a CUSTOM run on its own body key, its first tooled turn held while the page REMOVEs or rotates its OpenRouter copy. RED at bfca6be28 (7 problems: the rung and image_generate sent the removed key, the rotation's rung the old one), GREEN at 531c9ef2c (93).
- `test/web.search.test.js` E3 and `test/image.test.js`: the modules with the check. RED at bfca6be28 (2 and 4 problems), GREEN (27 and 538).

Review round 2, resumed after the workflow stopped, found two remaining ownership paths:

- A station turn queued before REMOVE could still be misclassified as bot-owned when an unproven channel version held the same key (0c19e17c8). `runOnce` now captures ownership before its queue in a store-private Symbol. Options copies preserve it; repeated admission cannot erase it; the core accepts it only for the exact provider/key pair. JSON cannot supply it. A newly resolved pair uses current store classification. Caller/body-key and own-bot exemptions remain. Exact c1b761297 store plus production queue wrapper control: RED 2 / 106 passing; fixed credential-live 108. The real-sidecar queue scenario now includes a real failed channel conversion with a read-only record: exact c1b761297 index/store control RED 3 / 114 passing (queued request sent the removed key); fixed remove-rotate 117 passing.
- A station-selected pool key that a bot independently owned escaped the watch for warm starts and rotation (110c2660e). The host already knows whether that pool came from the station layer or an explicit caller pool, and passes that provenance to both adapter paths. The demoted original primary keeps its own admission verdict. Exact 0c19e17c8 production pool-options control: RED 2 / 115 passing; fixed credential-live 117. Real-loop rows clear only the backup pool before rotation while keeping the primary held, and clear the station layer after the warm alternate's first turn. Both explicit caller-pool controls continue successfully. Two independent source reviews agreed with the defect and narrow repair.

The initial HTTP fixture draft used a nonexistent seed helper and was corrected before the recorded RED/GREEN proof; its setup failure is not evidence for the product fix. These are focused proofs, with combined full gates owned by the orchestrator.

Not covered here: a verdict review parked by an earlier run that finished before the removal.
