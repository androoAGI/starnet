---
fingerprint: 907bc357
slug: a-damaged-transcript-line-among-a-deleted-chat-s
title: A damaged transcript line among a deleted chat's rows stopped the upload pass from settling
surface: sessions
severity: P1
status: fixed
found: 2026-11-07
lane: release-0150
fix: b53565c2987ee82a773f3ccac4ceb28a0c38b952
origin: audit
---

# A damaged transcript line among a deleted chat's rows stopped the upload pass from settling

## Symptom

After a chat was deleted, its uploads stayed on disk when a damaged transcript line or a missing transcript file sat among that chat's rows. Every chat deleted afterwards kept its uploads too, across restarts, and nothing told the user. Nothing was lost.

## Repro

1. Start a real sidecar, upload a file in chat `ws_old`, save and stop (`test/attachment-delete-in-use.http.test.js`, `tornLineScenario`).
2. While it is down, append a torn fragment to the active transcript segment, then 3100 later rows in the next segment, more than the RAM mirror holds.
3. Start it again and delete `ws_old`.
4. Before the fix, `store.view('proof', streamId, { complete: true })` threw `TRANSCRIPT_UNVOUCHED` at every pass, so the `attachment-files` entry in `sidecar/forget-wiring.js` threw before it removed anything, `forgetAll` threw and `markPurged` never ran.

## Evidence

- The late review (workflow wf_9a6a76fa-b8e, finding F1) reproduced it on a real sidecar.
- With the committed `sidecar/forget-wiring.js` hooked in, `test/attachment-delete-in-use.http.test.js` times out at "the old chat's upload goes" and `test/forget-stores.test.js` throws at line 639 (final review).
- Both pass on b53565c29: forget-stores 177 assertions, attachment-delete-in-use.http 43.

## Verdict

The entry read a deleted session's rows with the strict whole read only, and a closed segment never changes, so the refusal repeated at every pass. It now reads what still parses through eachRow, so the pass settles. A busy or degraded history still fails the pass, so it retries. A file only an unreadable row named stays, and the log says so.
