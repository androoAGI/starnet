---
fingerprint: e8f1cac1
slug: line-accounting-enrollment-can-be-erased-by-exis
title: Line accounting enrollment can be erased by existing owner writes
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: line-hold-next-1103
fix: a6e6ee342dc09d0eb38ff8043fcbc368aeb47200
origin: audit
---

# Line accounting enrollment can be erased by existing owner writes

## Symptom

The private held-line accounting path could lose its permanent enrollment when an ordinary job or legacy spend write rebuilt its store. Its receipt bridge could then advance without a confirmed matching enrollment. During implementation review, removing both markers from still-readable files also let the same process mint a replacement identity. This is a private durability prerequisite; public paid hold/resume has not been activated.

## Repro

1. Run test/line-accounting.retention.test.js with the saved original33779 LineJobs, line-spend and host blocks: seed exact root enrollment, then normalize/mutate jobs, prune completed records and make ordinary spend notes across a day boundary.
2. Run test/line-accounting.enrollment.test.js against those same original modules: seed a held job with prepared, missing or mismatched enrollment and call the existing private receipt bridge. It must refuse before either store changes.
3. Run test/line-accounting.observation.test.js against the exact source01 enrollment modules: confirm a pair, remove or replace only its root markers while retaining every job/line byte, then retry through the same canonical owner. Also test confirmed-to-prepared downgrade, prepared first observation, ordinary legacy writes and lost acknowledgment.
4. Run the current files. They must preserve original history, refuse changed observed authority and use the same canonical identity across write/readback faults and restart. Child controls verify their saved source hashes before compiling.

## Evidence

External receipts under gen-trees/_logs/codex-overnight-1103: line-hold-h3-enrollment-retention-old-33779.log has22 failed/15 passed, current retention37 passed; line-hold-h3-enrollment-old-bridge.log has9 expected failures, current enrollment145 passed; line-hold-h3-enrollment-observation-old.log has22 failed/12 passed, current observation34 passed. The existing receipt bridge passes46. Exact source/control manifests and PID/exit records are line-hold-h3-enrollment-source-04.json, the old/pre-observation source manifests and both enrollment receipts.jsonl files. The earlier retention-old37green log selected the wrong baseline due a launcher boolean/string comparison; it is excluded as original33779 evidence and preserved separately.

All17 affected files passed with actual exits in line-hold-h3-enrollment-affected-receipts.jsonl, including real allocated routing.line-jobs and routing.line-admission HTTP hosts, legacy cap projection, host writer faults and seven laws. Enrollment fault tests use the actual existing domain stores and extracted private host functions, with synthetic filesystem faults. They do not claim a live public enrollment or paid provider run.

## Verdict

Source-fixed in a6e6ee342dc09d0eb38ff8043fcbc368aeb47200. The existing two store owners retain additive root metadata, canonical primary readback proves ordered preparation/adoption/confirmation, and each owner remembers only actually observed identity/phase. Intended writes, recovered backup data, missing history and stale snapshots confer no positive authority. Root and independent peer source reviews closed the bounded findings.

Fresh-process simultaneous erasure of both markers is indistinguishable from legacy data under these two existing owners; this explicit limitation is not claimed fixed. Missing-ledger bootstrap, entry intent, durable walker hold/resume, public decisions, publication and SEND TO recovery remain subsequent work. No whole-lane or installed-app completion claim follows from this private checkpoint.
