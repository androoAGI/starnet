---
fingerprint: 8a553481
slug: mac-desktop-microphone-blocked-while-browser-mir
title: Mac desktop microphone blocked while browser mirror works
surface: voice
severity: P1
status: open
found: 2026-09-06
lane: agent/voice-agents-mac-0906
fix: d65f8f538
origin: customer
report: Owner relayed customer report on 2026-09-06
affected: MacBook Pro M1 Max; app version and macOS version unknown
family: desktop-microphone
installer: unverified
recovery: unconfirmed
---

# Mac desktop microphone blocked while browser mirror works

## Symptom

Customer reports Speak and Hands-Free Mic work in a mirrored localhost browser session but remain blocked in the regular Mac desktop app despite repeated permission grants and resets.

## Repro

1. On the affected signed Mac desktop build, try Speak and Hands-Free Mic.
2. Compare microphone access in its mirrored localhost browser session.
3. Customer reports only the browser succeeds. Actual Mac reproduction is pending; this lane runs on Windows.

## Evidence

Owner-relayed customer report, 2026-09-06. At base 3d31e373e, src-tauri/tauri.conf.json enables hardened runtime and uses entitlements.plist; src-tauri/Info.plist declares NSMicrophoneUsageDescription, but src-tauri/entitlements.plist omits `com.apple.security.device.audio-input`. Apple documents this resource entitlement at https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input . Test anchor: test/desktop-voice-bundle.test.js.

Release verification: d65f8f538 is the exact entitlement repair. Build-only CI 34070924471 for bd65c7737 completed both Mac builds and both notarization jobs; Intel installed acceptance passed Finder launch, sidecar startup, legacy-state preservation and restart. These checks establish packaging/launch acceptance, not physical microphone capture or affected M1 Max recovery. The physical allow/deny/reset/restart test remains required.

## Verdict

Source packaging gap repaired in this lane. Report remains open until the affected signed Mac installer is tested; this source finding is consistent with the report, not proof of customer recovery.

## Regression

The desktop voice bundle regression now checks hardened runtime, the configured entitlement file and a true audio-input entitlement. The new assertion fails against the base entitlement file and passes with the repair. Release CI checks the actual signed app entitlement and generated purpose string. Physical capture on macOS remains unverified.

## Sibling coverage

{"adapters":[{"target":"signed macOS WKWebView","state":"blocked","reason":"No Mac hardware or signed candidate is available on this Windows host."},{"target":"desktop bundle configuration","state":"covered","test":"test/desktop-voice-bundle.test.js","scenario":"hardened runtime microphone purpose and entitlement","gate":"fast"}],"entrypoints":[{"target":"Speak mic denial and retry","state":"covered","test":"test/voice.button.test.js","scenario":"recorder denied then re-granted","gate":"fast"},{"target":"Hands-Free Mic physical capture","state":"blocked","reason":"Requires the affected signed macOS app and a real microphone."}],"displays":[{"target":"Mac desktop recovery copy","state":"covered","test":"test/voice.button.test.js","scenario":"desktop Mac recovery directs to system microphone settings","gate":"fast"},{"target":"browser mirror","state":"blocked","reason":"Customer reports success; this lane has not reproduced their browser hardware capture."}],"lifecycle":[{"target":"permission prompt timeout and late grant","state":"covered","test":"test/voice.button.test.js","scenario":"recorder timeout recovers the button","gate":"fast"},{"target":"signed Mac allow deny reset restart","state":"blocked","reason":"Release acceptance must test the actual signed artifact on Apple Silicon."}]}
