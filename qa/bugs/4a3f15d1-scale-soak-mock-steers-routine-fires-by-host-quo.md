---
fingerprint: 4a3f15d1
slug: scale-soak-mock-steers-routine-fires-by-host-quo
title: Scale soak mock steers routine fires by host-quoted activity, and RSS rule judges a post-boot warm-up window
surface: release
severity: P2
status: fixed
found: 2026-10-30
lane: agent/release-0142-scale-soak
fix: 39d1fde80, 2fc129f5e
origin: audit
---

# Scale soak mock steers routine fires by host-quoted activity, and RSS rule judges a post-boot warm-up window

## Symptom

The first CI soak of 7210e0ae1 (soak.yml run 40976593740) passed the 20-minute main soak and failed the
10-minute `qa:soak:scale` job on two rules: `runs` ({ok:14, failed:2}; both failures are the soak's own
`soak_shell_1` call answered `workspace-busy` after a 45 s wait) and `rss` (slope 11.15 MB/min, +23.8 %
over 7 points). Both are harness defects. The product code was not at fault.

## Repro

1. On e787dd07e (pre-fix harness), run `node scripts/qa/soak.mjs --minutes=4 --routines=5 --restart-every=2 --out=<dir>`.
2. Count `agent.tool_call` shell_exec lines in `<dir>/sidecar.log` for runs whose `agent.run.start` has
   `"trigger":"schedule"`: every routine fire calls shell_exec, though no routine prompt asks for it.
3. Read `rules.runs` in `<dir>/soak-receipt.json`: a tool run fails with `"summary":"workspace-busy"` once a
   slow routine fire holds the agent's workspace lease past the 45 s wait.
4. For RSS: replay the scale receipt's samples through `evaluate` in `scripts/qa/soak.mjs`; the judged
   window is the 2.26 minutes right after the outage restart.

## Evidence

- Mechanism: on the OpenRouter chat wire the host folds `<run_context>` into the routine's own user turn
  (`sidecar/providers/provider.js` userSideHostNotes), and since 4cfcc4d6c (v0.14.0) a routine fire's run
  context quotes recent owner activity, i.e. the soak's own "SOAK_TOOL run the soak command". The mock
  matched the marker anywhere in that turn: `const last = users.length ? String(users[users.length - 1].content || '') : '';`.
- CI run 40976593740 (7210e0ae1): 117 of 126 routine fires ran shell_exec (the 9 that did not fired before
  the first tool run). Log order shows that slow routine r04's run 50b03a41 ran shell_exec and held the lease
  until its 75 s answer ended, across the first failed tool run (f7e11701). Slow r05's run 9e620772 held it
  across the second (6c5f59e2).
- v0.14.1 baseline run 40979299342: 141 of 141 fires ran shell_exec. The tool runs stalled 33-45 s on the lease
  at ticks 8, 20 and 24, but each got it just inside the wait, so that run passed. Same defect, different timing.
- Same-box A/B on Windows (4 min, 5 routines): pre-fix harness gave 10 of 10 fires with shell and runs 8/1
  FAIL (workspace-busy, 45005 ms). Post-fix 2fc129f5e gave 0 of 7 fires with shell, mockShellCalls 4 for 4
  tool runs, runs 12/0 PASS.
- RSS: in both scale receipts, epoch 1 was sampled 0.76-3.02 min after its post-outage boot. Epoch 0 climbed
  the same curve at the same uptimes and peaked about 3.4 min after boot (196 / 197.5 MB), then fell 23 MB.
  That is warm-up plus a major GC, not a leak. v0.14.1 passed rss only on GC phase (2.63 MB/min, growth 0.5 %).
  Both 20-minute receipts pass with the same numbers before and after the change (1.324 / 0.693 MB/min over
  9.54-minute windows).
- Pins: `test/soak.test.js` builds the routine's turn with the real host projection, checks the mock answers
  it with one line, and checks the soak's own prompt still gets exactly one shell_exec. It replays the CI RSS
  window as NOT JUDGED and pins the 5.00 / 4.75-minute boundary.

## Verdict

Fixed in the harness only. 39d1fde80: the mock steers by `soakDirective` (the turn minus fenced host
quotation), and the receipt meta carries mockShellCalls. 2fc129f5e: the rss rule does not judge a window
spanning under 5 minutes. That window is shorter than one post-boot climb-and-drop, so its slope cannot
tell warm-up from a leak. Thresholds are unchanged, and unmeasured rules render NOT JUDGED, never PASS. The
10-minute scale shape therefore reports RSS NOT JUDGED. The leak verdict stays with the 20- and 720-minute
soaks. A full-shape scale soak on the fix was not run: local RAM stayed under 2 GB, and CI dispatch needs a
ref that contains these commits.
