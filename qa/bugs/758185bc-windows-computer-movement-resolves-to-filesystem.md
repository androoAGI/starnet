---
fingerprint: 758185bc
slug: windows-computer-movement-resolves-to-filesystem
title: Windows computer movement resolves to filesystem Move-Item
surface: autonomy
severity: P1
status: fixed
found: 2026-09-11
lane: computer-move-proof-0911
fix: dd85573b9
origin: customer
report: Customer report relayed by owner on 2026-09-11; actual customer tool transcript unavailable
affected: Customer build unknown; reproduced on Windows source bb9f0719d
family: computer-movement
installer: verified
installerVersion: 0.11.2
installerSha256: 8b39dab2818acac23097056c8796d1f48668b9a711f09c134f7d56b51e58f416
installerEvidence: Signed candidate 69baf91a5 installed over the personal 0.11.2; exact bundled driver physically moved, clicked, double-clicked and dragged inside an owned Windows test window with 10 native checks passing. Installed WebView smoke 9/9 and 534 preservation checks after installation and restart pass. See docs/releases/0.11.2/POINTER_CUT.md.
recovery: unconfirmed
---

# Windows computer movement resolves to filesystem Move-Item

## Symptom

A reported desktop click at (306, 994) fails with a path-not-found error ending in `306` instead of moving the pointer. The customer's actual tool execution and capability configuration are unverified; this record tracks the independently reproduced driver defect.

## Repro

On Windows run `node test/win32desktop.test.js` with the regression test and the pre-fix driver. The test invokes the production PowerShell program through the real child-process bridge, replacing only native OS calls with tracing stubs. `perform({action:'move',x:306,y:994})` fails before reaching the cursor stub. The same helper is called by click, double_click and drag.

## Evidence

Before the rename, the new regression exits 1 with `Cannot find path '...\\starnet-mouse-dispatch-...\\306' because it does not exist.` PowerShell's default `move` alias resolves to `Move-Item` ahead of the driver's `function Move`. After the helper and its call sites are renamed to `Set-StarNetCursorPosition`, the same real-PowerShell regression passes: `win32desktop.test: OK (19 assertions)`. Existing computer and desktop suites pass 46 and 38 assertions respectively.

## Verdict

Source-fixed by dd85573b9 and installer-verified on signed 0.11.2 candidate 69baf91a5. This is not evidence that the reporter had computer capabilities or actually invoked this driver. Image handling, keyboard syntax and focus policy are separate and unchanged. Customer recovery remains unconfirmed.

## Regression

Windows regression verifies move, click, double-click, drag start/end coordinates, mouse down/up ordering and negative screen coordinates. Physical calls are stubbed to avoid affecting the running desktop; PowerShell command resolution and the production JSON/process bridge are real. Non-Windows retains existing inert-driver coverage.

Live source proof on 2026-09-11: isolated `node dev/seed.js --keep` station, separate Chrome profile, real Windows driver and `computer.use` Full Power dispatch. The test verified the button's screen point belonged to its own browser process. Original driver at BUILD coordinates (352, 779) rejected with `Cannot find path '...\\352'`, leaving `aria-expanded=false`. Repaired driver at the identical point returned `computer.click ok`, with `aria-expanded=true` and the REFIT STATION menu item visible. Native before/after screenshots confirmed the menu. Private local receipts: `.tmp/live-receipt.json`, `.tmp/live-before.png`, `.tmp/live-after.png`; full desktop screenshots are not committed. Customer journeys passed 34/34. Full fast gate passed 771/771; HTTP gate passed 113/113, both exit 0.

## Sibling coverage

{
  "adapters": [{"target":"Windows native driver","state":"covered","test":"test/win32desktop.test.js","scenario":"real PowerShell routes move/click/double_click/drag to native coordinate stubs, with negative coordinate coverage","gate":"fast"},{"target":"non-Windows driver selection","state":"covered","test":"test/win32desktop.test.js","scenario":"Linux selection returns no Windows driver","gate":"fast"}],
  "entrypoints": [{"target":"computer.use permission and dispatch boundary","state":"covered","test":"test/computer.test.js","scenario":"authorized injected-driver calls dispatch; unauthorized physical input is refused","gate":"fast"},{"target":"customer installed call and capability configuration","state":"blocked","reason":"Customer tool transcript, build identity and actual grants were not supplied; no causal attribution to her session is claimed."}],
  "displays": [{"target":"customer Windows desktop configuration","state":"blocked","reason":"The exact installed driver passed native pointer/event checks on the owner's Windows desktop; the affected customer's build, grants and successful retest remain unavailable."}],
  "lifecycle": [{"target":"fresh PowerShell process per action","state":"covered","test":"test/win32desktop.test.js","scenario":"each movement action launches a fresh Windows PowerShell process retaining default aliases","gate":"fast"}]
}
