---
fingerprint: 253e5a8e
slug: saved-file-links-disappear-when-conversation-his
title: Saved file links disappear when conversation history is restored
surface: sessions
severity: P1
status: fixed
found: 2026-09-16
lane: agent/release-0120-prep-0915
fix: 8d4f3f5ca
origin: customer
report: September 14 hotspot-user report item 4, relayed in the September 16 release handoff
affected: Reported desktop build not identified
family: deliverable-history-replay
installer: unverified
recovery: unconfirmed
---

# Saved file links disappear when conversation history is restored

## Symptom

After reopening a conversation, a delivered file is represented only by the model's text path; its clickable saved-file row has disappeared.

## Repro

Record a file deliverable between a user request and an assistant reply. Reload the page or switch away and reopen the stream. Before `8d4f3f5ca`, history rendering omits the saved-file row. After the fix, the recorded file row reappears before its associated reply.

## Evidence

`test/comms-deliverable-replay.test.js` checks persisted deliverable records and the production rendering seam. The prior lane's `scratchpad/deliverable-proof/receipt.json` was inspected in Claude session `2cdb804a-45aa-4e95-abd5-f04bf4be0db7`: pass=true, restored `meeting-notes.md` link present, deliverable index 1 before reply index 2 after page reload. This was a browser fixture with recorded history, not a real-provider file-opening or installed-desktop proof.

Source anchor: `frontend/app/chat.js` functions `replayableDeliverables`, `replayDeliverableRow`, and `renderHistory`.

## Verdict

Source repair `8d4f3f5ca` replays stored deliverables through the existing file/image/video/audio renderers. This report was previously mentioned only in the release handoff; it now has a durable record. Customer recovery remains unconfirmed.

## Regression

Before: renderHistory replayed conversation turns but no stored file rows. After: persisted deliverables replay in recorded time order, including files newer than the last stored reply. Browser fixture evidence confirms the link survives reload; installed acceptance remains separate.

## Sibling coverage

{
  "adapters":[{"target":"stored file and media records","state":"covered","test":"test/comms-deliverable-replay.test.js","scenario":"recorded file/image kinds and timestamps are preserved","gate":"fast"}],
  "entrypoints":[{"target":"history restoration","state":"covered","test":"test/comms-deliverable-replay.test.js","scenario":"renderHistory invokes the original file and media renderers","gate":"fast"}],
  "displays":[{"target":"saved-file row order","state":"covered","test":"test/comms-deliverable-replay.test.js","scenario":"rows precede their reply and remaining rows are flushed","gate":"fast"}],
  "lifecycle":[{"target":"installed desktop file opening","state":"blocked","reason":"The imported browser fixture verifies row restoration, not native file opening or customer recovery."}]
}
