---
fingerprint: ec226657
slug: reload-duplicates-combined-assistant-replies-bes
title: Reload duplicates combined assistant replies beside durable turns
surface: sessions
severity: P1
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Reload duplicates combined assistant replies beside durable turns

## Symptom

After restarting the installed app, a completed multi-turn reply appears twice: once as its separate durable provider turns, and again as the combined local reply. The project file and saved crew remain intact.

## Repro

Complete a real task that triggers verify-on-stop and emits more than one final assistant turn. Persist the station, restart, and reopen that conversation. Installed run `159301af-e754-4df9-89f7-11781f77ad43` on `f111be488`, then reopened on `fbaab109f`, reproduces the duplicate in `ws_mtw1x111kmaw`.

## Evidence

`.dogfood/release-0112-closeout/installed-persistence-before.json` and `installed-persistence-after.json` preserve the actual local and hydrated history. The old local aggregate contains the exact concatenation of two durable assistant turns; after restart both those turns and the aggregate are present. `frontend/app/chat.js:mergeCanonicalHistory` previously deduplicated only whole-message byte equality.

`test/chat-history-reconcile.test.js` reproduces the local aggregate, already-duplicated legacy save, and explicit-run cases; three assertions fail before repair and all 13 pass afterward. The repair discards an aggregate only when run identity and exact contiguous canonical bytes prove it already committed. Unknown identity, partial transcripts, different runs, attachments, error/stopped markers and intentional repeated messages remain preserved. Completed local replies now retain the real sourceRunId too. The stopped-retry and history-scroll suites still pass (16 and 6 assertions).

## Verdict

Source repair verified in focused tests. The original installed legacy conversation must be reopened on a rebuilt candidate before this record can close. No data deletion or transcript rewrite is performed; canonical storage remains untouched.
