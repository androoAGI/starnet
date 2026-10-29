---
fingerprint: 61bb1c7d
slug: a-channel-reconnect-that-switches-provider-sends
title: A channel reconnect that switches provider sends the old provider's saved key and endpoint to the new provider
surface: channels
severity: P1
status: fixed
found: 2026-10-29
lane: release-0142-channel-key-guard
fix: 4183a7415
origin: audit
---

# A channel reconnect that switches provider sends the old provider's saved key and endpoint to the new provider

## Symptom

The Commander connects a Telegram, Discord, Slack, Matrix or Signal bot on one provider (for example OpenRouter), moves the agent to another provider (Anthropic, or a local CUSTOM server), and presses CONNECT again without pasting a key. That is the normal desktop flow, because the desktop page never sends a key. The reconnect succeeds, and every message the bot answers sends the OLD provider's key to the NEW provider: the OpenRouter key goes to api.anthropic.com, or to the LAN server. The Anthropic key the station already holds is ignored. When the agent moves the other way, from a CUSTOM LAN server to OpenRouter, the saved LAN endpoint is kept, so the OpenRouter key (the one in the body, or the station's keychain key) goes to the LAN server.

## Repro

1. A station with a channel record saved by an earlier connect: provider openrouter, key = the Commander's OpenRouter key. The operator's ANTHROPIC_API_KEY is set (or there is no Anthropic key at all).
2. POST /api/channels/telegram/connect (or /api/channels/discord/connect, /api/channels/slack/connect) with provider anthropic, model claude-x, agentId agent, and no key.
3. The connect answers 200. The saved record is now provider anthropic with the OpenRouter key, and each message's secrets() asks providerRuntimeKey for anthropic with the OpenRouter key as the explicit key, which returns it, because an explicit key beats the station's.
4. For the endpoint: a record with provider custom and base URL http://192.168.1.40:1234/v1, then a connect with provider openrouter and key sk-or-NEW. Each message sends sk-or-NEW to the LAN server.

## Evidence

- sidecar/index.js, all three connect handlers (handleChannelConnect, handleDiscordConnect, handleGenericChannelConnect), at v0.14.1 (index.js:26172, 26460, 26622 there) and at d5024f5a2: `const key = providerRuntimeKey(provider, String(body.key || '').trim() || String(saved.key || ''));` and `const baseUrl = providerRuntimeBaseUrl(provider, body.baseUrl || body.base_url || saved.baseUrl || saved.base_url || '');` read the saved record's key and endpoint whatever `saved.provider` was. providerRuntimeKey returns an explicit key before the runtime, operator or page-copy key.
- `test/channels.connect-provider-switch.test.js` runs the real handlers and each start function's own per-message secrets() block. On the unfixed d5024f5a2 source it fails 30 of 95 checks, for example "telegram openrouter -> anthropic (env key): each message runs the station's Anthropic key at Anthropic — expected ["sk-ant-ENV-OPERATOR","https://api.anthropic.com/v1"], got ["sk-or-COMMANDER-OWN","https://api.anthropic.com/v1"]", and "telegram openrouter -> anthropic (no key): the reconnect is refused — expected 400, got 200".
- First found by the run-wire lane's round-8 credential review (its probe sent an OpenRouter key to a LAN CUSTOM server and to api.anthropic.com), and confirmed by the 0.14.2 release critic.

## Verdict

Fixed in 4183a7415. Each of the three connect handlers now reuses the saved key and endpoint only when the record was saved for the provider it connects (normalizeProvider of saved.provider equals normalizeProvider of the provider; otherwise the saved pair is treated as empty), and reads the key and base URL from that guarded record. This is the same guard the run-wire lane puts in channelConnectCredential, so that lane's merge takes its own lines. A reconnect on the same provider (including an alias such as claude for anthropic, and a record saved before records named their provider) still reuses the saved pair, and a key in the body still wins. When the station holds no key for the new provider, the reconnect is now refused, and the saved record is left as it was. Regression: test/channels.connect-provider-switch.test.js, green on the fixed tree (95 of 95).

## Notes

Not covered by this fix: the channel sync route (Telegram, Discord and the generic channels) patches the record's provider from the body and keeps the record's key and endpoint. On the desktop the page posts a sync with the new provider and no key after a model pick on another provider and at every boot, so the same cross-provider send is reachable through sync until that route gets the same guard. The run-wire lane's sync handlers already have it.
