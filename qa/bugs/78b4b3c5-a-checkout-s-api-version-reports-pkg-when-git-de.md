---
fingerprint: 78b4b3c5
slug: a-checkout-s-api-version-reports-pkg-when-git-de
title: A checkout's /api/version reports pkg when git describe is slow
surface: release
severity: P2
status: fixed
found: 2026-10-30
lane: agent/version-describe-1030
fix: 99d31510e
origin: audit
---

# A checkout's /api/version reports pkg when git describe is slow

## Symptom

On a loaded box (free RAM about 0.4-0.5 GB), a sidecar running from a git checkout reports `harnessSource: 'pkg'` and the `0.0.0` package placeholder on `GET /api/version`, so `test/sidecar.http.test.js` fails "/api/version resolves harness via git-describe when no build stamp is set" (expected git, got pkg). The wrong answer is kept for the life of the process, and nothing in the log says why.

## Repro

1. Check out trunk d5024f5a2 (the defect is in `sidecar/index.js` computeVersionSurface, about line 26199).
2. Load the box until `git describe --always --dirty --tags` in the work tree takes more than 2 s (a full gate running with about 0.4 GB free did it).
3. Boot the sidecar with no STARNET_BUILD_DESCRIBE and `GET /api/version`: harnessSource is 'pkg'. Or run `node test/version-source.test.js` on d5024f5a2: scenario V7 runs the real computeVersionSurface with a first describe that times out and reads 'pkg', twice.

## Evidence

- Gate disposition `_logs/stop-retitle-298473720-gate-disposition.md`: full test:http step 10 and the whole-test solo both fail the same assertion on 298473720 (free RAM 0.47 GB before the solo); the same assertion failed on release 192dd3c6e's local http.
- The defective code on d5024f5a2: `execSync('git describe --always --dirty --tags', { ..., timeout: 2000 })` inside `} catch (_) {}`, then the package.json fallback with harnessSource 'pkg', then `_versionCache = out` for the process.
- Measured on 10-30 in this work tree with a gate running: `git describe --always --dirty --tags` took 1.1-1.6 s, and describe plus rev-parse took 3-7 s through execFile.
- `test/version-source.test.js` on d5024f5a2: 16 problems, 4 ok, among them "V7 /api/version: a checkout whose first git describe timed out reports git once a retry answers (not a cached pkg) — expected git, got pkg" and "computeVersionSurface runs no synchronous child process — got [git describe --always --dirty --tags]".

## Verdict

Fixed on agent/version-describe-1030 by 99d31510e (not merged yet). `sidecar/version-source.js` resolves the harness id without blocking: an env stamp wins; no `<repo>/.git` (a packaged app) is 'pkg' at once; in a checkout (a .git directory or a worktree's .git file) git runs through async execFile with a 15 s per-attempt timeout, and every failure is noted (version.git.attempt, with the exit code, the timeout or the first stderr line) and retried with backoff, at most 6 attempts inside 60 s. Until git answers, or after an exhausted budget (noted, version.git.exhausted), harness reads '' with harnessSource 'unknown'. That answer is never cached, and git is asked again after a 5 min cool-down. A checkout never reads 'pkg'. GET /api/version and a run's [RUNTIME] line wait for a describe still in flight, bounded at 10 s. `test/version-source.test.js` is green on 99d31510e (62 assertions) and red on d5024f5a2. `test/sidecar.http.test.js` passed solo on the lane (524 assertions, 0.86 GB free before). The full http gate has to pass again at the rebased merge tip.
