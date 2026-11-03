---
fingerprint: 31cadf39
slug: channel-record-pins-a-stale-provider-key-on-disk
title: A channel record pins a stale provider key on disk
surface: channels
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: ffbb95fae
origin: audit
family: B1-credential-sources
---

# A channel record pins a stale provider key on disk

## Symptom

A chat bot connected with a provider key of its own kept that key in `channels/secrets.json` and its `.bak`, in plaintext, after the station's copy rotated and after a restart, and it went on running on the old key. A key a sync replaced stayed in `secrets.json.bak` until the next channel save. A bot's own key the page later saved as its copy stayed on the record, so the page's next rotation left the bot on the old key until a reboot. On the desktop the key was kept nowhere, and after a restart the bot quietly moved onto the station's key, another account, or stopped. Related: the class of email E25 ("saved but not verified" after a key replacement), classes (b), (c) and (d) in the credential-store plan. That incident's own mechanism is not established, and this record does not claim it.

## Repro

1. Check out a3af8dafd (or any trunk before this fix), give it a `node_modules` junction, and copy `test/credential-store.channel-ref.e2e.test.js` from this lane into it. Run `node test/credential-store.channel-ref.e2e.test.js`.
2. Browser: POST /api/channels/telegram/connect with `{ token, key: K1, baseUrl: U, provider: 'openrouter' }`. K1 and U are in `channels/secrets.json` and its `.bak`. Save K2 through POST /api/providers/engine-key and restart: K1 is still in both, and a message runs on K1.
3. POST /api/channels/telegram/sync with `{ key: K2 }`: K1 stays in `secrets.json.bak`.
4. Connect with K1, save K1 through engine-key, then save K2, with no sync and no restart: the record holds K1 and a message sends K1.
5. Desktop-shaped station: connect with K1 and restart: the record holds no key, and a message sends the station's key.

## Evidence

- Mechanism at a3af8dafd: `startTelegram`, `startDiscord` and `startGenericChannel` (sidecar/index.js) wrote `key` and `baseUrl` into the record; the three hubs' `secrets()`, `stationHubRunConfig`, `channelConnectCredential`, the three syncs, bots/connect, the owner-revoke restart and the auto-starts each read them, about 12 sites. `saveResilient` hard-links the old main as the `.bak`, and `scrubChannelSecretsBak` ran on the desktop only. `scrubChannelStationKeys` ran at boot, so nothing turned a record into a follower while the station ran.
- Probes in the lane's plan scratch: probe-channel-key.js (K1 in main and `.bak` after connect, rotation and restart; on the desktop kept nowhere), probe-channel-sync.js (K1 in `.bak` after the sync, until the next save), critique-spec-and-rules/probe-todo3.js row A (K1 on the record after the page saves it and rotates; row B, with a restart, passes through the boot scrub).
- `test/credential-store.channel-ref.e2e.test.js` in a scratch checkout of a3af8dafd: 41 problems, 48 ok. The first failure is the connect's answer, then "the own key is in the channel file, both copies, and no other file in the workspace", got `channels/secrets.json`, `channels/secrets.json.bak`. After the sync K1 is in `channels/secrets.json.bak`. TODO 3 sends K1 after the page rotated to K2. In the torn-main row the bot sends the older key. R4's delivery and 3195ab5a's delivery pass at trunk: they are guards.
- Cross-version, a real trunk booted on a workspace this build prepared (a record with a reference and its entry). Downgrade: trunk's auto-start rewrote the record as `{ agentId, baseUrl, enabled, key, model, ownerPairing, provider, reasoningEffort, token }`, the reference gone and `key` empty (probe R2). This build then made it a station reference, deleted the entry and left the key in no file. Forget: trunk's purge of an agent-bound bot deleted its record, and this build deleted the orphaned entry, naming it by record id. Trunk's forget of the station bot keeps the record, whose reference and entry then stand: see below.
- Crash ordering, `test/channels.secrets.test.js` section K: index.js's own boot text over real files, with the disk stopped after each of the 20 writes across four scenarios (an older build's own key; a half-migrated record; a torn main over a newer entry; a torn main with no entry). No key is lost, none rolls back, and the next boot finishes the job and then writes nothing.
- Mutations of the fixed code, 23 of 23 caught, among them the entry written after the record, recovery step 1a removed, entries deleted before the records land, no conversion, a lost key moved onto the station's, a desktop key written to the file, an own credential crossing providers, and the `.bak` sweep desktop-only again. The first run left one alive (entries deleted before the records land), which a row for a failed record save now catches.

## Verdict

Fixed by ffbb95fae on agent/credential-store-1031 (credential-store lane, step S8; not merged yet). Closes channels TODOs 1, 2 and 3, and classes (b), (c) and (d) of E25. The incident itself stays unconfirmed.

A record holds `credential: { ref, bind }` and no key or endpoint. `ref: 'station'`: the bot follows the station's credential for its provider, live. `ref: 'channel'`: the bot has an entry in `.secrets/channel-credentials.json` v1, written main and `.bak` with both read back, bound to its provider and to its record by the bind stamp. An own key is an explicit key for that provider only: never swapped, no station pool, and its own endpoint rides it. An endpoint-only entry serves only a keyless run, as a record's endpoint did. One `channelCredential(recordId)` replaces the record reads, and the three hubs' `secrets()` and the three syncs are one function each. A key that becomes station-held turns its channel into a station reference at once, record first, so a later rotation reaches the bot with no sync and no restart.

