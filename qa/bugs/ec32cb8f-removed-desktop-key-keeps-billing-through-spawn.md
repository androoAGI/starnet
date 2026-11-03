---
fingerprint: ec32cb8f
slug: removed-desktop-key-keeps-billing-through-spawn
title: A provider key removed in the desktop app keeps billing through its spawn environment copy
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: f3ec6c5d3
origin: audit
family: B1-credential-sources
---

# A provider key removed in the desktop app keeps billing through its spawn environment copy

## Symptom

On the desktop app, removing a provider key under SETTINGS → AI & MODELS did not stop the station using it. The shell deleted the keychain entry and told the sidecar, and the sidecar answered 200 with `configured: true`. GET /api/providers kept the provider configured, Run Now and the scheduled fire of a routine went out on the removed key, /v1 ran on it, and a Telegram bot could still be connected on it. The same copy outlived a rotation (the old key stayed held by the station) and a cleared key pool (the pool came back). A desktop user who also had a bare OS export of the same provider (ANTHROPIC_API_KEY set for another tool) got the OS key, not the one saved in Settings, until they saved a key during the session.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and run `node test/credential-store.remove-rotate.e2e.test.js` from this lane in it. It boots a real sidecar the way the desktop shell does and fails 37 assertions, the first being the REMOVE push answering `configured:true`.
2. By hand: boot the sidecar with `STARNET_DESKTOP_SHELL=1`, an IPC token, and `SKYNET_ANTHROPIC_API_KEY` and `STARNET_ANTHROPIC_API_KEY` set to one key (what `set_sidecar_branded_env` in src-tauri/src/main.rs writes for a keychain key), with `ANTHROPIC_BASE_URL` at a recording server. Create an Anthropic routine.
3. POST /api/key `{"provider":"anthropic","key":"","baseUrl":""}` with the IPC token, as `harness_store_provider_key` does after deleting the keychain entry.
4. The answer says `"configured":true`, GET /api/providers says anthropic is configured, and Run Now answers 200 while the recording server receives `x-api-key` = the removed key.

## Evidence

- Mechanism at a3af8dafd: src-tauri/src/main.rs `sidecar_command` writes every keychain key and key pool into the sidecar's environment in both spellings at spawn, and never removes them. The REMOVE push reached `setProviderRuntimeConfig` (sidecar/index.js:15724 at a3af8dafd), which deleted `runtimeKeys[id]` only; the next resolution fell through to the operator layer, where `envFirst` (sidecar/index.js:2975 at a3af8dafd) read `ENV(name)`, the spawn copy, and served it. The pushed pool cleared the same way fell back to `providerFallbackKeyPool`'s env `KEY_POOL_<ID>`, the spawn copy of the pool. `envFirst` reads the bare name before the branded spelling, so a bare `ANTHROPIC_API_KEY` beat the shell's key (probe R5).
- `test/credential-store.remove-rotate.e2e.test.js` run in a scratch checkout of a3af8dafd: 37 problems, 34 ok. The first is "desktop: the REMOVE push answers configured:false at once: {"ok":true,"provider":"anthropic","configured":true,"alternateCount":2}". Others: GET /api/providers kept anthropic configured; Run Now answered 200 instead of the shared sentence; /v1 answered 200; the scheduled fire sent `x-api-key` = the removed key; the Telegram connect answered 200; the sidecar's environment held the removed key as SKYNET_ANTHROPIC_API_KEY and STARNET_ANTHROPIC_API_KEY; the rotated-away OpenRouter key stayed in SKYNET_/STARNET_OPENROUTER_KEY; the OpenRouter REMOVE answered configured:true and its routine still ran; the CUSTOM REMOVE still sent the removed key; a cleared pool answered 2 alternates; and D1's routine sent the bare OS key. The browser and headless rows passed at trunk except the new readout fields: they are guards.
- The planner's probe-remove-desktop.js and the risk critic's probe-risk-r5.js (lane scratch) showed the same at a3af8dafd: both pushes answered configured:true, /api/providers kept anthropic and openrouter configured, Run Now answered 200 and the upstream got the removed key; with a bare OS key the routine sent it before and after the REMOVE.
- test/fixtures/credential-store-golden.json, table `shell`, captured with trunk's own functions at a3af8dafd: the same stations with and without the shell's marker resolve identically at trunk. The rows the fix changes are listed in `deltas.D1` with trunk's value.
- Related customer report: email E25 ("saved but not verified" after a key replacement), class (a) in the credential-store plan. Its own mechanism is not established, and this record does not claim it.

## Verdict

Fixed by f3ec6c5d3 on agent/credential-store-1031 (credential-store lane, step S2; not merged yet).

Under the shell's marker (`STARNET_DESKTOP_SHELL=1`, which every spawn sets), sidecar/index.js hands `process.env` to `adoptSpawnCredentials` (sidecar/credential-store.js) right after it consumes the connector key, before any other module loads. Each provider's key and key pool written in both spellings with one value becomes the credential store's keychain layer, and both spellings leave the environment. The store is then the only holder: a REMOVE push empties it, a rotation replaces it, and a cleared pool stays cleared, on every surface at once. One spelling, two different values and a bare name are the user's own exports. They stay in the environment layer, survive a REMOVE and are named. Without the marker (bin/starnet.js, servers, CI, tests) nothing is adopted or deleted, and a headless env key behaves exactly as before.

The /api/key answer and GET /api/providers take `configured` from the store and gain two additive fields: `credentialSource` ('keychain' | 'environment' | 'page' | 'linked' | 'sign-in' | 'none') and `envName`, the variable when an environment variable serves. A REMOVE that leaves an environment key serving logs one line naming the variable. Engine-key presence keeps the `keySource` vocabulary the page reads.

Named changes:
- Golden delta D1 (decision 4): under the marker the Settings key outranks a bare OS export of the same provider. After a REMOVE the OS export serves, and the answer, /api/providers and the log say so. The Settings page does not show it in this lane: that line is a follow-up for Andrew.
- An adopted key is a held value from boot, so redaction scrubs it and a host helper no longer receives a user's own variable that holds the very same key. At trunk that happened only after the shell pushed it during the session. Step S5 names this too.
- Residual: a desktop user who exported both spellings of a provider's key name with one value has it read as a keychain key. Settings, which reads the keychain, does not show it (as at trunk), and it comes back at the next spawn.

States it now refuses, each with its exit: a removed desktop key is refused by Run Now, the scheduled fire, /v1 and the channel connect gate. Exit: add the key again under SETTINGS → AI & MODELS. A CUSTOM endpoint saved without a key still runs keyless.

Tests:
- `test/credential-store.remove-rotate.e2e.test.js` (http): RED at a3af8dafd (37 problems, 34 ok), GREEN at f3ec6c5d3 (71 assertions).
- `test/credential-store.spawn-adoption.test.js` (fast): reads the shell's spawn tables from src-tauri as text, adopts exactly what they write and nothing else, wires through index.js's own statements, and locks that no sidecar module reads a provider key's variable except through the store. 86 assertions.
- `test/credential-store.golden.test.js`: the 65 D1 rows are exactly the rows the marker changes, each with trunk's value. 85 assertions.
- `test/set-key-body.test.js`: the real handler over the real store answers the readout and logs the line. 29 assertions.

Not proven here: the OS keychain itself, which tests cannot reach. A live check needs one installed desktop run that removes a key in Settings and confirms routines refuse and the sidecar log names any env key still serving.
