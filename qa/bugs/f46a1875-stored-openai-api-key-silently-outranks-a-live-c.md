---
fingerprint: f46a1875
slug: stored-openai-api-key-silently-outranks-a-live-c
title: Stored OpenAI API key silently outranks a live ChatGPT sign-in at Wake
surface: onboarding
severity: P1
status: fixed
found: 2026-09-16
lane: agent/codex-wins-wake
fix: f7e050e6f
origin: customer
report: Customer screenshot relayed by Andrew, 2026-09-16 — ChatGPT Plus subscriber stuck on the overseer create screen
affected: Installed desktop v0.11.2 (Windows), overseer create screen, OPENAI card with ChatGPT signed in
family: genesis-provider-credential-selection
installer: unverified
recovery: unconfirmed
---

# Stored OpenAI API key silently outranks a live ChatGPT sign-in at Wake

## Symptom

On the overseer create screen the OPENAI card shows the green "connected to ChatGPT — your agents can run on your subscription" status, the key field is blank, and WAKE OVERSEER fails every time with `your model didn't answer - openai-compatible http 429 - [... type insufficient_quota; code credit_balance_exhausted] You have no credits remaining`. The customer has a paid ChatGPT Plus plan. RE-SIGN IN and DISCONNECT do not change the outcome, and the create screen offers no way out.

## Repro

1. Fresh desktop station, OPENAI card selected. Paste an OpenAI API key that has no prepaid API credit, press WAKE — the key is written to the keychain by `validateAndSetKey` BEFORE `preflightWire` runs, and the wire test fails with the 429.
2. Clear the key field (desktop shows the "stored in keychain — leave blank to keep" placeholder). Press SIGN IN WITH CHATGPT and complete the OAuth; the card turns green.
3. Press WAKE OVERSEER with the key field blank. Before the fix the branch in `frontend/app/app.js` (`onWakeAttempt`, merged OPENAI card) required `!Harness.hasStoredCredential('openai')` to ride codex, so the wake fell through to the API-key branch and hit api.openai.com with the zero-credit key. The error label `openai-compatible` (not `codex http NNN`) proves the request never rode the ChatGPT sign-in.

## Evidence

- Customer screenshot 2026-09-16: green ChatGPT connection status + red `openai-compatible http 429 ... insufficient_quota ... credit_balance_exhausted` under WAKE OVERSEER.
- `sidecar/providers/codex.js:391` labels its errors `codex http <status>`; `sidecar/providers/factory.js` gives keyed openai-compatible providers the generic label — the screenshot label identifies the keyed OpenAI path.
- `frontend/app/app.js` wake branch before fix: `pickedProvider === 'openai' && !el('in-key').value.trim() && !(Harness.hasStoredCredential && Harness.hasStoredCredential('openai')) && codexConnected` — the stored-credential clause is the defect. The rule was ambient (carried from `Harness.configured` by `0250793ac`), never a product decision.
- The create screen has no control that removes a stored key; DISCONNECT only clears the ChatGPT tokens.

## Verdict

A credential the Commander cannot see or remove must never outrank the one the card visibly asserts. A LIVE ChatGPT sign-in with a blank key field now rides codex; a TYPED key still wins (explicit beats ambient); a merely STORED key no longer does. The dead-wire line names the door it rode: `(via your ChatGPT sign-in)`, `(via the OpenAI API key stored on this station)` or `(via the OpenAI API key you typed)`. Fix commit `f7e050e6f` on `agent/codex-wins-wake`. Installed-desktop reproduction with a real stored key plus real ChatGPT tokens was not exercised; the regression test drives the real `onWakeAttempt` body.

## Regression

Before fix: `test/genesis-wake-credential.test.js` case `stored:true, connected:true` selected provider `openai` (the old assertion "a real saved API key keeps the API route" locked the defect). After fix: the same case selects `codex` with zero key writes; `stored:true, connected:false` still selects `openai` and reaches preflight; a typed key selects `openai` even with a sign-in live; each dead-wire message carries its `(via …)` door. 16 assertions pass. `test/genesis-starnet-link.test.js` (47 assertions) still finds the codex branch by source grep.

## Sibling coverage

{
  "adapters": [
    {
      "target": "ChatGPT OAuth vs stored OpenAI API key",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "live sign-in + blank field rides codex even with a stored key; no sign-in keeps the stored key; typed key always wins",
      "gate": "fast"
    },
    {
      "target": "OpenRouter server-held key",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "the DEV provider's own stored key still carries the wake",
      "gate": "fast"
    },
    {
      "target": "desktop keychain",
      "state": "blocked",
      "reason": "Installed-desktop routing with a real keychain key and real ChatGPT tokens was not exercised in this lane."
    }
  ],
  "entrypoints": [
    {
      "target": "Wake Overseer",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "onWakeAttempt selects the credential before the live preflight",
      "gate": "fast"
    },
    {
      "target": "OPENAI card codex branch presence",
      "state": "covered",
      "test": "test/genesis-starnet-link.test.js",
      "scenario": "source grep pins the codexConnected branch to setProv('codex')",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "Dead-wire message names the door",
      "state": "covered",
      "test": "test/genesis-wake-credential.test.js",
      "scenario": "the failure line carries (via your ChatGPT sign-in) / (via the OpenAI API key stored on this station) / (via the OpenAI API key you typed)",
      "gate": "fast"
    }
  ],
  "lifecycle": [
    {
      "target": "customer recovery",
      "state": "blocked",
      "reason": "The customer has not yet run a build carrying the fix; recovery stays unconfirmed until they report a successful wake."
    }
  ]
}
