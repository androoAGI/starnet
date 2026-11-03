---
fingerprint: 9e60dd9f
slug: a-telegram-consent-ask-allowed-from-starnet-remo
title: A Telegram consent ask allowed from STARNET REMOTE is stamped 'expired — DENIED' by a late tap on the still-live keyboard
surface: channels
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 0fcbbd42d
origin: audit
---

# A Telegram consent ask allowed from STARNET REMOTE is stamped 'expired — DENIED' by a late tap on the still-live keyboard

## Symptom

A Telegram chat with /approvals on is asked for permission (fs.write). The Commander approves it from the StarNet Remote phone app instead — the action runs and the chat gets "Wrote gamma.md." The Telegram permission message still shows its four buttons. Tapping one afterwards toasts "⚠ Already expired — denied", rewrites the permission message to end "▸ ⚠ expired — DENIED, the run moved on", and sends "⚠ That permission request had already expired — the action was denied and the run moved on." The permanent record of a security decision says DENIED for an action that was allowed and ran.

## Repro

Booted sidecar :9721 with STARNET_REMOTE_PORT / STARNET_REMOTE_LAN=1 / STARNET_REMOTE_RELAY=off, mock Telegram + scripted mock OpenRouter, owner paired in DM 4242.
1. /approvals on, then "write gamma.md please" -> brief_proceed -> fs_write -> consent keyboard (sendMessage with 4 buttons).
2. Pair a phone with relay/app/phone-client.js (POST /api/remote/enable, /api/remote/pair, Phone.pair/connect), call `approvals`, then `decide {decision:'once'}` on the channel prompt.
3. The run finishes ("Wrote gamma.md."); tap any button on the Telegram permission message.

## Evidence

- Before the fix (mock Bot API capture): `answerCallbackQuery "⚠ Already expired — denied"`, `editMessageText "…\n\n▸ ⚠ expired — DENIED, the run moved on"`, `sendMessage "⚠ That permission request had already expired — the action was denied and the run moved on."` — while `ws/tg_4242/gamma.md` = `GAMMA` and the phone's decide returned `{"ok":true,"data":{"decided":"once"}}`.
- Mechanism: STARNET REMOTE answers channel prompts through the same finisher (`remoteApprovals.add({… finish: pend.get(promptId) })` in channelAskConsent, sidecar/index.js), so `channelResolveConsent` returns false for the late tap, and `sidecar/channels/hub.js` onCallback treated every false as an expiry (`'▸ ⚠ expired — DENIED, the run moved on'`).
- Regression: `test/channels.buttons.test.js` case 5E3 — RED before (stamp, toast and correction all claimed a denial), GREEN after.
- Not fixed here: when the ask is answered on another surface, the Telegram keyboard is not stripped at that moment; it stays live-looking until tapped.

## Verdict

Fixed: the host remembers how each settled channel ask ended (`channelConsentOutcome`, bounded) and the hub's late-tap path reports an allow as "▸ already answered in StarNet — ALLOWED (once)" with no denial toast or correction. Live re-check: phone approved, Telegram Deny tapped -> ack "✓ Already answered elsewhere — allowed", stamp "▸ already answered in StarNet — ALLOWED (once)", delta.md written. Fix: `0fcbbd42d`.

## Family

Closed as a family by the channel-delivery-ledger lane. This is the same remainder as 64563ad9: the settle's stamp was neither retried nor durable, so an ask answered on STARNET REMOTE left its buttons live whenever the first edit met a 429.

The invariant is the same test, `test/channels.consent-stamp.property.test.js`. Its REMOTE rows answer through STARNET REMOTE's real approvals index, in both landing orders, with and without a refused first edit, and a late tap afterwards edits nothing.
