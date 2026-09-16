---
fingerprint: bf3be27e
slug: refit-entry-freezes-the-installed-remastered-sta
title: Refit entry freezes the installed remastered station for roughly ten seconds
surface: world
severity: P1
status: fixed
found: 2026-09-16
lane: release-0120-prep-0915
fix: 15ac83ceb
origin: owner
---

# Refit entry freezes the installed remastered station for roughly ten seconds

## Symptom

Owner reports entering REFIT in the installed 0.12.0 candidate freezes the interface for roughly ten seconds. The concurrent task-board openings came from the release test runner driving panels in the owner station, not a demonstrated shipping application behavior; that runner has stopped.

## Repro

1. Install candidate 47ee14e8892b0f7ba79c7c38058b8b615a2cd830.
2. Open the existing populated station (33 room/corridor footprints, 141 props).
3. Click REFIT STATION and measure click-to-first-painted editor plus main-thread blocking.
4. Compare a fresh one-room station to ensure the reproduction covers saved-station scale.

## Evidence

Owner report on 2026-09-16. The exact installed candidate failed scripts/qa/installed-graphics.mjs: longest recorded main-thread task 12,016 ms; frame gap 12,110.6 ms. Raw receipt: .dogfood/release-recovery/graphics-final/receipt.json (owned preparation worktree). The existing runner never entered REFIT. Reproduction anchor: frontend/app/build.js `open()` and `rebake()`. Isolated CPU profiles live in .dogfood/release-recovery/refit-profile/.

## Verdict

Source fix `15ac83ceb` verified in an isolated live browser against the copied saved station: first entry 639 ms, reopening 151 ms, zero entry rebakes, no saved-layout changes. A real floor edit invalidated the borrowed image and undo restored the original layout. Software-rendered cold chunk baking fell from 73.5 seconds to 5.3 seconds; this is a diagnostic comparison, not an installed-device performance promise.

REFIT had discarded an already-rendered world image and synchronously rebuilt every visible chunk. Each chunk also rendered dense hull layers with no owned pixels and sampled offscreen wall patches. The fix borrows only the exact current station's clean world bake, bounds hull material layers to their ownership, and skips wholly offscreen wall patches. Lighting pixels and alpha/geometry were unchanged in three real-canvas chunk comparisons; RGB differences were at most 2/255.

The installed candidate remains blocked by the separate open P1 finding until the rebuilt installer passes populated-station Refit verification. No fixed-installer or release-readiness claim is made by this source disposition. The installed graphics observer is now passive and cannot open Task Board or any other panel.