The boot reconciliation runs at every boot and is safe to run again: 1a a record loaded from `.bak` with an entry for its provider binds to that entry, which is newer; 1b a key the station holds is dropped, and an endpoint of its own becomes an endpoint-only entry; 1c any other key is written to the file and read back before the record changes; 2 an entry whose key has become station-held converts; 3 a reference with no matching entry is refused and logged; 4 a record with nothing (an older build's, or one it rewrote) becomes a station reference and its entry goes; 5 an entry whose record is gone or carries another bind goes, once the records are saved; and secrets.json.bak is swept on every mode, tokens by stripTokens' durability rule. An unreadable file is left alone and nothing is deleted because of it. A failed write moves nothing: the bot runs on what its record carried, every save keeps it there, and the next boot retries.

Named changes:
- A key held only in a station pool counts as station-held in the reconciliation and in `putChannel` (`holds`, as step 1b says). `channelConnectCredential` keeps its `stationHeld` question, which never counted a pool, so a connect naming a pool key is proven on that key and then follows the station's primary.
- Beyond the plan: an endpoint equal to the one the station resolves for that key anyway is dropped, not kept as an endpoint-only entry, so a converted bot follows a proxy configured later. This is `ownBase`'s rule at connect. A record holding the page key beside the page copy's own endpoint now simply follows the page copy.
- Beyond the plan: step 1a also covers a recovered record that carries nothing at all. The `.bak` sweep cleans a record without giving it a reference, so a later recovery from that `.bak` would otherwise read as an older build's record (step 4) and delete a good entry.
- Beyond the plan: Discord's disconnect honours `purge`. The panel's FORGET always sent it, and a forgotten Discord bot's token and key stayed on disk while the panel said the record was not purged.
- The refused bot's sentence joins the channel's existing status line, which the panel already shows; the bot still starts, so each message says so, as a sign-in recorded dead does. Bots report it in `runDetail`.
- A record with no token that is disabled cannot be told from a desktop record whose token is in the keychain, so nothing infers a forget from it.

States it refuses, each with its exit:
1. A channel that switches provider drops its own key (state 4): it follows the station's credential for the new provider, or is refused. Exit: reconnect with that provider's key.
2. A desktop bot's own key lasts for the session; connect answers `keyPersisted: false`. After a restart the bot is refused with "this bot's own OPENROUTER key was kept for that session only — reconnect it with its key, or with none to use the station's", and never moves onto the station's key (state 5).
3. A reference with no matching entry (a pre-update backup restored elsewhere, which skips `.secrets/`, or a file deleted by hand): "this bot's own OPENROUTER key is no longer saved on this station — reconnect it with its key, or with none to use the station's". The record id is logged.

Where an old key can still linger after the reconciliation:
- `channels/secrets.json.corrupt-<pid>-<seq>` quarantines: forensic copies, unreadable as JSON, and skipped by pre-update backups. Each boot names them in one line of the log and leaves them.
- Pre-update backups made before the migration: `sanitizeManagedJson` strips key and token but not `baseUrl`, so a record endpoint with a token in its path was copied into earlier backups. Those are the Commander's recovery points and stay. New backups hold no channel endpoint.
- Logs: no key was ever printed; this code logs record ids and file names only.
- The OS keychain on the desktop: the sidecar does not touch it.
- A write torn by a crash: the temp file of a channel-file write in `.secrets/`, as for every store there.
- A station bot forgotten on an older build that never auto-started it: that build keeps the record and its reference, so the entry stands until this build's next connect or forget of that bot. An agent-bound bot's record is deleted there, and its entry goes at the next boot.
- A downgraded build writes record keys again; the next upgrade moves them (1c) or drops them (1b).

Downgrade: an older build ignores `credential` and `channel-credentials.json`, and its first auto-start rewrites the record without the field. A bot that ran on its own key runs on the station's key for its provider, or is refused. There is no crash and no key leak, and on re-upgrade step 4 deletes the orphan.

Tests:
- `test/credential-store.channel-ref.e2e.test.js` (http, new): real sidecars, a recording upstream, a fake Bot API, a real message through a real hub at each step, and the whole workspace read for the key. RED at a3af8dafd (41 problems, 48 ok), GREEN at ffbb95fae (96 assertions). The lane's closing pass added row 9, a sync and a forget on Discord, a generic channel and an agent-bound bot, each through its own route and seeded as trunk writes it: Discord's purge had only a route lock until then. At a3af8dafd the replaced keys stay in the `.bak`, Discord ignores the purge, and a generic forget leaves its key on the record. The file then stands at 55 problems, 50 ok at a3af8dafd and 112 assertions here.
- `test/channels.secrets.test.js` section K (fast): each step, each failure and the crash loop on real files through index.js's own text. 249 assertions.
- `test/credential-store.no-crossing.test.js` section 8 (fast): an own credential is not there on another provider, over every pair of four provider classes, and the shapes of an entry. Tip only: the layer has no form at trunk.
- `test/channels.station-key.test.js` (TODOs 1-3 resolved), `test/channels.boot-admission.test.js` (state 5 at boot), `test/channels.keychain-all.e2e.test.js` (the reconciliation and the token migration in one desktop boot), `test/station-recovery-unreadable.test.js` (a backup carries the reference and neither the key nor the endpoint), `test/redact.known-values.test.js`.

Not proven here: one installed desktop run that connects a bot with its own key and restarts. The Settings UI does not show `keyPersisted`; the answer is additive, and the frontend is unchanged in this lane. Merge note: the channel-key guard (bug 61bb1c7d) reached trunk after this lane forked, and its `test/channels.connect-provider-switch.test.js` reads `key` and `baseUrl` on the record, so it needs the same move to the record view when this lane merges. Its rule is state 4, and the leftover it names (a record an older sync moved, with the old provider's address) is healed here: that address becomes an endpoint-only entry a station key never rides.
