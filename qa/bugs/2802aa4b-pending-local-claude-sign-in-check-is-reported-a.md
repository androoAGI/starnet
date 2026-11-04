---
fingerprint: 2802aa4b
slug: pending-local-claude-sign-in-check-is-reported-a
title: Pending local Claude sign-in check is reported as missing API credentials
surface: providers
severity: P2
status: fixed
found: 2026-11-03
lane: batch3-fixture-repairs-1103
fix: 92a2b373a1449d233d1d2a7bd62f07c7c3250e62
origin: audit
---

# Pending local Claude sign-in check is reported as missing API credentials

## Symptom

A first request while Claude Code's local sign-in check is still running says a key or model is missing and opens generic API credentials. A temporary inability to read that local status also looks like absent credentials.

## Repro

Run test/provider-cli-admission.http.test.js. It starts a real isolated sidecar with a synthetic local CLI, holds its auth-status child, submits an actual request, then releases the check and separately submits one eligible request. Independent unavailable, missing-installation and signed-out cases exercise the same host and frontend reader.

## Evidence

Original index and FriendlyError bytes are preserved under gen-trees/_logs/codex-overnight-1103/cli-pending-control-16d15. provider-cli-pending-original1507.log fails22 of45 assertions; provider-cli-pending-current1507.log passes43. The old reader adds two wrong-action assertions because it incorrectly offers Settings for temporary states. All four refused requests generate zero calls; after explicit status resolution exactly one separately submitted request generates and succeeds. cli-pending-readers-1743.log passes FriendlyError, typed-code, common-readiness and actual headless-boot regression files.

## Verdict

The host projects its existing readiness reason and the frontend distinguishes checking, unavailable, missing installation and signed-out states. Existing HTTP400 eligibility remains; no waiting, retry, automatic generation or new credential resolver was added. Actual marked transport loss keeps precedence. The shipped mirror matches. Combined candidate gates remain pending; no real account or installed-build acceptance claim.
