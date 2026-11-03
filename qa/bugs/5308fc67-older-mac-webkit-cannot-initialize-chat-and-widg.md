---
fingerprint: 5308fc67
slug: older-mac-webkit-cannot-initialize-chat-and-widg
title: Older Mac WebKit cannot initialize Chat and widget polling
surface: onboarding
severity: P1
status: fixed
found: 2026-09-18
lane: mac-boot-compat-0918
fix: 14c6a69a8
origin: customer
report: support-2026-09-18-mac-boot
affected: Installed Mac WebKit; exact app and OS versions unknown
family: boot-integrity
installer: unverified
recovery: unconfirmed
---

# Older Mac WebKit cannot initialize Chat and widget polling

## Symptom

The installed Mac app displays a fatal boot banner naming Chat, a regex parse error at chat.js:559, an unavailable AbortSignal.timeout call at widgets.js:895, and a downstream missing Chat rejection. Catalog loading is tracked separately in 2f156837.

## Repro

Open the reported installation in WebKit without regex lookbehind or AbortSignal.timeout. Chat fails during parsing; widget polling throws before fetch starts. On a current engine, test/mac-boot-compat.test.js removes the timeout API and executes production polling; test/chat-code-copy.test.js guards the parse-time syntax and renders escaped table cells. The original Mac runtime is unavailable locally.

## Evidence

Sanitized September 18 owner-supplied customer diagnostics: SyntaxError: Invalid regular expression: invalid group specifier name at app/chat.js:559; TypeError: AbortSignal.timeout is not a function at app/widgets.js:895; Can't find variable: Chat. Source at b737e9cbe has the literal lookbehind and four unguarded timeout calls. The timeout helper and table regressions are in test/mac-boot-compat.test.js and test/chat-code-copy.test.js.

## Verdict

Source-fixed in 14c6a69a8: scan table cells without lookbehind, use U.timeoutSignal for widget reads/writes and automation recovery, retaining native deadlines where available. Full fast gate 818/818 and customer journeys 36/36 pass. Live capability-fault comparison reproduces the original timeout exception and passes after repair; actual staged frontend loads Chat and catalog with no native timeout and no page errors. See qa/digests/2026-09-18-mac-boot-compat.md. No installer or affected-customer recovery claimed.

## Regression

The missing API previously threw synchronously before widget fetch; the regression executes production pollFeed/pollInsights with no native timeout, checks failure-to-retry recovery, and verifies real HTTP cancellation. Table tests preserve escaped pipes, backslashes, empty cells and inert hostile HTML while rejecting reintroduced lookbehind.


## Sibling coverage

{"adapters":[{"target":"legacy and modern timeout implementations","state":"covered","test":"test/mac-boot-compat.test.js","scenario":"missing API, native delegation and real fetch cancellation","gate":"fast"},{"target":"original Mac WebKit","state":"blocked","reason":"Affected hardware and exact WebKit version unavailable on this Windows host."}],"entrypoints":[{"target":"widget reads and automation recovery","state":"covered","test":"test/mac-boot-compat.test.js","scenario":"production widget poll failure and retry plus sibling deadline guard","gate":"fast"},{"target":"automation recovery lifecycle","state":"covered","test":"test/emergency-control.test.js","scenario":"hydrate, explicit resume, read-back and offline state","gate":"fast"}],"displays":[{"target":"Chat report tables","state":"covered","test":"test/chat-code-copy.test.js","scenario":"escaped pipes, backslashes, empty cells and hostile HTML","gate":"fast"}],"lifecycle":[{"target":"timeout cancellation and repeat polling","state":"covered","test":"test/mac-boot-compat.test.js","scenario":"real HTTP deadline and poll lock release after failure","gate":"fast"},{"target":"affected installed Mac restart","state":"blocked","reason":"Source verification does not substitute for a rebuilt signed Mac installer or customer retest."}]}

## Engine-floor and load-accounting continuation - 2026-11-03

Source a910716cd derives the Safari 15.4 compatibility floor and staging checks from scripts/lib/engine-floor.json. Sources a0da71d2a and 25c5c1e4e add per-script boot accounting and a bounded, sanitized shell boot report while preserving the fatal-banner rule. The WebKit harness and workflow at 772eaaacb exercise real pages with later APIs removed; this emulates API availability, not the bugs or CSS of an actual older Safari release.

Fresh focused tests passed for bootguard, engine-floor, webkit-floor-syntax, webkit-floor-boot, diagnostics-build and the installed-acceptance scripts. The canaries at 330c6c29b add external-floor checks through product clients, validated offline with 105 assertions; no live provider or installed Mac acceptance is claimed. Existing source-fixed status is retained, with installer unverified and recovery unconfirmed.
