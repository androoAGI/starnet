---
fingerprint: abd75bb4
slug: credit-usage-during-mac-boot-failure
title: Customer requests accounting for credits consumed during Mac boot trouble
surface: autonomy
severity: P2
status: open
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: customer
report: support-2026-09-16-mac-boot-credit-usage
affected: Installed Mac app, reported latest public update; exact account run correlation not yet obtained
family: account-usage-correlation
installer: unverified
recovery: unconfirmed
---

# Customer requests accounting for credits consumed during Mac boot trouble

## Symptom

The Mac boot-catalog reporter says purchased credits were partially consumed while the application was not usable and requests an explanation and possible restoration.

## Repro

Correlate the affected account's authoritative charge/run ledger with boot-failure timestamps, other linked stations and any scheduled work. A screenshot balance or inability to use one window alone does not establish whether charges were valid.

## Evidence

Fresh September 16 private follow-up ties the billing concern to the existing shared/specialties.js boot complaint (2f156837). No account-ledger query, run attribution or refund has been performed in this release lane. Anchors: sidecar/budget.js and test/credits.test.js. Keep this separate from the older unrelated idle-usage account report acb47320.

## Verdict

Open P2 account investigation. The BootGuard source hardening does not explain or repair historical charges. No credit adjustment, refund or customer message is authorized by the incoming customer email alone.
