# Approved StarNet world upgrade — 2026-09-09

The owner approved the exact preview at http://127.0.0.1:9207/. Visual baseline: ab146a0f93ec2915caf1cc423a0f7a585567e22e. The additional flight/inset/weave batch was canceled before any changes.

## Integration

Trunk snapshot a78441e04260cb68ce697f0e98ddb65e3666e085; synchronized candidate e456f3f7a70217b82a49f8ffb1d93c41fef296e1; merge 0656a655e5feabcfd3be5fbaee7d234e97215731. Candidate and merge have identical tree ac838c5245af29b7791c2251dd954164da32b5f7.

Retained both independent CSS conflict blocks: trunk's mutation-review/rating controls and the approved world glass/HUD treatment. Website mirror regenerated. Claims inventory retained from trunk; only its mechanical source receipt regenerated.

Trunk also carried a cleanly merging palette/exposure change that would whiten default hulls and brighten colored floors. The owner's later approval selects the preview's dark palette, original hull exposure, and corresponding hull regressions. Ten core world/model/render/art modules are byte-identical to the approved baseline. No sidecar, shared contract, or package differences were introduced over trunk.

## Verified

- Pre-merge and post-merge full fast suites: 744/744, exit 0.
- Full HTTP suite: 108/108, exit 0 in an isolated worktree with the identical candidate tree.
- All 24 floor materials; six additions (basalt, parquet, rubber, slotted, terrazzo, octile), plus refined existing decks. Props retain accepted art and scale.
- Live grade saturate(1.14) contrast(1.08) brightness(0.94); grain .26, scan .10, film .38, sharpen .28, fade 0, bloom 0, glass opacity .62. Exact equality against the approved runtime settings.
- Saved rooms, props and belts equal the approved snapshot: 6 rooms, 46 props, 50 belts. Build open/close, reduced motion, canvas-cache loss/recovery and reload passed. Routing hash retained. All 44 light sources active, none dropped; no browser errors or exceptions.
- Unrelated integration qa/STATUS.md and Rooms handoff bytes preserved through the merge. The digest commit stages only this lane's new QA entry, leaving existing uncommitted QA edits unstaged.

Preview stays running in the retained world-next-0907 worktree on 9207. No installer, release, deployment, or push performed.

Local evidence: .tmp/world-upgrade-merge-fast.log, .tmp/world-upgrade-trunk-fast.log, .tmp/world-upgrade-http-receipt.json, .uishots-world-upgrade-merge-verify/live-proof.json, and .uishots-immersion-world-upgrade-merged-candidate/live-proof.json in the retained preview worktree.

## Concurrent Guardian result

The background Guardian cycle at 22:09Z on the same merge reports RED: its HTTP run stopped at customer-journey step 2 because the synthetic openrouter/journey model was classified as not tool-capable; visual golden comparison flagged 12 frames for review. Its fast, saboteur, shoot, behavioral audit and journeys gates passed. The independent complete HTTP run above passed 108/108 on identical source. These Guardian findings remain open; this receipt is lane verification, not a release-readiness verdict. The concurrently refreshed Guardian row and all other foreign QA edits remain unstaged. Evidence: .bugloops/guardian-20260909-220002 in integration.
