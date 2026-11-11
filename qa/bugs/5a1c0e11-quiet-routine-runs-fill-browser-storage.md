---
fingerprint: 5a1c0e11
slug: quiet-routine-runs-fill-browser-storage
title: Quiet routine runs fill browser storage, and deleted routine sessions come back after a restart
surface: sessions
severity: P1
status: fixed
found: 2026-11-10
lane: agent/routine-records-1111
fix: (this lane)
origin: customer
---

# Quiet routine runs fill browser storage, and deleted routine sessions come back after a restart

## Symptom

Customer report on 0.15.0 (macOS): 19 enabled routines, two every minute and seven every five minutes. The app said browser
storage was full. The station held about 5,800 routine sessions, nearly all "— routine ran, nothing to report —". Cleaning
them up cut the saved station from 13.4 MB to 4.0 MB (UTF-16), but after a normal restart 72 of the removed sessions re-formed.

Three causes:

1. Every cron fire became a saved session (`autosessions.js` beginSession/completeSession, and the boot backfill), even when it
   succeeded and said nothing (no reply, or `[SILENT]`, which is also what every quiet script-only routine returns). That is
   about 1 KB saved per fire.
2. The deleted-session list (`workstreams.js` MAX_TOMBS, mirrored by `sidecar/save-merge.js` TOMBS_MAX) kept only the newest
   500 ids. Any older deleted id still in the boot backfill's run list was adopted again.
3. Archiving only hides a session, so archived quiet sessions stayed in the save.

## Fix

- A fire that succeeded and said nothing keeps no session. It is dropped when it settles (`Workstreams.drop`, no tombstone), and
  the boot backfill reads a finished run's transcript once and forms no session for a quiet one. The run still appears in
  RUN HISTORY and its durable transcript.
- At boot, quiet sessions an older build saved are cleared, archived ones included. A session is kept if it is open, pinned,
  renamed, has a follow-up, a deliverable, a second run, a failure/stopped/unloaded line, a run in flight, or (if packed) more
  than one packed row.
- The deleted-session bound is 20,000 on both the page and the sidecar merge, matching `session-tombstones.js` MAX_STREAMS.

## Not covered

- An archived session that holds real output is still saved in full (archive keeps the conversation). Its history packs to
  references like any other session once sealed.

## Test

`test/routine-quiet-records.test.js` (fast list). It fails on the pre-fix code: quiet fires kept, old quiet sessions not
cleared, and deleted ids re-adopted after reload.
