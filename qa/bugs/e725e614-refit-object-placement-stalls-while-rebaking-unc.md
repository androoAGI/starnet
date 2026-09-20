---
fingerprint: e725e614
slug: refit-object-placement-stalls-while-rebaking-unc
title: Refit object placement stalls while rebaking unchanged environment
surface: world
severity: P2
status: fixed
found: 2026-09-20
lane: refit-smooth-0919
fix: 0afbde0cf
origin: owner
report: Owner report in Codex task on 2026-09-19
affected: Reported build unknown; reproduced on source 713951f89 (0.12.3), Windows
family: refit-placement-performance
installer: unverified
recovery: unconfirmed
---

# Refit object placement stalls while rebaking unchanged environment

## Symptom

Owner reports lag in REFIT, especially while placing objects.

## Repro

1. Boot an isolated seeded station using `node dev/seed.js --keep --workspace <private-directory>`.
2. Enter REFIT and place five plants on empty deck tiles.
3. Measure the click through two animation frames and calls to `StationBake.bakeIncremental`.
4. Run `scripts/qa/refit-placement.mjs` for pointer, mixed-edit and lifecycle checks.

## Evidence

Baseline 713951f89: five placements took 397, 463, 454, 473 and 459 ms through two animation frames in isolated software-rendered Chromium. Each placement rebuilt a static chunk, taking 294–342 ms. The mutation itself took 0.4–3.3 ms. Raw comparison receipts are `.refit-proof/before.json` and `.refit-proof/after.json` in the owned refit-smooth-0919 worktree. Anchor: `test/refit-bake-reuse.test.js`.

## Verdict

Source fix `0afbde0cf` passed the live small and 100-prop station campaigns. Ordinary prop placement, movement, rotation, mirroring and deletion now advertise that static environment pixels are unchanged. REFIT retains those pixels but refreshes geometry and routing. Airlocks, floor edits, undo/redo, unknown patches and global changes retain conservative invalidation. Installed WebView performance and owner recovery remain unverified.

## Regression

Before: every ordinary placement rebaked an unchanged environment. After: the same five placements took 80, 77, 74, 75 and 88 ms, with zero placement rebakes. A later undo did rebake. `test/refit-bake-reuse.test.js` executes production event and rebake paths, checking cache reuse, geometry/routing refresh, both orders of mixed edits, pan invalidation, airlocks and history. Timing is a diagnostic measurement on this host, not a universal latency guarantee.

The live `scripts/qa/refit-placement.mjs` campaign additionally passed real pointer preview/click agreement, move/rotate/mirror, functional equipment, collision, serialization, undo/redo, same-frame floor plus prop edits, airlocks and reopening on both small and populated stations. Receipts: `.refit-proof/live/receipt.json` and `.refit-proof/populated/receipt.json`; the latter finishes with 100 props. Actual pointer timing includes UI feedback and concurrent gate load; see `qa/digests/2026-09-19-refit-placement.md` for the separate measurements.

## Sibling coverage

{"adapters":[{"target":"shared model mutation notifications","state":"covered","test":"test/refit-bake-reuse.test.js","scenario":"ordinary prop mutations opt in; airlocks remain conservative","gate":"fast"},{"target":"installed WebView2","state":"blocked","reason":"No rebuilt installer was requested or tested."}],"entrypoints":[{"target":"place move rotate mirror delete","state":"covered","test":"test/refit-bake-reuse.test.js","scenario":"real model operations carry correct static bake invalidation","gate":"fast"}],"displays":[{"target":"REFIT environment cache","state":"covered","test":"test/refit-bake-reuse.test.js","scenario":"prop-only pixels survive while geometry and routing refresh; mixed edits repaint","gate":"fast"},{"target":"live world and native desktop performance","state":"blocked","reason":"The world renderer is unchanged; timing claims are limited to isolated seeded Chromium REFIT."}],"lifecycle":[{"target":"undo redo entry cold fallback","state":"covered","test":"test/refit-bake-reuse.test.js","scenario":"history retains invalidation; entry handoff and missing cache fallback remain intact","gate":"fast"}]}
