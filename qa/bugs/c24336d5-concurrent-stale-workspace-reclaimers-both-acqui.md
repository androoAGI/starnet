---
fingerprint: c24336d5
slug: concurrent-stale-workspace-reclaimers-both-acqui
title: Concurrent stale workspace reclaimers both acquire ownership
surface: sessions
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9f9b71f0
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

2026-09-20 source repair: immutable generation tickets, published with atomic hard links, elect one owner before any primary claim mutation. Release markers follow the final primary-file operation. Complete primary bytes are also atomically linked so a process kill cannot leave a new torn claim. Generations are never reused or removed, closing the stale-read ABA race; they are excluded from portable and automatic recovery copies. Filesystems without hard-link support fail closed. Simultaneously running older hosts that do not implement this election protocol remains unsupported.

Fresh Windows evidence: test/workspace-owner-election.test.js passes the original reentrant stale-read interleaving, five actual process-death boundaries (pending write, ticket publication, primary publication, readback and held ownership), and eight simultaneous stale reclaimers with exactly one winner. test/workspace-owner.e2e.test.js passes 9 assertions against the production sidecar, including a forced process kill and subsequent recovery. test/workspace-owner.test.js passes 34 assertions; update-preparation.test.js passes 21 and workspace-recovery.test.js passes 66. Native Mac filesystem acceptance is still owed. Historical pre-fix evidence remains retained above.
