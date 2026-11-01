---
fingerprint: 96dcbade
slug: the-phone-s-routine-list-shows-a-live-green-dot
title: The phone's routine list shows a live green dot and cadence while scheduling is OFF or E-STOPped
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 1b374f9ba
origin: audit
---

# The phone's routine list shows a live green dot and cadence while scheduling is OFF or E-STOPped

## Symptom

On the paired phone, SETTINGS › Routines shows each enabled routine with a green "ok" dot and its cadence ("every day at 9am") while scheduling is OFF or the E-STOP is engaged — the same routines the desk panel, the apps list and GET /api/cron report as not running.

## Repro

1. Pair a phone; create an enabled routine.
2. `POST /api/cron/arm { enabled:false }` (or `POST /api/halt`).
3. Open the phone app's Settings › Routines.
(Code-path repro: `sidecar/remote/host.js` `routines()` maps `d.routines()` — `cronStateSnapshot(Date.now()).jobs` in `sidecar/index.js` — to `{ enabled, nextRunAt, … }` with no scheduler state.)

## Evidence

Not live-verified on a paired phone (no device in this sweep). Server truth during probeB: `GET /api/cron` `{ enabled:false }` then `{ halted:true }` with both jobs `enabled:true`. The phone payload carries only `enabled`/`inFlight`, and `relay/app/app.js` `renderSettings` renders `el('i', 'dot' + (j.inFlight ? ' work' : j.enabled ? ' ok' : ''))` with text `j.enabled ? (j.schedule || 'scheduled') : 'paused'` — a live dot for a routine that cannot fire.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed in source on the wave-1 candidate. 1b374f9ba (qw-channels-lines, quick win 30): the remote host's routines reply carries the scheduler's own state, so each row is `held: 'off'` or `held: 'halted'` while scheduling is OFF or the E-STOP is engaged (sidecar/remote/host.js schedulerHold, fed by the sidecar's cronStateSnapshot), and the phone app (relay/app/app.js renderSettings) shows no live dot and reads 'not running — scheduling is off' / 'not running — E-STOP is on' instead of the cadence. Regression test green on the merged tree: remote-routines-scheduler (12). Not live-proven on a paired phone; the relay app ships separately and is not deployed; not released.
