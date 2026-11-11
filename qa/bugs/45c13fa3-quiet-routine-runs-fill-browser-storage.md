---
fingerprint: 45c13fa3
slug: quiet-routine-runs-fill-browser-storage
title: Quiet routine runs fill browser storage, and deleted routine sessions come back after a restart
surface: sessions
severity: P1
status: fixed
found: 2026-11-10
lane: agent/routine-records-1111
fix: 44801f696
origin: customer
report: Direct message from a customer, 2026-11-10 (test scripts and notes attached in that thread)
affected: v0.15.0; macOS 26.6.2; 19 enabled routines, two every minute and seven every five minutes
family: session-records
installer: unverified
recovery: unconfirmed
---

# Quiet routine runs fill browser storage, and deleted routine sessions come back after a restart

## Symptom

The app reported browser storage full. The station held about 5,800 routine sessions, nearly all "— routine ran, nothing to
report —". Cleaning them up cut the saved station from 13.4 MB to 4.0 MB (UTF-16), but after a normal restart 72 of the
removed sessions re-formed. Archived sessions stayed in the saved document.

Three causes:

1. Every cron fire became a saved session (`autosessions.js` beginSession/completeSession, and the boot backfill), even when it
   succeeded and said nothing (no reply, or `[SILENT]`, which is also what every quiet script-only routine returns). That is
   about 1 KB saved per fire.
2. The deleted-session list (`workstreams.js` MAX_TOMBS, mirrored by `sidecar/save-merge.js` TOMBS_MAX) kept only the newest
   500 ids. Any older deleted id still in the boot backfill's run list was adopted again.
3. Archiving only hides a session, so archived quiet sessions stayed in the save.

## Repro

1. Create a routine every minute whose reply is `[SILENT]` (or a script-only routine whose check prints nothing). Let it fire.
   Each fire adds a saved session reading "routine ran, nothing to report".
2. In a Node harness on the real `workstreams.js`, adopt and delete 501 sessions, serialize, `init()` the result, then adopt the
   deleted ids again: the oldest one is adopted (the customer's synthetic test reproduced exactly this).

## Evidence

The customer's measurements: 5,800 sessions, 13.4 MB → 4.0 MB after cleanup, 72 removed ids back after restart, oldest of 501
deleted ids adoptable after reload. Measured here on the pre-fix code: one quiet routine session serializes to 973 characters.
`test/routine-quiet-records.test.js` run against the pre-fix files fails: quiet fires kept their sessions, 40 saved quiet sessions
were not cleared at boot, and deleted ids were re-adopted after a reload.

## Verdict

Source fixed in 44801f696:

- A fire that succeeded and said nothing keeps no session. It is dropped when it settles (`Workstreams.drop`, no tombstone), and
  the boot backfill reads a finished run's transcript once and forms no session for a quiet one. The run still appears in
  RUN HISTORY and its durable transcript.
- At boot, quiet sessions an older build saved are cleared, archived ones included. A session is kept if it is open, pinned,
  renamed, has a follow-up, a deliverable, a second run, a failure/stopped/unloaded line, a run in flight, or (if packed) more
  than one packed row.
- The deleted-session bound is 20,000 on both the page and the sidecar merge, matching `session-tombstones.js` MAX_STREAMS.

Not covered: an archived session that holds real output is still saved in full (archive keeps the conversation); its history
packs to references like any other session once sealed. Not verified in the live app or an installed build.

## Regression

Before the fix, `node test/routine-quiet-records.test.js` failed ("a [SILENT] fire keeps no session once it settles — expected null",
"cron-old0 should have been cleared at boot", and the rest). After the fix it passes 29 assertions. Neighbouring suites pass:
cron-session-hydration, cron.session-transcript.e2e, delegated-threads, outcome-family.census, packed-history.writers,
turn-identity.property, turn-merge.family, workstreams, workstreams-packed-uploads, save-merge, save-merge.identity,
session-tombstones, frontend-fetch-truth-ratchet.

## Sibling coverage

{
  "adapters": [{"target":"agent routine replying [SILENT] and script-only routine with no output","state":"covered","test":"test/routine-quiet-records.test.js","scenario":"a [SILENT] fire and an empty-reply fire keep no session; a reply and a failure keep theirs","gate":"fast"}],
  "entrypoints": [{"target":"live cron.result, boot backfill and saved sessions","state":"covered","test":"test/routine-quiet-records.test.js","scenario":"quiet fires dropped live, quiet while-away runs never formed, older saved quiet sessions cleared at boot","gate":"fast"}],
  "displays": [{"target":"sessions rail","state":"covered","test":"test/routine-quiet-records.test.js","scenario":"the open session, pinned, renamed, followed-up, failed and replied sessions are kept","gate":"fast"}],
  "lifecycle": [{"target":"delete, save and reload","state":"covered","test":"test/routine-quiet-records.test.js","scenario":"5000 deleted ids stay refused after serialize and init; revive still re-opens","gate":"fast"},{"target":"multi-window save merge","state":"covered","test":"test/routine-quiet-records.test.js","scenario":"save-merge.js keeps the same 20000 deleted-id bound","gate":"fast"}]
}
