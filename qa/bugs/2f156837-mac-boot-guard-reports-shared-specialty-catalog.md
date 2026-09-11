---
fingerprint: 2f156837
slug: mac-boot-guard-reports-shared-specialty-catalog
title: Mac boot guard reports shared specialty catalog load failure
surface: onboarding
severity: P1
status: open
found: 2026-09-11
lane: release-0112-finalprep-0911
fix:
origin: customer
report: support-2026-09-10-mac-shared-specialties
affected: Mac WebKit; app version and failing origin not supplied
family: boot-integrity
installer: unverified
recovery: unconfirmed
---

# Mac boot guard reports shared specialty catalog load failure

## Symptom

Opening StarNet produces a page-side boot-guard failure naming `shared/specialties.js` as the single failed script. The reported page path is `/`; the user agent identifies Mac WebKit. The report does not include the application version, full origin, requested resource URL, or native startup log.

## Repro

Customer operation: open the reported installation and observe the boot guard. Exact local reproduction is not established. Capture the affected build, full page/resource origins, native startup log and HTTP status for the failed resource before changing or resetting the station.

## Evidence

Sanitized support report dated September 10, 2026, with boot report timestamp `2026-09-10T12:24:11.768Z`: `scripts failed: shared/specialties.js`; `page errors: 1 script load failure(s): shared/specialties.js`.

Anchors: `frontend/index.html:850` builds the parser-ordered script URL from the shell-injected API origin; `test/bootguard.test.js` retains fatal handling for actual shared-module failures; `test/website-deploy-staging.test.js` checks the separate website upload tree.

September 11 installed Windows candidate `7f6c7b005`: SharedSpecialties was loaded, no boot-fatal element was present, and the script's actual loopback URL returned HTTP 200 with bytes matching the committed catalog (SHA-256 `b346c34841d2b2b75eb77dabd2e9c47049a85738a56e001d73eecd4933f41893`). Evidence is retained in the release preparation worktree `.dogfood/customer-execution/installed-catalog.json`. This does not establish Mac recovery.

## Verdict

Open pending the affected origin/build and Mac reproduction. Do not merge this symptom into eaaa3ec8 (native station data unreachable after relink) without evidence. Website-only record b3b8d28f includes a prior missing staged catalog, but a matching filename does not establish that this reporter used the website or that the same deployment was involved.

## Regression

No exact before/after customer reproduction yet. Current Windows module loading passes. A cross-origin fetch probe is not equivalent to a classic script load; neither its CORS rejection nor a successful HTTP request alone establishes page boot health.


## Sibling coverage

{"adapters":[{"target":"affected Mac WebKit script request","state":"blocked","reason":"The report omits the actual origin, build and failed resource response."}],"entrypoints":[{"target":"native app or website entry","state":"blocked","reason":"A pathname of / does not identify the full page origin; obtain the original entry point."}],"displays":[{"target":"boot-guard diagnostic","state":"covered","test":"test/bootguard.test.js","scenario":"station-owned shared script failures remain fatal","gate":"fast"}],"lifecycle":[{"target":"affected Mac restart and resource loading","state":"blocked","reason":"No affected installer, startup log or successful restart was supplied."}]}
