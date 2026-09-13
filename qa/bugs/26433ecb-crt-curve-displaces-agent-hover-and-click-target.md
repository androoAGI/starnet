---
fingerprint: 26433ecb
slug: crt-curve-displaces-agent-hover-and-click-target
title: CRT curve displaces agent hover and click targets away from center
surface: world
severity: P2
status: fixed
found: 2026-09-12
lane: agent/curve-pointer-0912
fix: f8b60bef0
origin: owner
report: Owner report in Codex 2026-09-12
affected: Source 1a6a93346; reported installed build unknown
family: world-pointer
installer: unverified
recovery: unconfirmed
---

# CRT curve displaces agent hover and click targets away from center

## Symptom

The agent responds at screen center but hovering or clicking its visible body near the edges misses.

## Repro

Boot node dev/seed.js --keep, set CRT curve .09 / overscan 1.2, zoom out to roughly 1.15, and pan the same agent from center to left/right and opposite corners. Move and click at the curved visible position.

## Evidence

Source anchor: test/world-agent-click.test.js. Live seeded Chromium at port 8962: before repair center returned pointer/agent, left/right/upper-right/lower-left returned default/null. Image displacement was 38-41 backing pixels. After repair all five returned pointer/agent. Local raw receipts: .proof/before.json and .proof/after.json.

## Verdict

Source fixed in f8b60bef0. Live before/after evidence: qa/curve-pointer-0912.md. Installer and owner recovery remain unverified.

## Regression

Live center passed while four edge positions missed before repair; all five passed afterward. Registered test/world-agent-click.test.js passes 40 assertions. Visible in-app browser click opened the correct dossier at the right side of the canvas. See qa/curve-pointer-0912.md.



## Sibling coverage

{"adapters":[{"target":"WebGL rendered pointer mapping","state":"covered","test":"test/world-agent-click.test.js","scenario":"independent forward projection for classic and phosphor CRT presets","gate":"fast"},{"target":"CPU renderer fallback live","state":"blocked","reason":"The live browser used the normal renderer; CPU fallback was not forced in this lane."}],"entrypoints":[{"target":"agent hover and click, hero and specialist ID routing","state":"covered","test":"test/world-agent-click.test.js","scenario":"world conversion and stable roster ID resolver","gate":"fast"},{"target":"wheel zoom","state":"covered","test":"test/world-agent-click.test.js","scenario":"wheel handler uses corrected scene conversion","gate":"fast"},{"target":"all clickable prop types","state":"blocked","reason":"All share toWorld but individual prop actions were not exercised live in this lane."}],"displays":[{"target":"CSS-scaled canvas and CRT modes","state":"covered","test":"test/world-agent-click.test.js","scenario":"CSS/backing dimensions, both presets, disabled curve and no-scan","gate":"fast"},{"target":"installed desktop and physical high-DPI hardware","state":"blocked","reason":"Preview-only change; installer was not rebuilt or tested."}],"lifecycle":[{"target":"CRT disabled and restored","state":"covered","test":"test/world-agent-click.test.js","scenario":"curve and no-scan bypass followed by enabled corner rejection","gate":"fast"}]}


