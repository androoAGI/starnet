# Backdrop performance repair — September 11, 2026 UTC

The owner's lag report exposed gaps in the earlier small-viewport idle check. Large sky artwork was generated synchronously, and the ground renderer repainted every overlapping tree on each frame. Source repair: `2c041bbe69124eda1f60a6eb5a11cc44676028cb`; follow-up `0152b2f16` updates the exact release-surface ledger only.

Sky artwork now builds in a worker. Ground scenery uses a full-resolution, overscanned world-space plate that moves with the camera and rebuilds for zoom, viewport and station-footprint changes. Each renderer permits one active worker request and one latest queued request; cancellation and stale replies dispose transferred bitmaps. Scene artwork, parallax and animation remain in the existing renderers. The compatibility path retains direct sky generation and cached ground drawing when workers are unavailable.

| Measurement | Before | After |
| --- | --- | --- |
| 4K Night City initial UI-thread draw | 3,798 ms | 0.1 ms |
| 4K Ocean initial UI-thread draw | 6,364 ms | 0.4 ms |
| Forest draw p95, 1080p renderer stress at scale 0.3 | 61.1 ms | 0.2 ms |
| Forest draw p95, 4K renderer stress at scale 0.3 | 257.8 ms | 0.2 ms |

These measure renderer submission, not whole-app FPS. First-time 4K artwork still took roughly 3.7 seconds for City and 6 seconds for Ocean in the worker; the UI stayed responsive while it completed. The scale-0.3 stress is below the main UI's minimum. At the actual minimum 0.5, an independent instance of the original terrain module in the same Windows WebView measured 97.9 ms p95 per 4K Forest draw. The repaired installed app's real minimum-zoom drag measured 0.1 ms p95 for terrain submission and 8.3 ms p95 for whole-app frames, with a 62.5 ms maximum frame interval. It recorded no long tasks, blank viewport or render errors during that sample. Hardware/workload variation and isolated long frames remain possible.

Verification completed:

- Full fast gate **771/771**, customer journeys **34/34**, visual regression **16/16** with unchanged baselines and 1.5 threshold.
- Source and installed Cinema flows: all six scenes, actual Appearance selection, mouse dragging and wheel zoom; installed coverage includes a 3840×2160 emulated viewport and the minimum zoom level.
- All six source and installed scenes recovered after deliberate canvas/cache loss. Worker failure, cancellation, late replies, bitmap disposal, cached pans and clearing changes have registered regressions.
- Exact clean Windows canary source `2c041bbe6`, v0.11.2 overlay, passed installed smoke. Its nine state-persistence checks passed, including crew, equipment, project root, configured-key status, canonical history and the completed one-time routine.

[Portable evidence and hashes](../../../qa/evidence/backdrop-performance-0911/manifest.json) retain the measurements separately. The first full gate hit the live test-browser profile's locked file; that owned profile was moved out of evidence. A second gate caught the release-surface ledger still bound to the previous commit; it was refreshed after the source commit and the full gate passed. The first installed smoke expected the later QA-only commit, while compilation had captured the clean source-repair commit; the failed attempt is retained and the passing receipt identifies the actual binary. No check was waived.

The fix is source- and Windows-canary-verified. The owner's recovery is still unconfirmed, and no physical Apple Silicon proof is claimed. Official version pins remain 0.11.1; no release was published. Earlier release-audit receipts retain their original source identities, and the old frozen source soak remains separate from this graphics repair.
