---
fingerprint: e5d4b743
slug: google-account-connection-asks-customers-for-dev
title: Google account connection asks customers for developer credentials
surface: onboarding
severity: P1
status: fixed
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

2026-09-07 scope decision: the owner deferred Google Workspace integrations from 0.11.0.
The original developer-credential prompt is source-fixed by cb8385c56 and was absent
in signed 49d859186 installed acceptance. All five real fixture reads passed after
that upgrade, with a real Docs reconnect. The new release instead explicitly defers
the integrations, retains saved grants, blocks OAuth/runtime use and omits the
publisher registration; see `docs/RELEASE_0.11.0_GOOGLE_DEFERRAL.md` and
`test/google-release-deferred.e2e.test.js`. Close the original prompt defect as
source-fixed. This does not certify public Google activation, all lifecycle paths,
or the replacement installer: those remain separate future-release acceptance work.
The earlier paragraphs below describe the former activation-in-0.11.0 scope.

Source implementation committed at cb8385c56. The StarNet Desktop OAuth registration, five Workspace APIs, declared scopes and build secret are configured and included in the signed bd65c7737 installer. Native installed Windows inspection showed Gmail → SIGN IN WITH GOOGLE, with no application-client credential form. Real consent and bounded operations now pass for all five services on installed Windows. The corrected privacy disclosure is published; Google confirmed domain ownership, verified the branding, and published it. Data-access verification remains unsubmitted pending its required demo and review material. Real-account refresh/removal/revocation/restart and physical Mac acceptance remain outstanding. An additional in-app disclosure before consent is verified in the seeded UI and requires a rebuilt installer. This record stays open until the requested customer flow can be activated for distribution.

## Regression

2026-09-06 23:04 EDT installed Windows acceptance: signed bd65c7737 completed real
Google consent for Gmail, returned "Gmail connected" with six tools, and changed the native
catalog action to MANAGE SERVICE. In a dedicated test conversation, run
5451d600-a49e-4410-8d99-d713c8087687 recorded three successful calls: create_draft (540 ms),
search_messages (429 ms), and read_message (231 ms), with no uncertain mutations and no
send call. Gmail's own web UI independently returned exactly one matching unsent draft
with the requested test subject/body. This verifies Gmail's real installed connection and
these operations. Subsequent real runs ddc0e3a3-7018-48ca-9ba9-f48b6d62f96c and
38f2b951-ac99-4f71-9a99-f4c0aef9c82f verified 12 Docs/Sheets/Drive calls and five Calendar
calls respectively, all successful and limited to dedicated fixtures. All five connections
report authorized and up. Restart/refresh/removal/revocation and the Google review
remain outstanding. The project has two OAuth clients (Desktop and Account web), both of
which must be covered by the verification material. No demo video has been submitted.

2026-09-06 release follow-through: published the audited Google disclosure to
https://starnetos.com/legal/privacy from a website branch based on the currently live
46b944c source, with only the privacy page changed among 3,944 staged files. Verified the
served HTML after accounting for Cloudflare's email obfuscation. Added the one-time Google
ownership TXT record through Cloudflare Domain Connect; Search Console confirmed ownership.
Google branding verification then passed and the verified StarNet branding was published.
Data-access review is still unsubmitted: Google requires intended-use selections and a real
OAuth/demo video covering this project's clients. Productivity categories were reviewed but
cannot be saved without the required video. No video URL, public data-access approval,
Limited Use attestation, or real-account lifecycle receipt has been fabricated. See
`docs/RELEASE_FOLLOWTHROUGH_2026-09-06.md`.

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
