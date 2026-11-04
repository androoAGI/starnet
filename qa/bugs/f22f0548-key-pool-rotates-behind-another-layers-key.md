---
fingerprint: f22f0548
slug: key-pool-rotates-behind-another-layers-key
title: A refused provider key rotates onto a key pool saved for another layer's key
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: 22ce8eec1
origin: audit
family: B1-credential-sources
---

# A refused provider key rotates onto a key pool saved for another layer's key

## Symptom

When the upstream refused a run's key (a 401, a rate limit, a spent balance), the run rotated onto backup keys for the same provider before it tried its fallbacks. Those backup keys were the desktop shell's keychain pool, else the operator's environment `KEY_POOL_<ID>`, whatever key the run was on. A routine on the CUSTOM key and endpoint a browser page saved, refused, then sent the operator's environment pool key to the page's endpoint and ended `done` on it: one account's key went to an endpoint saved for another, and an account the routine was never on paid for it. An /api/run body key on the desktop, refused, rotated onto the keychain pool. A keyless run after the shell's REMOVE (the shell keeps the pool's slot) rotated onto that pool. A page key with backups of its own rotated onto the environment's pool instead of its own.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and copy `test/credential-store.pool-binding.e2e.test.js` from this lane into it. Run `node test/credential-store.pool-binding.e2e.test.js`.
2. Row 1a (probe R1): a headless sidecar with `STARNET_KEY_POOL_CUSTOM=E2` and no env key; the page saves CUSTOM {K, U} through POST /api/providers/engine-key; U answers 401 to K; Run Now of a CUSTOM routine. U receives K, then E2, and the run ends `done`.
3. Row 2a (probe R6): a desktop-shaped sidecar (`STARNET_DESKTOP_SHELL=1`, the IPC token); the shell pushes a CUSTOM endpoint U6 and a pool [P1] with no key; POST /api/run with its own CUSTOM key Kb; U6 answers 401 to Kb. U6 receives Kb, then P1.
4. Table form: copy `test/credential-store.no-crossing.test.js` and `test/helpers/credential-store-sandbox.js` into the same checkout and run the first. Its pool table runs over trunk's own resolvers, lifted from that tree's index.js, and runOnceCore's own rotation lines.

## Evidence

