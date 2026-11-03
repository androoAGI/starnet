---
fingerprint: 08c34d57
slug: private-entry-intent-lacks-lossless-lifecycle-ow
title: Private entry intent lacks lossless lifecycle ownership
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: line-hold-next-1103
fix: 3329cfd48837168e937fe7d7f461b424f6aac5a3
origin: audit
---

# Private entry intent lacks lossless lifecycle ownership

## Symptom

Before activating private entry checkpoints, the existing LineJobs owner could discard an additive entry receipt during normalization, replace or ordinarily finish an unresolved entry, and turn a saved intent into a generic terminal restart record. The exact6cb control seeds the proposed receipt into the real existing owner; this proves a required new private durability boundary, not a claim that a public entry/resume API previously existed.

## Repro

1. Run `test/linejobs.entry.test.js` with `LINE_ENTRY_CONTROL_JOBS` pointing to the preserved exact6cb LineJobs source and its verified SHA256. Normalize, mutate, boot and prune jobs bearing the proposed entry record; invalid/duplicate enclosing records must not silently erase it.
2. Run the same test against the current owner, and `test/line-entry.test.js` for immutable identity/input/ceilings, exact revision replay, file receipts, safe bounds and unknown preservation.
3. Run `test/linejobs.entry.persistence.test.js`: actual extracted private host functions plus real canonical stores inject failures before and after rename, restart lost ACKs, remove/corrupt/mismatch ledger authority, retain original boot IDs, and reject stale CAS or usageMissing adoption. No provider or public endpoint is invoked.

## Evidence

External rootlogs `line-hold-h3-entry-owner-old-6cb.log` contains the child-verified source SHA256 F5F16DE151941B9A0EBD337A34EB6CE3D1A51D48CAD0884197499C5C403CC626 and full RED10/13 (three positives). Current owner25, schema66 and actual extracted-host persistence42 passed; syntax8 passed. Exact PID/exit records are `line-hold-h3-entry-receipts.jsonl`, source/control manifest `line-hold-h3-entry-source-01.json`.

All19 affected files/laws passed with actual exits in `line-hold-h3-entry-affected-receipts.jsonl`: H2 schema93/transitions25/continuation66; enrollment observation34/retention37/enrollment145; receipt46/persistence46/LineJobs25/invariant123; real allocated routing.line-jobs and routing.line-admission HTTP; seven laws608/37/11/485files/151/293/3602files. No assertions, thresholds or law exemptions were weakened. Root and renderer independently reviewed unchanged source01; `line-hold-h3-entry-independent-review.md` records the peer scope.

## Verdict

Source-fixed in3329cfd48837168e937fe7d7f461b424f6aac5a3. The same LineJob preserves exact entry intent/uncertainty/observed receipts and opaque future data; private writes require fresh matching canonical enrollment, expected revisions and verified readback. Lost ACK replay returns saved state without new IDs or dispatch permission. Observed usageMissing remains unresolved, and entry-to-continuation booking/adoption is refused.

This is a private schema/owner prerequisite. Canonical run evidence, paid entry dispatch, fresh-ledger bootstrap, one-walker integration, public hold/resume and terminal publication remain separate unimplemented/held slices. No live paid/provider run, whole-lane or installed-app acceptance claim follows.
