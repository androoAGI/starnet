---
fingerprint: 61bb1c7d
slug: a-channel-reconnect-that-switches-provider-sends
title: A channel reconnect or sync that switches provider sends the old provider's saved key and endpoint to the new provider
surface: channels
severity: P1
status: fixed
found: 2026-10-29
lane: release-0142-channel-key-guard
fix: 4183a7415 dfd5bc165
origin: audit
---

# A channel reconnect or sync that switches provider sends the old provider's saved key and endpoint to the new provider

## Symptom

The Commander connects a Telegram, Discord, Slack, Matrix or Signal bot on one provider (say OpenRouter), then moves the agent to another (Anthropic, or a local CUSTOM server). On the desktop that move is a model pick. The page then syncs every connected channel with the new provider and no key, and it does the same at every boot. The sync moved the saved record to the new provider but kept its key and endpoint, and each message the bot answers reads the live record. So the bot ran on the old provider's key or address under the new provider before any reconnect. A RECONNECT that switched provider with no key (the desktop page never sends one) did the same through the connect handlers.

A record a 0.14 connect saved keeps the endpoint it resolved (OpenRouter's address), and the desktop strips only the token and key from disk. So the usual results were: in the same session, the OpenRouter key went to OpenRouter's address under the Anthropic adapter; after a restart, the station's Anthropic key went to openrouter.ai with every message. A record saved with no endpoint sent the OpenRouter key to api.anthropic.com. Moving the other way, from a keyless CUSTOM LAN server to OpenRouter, sent the station's OpenRouter key to the LAN server.

## Repro

1. A station whose operator ANTHROPIC_API_KEY is set, and a channel record as a 0.14 desktop connect on OpenRouter leaves it after a restart: provider openrouter, base URL https://openrouter.ai/api/v1, no key on disk.
2. Sync path, the normal desktop flow: POST /api/channels/telegram/sync (or discord, slack) with agentId agent, model claude-x, provider anthropic and no key, which is what the page's syncChannels posts after a model pick. The record now says anthropic with OpenRouter's address, and each message's secrets() returns the station's Anthropic key with https://openrouter.ai/api/v1. A later RECONNECT on anthropic keeps that pair, because the record already names anthropic.
3. Connect path: from the same record with no sync first, POST /api/channels/telegram/connect with provider anthropic, model claude-x, agentId agent and no key. It answers 200 with the same result. With a record that also holds the OpenRouter key and no endpoint, each message sends the OpenRouter key to api.anthropic.com, because an explicit key beats the station's.
4. Endpoint the other way: a keyless record with provider custom and base URL http://192.168.1.40:1234/v1, then a sync or a connect on openrouter with the station's keychain OpenRouter key. Each message sends that key to the LAN server.

## Evidence

- sidecar/index.js, all three connect handlers (handleChannelConnect, handleDiscordConnect, handleGenericChannelConnect), at v0.14.1 (index.js:26172, 26460, 26622 there) and at d5024f5a2: `const key = providerRuntimeKey(provider, String(body.key || '').trim() || String(saved.key || ''));` and `const baseUrl = providerRuntimeBaseUrl(provider, body.baseUrl || body.base_url || saved.baseUrl || saved.base_url || '');` read the saved record's key and endpoint whatever provider the record was saved for. providerRuntimeKey returns an explicit key before the runtime, operator or page-copy key.
- sidecar/index.js, all three sync handlers (handleChannelSync, handleDiscordSync, handleGenericChannelSync), at v0.14.1 (index.js:26208, 26476, 26663 there) and at d5024f5a2 (sidecar/index.js:26676, 26944, 27131): each copies the body's provider onto the record and keeps the record's key and base URL. The page's syncChannels (frontend/app/app.js:1475) posts the agent's provider with no key on the desktop, after a ModelDock model pick and at boot. Each start function's per-message secrets() reads the live record.
- `test/channels.connect-provider-switch.test.js` runs the real connect and sync handlers and each start function's own per-message secrets() block. On the unfixed d5024f5a2 source it fails 93 of 233 checks. On 4183a7415's tree, which has the connect guard only, it fails 57, every one in rows E and F, for example "telegram sync openrouter -> anthropic, record desktop after a restart (key stripped from disk): after the sync alone, each message runs the station's Anthropic key at Anthropic — expected ["sk-ant-ENV-OPERATOR","https://api.anthropic.com/v1"], got ["sk-ant-ENV-OPERATOR","https://openrouter.ai/api/v1"]".
- First found by the run-wire lane's round-8 credential review (its probe sent an OpenRouter key to a LAN CUSTOM server and to api.anthropic.com), and confirmed by the 0.14.2 release critic. The release fix's review found that the page's sync runs first and moves the record, so a connect guard alone almost never fires on the desktop.

## Verdict

Fixed in 4183a7415 and dfd5bc165. In 4183a7415, each connect handler reuses the saved key and endpoint only when the record was saved for the provider it connects (normalizeProvider of saved.provider equals normalizeProvider of the provider; otherwise the saved pair is treated as empty), which is the guard the run-wire lane puts in channelConnectCredential. In dfd5bc165, each sync handler drops the record's key (unless the body sent one) and its endpoint when the sync changes the record's provider, which is the rule in the run-wire lane's sync rewrite. A connect or sync on the same provider (including an alias such as claude for anthropic, and a record saved before records named their provider) still keeps the saved pair, and a key in the body still wins. When the station holds no key for the new provider, the reconnect is now refused and the saved record is left as it was, and after a sync each message is refused for want of a credential. Regression: test/channels.connect-provider-switch.test.js, green on the fixed tree and, unchanged, on the run-wire lane's tip (see Notes).

## Notes

Residual, not healed by either commit: a record that a 0.14.1 sync already moved (provider anthropic with OpenRouter's address) looks to both guards as if it belongs to its new provider, so the station's Anthropic key keeps going to that address. A model pick on another provider and back clears it (two syncs that each change the provider; row F of the regression), and so would the run-wire rule that an endpoint rides only the key it came with. On Telegram, Discord, Slack and Matrix, FORGET does not clear it either: purge removes only the token, and the next connect on the same provider reuses the saved endpoint. Also pre-existing and out of scope: on a reconnect the record still stores the key providerRuntimeKey resolved, so a key the station holds is written into the record (plaintext secrets.json on a headless or browser station). The run-wire lane's rule that a station-held key is never recorded fixes that later. The regression was run, unchanged, against the run-wire lane's tip fbd1a643e and passed every check.
