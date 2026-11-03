---
fingerprint: f9c18635
slug: remote-host-rejects-proven-desk-caches-without-t
title: Remote host rejects proven desk caches without transcript proof readers
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: batch3-codex-1103
fix: d4a54f29f
origin: audit
---

# Remote host rejects proven desk caches without transcript proof readers

## Symptom

A phone cannot list or continue a desk session whose saved cache contains valid transcript row identities. It reports that cached identity could not be proved even though the host can prove those same rows through its transcript endpoint.

## Repro

Run test/remote.e2e.test.js with a durable desk conversation and its identical saved cache. Read the phone thread list and continue that session through the actual sealed phone routes. The pre-repair host adapter supplies view but omits both cache proof readers required by sidecar/remote/host.js.

## Evidence

Logs under gen-trees/_logs/codex-overnight-1103: batch3-4390a984-merged-preflight.log preserves the original desk-cache-only fixture failure. The corrected canonical fixture then fails at thread-list identity proof in batch3-remote-canonical-fixture-03.log. batch3-remote-canonical-diagnostic.log shows the same IDs receive HTTP200 affirmative proof and appear in the host transcript while the phone refuses them. Wiring the two existing Store readers yields batch3-remote-canonical-owner-green.log, all118 assertions green, including accepted dispatch, hidden-history exclusions, exact desk history, restart and stop paths.

## Verdict

Source-fixed in d4a54f29f. The host now supplies cacheRetractions and cacheRetractionsBatch from its existing transcriptStore; no bypass, inferred absence or duplicate proof owner was added. The fixture publishes and closes its canonical seed before starting the host and saves copies with matching identities. Combined gates remain pending; no installed-phone acceptance claim.
