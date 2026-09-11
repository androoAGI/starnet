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
installer: unverified
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

Source-fixed by dd85573b9. This is not evidence that the reporter had computer capabilities or actually invoked this driver. Image handling, keyboard syntax and focus policy are separate and unchanged. Installed artifact and customer recovery remain unverified.

## Regression

Windows regression verifies move, click, double-click, drag start/end coordinates, mouse down/up ordering and negative screen coordinates. Physical calls are stubbed to avoid affecting the running desktop; PowerShell command resolution and the production JSON/process bridge are real. Non-Windows retains existing inert-driver coverage.

Live source proof on 2026-09-11: isolated `node dev/seed.js --keep` station, separate Chrome profile, real Windows driver and `computer.use` Full Power dispatch. The test verified the button's screen point belonged to its own browser process. Original driver at BUILD coordinates (352, 779) rejected with `Cannot find path '...\\352'`, leaving `aria-expanded=false`. Repaired driver at the identical point returned `computer.click ok`, with `aria-expanded=true` and the REFIT STATION menu item visible. Native before/after screenshots confirmed the menu. Private local receipts: `.tmp/live-receipt.json`, `.tmp/live-before.png`, `.tmp/live-after.png`; full desktop screenshots are not committed. Customer journeys passed 34/34. Full fast/HTTP receipts pending.

## Sibling coverage

{
  "adapters": [{"target":"Windows native driver","state":"covered","test":"test/win32desktop.test.js","scenario":"real PowerShell routes move/click/double_click/drag to native coordinate stubs, with negative coordinate coverage","gate":"fast"},{"target":"non-Windows driver selection","state":"covered","test":"test/win32desktop.test.js","scenario":"Linux selection returns no Windows driver","gate":"fast"}],
  "entrypoints": [{"target":"computer.use permission and dispatch boundary","state":"covered","test":"test/computer.test.js","scenario":"authorized injected-driver calls dispatch; unauthorized physical input is refused","gate":"fast"},{"target":"customer installed call and capability configuration","state":"blocked","reason":"Customer tool transcript, build identity and actual grants were not supplied; no causal attribution to her session is claimed."}],
  "displays": [{"target":"installed Windows desktop","state":"blocked","reason":"No rebuilt installer or customer retest is available; source proof cannot establish installer recovery."}],
  "lifecycle": [{"target":"fresh PowerShell process per action","state":"covered","test":"test/win32desktop.test.js","scenario":"each movement action launches a fresh Windows PowerShell process retaining default aliases","gate":"fast"}]
}
