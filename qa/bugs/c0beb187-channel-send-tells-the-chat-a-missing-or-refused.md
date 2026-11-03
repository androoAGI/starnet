---
fingerprint: c0beb187
slug: channel-send-tells-the-chat-a-missing-or-refused
title: channel.send tells the chat a missing or refused file 'is saved in the workspace on the station'
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 00bc7ba60
origin: audit
---

# channel.send tells the chat a missing or refused file 'is saved in the workspace on the station'

## Symptom

An agent sends files to Telegram with channel.send. For a file that does not exist ("missing.txt"), is empty, or is a refused path ("../../channels/secrets.json"), the chat is told: "Note: this file could not be attached here — "../../channels/secrets.json". It is saved in the workspace on the station." — pointing the Commander at a file that is not there (and, for the traversal, at the station's secrets path).

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner DM 4242 with a clean history.
1. Scripted run: brief_proceed -> `channel_send {target:"4242", text:"Media incoming", files:["../../channels/secrets.json","song.mp3","chart.png"]}`.

## Evidence

- Before the fix (mock capture): `sendAudio song.mp3`, `sendPhoto chart.png`, then `sendMessage "Note: this file could not be attached here — \"../../channels/secrets.json\". It is saved in the workspace on the station."`; the tool result itself was honest: `"filesFailed":["\"../../channels/secrets.json\" could not be read from your workspace (illegal path: …) — nothing was attached"]`. Same for missing.txt / empty.txt in an earlier send.
- Mechanism: `sidecar/tools/builtin/comms.js` built the note from every non-attached path (`wanted.slice(0, MAX_FILES).filter(f => attached.indexOf(f) === -1)`) and always appended "saved in the workspace on the station".
- Regression: `test/channels.telegram.media.test.js` case H — RED before, GREEN after.

## Verdict

Fixed: only a file that was read and then failed to upload is said to be on the station; an unreadable one is "could not be found in the workspace, so nothing was attached". Live re-check: "Note: this file could not be found in the workspace, so nothing was attached — \"../../channels/secrets.json\"." Fix: `00bc7ba60`.

## Family

Closed as a family by the channel-delivery-ledger lane. The copy was fixed, and the path stayed double: the missed-file note was composed and sent separately by channel.send and by routine delivery, neither emitted channel.delivery, and channel.send's note carried no thread. Both now go through ChannelOutbound, and a routine's note is a part of its ledger record.

Since review round 1 the sentence itself has one home too: `comms.js` missedNote, which channel.send and a routine's note both say, so a refused or unreadable file is never "saved in the workspace" on either path.

The invariants: `test/channels.outbound.contract.test.js` (the missed-file notes among the paths held to the one contract: the chat's topic and one delivery with its reason; and "the missed-file note": its wording per file on both paths) and `test/routine-delivery.lifecycle.test.js` (a file that resumes after a restart never resends the words).
