---
fingerprint: b0153e33
slug: saved-line-identities-leave-builder-receipts-wit
title: Saved line identities leave builder receipts without a usable line name
surface: world
severity: P2
status: fixed
found: 2026-11-03
lane: line-intake
fix: 948c614349ee36c0452b1ecfb5a73d74140d63f1
origin: audit
---

# Saved line identities leave builder receipts without a usable line name

## Symptom

A newly refitted line that needs crew tells the Commander to staff "a line" instead of naming the floor's actual LINE. The suggested follow-up cannot identify the intended line after INBOX identities became persistent.

## Repro

Run `node test/station-builder-model-recovery.test.js` on candidate2929d0d7883aebc591108cb8e7179cdeb641b177. Its real model/build fixture places an INBOX, WRITER BAY and OUTBOX, connects them and builds the unstaffed line. The resulting staffing instruction names "a line" instead of LINE plus its floor letter.

## Evidence

The immutable full FAST log `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/batch3-2929d0d78-fast.log`, step1278, records the failing full instruction (134 assertions pass, one fails). `frontend/app/stationbuilder.js` passed `c.key` and `rl.comp.key` to `lineWordOf`, whose argument is a member prop ID. A saved line ID is no longer that prop ID.

The repair passes a real component member while retaining the saved line ID as job/budget identity. `batch3-history-builder-close-2057.log` records seven affected files passing, including the original model/build test, line operations and intake identity. The website mirror was generated through `scripts/sync-website-app.mjs`. This is a model/host fixture proof, not installed-app acceptance.

## Verdict

Source-fixed in948c614349ee36c0452b1ecfb5a73d74140d63f1. The original real model/build fixture and affected line operations/identity checks pass. Independent source review confirmed both callers resolve a real component member while retaining the saved line ID as durable authority. Combined gates and installed/live builder acceptance remain separate.
