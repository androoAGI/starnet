---
fingerprint: c9929ae3
slug: onboarding-sign-in-codes-have-dark-text-on-dark
title: Onboarding sign-in codes have dark text on dark backgrounds
surface: onboarding
severity: P2
status: fixed
found: 2026-09-19
lane: agent/onboarding-test-0919
fix: 51dcb517d2ed6935bca7ed924d8ca6c095a17913
origin: owner
report: Owner screenshot and local onboarding test, 2026-09-19
affected: 0.12.3 source at 5bb28bb83, Windows browser
family: onboarding-code-contrast
installer: unverified
recovery: unconfirmed
---

# Onboarding sign-in codes have dark text on dark backgrounds

## Symptom

Sign-in codes are nearly invisible against their dark code boxes.

## Repro

Open fresh onboarding, choose OpenAI, and request a ChatGPT device code. Inspect the visible code box.

## Evidence

Owner screenshot reported 2026-09-19. Browser sample-code reproduction: foreground rgb(25, 15, 2), opacity 1. Source anchor: frontend/css/overseer-setup.css:105.

## Verdict

Source contrast repair verified in the live browser across all six built-in themes. Both frontend and website stylesheet copies match. Installer and owner retest remain unverified.

## Regression

Before: production onboarding cascade paints sample codes rgb(25, 15, 2), nearly black. After: live browser with the production stylesheet order and glass-demo body paints both code boxes rgb(255, 217, 163) in amber, opacity 1, user-select all. Theme switches verified matching bright colors in green, blue, purple, red and white. Screenshot confirms legible sample alphanumeric and numeric codes; reload retains the fix. This is a rendered sample-code check, not a new OAuth round trip.

## Sibling coverage

{"adapters":[{"target":"ChatGPT, Grok, Kimi and StarNet account link","state":"blocked","reason":"All share the repaired onboarding code class; verified rendered samples. No fresh real provider authorization was performed or registered as an automated contrast gate."}],"entrypoints":[{"target":"index.html and agent-station-demo.html","state":"blocked","reason":"Both load the shared repaired stylesheet; runtime proof used the production stylesheet order in an isolated sample-code page, not both complete onboarding flows."}],"displays":[{"target":"Six built-in browser themes","state":"blocked","reason":"Live computed-color and screenshot checks passed; these manual contrast checks are not a registered fast/http scenario."},{"target":"Packaged desktop and custom themes","state":"blocked","reason":"No rebuilt installer or exhaustive arbitrary custom-theme acceptance in this source-only repair."}],"lifecycle":[{"target":"Reload and theme switch","state":"blocked","reason":"Verified in the live sample-code page; no registered automated browser contrast scenario."}]}

## Investigation

The owner reported almost invisible sign-in codes during otherwise successful onboarding. The shared `.codex-code` foundation uses `color: var(--ink)` on a bright background. `frontend/css/overseer-setup.css:105` replaces that background with dark glass without replacing the foreground.

Repro: start fresh onboarding, choose OpenAI, request a ChatGPT device sign-in code. The same box serves Grok and Kimi; the StarNet account-link box uses the same class. No real code is retained in this report.

Live browser reproduction using the production stylesheet order and code classes with sample text measured the inherited foreground as rgb(25, 15, 2) at full opacity. The repair pairs the dark glass background with `var(--ph-bright)`.

Settings sign-in codes use `.key-mask` with `var(--ph-bright)` already; Settings account-link codes use `var(--gold)`. Neither uses the defective onboarding override. Both HTML entrypoints load the repaired stylesheet. Native installer verification remains outstanding.

## Validation receipt

Customer journeys: 38/38 PASS. Release claims regression: 64 assertions PASS after updating only the changed stylesheet fingerprint and source commit. Full fast run stopped at step 317/822 on the unrelated web-search parser timing assertion (532 ms against 500 ms). Immediate unchanged focused rerun: web.search.test PASS, 18 assertions. The complete fast gate is not claimed green; no trunk merge or release performed. Logs remain in the owned .onboarding-test directory.


## Integration verification

Merged at 9ef5b7e61 on 2026-09-19. Fresh complete pre/post fast gates PASS 829/829 after sync with current trunk. This supersedes the earlier incomplete fast-run receipt. Live six-theme check repeated after sync. See qa/digests/2026-09-19-onboarding-contrast.md. Installer and owner retest remain unverified.
