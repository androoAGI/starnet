---
fingerprint: 6e29727c
slug: windows-node-24-http-test-exits-with-a-native-li
title: Windows Node 24 HTTP test exits with a native libuv assertion after passing
surface: release
severity: P2
status: open
found: 2026-09-19
lane: reliability-audit-0919
fix:
origin: audit
---

# Windows Node 24 HTTP test exits with a native libuv assertion after passing

## Symptom

The local HTTP validation gate reports passing update-preparation assertions, then its Node 24.19.0 Windows process crashes instead of returning success. This is validation-runtime evidence, not evidence of an installed-app failure.

## Repro

On the audited Windows host, invoke `test/update-preparation.http.test.js` using the bundled Node 24.19.0 executable. Repeat with the normal Node 22.23.0 executable. Two Node 24 runs (full HTTP gate and direct reproduction) passed nine assertions and then hit the same native assertion. The Node 22 direct run and original full HTTP gate returned success.

## Evidence

Observed terminal: `update-preparation.http.test: OK (9 assertions)` followed by `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94`. Gate exit code 3221226505 at step 16/120. Logs are retained in the audit worktree `.dogfood/reliability-audit/http-final.log`; a sanitized receipt accompanies the audit digest. Anchor: `test/update-preparation.http.test.js`.

## Verdict

Open. Validate the source on Node 22 while retaining this failure. Isolate a minimal native shutdown reproduction before assigning responsibility to Node/libuv or application/test teardown; do not suppress the crash or loosen the gate. No runtime replacement or native-library patch is justified by this audit alone.
