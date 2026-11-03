---
fingerprint: d53b4cdf
slug: webhook-terminal-write-failures-abandon-exact-jo
title: Webhook terminal write failures abandon exact job cancellation owners
surface: autonomy
severity: P1
status: fixed
found: 2026-11-03
lane: line-intake-next-1103
fix: 0bd76b7d4f1ba46dc0fda237bfff9ed2e2b6dffd
origin: audit
---

# Webhook terminal write failures abandon exact job cancellation owners

## Symptom

A webhook job can remain running after storage refuses its final record, even when the provider has already finished. Once storage recovers, cancelling that exact job still cannot finish it. Its floor entry remains occupied and no durable terminal result appears.

## Repro

Run test/line-hook-orphans.test.js against the original S3 checkpoint. Refuse the trigger rate write and subsequent refusal finish after a strict job start; alternatively allow the actual hub and chain to complete one run, then refuse every terminal job write. Recover storage and cancel that same job through its existing book. Also see test/line-hook-cancellation.test.js for cancellation before hub adoption.

## Evidence

Logs in gen-trees/_logs/codex-overnight-1103: line-intake-s3-orphans-red.log preserves 11/32 failures against immutable original sources. Root repaired proof passes40 in line-intake-s3-orphans-expanded-root.log, including retained run/spend, held floor capacity and retry-only STOP/fault. line-intake-s3-close-root.log passes all18 affected files, including actual HTTP delivery/restart/lost acknowledgement/cancellation. Expanded queue resumption passes49 in line-intake-s3-orphans-resume-root-02.log. Its first attempt incorrectly expected the run outcome succeeded instead of the established job outcome delivered; that fixture error remains in line-intake-s3-orphans-resume-root.log. Original prestart control fails21/48 and repaired cancellation passes48.

## Verdict

Source repair checkpoint0bd76b7d4 retains the exact item in the existing trigger queue when terminal persistence is unconfirmed. The existing job book preserves first terminal facts and resolved paid rows; cancellation retries only settlement and reconciles floor/trigger projection once. The held item blocks following dispatch until durable settlement. No replacement job or paid replay is used. Final independent review resumed and found no additional blocker in these orphan repairs; the separate normal-withdrawal and prestart gap it discovered is fixed by ebded1422 and recorded as e5a46952. The affected37-file run preserves orphan49-green coverage. This record claims the focused source fix, not whole-lane, installed-app or release acceptance.
