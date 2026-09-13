---
fingerprint: 32f959e0
slug: wake-mistakes-dev-configuration-for-an-openai-ap
title: Wake mistakes DEV configuration for an OpenAI API credential
surface: onboarding
severity: P1
status: fixed
found: 2026-09-13
lane: onboarding-conversation-0912
fix: 0250793ac
origin: owner
report: Owner report in onboarding task, 2026-09-13
affected: Local browser candidate 5955a288b on Windows, port 8992
family: genesis-provider-credential-selection
installer: unverified
recovery: unconfirmed
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

Source fix uses hasStoredCredential for credential selection instead of the DEV auto-resume eligibility getter. Live owner-origin recovery is verified; 139/139 customer-journey assertions passed; the full fast gate runs on the final candidate.

## Regression

Before fix: real Wake on 8992 returned HTTP 400 missing key/model with ChatGPT connected, no typed key, and gpt-5.5 selected. After fix: the real provider answered, the arrival completed, and the interview opened. test/genesis-wake-credential.test.js passes nine assertions on the actual wake handler.

## Sibling coverage

{
  "adapters": [
    {
      "target": "ChatGPT OAuth and OpenAI API",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "DEV configured=true chooses OAuth unless a real saved or typed API key exists",
      "gate": "fast"
    },
    {
      "target": "OpenRouter server-held key",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "Actual credential for the chosen DEV provider remains valid",
      "gate": "fast"
    },
    {
      "target": "desktop keychain",
      "state": "blocked",
      "reason": "Installed-desktop credential routing was not exercised in this local browser repair."
    }
  ],
  "entrypoints": [
    {
      "target": "Wake Overseer",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "onWakeAttempt selects credential before live preflight",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "Missing-credential guidance",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "Without actual credentials, setup explains sign-in before dispatch",
      "gate": "fast"
    }
  ],
  "lifecycle": [
    {
      "target": "browser reload",
      "state": "blocked",
      "reason": "Reload and successful wake were observed live on 8992, but reload persistence is not asserted by the focused automated regression."
    }
  ]
}
