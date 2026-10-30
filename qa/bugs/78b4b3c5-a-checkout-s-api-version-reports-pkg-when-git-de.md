---
fingerprint: 78b4b3c5
slug: a-checkout-s-api-version-reports-pkg-when-git-de
title: A checkout's /api/version reports pkg when git describe is slow
surface: release
severity: P2
status: fixed
found: 2026-10-30
lane: agent/version-describe-1030
fix: 99d31510e 4ce9d200b f884cced3 c7c5a99f1
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
- Review of 99d31510e (Codex `_logs/reliability-coordination-codex-1029/coord-version-99d-provisional-review.json`, VD99-01..03, plus round-1 review) found that the first fix still had gaps:
  - a successful describe was withheld until `git rev-parse HEAD` finished, even when a valid BUILD_SHA made HEAD unneeded, and an exhausted rev-parse froze buildSha '' for the process (VD99-01);
  - a backoff that woke late could start an attempt past the budget with a 1000 ms minimum timeout (VD99-02);
  - a failure note cut raw stderr to 200 characters BEFORE failNote redacted it, so a known 64-character secret crossing the cut left a 24-character fragment no redaction could match (VD99-03);
  - runs and GET /api/version waited up to 10 s whenever a resolution was in flight, including for a git that always fails, again after every 5 min cool-down. That is longer than the CLI attach probe's 5000 ms timeout (`bin/starnet.js` attachClient). The token was still enforced: the server checks it before the version handler runs, so a bad token is refused with 403 without waiting on git (Codex `coord-version-9926-caller-lifecycle-prep.json`). What a timed-out probe cost was the CLI client's positive confirmation: attachClient throws only on a 401 or 403 answer, so on a timeout it carries on without one. That permissive client fallthrough predates this lane and is unchanged. The 10 s wait was also shorter than one 15 s attempt;
  - 'exit 0 with nothing printed' had no test;
  - a git in flight was not reaped at shutdown;
  - `fs.existsSync` (it never throws) made the 'a .git probe that errors is a checkout' branch dead code.
- The repaired `test/version-source.test.js` run against 9926cc5d2's sidecar files: 49 problems, 81 ok, covering every item above. Two mutants of the repair also go red: one accepts an empty describe (4 problems), one cuts the text before redacting (2 problems).
- Review of 4ce9d200b (Codex `_logs/reliability-coordination-codex-1029/coord-version-4ce-provisional-repair-review.json`, VD4CE-01) found the shutdown kill did not match the launch on POSIX. git ran through a plain execFile, so it was not a process-group leader, and the injected kill was stopTerminalTree, written for PTY group leaders. Its -pid signal missed, the fallback killed git alone, and a descendant (for example a configured fsmonitor hook during the --dirty index refresh) could outlive the station. Windows was not affected (taskkill /T).
- `test/version-source.test.js` V11 on f884cced3 drives makeOwnedGit with an injected host on each platform shape, and kills a real launched child and its grandchild through stop(). Two mutants go red: dropping the POSIX detached launch (3 problems), and dropping taskkill's /T (3 problems, among them the real grandchild surviving on win32).
- Final review 1 of f884cced3 found that on Windows the shutdown taskkill lost a race with gracefulShutdown's exit. kill() started taskkill, unref'd it and returned, and nothing waited for it, so with no station browser and no runs the station exited a few ms after stop(). taskkill takes about 220-270 ms on this box. The exit ended the station's own taskkill and its direct child (libuv's kill-on-close job), but git's own children are outside that job and lived on. With Git for Windows the direct child is the `cmd\git.exe` launcher, so the git doing the --dirty refresh is always such a descendant. The reviewer reproduced it with real git 2.54.0.windows.1 and an fsmonitor hook that sleeps. V11's real-tree check passed only because the test process stays alive after stop(). The race predates f884cced3: stopTerminalTree was fire-and-forget too.
- `test/version-source.test.js` V12 on c7c5a99f1 drives the kill's settle on each platform shape. It also runs a real child station that stops and exits the way gracefulShutdown does, and checks that no git child or grandchild is left. Against acdf69560's sidecar files it gives 18 problems, among them "win32: child gone, grandchild alive". Two mutants go red: dropping the settle from stop() (3 problems, the real grandchild among them), and unref'ing taskkill again (1 problem).

