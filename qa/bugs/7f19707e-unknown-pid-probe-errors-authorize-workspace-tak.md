---
fingerprint: 7f19707e
slug: unknown-pid-probe-errors-authorize-workspace-tak
title: Unknown PID probe errors authorize workspace takeover
surface: sessions
severity: P1
status: open
found: 2026-09-19
lane: reliability-audit-0919
fix:
origin: audit
---

# Unknown PID probe errors authorize workspace takeover

## Symptom

An uncertain process-probe error is interpreted as proof of death and can authorize taking an active workspace.

## Repro

Run `node test/workspace-probe-errors.test.js`. Inject EACCES, EIO, EPERM, ENOSYS, an unclassified exception, ESRCH and success into the process probe.

## Evidence

`qa/evidence/reliability-hardening-0919/owner-before.log` captures EACCES authorizing reclaim before the patch. The regression now permits recovery only for ESRCH.

## Verdict

Candidate patch treats every uncertain probe as busy. Full gates pending; concurrent stale-reclaimer race remains tracked separately.
