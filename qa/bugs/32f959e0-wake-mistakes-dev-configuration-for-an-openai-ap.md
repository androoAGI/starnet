---
fingerprint: 32f959e0
slug: wake-mistakes-dev-configuration-for-an-openai-ap
title: Wake mistakes DEV configuration for an OpenAI API credential
surface: onboarding
severity: P1
status: open
found: 2026-09-13
lane: onboarding-conversation-0912
fix:
origin: owner-report
---

# Wake mistakes DEV configuration for an OpenAI API credential

## Symptom

On localhost:8992, Wake reports HTTP 400 missing key/model despite the OpenAI card showing a connected ChatGPT account. Affected candidate: 5955a288b.

## Repro

1. Start a DEV-mode first-run station with ChatGPT OAuth connected and no OpenAI API key.
2. Select the OpenAI card and a ChatGPT model, leaving API KEY blank.
3. Press Wake Overseer. Before the fix, configured(openai) returns true solely because DEV mode is enabled, choosing the API-key route instead of codex.

## Evidence

Live reproduction on 8992: connect-msg contained "sidecar HTTP 400 — missing key/model", in-model was gpt-5.5, and keyEntered was false.

After the source fix and reload, the real ChatGPT-connected provider answered; the app reached Get acquainted / Choose your pace. NOVA authored: "Commander, you switched me on. what needs doing?"

Regression: `test/genesis-wake-credential.test.js` executes the actual onWakeAttempt function. Nine assertions cover DEV mode plus OAuth, a saved API key, an explicitly typed key, missing credentials stopping before dispatch, and the actual DEV provider holding its own key. All pass.

Sibling entry points: the generic API-key wake branch now uses the same actual-credential getter; existing device-OAuth branches are unchanged. Desktop keychain and browser/server-held credentials are resolved by Harness.hasStoredCredential. Installed-desktop behavior remains unverified.

## Verdict

Source fix uses hasStoredCredential for credential selection instead of the DEV auto-resume eligibility getter. Live owner-origin recovery is verified; repository gate receipt will follow.
