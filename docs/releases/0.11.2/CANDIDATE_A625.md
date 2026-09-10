# 0.11.2 candidate addendum — September 10, 2026

**Release acceptance remains incomplete.** The audit now freezes candidate `a625182bde05e041c4f4d1fd43112b51770044af`, including the approved six-backdrop merge. This addendum supersedes the candidate scope in [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md); that document and its earlier receipts remain historical evidence with their original source identities. Official pins remain 0.11.1. No public release or tag has been created.

The new delta from `32e1831d91e3f20a272048cd6c2a517bfd8a06a0` changes the procedural sky and terrain renderers, their website mirrors, and QA records. It includes THE NURSERY, NIGHT CITY, OCEAN, THE BELT, THE MOON and FOREST. It adds no provider, storage, permission or shared-contract changes. Both renderer mirrors match their frontend files byte for byte. The original inventory's 54 merges through `00de68e0f` is a historical count; six subsequent reachable merges bring this candidate to 60 since v0.11.1, including synchronization merges. The supplemental inventory records their identities separately.

The exact clean Windows canary passed installed smoke, selection and cache-loss recovery for all six scenes, then retained FOREST after a full reload. The six actual installed screenshots were inspected: the selected environments and station rendered after recovery, with no blank scene or missing terrain. Fresh visual regression passed 16/16 with maximum difference 0.24%; neither the 1.5% threshold nor the baselines changed for this delta. The fresh beginner flow passed six UI steps in 95.011 seconds and stops at the real-model boundary.

The exact candidate's full seven-part Guardian passed with no skipped gates at 23:43:05 UTC: fast 770/770, HTTP 111/111, adversarial API sweep, screenshot sweep, visual golden check, behavioral audit and journeys 139/139. Integration's post-merge fast run also passed 770/770. Actual source-bound Guardian, journey, beginner and installed-smoke receipts were copied into integration without relabeling their identities. Canonical readiness reports one reason: the seven open customer P1s. The candidate was pushed to trunk after these gates; other agents' uncommitted queue, status and handoff work was preserved.

The exact candidate's non-publishing [desktop CI run 34542000961](https://github.com/androoAGI/starnet/actions/runs/34542000961) passed all four platform builds, both Mac notarizations and Intel Mac installed acceptance. Its official-version artifacts remain 0.11.1; the isolated local canary uses the 0.11.2 overlay. Intel synthetic migration acceptance does not establish physical Apple Silicon onboarding or microphone behavior.

The exact installed canary completed twenty minutes of idle with 80 visible, nonblank samples and zero added usage. Deliberate canvas-cache loss, WebGL loss and stage failure all retained a working viewport; the GPU-loss case used the CPU fallback. A subsequent reload restored normal WebGL rendering. The initial tour's brief 15 fps forest observation did not reproduce as a forest-specific slowdown: fresh ten-second forest/default/forest samples each had a 25.1 ms 95th-percentile frame interval, while forest's own draw time was 0.8 ms at that percentile. Both fallback and normal samples are retained; these measurements are bounded to this Windows system and workload.

The original affected conversation still reopened, persisted and reloaded as exactly four canonical rows. Final install comparison passed all nine persistence checks: crew, props, configured-key status, trusted project root, last successful run, run IDs, history, project file and the completed one-time routine with count 1. No canonical transcript data was rewritten to manufacture this result.

Portable receipts, six inspected screenshots, supplemental merge inventory and content hashes are in [candidate-a625 evidence](../../../qa/evidence/0.11.2-merge-audit/candidate-a625/manifest.json). This addendum and its evidence are prepared on a separate documentation branch so they do not move the tested candidate's source identity. A passing short recovery check does not close the affected customer's idle-black-viewport report.

## Source soak boundary

The 720-minute source soak remains pinned to `afd1da77fb4a489151b45b5a6c53e60ada4ca1f4`, starting September 10 around 22:14 UTC and expected to finish September 11 around 10:14 UTC. Its backend, native, shared, script and package objects match this candidate; the frontend and website renderer objects differ. The receipt retains the original source SHA and cannot establish long-duration acceptance of the new graphics. The frozen soak and its dependency junction must remain intact until completion.

## Acceptance still needed

- Inspect the completed 720-minute source soak and finish the separate installed/attended acceptance, including the required long-duration run. No earlier release waiver is inherited.
- Reproduce and retest the seven open customer P1s on the affected station/account: idle usage, one-time routine delivery, Mac onboarding/relink, funded balance display, the managed Sonnet 5 error, idle black viewport, and equipment/project/last-run persistence. Provide station/account identity and a recent relevant run/job ID or timestamp; never credentials.
- Obtain physical Apple Silicon onboarding/relink, account state and microphone/audio interruption/noise proof. Platform CI and Intel synthetic migration acceptance cover different conditions.
- Finish managed-account image charge/cancellation and historical public 0.11.1 client-to-public-feed update continuity. The successful BYOK image task, cancellation observation and local canary overlay update retain their narrower scope.
- Earn canonical readiness for the eventual release freeze before changing the five official version pins, running post-bump gates or creating a release tag.

The code repairs and earlier real text/file/image/ONCE evidence are detailed in [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md). Missing account and hardware details were requested during the audit and had not been supplied when this addendum was prepared.
