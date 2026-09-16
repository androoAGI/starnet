# Renderer lag investigation — 2026-09-16

Status: targeted mitigation verified; NOT a smoothness or release-readiness sign-off.

The disappearing remaster layers and their recovery watchdog are shared renderer
code, not a demo-only implementation. The original screenshot trigger was not
captured. Production can encounter the same class of graphics backing-store loss.
No installed-executable performance claim is made here.

## Findings and change

The local health endpoint returned 0–5 ms after its initial request; frame profiling
instead exposed synchronous graphics readbacks in recovery checks. The preview
was using WebGL CRT, not the CPU fallback. The first 10-second baseline recorded
212 frames, median interval 41.6 ms and p95 frame CPU time 101.9 ms.

Probe pixels are now assembled into one tiny GPU strip, exported asynchronously,
and read on the dedicated CPU sentinel. Completed results are consumed on the next
frame. Epochs reject stale pre-rebake results, bitmaps are closed, and a one-second
encoder timeout retains synchronous loss recovery. A late successful encoder
restores async operation. Fresh staging strips avoid repeated readback of the same
GPU canvas (which can migrate that canvas to software backing). No render canvas
is passed to getImageData.

The opt-in localhost worldPerf=1 controls measure the real world frame loop and
exercise three consecutive LOD losses without changing station contents or saves.
Normal preview URLs have no profiling panel or section sampling enabled.

A larger crew lighting cache experiment did not demonstrate a useful improvement
and was reverted. An initial reused staging-strip experiment regressed after
repeated loss checks; that version is not the final implementation.

## Live evidence and limits

Measurements used the actual :18797 projection/study station (159 props), not a
synthetic empty scene. Hardware load varied: free physical RAM was about 0.4 GB
of 15.8 GB initially and 1.2 GB later. One obsolete agent-created duplicate game
preview was closed. Other user apps and previews were left alone.

Fresh-strip 10-second run at 588x572 / scale 0.45: 447 frames, frame CPU median
9.3 ms / p95 14.3 ms, interval median 20.8 ms / p95 37.5 ms, recovery section p95
0.1 ms. This is about 45 FPS average, NOT a proven steady 60 FPS. CPU frame timings
exclude GPU/compositor completion. Baseline camera/viewport and host load differed;
these are diagnostic observations, not a controlled universal speedup claim.

## Checks

Real-canvas projection/depth/recovery regressions pass, including batched reads,
async bitmap release, stale-result rejection, stalled encoder fallback and async
resumption after a late callback. Existing canvas-loss recovery: 44 assertions;
stage context loss: 35 assertions. JS syntax and diff whitespace checks pass.

The full fast gate failed at step 288/804 in qa-product-perfect-claims.test.js
(9 failures / 55 passed, including planning authority BLOCKED). Log:
dev/.scratch-workspace/lag-fix-fast.log. It is not a passing gate and no merge or
release-readiness claim is made. A multi-hour soak and installed app comparison
remain unverified.

Final follow-up after repeated faults: 362 frames / 10 seconds, frame CPU median
11.7 ms / p95 18.9 ms, interval median 25 ms / p95 45.8 ms. Recovery section p95
remained 0.1 ms, but the receipt ended in sync-backstop mode: asynchronous encoder
availability remains variable under load, and tail stalls below the p95 threshold
are not ruled out. Do not describe this as a complete lag fix. The three final
forced LOD losses recovered in 678 / 1184 / 1306 ms. Live receipts are stored in
renderer-lag-live.json, renderer-lag-sustained-live.json and
renderer-lag-recovery-live.json. About 36–45 FPS across these final samples remains
below the requested steady 60 FPS target. No texture, lighting or grain quality was
reduced by this patch.
