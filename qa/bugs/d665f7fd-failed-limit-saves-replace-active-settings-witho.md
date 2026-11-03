---
fingerprint: d665f7fd
slug: failed-limit-saves-replace-active-settings-witho
title: Failed limit saves replace active settings without durable confirmation
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: spend-governor-1103
fix: f796a11ef21a65bfdc13b5dac6356559c021dd4c
origin: audit
---

# Failed limit saves replace active settings without durable confirmation

## Symptom

A failed runtime or spending-limit save can appear successful and change active enforcement even though persistence was not confirmed.

## Repro

1. Use the actual host save handlers and real durable store with a prior saved limit.
2. Inject a filesystem failure before write, then separately after the new file lands but before main-file readback.
3. Exercise runtime save, budget save, budget import and budget reset; compare response, saved projection, active values and independent reload.

## Evidence

test/limits.persistence.test.js lifts the production handlers and uses the real filesystem/durable stores. Exact original index source fails 34/82 assertions; fixed source passes all82. Each surface returns500 on missing durability proof, retains prior in-memory/live values, and does not advertise an applied import. Pre-write faults preserve old bytes; readback faults acknowledge bytes may have landed. Explicit retry and independent reload confirm the accepted settings. Receipts: C:/Users/andro/gen-trees/_logs/codex-overnight-1103/spend-s5-persistence-control-red.log and spend-s5-limits.persistence.log. Real governor.every-call HTTP51 passes positive save/application timing/readback in spend-s5-governor-http-final.log.

## Verdict

Existing verified-save boundaries now run before memory/active limits are replaced. Refusal wording says unconfirmed rather than falsely promising that disk is unchanged. This is source plus real-filesystem/lifted-host proof; actual browser failed-save preview remains separately pending in the handoff.