- Mechanism at a3af8dafd: `providerRuntimeKeyPool` (sidecar/index.js:3006) returned the pushed pool `runtimeKeyPools[id]` for any run key, else `providerFallbackKeyPool` (sidecar/index.js:3017), which returned the env `KEY_POOL_<ID>` for any run key and only after that the page copy's backups, for a run on the page key (`pageCopyRidesWith`). runOnceCore's rotation (sidecar/index.js:23421) asked it with the caller's pool when one was passed, `[]` when the run's endpoint was not the station's own for that key, else `undefined`, which fell through to those unbound pools. So the backups a refused key rotated onto were chosen by what the station held, not by whose key was refused. The /api/key answer counted the same way (sidecar/index.js:15801, `alternateCount: providerRuntimeKeyPool(id).length`): with no pushed pool it counted the environment's.
- Probes R1 and R6 (critique-risk/probe-risk.js and probe-risk-r6.js in the lane's plan scratch), re-run for the plan: Run Now ended `done` and U received "page key K" then "OPERATOR ENV POOL KEY E2"; U received the caller's body key, then "KEYCHAIN POOL KEY P1".
- `test/credential-store.pool-binding.e2e.test.js` in a scratch checkout of a3af8dafd: 11 problems, 18 ok. The first failure is "R1: U sees the page key only, never the operator's env pool key (trunk sent it to U after K was refused) — expected ["/u/page"], got ["/u/page","/u/envPool"]", and that run ended `done`. Row 1e got ["/d/dsLone","/d/dsEnvPool"] (a body key sent with no pool, at the station's own endpoint, took the env pool), R6 got ["/u6/body","/u6/kcPool"], and after the shell's REMOVE the keyless routine rotated onto kcPool and ended `done`. Two more failures are step S2's additive `credentialSource` field, which trunk does not have. Rows 1b, 1c, 1d and 2b (each layer's own pool behind its own key, and a pool sent with a body key) pass at trunk and are the guards.
- `test/credential-store.no-crossing.test.js` in the same checkout: 9 problems, 10 ok. The first failure is the pool table: 8864 of its 14280 runs cross, in 15 of its 17 run shapes. Only the two shapes where a key is sent with a pool of its own were already right. Then R1, R6, the REMOVE rows and the OpenRouter alias rows of its section 2.
- The golden: with the binding undone, the store reproduces this lane's S3 fixture exactly (0 rows differ). The binding moves the pools of 681 rows (deltas.D2 in test/fixtures/credential-store-golden.json) and nothing else: no key, endpoint, presence or held key.
- Related customer reports: gh#89 lists "the operator's env key pool rotates behind the page key at the page endpoint (R1)" among what is still broken; this record covers that item.

## Verdict

Fixed by 22ce8eec1 on agent/credential-store-1031 (credential-store lane, step S4; golden delta D2; not merged yet).

A key pool rides only its own layer's key: the keychain pool only the keychain key, the environment's `KEY_POOL_<ID>` only the environment's key, and the page copy's backups only the page key (sidecar/credential-store.js `keyPool`, which reads one `layersOf` table). A key the caller sent in this request (an /api/run body key) gets only a pool sent with it, never a station pool (runOnceCore's key-pool line, `runKeyWatch.sentByCaller`), and a channel's own key gets none, because no layer holds it. A pool whose layer holds no key is unused: the keychain pool after the shell's REMOVE, an environment `KEY_POOL_<ID>` with no environment key, and a page copy's backups with no page key. When two layers hold the same key, the first in key order with backups serves; both are that key's own account. runOnceCore's guard stays: the station's pool never rotates onto an endpoint the caller named. Trunk's `providerFallbackKeyPool`, which handed the environment's pool to any run key, is gone.

Named changes:
- The /api/key answer's `alternateCount` is the size of the pool the shell pushed, ridden or not, which is the push's own answer. At trunk, with no pushed pool, it counted the environment's pool. No client reads this field from the sidecar: the desktop page takes its count from the keychain (`harness_provider_key_status`).
- `holds()` (step S3's in-flight watch) counts a backup key only while its layer still holds a key for its pool to ride. A run that rotated onto the keychain pool therefore stops at its next call once the keychain key is removed, and a rotation of the keychain key keeps the run going, since the pool then rides the new key.
- A headless operator who set only `STARNET_KEY_POOL_<ID>` with no environment key, and relied on it rotating behind a page key or a keyless run, loses that rotation. That rotation was the crossing.

States it now refuses, each with its exit:
1. A key the caller sent, or a channel's own key, never rotates onto a station pool. Refused, it fails over to the run's model and provider fallbacks, never to another layer's account (state 9). Exit: send the backup keys with the key (a browser page sends its own pool with its key), or save the key and its backups together in one layer (Settings, or the environment key beside its `KEY_POOL_<ID>`).
2. A pool whose layer holds no key does not rotate. Exit: add the key in Settings, or set the environment key beside the pool.
3. A run in flight on a keychain backup key stops at its next call once the keychain key is removed, with step S3's sentence. Exit: run it again with a key the station holds (add one under SETTINGS → AI & MODELS).

Tests:
- `test/credential-store.pool-binding.e2e.test.js` (http, new): real sidecars and a recording upstream that refuses the primary. RED at a3af8dafd (11 problems, 18 ok), GREEN here (29 assertions).
- `test/credential-store.no-crossing.test.js` (fast, new): every combination of the three station layers (a key, backups, both or neither; the keychain pushed or adopted from the shell's spawn pair, then left alone, removed or rotated) for Anthropic, CUSTOM, Ollama, StarNet and Grok, under 17 run shapes. Each station is built by index.js's own wiring and each run resolved by runOnceCore's own lines, against an oracle that reads only the station's description. RED at a3af8dafd (9 problems, 10 ok), GREEN here (27 assertions, 19176 runs).
- `test/credential-store.golden.test.js`: deltas.D2 names every moved row with its old pools and the crossing it closed. With the binding undone, the D2 rows get their old pools back and no other row moves.
- `test/engine-credential.test.js` executes runOnceCore's key, endpoint, watch and pool lines; `test/set-key-body.test.js` runs the real handler over the real store for `alternateCount`; `test/loop.credential-live.test.js` adds the pool rows of the in-flight watch.

Not covered here: an environment pool beside a page pair the complete-pair rule chooses (step S7 makes that shape reachable, and adds its rows), and a channel's own key and pool in the channel layer (step S8).
