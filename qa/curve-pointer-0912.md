# CRT pointer repair — 2026-09-12

Source repair: f8b60bef0, isolated branch agent/curve-pointer-0912.

The display applies CRT curvature and overscan after the camera transform. Input previously undid only the camera transform. The shared pointer conversion now uses the renderer's inverse radial mapping before camera conversion. The same conversion serves agent/prop hover and click; wheel zoom anchors to the corrected scene point. Screen-space drag thresholds are unchanged. Disabled curvature and no-scan bypass the correction; black pixels outside the source image have no world target. Website mirror updated.

## Live before/after

Disposable seeded sidecar: http://127.0.0.1:8962, launched with node dev/seed.js --keep. No installed application files or personal station data changed.

Chromium received mouse events through the real stage handlers, with the agent frozen for repeatability. The test independently projected the body through the forward render formula using curve .09 / overscan 1.2 and zoom approximately 1.15. The click callback recorded the selected agent ID.

| Body position | Visual displacement | Before hover/click | After hover/click |
| --- | --- | --- | --- |
| Center | 0 pixels | pointer / agent | pointer / agent |
| Left | 41 pixels | default / null | pointer / agent |
| Right | 41 pixels | default / null | pointer / agent |
| Upper right | 38 pixels | default / null | pointer / agent |
| Lower left | 38 pixels | default / null | pointer / agent |

Raw local traces: .proof/before.json and .proof/after.json.

A separate visible in-app browser used normal running simulation and the default phosphor preset (.04 curve / 1.08 overscan). A real pointer drag moved the station toward the right edge. Clicking NOVA's visible body at that off-center location opened AGENT DOSSIER with NOVA selected. The dossier was closed and the preview left open for owner testing.

## Regression coverage

Registered fast suite test/world-agent-click.test.js: 40 assertions pass. Covers independent forward-projection points at center, edges and corners, both CRT presets, curve disabled, no-scan, CSS/backing-store scaling, nonzero pan and zoom, black corner rejection, wheel conversion wiring, hero/specialist ID routing, and exact website mirror equality.

Full fast gate: npm run test:fast PASS — 771 step(s) green. Local log: .proof/fast-final.log. The first run stopped at the expected world.js release-surface hash mismatch; cabf79daf refreshed only that file hash/length and its source commit, with claim verdicts unchanged. The focused claims gate then passed 64 assertions and the complete rerun passed.

Not verified: rebuilt installed desktop, owner recovery, every clickable prop type, CPU fallback live, physical high-DPI hardware. These are separate from the demonstrated source repair.
