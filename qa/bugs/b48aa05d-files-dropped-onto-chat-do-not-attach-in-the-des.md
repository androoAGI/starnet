---
fingerprint: b48aa05d
slug: files-dropped-onto-chat-do-not-attach-in-the-des
title: Files dropped onto chat do not attach in the desktop app
surface: sessions
severity: P2
status: fixed
found: 2026-09-18
lane: agent/chat-drop-0917
fix: 68a4cfabe
origin: owner
report: Owner request in Codex, 2026-09-17
affected: Windows desktop; reported version unknown; source 3ba5b8492
family: message-attachments
installer: unverified
recovery: unconfirmed
---

# Files dropped onto chat do not attach in the desktop app

## Symptom

The owner cannot drag a file or image into chat and has to use the attachment button.

## Repro

Open a conversation and drag a local file onto its transcript. Before the repair, no attachment appears. The browser handler only covers the input row; the desktop window additionally leaves Tauri's native interception enabled.

## Evidence

`scripts/qa/chat-drop-live.cjs --baseline` against isolated dev/seed.js reproduces an empty attachment strip with baseline chat.js from 3ba5b8492. The repaired live application accepts a CDP file drop onto the transcript, uploads one PNG and one text file exactly once, and returns their exact bytes through /api/file. The draft survives and both refs appear on the sent user turn (inference transport is a local fixture). Picker and paste work after session re-entry; an outside drop does not navigate. No page errors. Logs: .dogfood/chat-drop/live-before.log and live-after.log. Regression anchor: test/chat-file-drop.test.js.

## Verdict

Source repair 68a4cfabe verified in the isolated live browser with real uploads and read-back. Native shell HTML5 configuration is guarded. Rebuilt installer OS drops and owner recovery remain unverified.

## Regression

The baseline transcript drop stages zero files. The repaired live transcript drop stages and uploads two, preserving the draft. The fast regression executes production event handlers for desktop and website mirrors, including nested targets, text drag, folders, cancellation, direct/group sessions and re-entry. It also guards the native window builder's HTML5 drop setting. Browser proof cannot establish native OS drag delivery on an installed binary.

## Sibling coverage

{
  "adapters": [
    {"target":"browser and website attachment staging","state":"covered","test":"test/chat-file-drop.test.js","scenario":"file drops reach the existing upload path exactly once","gate":"fast"},
    {"target":"real attachment API","state":"covered","test":"test/e2e.attachments.test.js","scenario":"upload, read-back and attachment-bearing run","gate":"http"},
    {"target":"native Windows and macOS OS drops","state":"blocked","reason":"Native configuration is guarded, but exact installer file-manager drop gestures require rebuilt desktop acceptance on each OS."}
  ],
  "entrypoints": [
    {"target":"transcript, nested chat content, direct and group composer","state":"covered","test":"test/chat-file-drop.test.js","scenario":"same staging callback for files, mixed folder/file selection; preserve text dragging","gate":"fast"},
    {"target":"picker and clipboard paste","state":"blocked","reason":"Verified with the live script after session re-entry; not independently registered as browser UI scenarios in the fast/http runner."}
  ],
  "displays": [
    {"target":"drop overlay desktop and website","state":"covered","test":"test/chat-file-drop.test.js","scenario":"nested-target transitions, exit, blur, outside drop and cancellation clear overlay","gate":"fast"}
  ],
  "lifecycle": [
    {"target":"conversation re-entry","state":"covered","test":"test/chat-file-drop.test.js","scenario":"idempotent wiring prevents duplicated uploads and clears stale highlight","gate":"fast"}
  ]
}
