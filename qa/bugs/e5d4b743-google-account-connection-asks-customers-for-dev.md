---
fingerprint: e5d4b743
slug: google-account-connection-asks-customers-for-dev
title: Google account connection asks customers for developer credentials
surface: onboarding
severity: P1
status: open
found: 2026-09-06
lane: agent/google-account-signin
fix: cb8385c56
origin: owner
report: Owner report in local task on 2026-09-06; Google catalog screenshot and request for account-only sign-in
affected: Local demo 0.10.13; public installer unverified
family: google-sign-in
installer: unverified
recovery: unconfirmed
---

# Google account connection asks customers for developer credentials

## Symptom

Google service cards ask the customer to configure a Google Cloud project and paste client credentials instead of signing into their account.

## Repro

1. Open ABILITIES → CATALOG on a fresh local build without Google publisher configuration.
2. Find Gmail or Google Docs.
3. The original SET UP action reveals client ID/client secret fields.

## Evidence

Owner screenshot and live local DOM at 127.0.0.1:8791 showed Gmail → SET UP. Before repair, `frontend/app/windows/connectors.js` rendered `data-cc-oclientid` and `data-cc-oclientsecret`. Regression coverage: `test/google-connector.test.js`.

## Verdict

Source implementation committed at cb8385c56. The StarNet Desktop OAuth registration, five Workspace APIs, declared scopes and build secret are configured and included in the signed bd65c7737 installer. On 2026-09-06, the public home/privacy/terms URLs were saved in Google Branding and the console confirmed Branding changes saved. Native installed Windows inspection showed Gmail → SIGN IN WITH GOOGLE, with no application-client credential form. Google's Verification Center still reports branding and data-access verification incomplete. Real consent/operations/refresh/removal/revocation/restart and the privacy disclosure/verification work remain outstanding. This record stays open until the requested customer flow can be activated; a sign-in button is not account-connection proof.

## Regression

Before: fresh Gmail card required client ID and client secret input. After: the seeded UI at 127.0.0.1:8946 showed SIGN IN WITH GOOGLE and zero application-credential inputs. With a synthetic provider, callback completion changed the card to MANAGE SERVICE and displayed six Gmail tools plus a verified synthetic account identity. After restarting the seeded sidecar with --keep and opening a fresh browser tab, the connected Gmail account and all six tools were restored in the live UI. `test/google-connector.test.js` exercises all 23 native MCP operations and the package configuration guard; `test/google-signin.e2e.test.js` drives the real sidecar across consent, cancellation, persistence failures, restart, refresh, revocation and removal. These tests do not prove Google public approval.

## Sibling coverage

{
  "adapters": [
    {
      "target": "Gmail",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "MCP initialization probe and every declared tool through stable API adapter",
      "gate": "fast"
    },
    {
      "target": "Drive",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "MCP initialization probe and every declared tool through stable API adapter",
      "gate": "fast"
    },
    {
      "target": "Calendar",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "MCP initialization probe and every declared tool through stable API adapter",
      "gate": "fast"
    },
    {
      "target": "Docs",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "MCP initialization probe and every declared tool through stable API adapter",
      "gate": "fast"
    },
    {
      "target": "Sheets",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "MCP initialization probe and every declared tool through stable API adapter",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "catalog sign-in and callback",
      "state": "covered",
      "test": "test/google-signin.e2e.test.js",
      "scenario": "publisher registration, PKCE callback, partial and denied consent",
      "gate": "http"
    },
    {
      "target": "legacy Google preview connector",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "legacy first-party URL resolves to stable catalog adapter while custom endpoints remain custom",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "catalog customer controls",
      "state": "covered",
      "test": "test/google-connector.test.js",
      "scenario": "no developer credential form and Sign in with Google label",
      "gate": "fast"
    },
    {
      "target": "real installed Google consent on Windows and macOS",
      "state": "blocked",
      "reason": "StarNet Desktop registration is bundled in the signed candidate, but real-account consent/lifecycle acceptance and Google verification remain incomplete."
    }
  ],
  "lifecycle": [
    {
      "target": "durable Google grant",
      "state": "covered",
      "test": "test/google-signin.e2e.test.js",
      "scenario": "failed save and cancel preserve old grant; restart refreshes; revoked access fails closed; removal survives restart",
      "gate": "http"
    }
  ]
}
