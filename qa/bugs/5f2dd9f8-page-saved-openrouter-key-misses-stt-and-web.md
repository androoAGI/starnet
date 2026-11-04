---
fingerprint: 5f2dd9f8
slug: page-saved-openrouter-key-misses-stt-and-web
title: An OpenRouter key saved in a page or a bare env var never reaches STT or web_search's paid rung, and a credits run spends the desktop's
surface: providers
severity: P2
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: eadd2da4b
origin: audit
family: B1-credential-sources
---

# An OpenRouter key saved in a page or a bare env var never reaches STT or web_search's paid rung, and a credits run spends the desktop's

## Symptom

Each station-side consumer of an OpenRouter credential read whichever source its own code named, so the same key worked on one surface and not on the next.

- With an OpenRouter key saved in a browser page, /api/providers said configured:true while /api/stt/status said cloud:false, and a voice note with no page header had no OpenRouter leg.
- web_search's paid OpenRouter rung armed only on the run's own OpenRouter key or the legacy `runtimeKey` alias, so a page key or a bare OPENROUTER_API_KEY never reached it.
- Where the alias did arm it on a run on another provider, it sent that run's model id, which OpenRouter does not have.
- It armed on StarNet-credits runs too, spending a BYOK key on a run the image route keeps off every BYOK key.

This is gh#146's web half and the station-consumer half of gh#89. Doing it with one credential is the lane's second doneMeans.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and copy `test/credential-store.openrouter-consumers.e2e.test.js` and `test/helpers/outbound-edge.js` from this lane into it. Run `node test/credential-store.openrouter-consumers.e2e.test.js`. The file boots every station through the preload, which answers anything that is not loopback with 503 and records it, and it stops if the edge did not come up. Never run it without that helper: the voice legs and the rung would reach the real openrouter.ai, Mojeek and DuckDuckGo.
2. Row "page": a browser-mode sidecar, POST /api/providers/engine-key {provider:'openrouter', key:K, baseUrl:U}, then GET /api/stt/status, a CUSTOM /api/run whose model calls web_search, POST /api/stt with no page header. Status says cloud:false, U sees no web-plugin call, and /api/stt answers with no text.
3. Row "headless": OPENROUTER_API_KEY=K, OPENROUTER_BASE=U. The same three failures.
4. Row "credits": a desktop-shaped sidecar with a keychain OpenRouter key K and a linked StarNet account (.secrets/credits.json); a `starnet` /api/run whose model calls web_search. K goes to `openrouter.ai/api/v1/chat/completions`, recorded at the edge.

## Evidence

- Mechanism at a3af8dafd:
  - `getRuntimeKey: () => runtimeKey` (sidecar/index.js:3160) was STT's only OpenRouter source, in `sttStatus` and `transcribeAudioBuffer` (sidecar/media-service.js:796 and 817).
  - `const openrouterToolKey = providerId === 'openrouter' ? runKey : runtimeKey;` (sidecar/index.js:22360) armed the rung, and `makeWebTools` got `{apiKey, model}` with the RUN's model.
  - test/image-task.e2e.test.js:215 locked that line in, with a claim that was the opposite of this doneMeans. Its comment gave the reason the rung sent the run's model id; the fix removes the reason.
  - `studioRouteFor` patched only the image half, with a second rung (`stationOpenRouterFill`), so the image route and the rung read different sources.
- `test/credential-store.openrouter-consumers.e2e.test.js` in a scratch checkout of a3af8dafd: 31 problems, 43 ok.
  - The first failure is "page: /api/stt/status reports cloud:true (a key a page saved read false, probe P2) — expected true, got false", which is probe P2.
  - Then, on the page and headless rows: U sees no web-plugin call, /api/stt reaches nothing (0 calls), and the model is told every engine declined.
  - The credits row: "...nor anywhere else (the alias used to arm the rung here, at openrouter.ai) — expected [], got ["openrouter.ai/api/v1/chat/completions"]".
  - The image rows and `preferred` pass there. They are the guards: the first through trunk's #146 second rung, the second because this fix must not move it.
- Green here: 74 assertions. `test/credential-store.no-crossing.test.js` section 5 pins `credentialFor`'s key, endpoint, source and rank by where the key came from.

## Verdict

Fixed by eadd2da4b on agent/credential-store-1031 (credential-store lane, step S6; decisions 1 and 2; not merged yet).

`credentialFor('openrouter')` (sidecar/credential-store.js) is the one credential: the station's own key, the endpoint saved with it and its rank. Every station-side OpenRouter consumer asks it, through `consumerDeps()`, the function index.js builds them with. A run on OpenRouter uses its own key and endpoint. The `runtimeKey` alias, `getRuntimeKey`, the #146 second rung and the source lock are deleted. Rows 199-200 of test/image-task.e2e.test.js stay as guards.

The web rung arms on every BYOK run from the station's credential, any source. It stays last in its chain, and sends OpenRouter's search model (`openai/gpt-4o-mini`) on a run on another provider.

Rank (decision 1) keeps billing where it was. `rank` is 'primary' for the keychain layer and the branded STARNET_/SKYNET_OPENROUTER_KEY, which is what the alias held, and 'gap' for a bare OPENROUTER_KEY or OPENROUTER_API_KEY and the page copy. A 'gap' credential comes last in the image route and after the local engine in the STT ladder, and never changes /api/stt/status.preferred. `cloud` and `available` are reported for every source: a station whose only engine is that key can transcribe, so they now say so. `preferred` staying as it was means a desk on the browser's own recognition keeps it.

States it now refuses, each with its exit:
- A StarNet-credits run never arms the BYOK web rung (decision 2). Desktop credits users lose the rung the alias armed for them; the free engines still serve. Exit: run the agent on OpenRouter.

Billing: the paid rung now arms on non-OpenRouter BYOK runs for every key source. Its spend stays unmetered, as it was; metering it belongs to the auxiliary-spend lane. Image and STT billing do not move.
