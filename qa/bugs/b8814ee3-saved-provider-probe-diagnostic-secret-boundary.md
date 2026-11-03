---
fingerprint: b8814ee3
slug: saved-provider-probe-diagnostic-secret-boundary
title: Saved provider probes lose failure diagnostics and expose endpoint secrets
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: agent/batch3-fixture-repairs-1103
fix: dfeb64320de7c7a0901584e065b959575edf772b
origin: audit
---

# Saved provider probes lose failure diagnostics and expose endpoint secrets

## Symptom

A failed check of an already saved provider credential returned an error but left no provider failure note in the diagnostic tail. If the transport threw an error containing the saved key or credential-bearing endpoint, that value could also reach the response or diagnostic text when global redaction did not already know it.

## Repro

1. Run `node test/provider-key-check.test.js` with the current fixture against the original shared verifier from candidate `5acb0819a` using its `PROVIDER_KEY_CHECK_CONTROL` source loader.
2. Have the actual probe route resolve a saved API key without a request key, then return a rejection or throw an error echoing that key and a saved endpoint containing user/password/query credentials.
3. Repeat with an OAuth account token, request-key probe/validate, malformed JSON, missing key and unknown provider. The fixture runs the production shared verifier, routes and diagnostic logger; only transport/account/storage dependencies are synthetic, and global redact is deliberately `String`.

## Evidence

- `test/provider-key-check.test.js`: exact original source RED9/69, intermediate key-only repair RED2/69 (saved endpoint and OAuth endpoint leaks), current GREEN69. Preserved receipts are `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/batch3-provider-check-{original,intermediate,current}-ff1403.log`.
- Original source `batch3-provider-check-old-index.js` SHA256 `A39DA3FD37294B30B1D9462242EAAC50783F0F779EF0D93344D34168BEB354E6`; intermediate source `batch3-provider-check-pre-endpoint-index.js` is also retained beside the receipts. Loaders never replace production files.
- `verifyProviderPair` privately reports its exact resolved key and endpoint to `providerCheckRoute`. The route retains them in lexical variables for its existing rate-limited failure logger and throw-path scrub. No credential is added to a returned or JSON object and no second credential resolver is introduced.
- Independent root source review closed the callback, endpoint-secret scrub and OAuth coverage with no remaining blocker. Current actual-host `test/sidecar.http.test.js` passes531 after separately documented readiness fixture repairs.

## Verdict

Fixed in this branch at `dfeb64320`. Focused proofs cover saved API/OAuth credentials, endpoint password/query echoes, cleaned request candidates, rate limiting and malformed/missing/unknown refusal paths. No real account, installed application or release-wide claim is made; the orchestrator owns the combined candidate gates.
