---
fingerprint: c24336d5
slug: concurrent-stale-workspace-reclaimers-both-acqui
title: Concurrent stale workspace reclaimers both acquire ownership
surface: sessions
severity: P1
status: open
found: 2026-09-19
lane: reliability-audit-0919
fix:
origin: audit
---

# Concurrent stale workspace reclaimers both acquire ownership

## Symptom

Two processes recovering one stale workspace lock can both report ownership, enabling concurrent writes to single-writer stores.

## Repro

Run `node qa/evidence/reliability-hardening-0919/owner-race.cjs`. Reclaimer B reads the stale holder; before that read returns, A replaces it with its own live claim. B then renames the replacement using stale evidence.

## Evidence

The real-filesystem interleaving reproducer asserts both acquire results are successful and prints distinct holders. Anchor: `sidecar/workspace-owner.js`, the `fs.renameSync(lockfile, reclaim)` call.

## Verdict

OPEN P1. A reread cannot close the TOCTOU window. Safe repair requires an atomic OS ownership primitive or a recoverable election protocol, including crash-at-every-step and simultaneous-recovery tests. No automatic-recovery disabling or unsafe lock deletion was introduced.
