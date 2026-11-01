---
fingerprint: 46874bf8
slug: env-keys-and-endpoint-tokens-reach-transcripts
title: A provider key set in the environment, and a token inside an endpoint URL, reach transcripts unredacted
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: 60ac93a75
origin: audit
family: B1-credential-sources
---

# A provider key set in the environment, and a token inside an endpoint URL, reach transcripts unredacted

## Symptom

A provider key the operator set in the environment that starts StarNet, a backup key in its `STARNET_KEY_POOL_<ID>`, and a token inside an endpoint URL reached the run stream, the persisted transcript and `/api/diagnostics` raw whenever a model or an upstream echoed them. The same values rode every prompt the station built. redact()'s known-value layer held the desktop shell's pushed keys and pools, the OpenRouter alias and the browser page's saved keys, but nothing from the environment and no endpoint at all. A key with no vendor prefix (Mistral, DeepSeek, Together, a CUSTOM server's key) has no shape rule to catch it. On the desktop, a key the shell handed the sidecar at spawn was held only once the shell pushed it again. GET /api/providers answered each provider's endpoint whole as `currentBaseUrl`, including a `?api_key=` token or a password before the host.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and copy `test/credential-store.redaction.e2e.test.js` from this lane into it. Run `node test/credential-store.redaction.e2e.test.js`.
2. Row 1 (probe P4) runs a headless sidecar with:
   - `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` and `TOGETHER_API_KEY` holding keys with no recognisable prefix
   - `STARNET_KEY_POOL_MISTRAL` and a token-shaped `CUSTOM_OPENAI_KEY`
   - `CUSTOM_OPENAI_BASE_URL=<upstream>/t/<token>/v1`, `DEEPSEEK_BASE_URL=...?api_key=<token>` and `GROQ_BASE_URL=http://operator:<password>@...`
   - a Fireworks key the page saves through POST /api/providers/engine-key, with an endpoint that has a token in its path

   POST /api/run on CUSTOM; the upstream's reply echoes every value bare. Each value appears raw in the NDJSON stream and in /api/transcript. Two runs whose upstream answers 400 with the values in its error message put them in /api/diagnostics. GET /api/providers returns each endpoint whole (probe providers-echo).
3. Row 2 runs a desktop-shaped sidecar (`STARNET_DESKTOP_SHELL=1`, the IPC token) started with the shell's spawn pair `SKYNET_/STARNET_TOGETHER_API_KEY`. The model echoes the key before any push, and it appears raw.

## Evidence

