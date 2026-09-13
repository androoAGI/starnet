---
fingerprint: 305a9e3d
slug: campaign-cards-missing-from-browser-element-disc
title: Campaign cards missing from browser element discovery
surface: skills
severity: P1
status: open
found: 2026-09-12
lane: agent/browser-campaign-navigation-0912
fix:
origin: customer
report: Owner relayed Whop campaign navigation report on 2026-09-12
affected: Customer build, model and operating system unknown; reproduced card patterns on source 1a6a93346
family: browser-card-discovery
installer: unverified
recovery: unconfirmed
---

# Campaign cards missing from browser element discovery

## Symptom

Customer reports the internal browser spends about 15 minutes on one Whop campaign listing without opening a visible campaign card. The agent says its element finder does not expose the card and proposes a browser-only coordinate click. Customer version, model, URL, DOM and tool transcript were not supplied.

## Repro

1. Run `node test/browser.gauntlet.e2e.test.js` with Chromium installed.
2. The owned `/campaign-cards` fixture renders four working targets: a DOM onclick property, a delegated cursor-pointer card, an ARIA link, and an open-shadow-root button.
3. With the pre-fix browser.js from 1a6a93346, snapshot omits all four targets. With the discovery change, snapshot and session.find supply refs and real CDP clicks reveal the corresponding details.
4. The customer's authenticated Whop page remains a separate reproduction gap; the fixture proves a matching failure class, not its exact cause.

## Evidence

`test/browser.gauntlet.e2e.test.js` against the unchanged driver: `browser.gauntlet.e2e: 5 problem(s), 93 ok`; four missing-target assertions and the delegated-card count fail. First patched run: `browser.gauntlet.e2e: OK (102 assertions)`, including real clicks and detail text read-back. Final HTTP-gate run: `browser.gauntlet.e2e: OK (105 assertions)`, additionally covering session.find/ref click and the snapshot limit.

Source anchor: `sidecar/tools/builtin/browser.js` snapshotExpr used `a,button,input,textarea,select,[role="button"],[onclick],summary,label`, excluding JavaScript property handlers, non-button ARIA targets and shadow roots. The public browser.click tool requires a ref; browser.test_input requires an owned local test page.

Seeded-app verification on 2026-09-12: `node .dogfood/browser-cards-live.cjs` launched `node dev/seed.js --keep` with an isolated profile and a deterministic local provider. The real `/api/run` discovered the local-test tool, created and launched an owned fixture server, navigated, found the delegated card, clicked its ref, read the revealed details, wrote `campaign-note.md`, read that file back, and stopped the owned server. Receipt: `LIVE PASS: seeded StarNet /api/run -> owned server -> browser.find -> browser.click -> detail read -> saved note read-back; 13 provider turns.` Raw local receipts remain in `.dogfood/browser-cards-live-receipt.json` and `.dogfood/browser-cards-live-stream.log`. This verifies real tool execution and note delivery, not an unconstrained model's browsing decisions or Whop authentication.

Discovery-cost check: `.dogfood/browser-discovery-cost.json` records a real Chromium fixture with 10,000 noninteractive elements plus the visible card. All three snapshots found the card; measured snapshot durations were 20, 20 and 15 ms. This is a bounded local observation, not a performance guarantee for Whop or arbitrary websites.

## Verdict

Open pending exact customer correlation. Source improvement `dcbc2b941` fixes the reproduced discovery gap. Final validation: `npm run test:fast` passed all 771 steps; `npm run test:http` passed all 113 steps, including the 105-assertion browser gauntlet. Syntax checks, diff whitespace checks and bug-register validation passed. An earlier fast invocation hit the unrelated MCP restart/token-rediscovery test; it passed in isolation and in the subsequent complete 771-step run. No MCP code was changed. Neither a rebuilt installer nor customer recovery is claimed; this lane was not merged or released.

## Regression

Before/after real Chromium coverage is in test/browser.gauntlet.e2e.test.js, registered in test/http.list. Browser tool/ref contracts remain in test/browser.test.js and test/browser.wait-recovery.test.js. Failed searches now describe unsupported semantics and bounded recovery without suggesting public-page use of browser.test_input.


## Sibling coverage

{"adapters":[{"target":"Chromium card discovery and click","state":"covered","test":"test/browser.gauntlet.e2e.test.js","scenario":"property, delegated cursor, ARIA link and open shadow card details","gate":"http"},{"target":"authenticated Whop DOM and customer model","state":"blocked","reason":"Exact customer URL, session transcript, model and authenticated page were not supplied."}],"entrypoints":[{"target":"snapshot and find to ref click","state":"covered","test":"test/browser.gauntlet.e2e.test.js","scenario":"modern card discovery through driver and browser session","gate":"http"}],"displays":[{"target":"Windows headless Chromium","state":"covered","test":"test/browser.gauntlet.e2e.test.js","scenario":"visible card geometry and actual detail text read-back","gate":"http"},{"target":"installed desktop on customer platform","state":"blocked","reason":"Customer OS and installer are unknown; no rebuilt installer acceptance performed."}],"lifecycle":[{"target":"navigation, iframes and tab changes","state":"covered","test":"test/browser.gauntlet.e2e.test.js","scenario":"real Chromium navigation, frame offsets and popup selection","gate":"http"},{"target":"stale ref recovery","state":"covered","test":"test/browser.wait-recovery.test.js","scenario":"same-page stale recovery and refusal after navigation","gate":"fast"}]}