## Verdict

Fixed on agent/version-describe-1030 by 99d31510e and repaired by 4ce9d200b, f884cced3 and c7c5a99f1 (not merged yet).

`sidecar/version-source.js` resolves the harness id without blocking.
- An env stamp wins.
- No `<repo>/.git` (a packaged app) is 'pkg' at once. The probe is `fs.statSync`: ENOENT or ENOTDIR means no checkout. Any other probe error is noted (version.checkout) and treated as a checkout.
- In a checkout (a .git directory or a worktree's .git file) git runs through async execFile with a 15 s per-attempt timeout. Every failure is noted (version.git.attempt) and retried with backoff, at most 6 attempts inside 60 s. Failures include a timeout, a non-zero exit, a spawn that throws, and exit 0 with nothing printed. An attempt starts only while at least 1 s of the budget is left, checked after the backoff sleep. The note redacts the whole of git's text through context.redact before cutting it.
- Until describe answers, or after an exhausted budget (noted, version.git.exhausted), harness reads '' with harnessSource 'unknown'. That answer is never cached, and git is asked again after a 5 min cool-down. A checkout never reads 'pkg'.
- A describe answer is published at once. `git rev-parse HEAD` is skipped when a valid BUILD_SHA is stamped. Otherwise it only feeds buildSha, with its own retries. Until it answers (or after its budget, noted as version.head.exhausted), buildSha reads '' and buildDirty null, not cached, and HEAD is asked again after the cool-down.
- The resolution is kicked at listen. A caller waits only while the process's first describe attempt is still running, and the wait ends at that attempt's answer or failure: GET /api/version at most 2.5 s (half the CLI attach probe's 5 s), a run at most 1 s. After any failure nobody waits.
- gracefulShutdown stops the source: it kills the git in flight and starts nothing more. The kill matches the launch (makeOwnedGit, f884cced3). On POSIX git is launched detached, the leader of its own process group, and the group gets SIGTERM; only a group that cannot be signalled falls back to git itself, noted. On Windows git is never detached, and taskkill /T /F reaps its tree. The attempt timeout takes the same kill.
- The station exits only once that kill has landed (c7c5a99f1). stop() returns the kill's settle, which never rejects: on Windows it lands when taskkill answers (taskkill stays referenced until then), on POSIX at once. gracefulShutdown waits for it inside its existing 2.5 s afterBrowser bound, under the 3 s deadline.

Diagnostics, the live doctor, the harness snapshot, /v1 and the headless status read the interim without waiting: '' with 'unknown' (their fallbacks show 'dev' or 'unknown'), then 'git'.

Test results:
- `test/version-source.test.js`: green on c7c5a99f1 (202 assertions), on f884cced3 (180) and on 4ce9d200b (141), red on 9926cc5d2's sidecar files (49 problems) and on d5024f5a2.
- `test/sidecar.http.test.js` on 4ce9d200b: OK, 524 assertions, including the first-check 'git'. The first run hit the test's 9 s boot timeout before the listen line, with a full gate running and about 0.7 GB free; the re-run was green.
- `test/cli-station.e2e.test.js` (the CLI attach path): OK, 43 assertions.

The full http gate has to pass again at the rebased merge tip.

Known exposure, unchanged: a kill (attempt timeout or shutdown) that lands while `git describe --dirty` holds `.git/index.lock` to write the refreshed index can leave the lock stale. The window is the index write itself, and the old 2 s execSync had the same exposure, more often.

Known limit of the shutdown reap: the wait is bounded. If taskkill has not answered within the 2.5 s afterBrowser bound (a very loaded box), the station exits anyway and git's descendants can still outlive it until their own work ends. A hard kill of the sidecar (TerminateProcess, SIGKILL) runs no gracefulShutdown at all.