- Mechanism at a3af8dafd: `stationSecretValues` (sidecar/index.js:6560) built the provider part of the known-value list from `runtimeKey`, `Object.values(runtimeKeys)`, `Object.values(runtimeKeyPools)` and `engineKeys.secretValues()`. context.js `setKnownSecretSource` reads that list on every redact() call (sidecar/index.js:6576), and prompt-scrub's held source reads it through `stationCredentialValues` (sidecar/index.js:6584). Nothing read `envFirst` or `KEY_POOL_<ID>`, and no endpoint was listed. `handleProviders` (sidecar/index.js:27765) answered `currentBaseUrl: baseUrl || ''`, the endpoint `providerRuntimeBaseUrl` resolved, unmasked.
- Probes P4 and providers-echo (probe-browser.js re-run as critique-spec-and-rules/rerun-browser.js, and critique-spec-and-rules/probe-providers-echo.js, in the lane's plan scratch):
  - the Mistral and CUSTOM env keys and the token in the CUSTOM endpoint's path were raw in the /api/run stream (`p4_mistralEnvKeyRawInStream`, `p4_customEnvKeyRawInStream` and `p4_endpointPathTokenRawInStream` were all true)
  - `custom.currentBaseUrl` carried the `?api_key` token
- `test/credential-store.redaction.e2e.test.js` in a scratch checkout of a3af8dafd: 9 problems, 19 ok.
  - The first failure is "headless: no env key, env pool entry, endpoint credential part, page key or page endpoint token appears raw in the run stream — expected [], got ["mistral","deepseek","together","mistralPool","customKey","pathToken","queryToken","password","pagePath"]".
  - The transcript, both refused runs' errors and /api/diagnostics fail the same way, and GET /api/providers answers each endpoint whole.
  - On the desktop, the adopted key is raw in the stream and the transcript.
  - The page's own key, the Azure-style endpoint with no credential and the placeholder rows pass there; they are the guards.
- The same test at the lane's S4 tip 7ad9b499e: 7 problems, which are exactly the headless rows. The desktop rows already pass there, because step S2 adopted the shell's key into the keychain layer, which the list held.

## Verdict

Fixed by 60ac93a75 on agent/credential-store-1031 (credential-store lane, step S5; decision 8; not merged yet).

The provider part of the held list is the credential store's `secretValues()` (sidecar/credential-store.js). It holds every layer's keys and pools, the environment's included (the variable `envFirst` reads, and its `KEY_POOL_<ID>`). It also holds the credential parts of every endpoint a layer holds, found by `urlSecretParts`:
- a password before the host, to the authority's last `@`
- a user name there that is shaped like a token
- a path segment shaped like a token
- a query or fragment value named like a credential (`isCredentialName`: api_key, key, token, sig) or shaped like a token (a run of 20 or more letters and digits that holds both)

A whole URL is never held, so a server's address stays readable, and `?api-version=2024-02-01` is not a credential. Four list entries became one call. A channel record's own endpoint is held by the same parts (index.js `channelEndpointSecrets`) until step S8 moves those records into the store. GET /api/providers keeps `currentBaseUrl` and masks each credential part where it stands (`maskedUrl`).

Decision 8: the environment's key and backups of a provider that takes no key (CUSTOM) are held only when they look like a credential (a vendor shape, or a token-shaped run). So a local server's placeholder key (`lm-studio`, `not-needed`, `anything`) is not cut out of a transcript, a tool result or a prompt. A keyed provider's environment key is held whole, and the keychain's and the page copy's values are held as at trunk.

The helper-process strip (child-env.js) reads `secretValues({ childEnv: true })`: the keychain's and the page copy's keys and pools and the OpenRouter alias, which are the values trunk held. A user's own export (a bare `ANTHROPIC_API_KEY`) still reaches the claude CLI, and a user's `OPENROUTER_API_KEY` holding the branded `STARNET_OPENROUTER_KEY` value is still stripped.

Named changes:
- On the desktop an adopted keychain key is in the helper list from boot; at trunk it was listed only once the shell pushed it. A host helper therefore no longer sees a user's own variable that holds that very key, and the claude CLI then uses its own sign-in. This landed with step S2; this step pins it with a test.
- A value the environment holds for a keyed provider is cut out of text whatever it looks like, as page keys already were.
- Cost: redact() asks for the held list on every call, which is every token frame of a run's stream. Reading every provider's environment variables costs about 130 lookups: about 85 µs on Windows, against about 10 µs for a frame's own redaction. The environment cannot change from outside a running process, and nothing in the sidecar writes a provider's key, pool or URL variable after boot, so the store reads that part at most once a second with the host's clock. The keychain's and the page copy's values, which a push or a page save changes, are read live on every call.

States it now refuses: none. This fix only adds values that are cut out of text; no run, route or helper is refused.

Tests:
- `test/credential-store.redaction.e2e.test.js` (http, new): real sidecars and a recording upstream. RED at a3af8dafd (9 problems, 19 ok), RED at 7ad9b499e (7), GREEN at 60ac93a75 (28).
- `test/redact.known-values.test.js` (fast) builds a station with index.js's own wiring and reads it through index.js's own held lists. It covers:
  - every layer's values, decision 8, and the URL parts and the mask
  - a rotation held at once, and a channel record's endpoint
  - the environment read at most once a second with the clock, while the keychain stays live

  Each of seven mutations of the store fails it.
- `test/child-env.test.js` (fast): the claude CLI's environment, built by its own host over index.js's own source statement. It covers the headless bare key that is kept, the branded alias's copy that is stripped, and the desktop from-boot change.
- `test/secret-redaction.e2e.test.js` keeps its claims. `test/prompt-scrub.projectors.test.js`, `test/engine-credential.test.js` and `test/settings-p1-backend.test.js` keep theirs, and their source locks now name the store's one call where they named the four entries.

Not covered here:
- A token split across two streamed token frames. Each frame is redacted on its own; the transcript, which holds the whole turn, is not affected.
- StarNet's linked device token saved in `.secrets/credits.json` by a browser link. The known-value list does not hold it. This is pre-existing, and it is not a layer this store resolves on every call.
