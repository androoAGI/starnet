---
fingerprint: 88f0b2ce
slug: keyed-voice-leg-sends-key-to-unsaved-endpoint
title: A keyed voice leg, web_search's rung and Live Voice send a key to an endpoint it was not saved with
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: eadd2da4b
origin: audit
family: B1-credential-sources
---

# A keyed voice leg, web_search's rung and Live Voice send a key to an endpoint it was not saved with

## Symptom

A key saved with an endpoint belongs at that endpoint: a proxy, a corporate gateway, an OpenRouter-compatible server. Several station-side dialers ignored it and sent the key to a third party the user never chose for it.

- STT's and TTS's OpenRouter legs and web_search's rung dialed https://openrouter.ai whatever endpoint the key was saved with, so a key kept for a proxy left for the public host.
- A key the page sent with one /api/tts request went to the endpoint of the STATION's key for that provider, an endpoint saved with another key.
- Native Live Voice posted an OpenAI key saved with a gateway to the fixed https://api.openai.com/v1/realtime/calls.

## Repro

1. Check out a3af8dafd (or any trunk before this fix) and copy `test/credential-store.no-crossing.test.js` and `test/helpers/credential-store-sandbox.js` from this lane into it. Run `node test/credential-store.no-crossing.test.js`. Its section 4 builds the same modules with trunk's own wiring, fakes fetch at the network call and drives every leg over every combination of a provider's layers. No request leaves the machine.
2. Real-sidecar form: `test/credential-store.openrouter-consumers.e2e.test.js` with `test/helpers/outbound-edge.js`.
   - Row "desktop": a keychain OpenRouter key K with a pushed endpoint U. /api/tts, /api/stt and web_search each send K to `openrouter.ai`, recorded at the edge, and U sees none of them.
   - Row "Live Voice": a page saves an OpenAI key with another endpoint. GET /api/realtime/status?provider=openai reads native, and POST /api/realtime/session sends the key to `api.openai.com/v1/realtime/calls`, recorded at the edge.

## Evidence

- Mechanism at a3af8dafd:
  - `https://openrouter.ai/api/v1/audio/speech` (sidecar/media-service.js:327), `https://openrouter.ai/api/v1/chat/completions` (sidecar/media-service.js:847) and the same URL in sidecar/tools/builtin/web.js:658 were hard-coded.
  - The Gemini and OpenAI TTS legs resolved `providerRuntimeBaseUrl(provider, '')` (sidecar/media-service.js:285 and 310), the endpoint of the station's key, for a key the page sent (`ttsPageKey`, 623-626).
  - realtime-voice.js:145-166 posted `resolveProviderCredential('openai')` to the registry's fixed `liveVoice.url`, whatever endpoint that key was saved with.
- `test/credential-store.no-crossing.test.js` in a scratch checkout of a3af8dafd: 19 problems, 25 ok, with these from the dialer sections (the rest are the pool rows and the wiring).
  - "a keyed dialer sends a key only to the endpoint saved with it (1024 rows): 489 cross, in 15 legs". Examples from the run:
    - TTS OpenRouter, page {K, U}: may dial `http://pg.test/v1/audio/speech`, dialed `https://openrouter.ai/api/v1/audio/speech`.
    - TTS OpenAI, a key the page sent: may dial `https://api.openai.com/v1/audio/speech`, dialed `http://pg.test/v1/audio/speech`.
    - Live Voice, page {K, U}: may dial nothing, dialed `https://api.openai.com/v1/realtime/calls`.
    - The web rung on a run on OpenRouter: may dial the run's endpoint, dialed `https://openrouter.ai/api/v1/chat/completions`.
  - "no provider host stands in code outside the registry's profiles and each adapter's default constant" names media-service.js and web.js.
- `test/credential-store.openrouter-consumers.e2e.test.js` at a3af8dafd, through the preload, 31 problems, 43 ok, among them:
  - "desktop: nothing carrying the saved key left for any other host — expected [], got ["openrouter.ai/api/v1/chat/completions" (3 times), "openrouter.ai/api/v1/audio/speech"]"
  - "Live Voice: ...and the key never reached the fixed realtime URL — expected [], got ["api.openai.com/v1/realtime/calls"]"
- Green here: no-crossing 69 assertions, the e2e 74.
- The census bites. Fourteen regressions, applied one at a time to a scratch checkout of the fix, each turn a named test red:
  - TTS's and STT's OpenRouter legs back on the hard-coded host
  - `endpointFor` answering the station key's endpoint
  - the rung arming on a credits run, and sending the run's model
  - every key ranking primary, and the branded export ranking gap
  - Live Voice ignoring the endpoint, and `createCall` skipping the blocker
  - a gap credential displacing OpenAI
  - a new dialer with no row, a key read with no endpoint, a provider host in new code, and index.js wiring the media service by hand
- One of those first survived. The scan skipped any line starting with `function`, so a one-line dialer went unseen. It is fixed, and a one-line and a multi-line dialer, a new Bearer header and a new x-api-key header now each fail it.

## Verdict

Fixed by eadd2da4b on agent/credential-store-1031 (credential-store lane, step S6; decision 6; not merged yet).

Every keyed leg dials `endpointFor(provider, the key it sends)` (sidecar/credential-store.js), and native Live Voice opens only for a key saved with the profile's default endpoint. `consumerDeps()` builds every module-level dialer's credential dependencies in one place, for index.js and for the census test alike.

The class is closed by `test/credential-store.no-crossing.test.js`:
- Section 4 drives every leg over every layer combination against an oracle that reads only the station's description.
- Section 6 is a census over the sidecar's own source. A provider host may stand only in the registry's profiles and each adapter's default constant. Every place a provider credential leaves the process has a row, so a new dialer with none fails. A function that reads a provider's key reads the endpoint for that provider. index.js builds each module-level dialer from `consumerDeps`.

Step S6's plan had `test/helpers/outbound-edge.js` install undici's global dispatcher. That alone never sees the voice legs: media-service.js hands them a keep-alive Agent of their own (`voiceFetchOpts`), so at trunk the TTS row would have dialed the real openrouter.ai. The helper also patches `undici.Agent.prototype.dispatch`, and the e2e has a row that proves it.

States it now refuses, each with its exit:
- An OpenRouter key saved with a proxy endpoint is no longer sent to openrouter.ai by STT, TTS or the web rung. If the proxy cannot serve a call, that leg fails with its reason and the next leg runs (decision 6).
- An OpenAI key saved with a non-default endpoint does not open native Live Voice. /api/realtime/status says composed, with a `note` that names why, and /api/realtime/session answers 501 before the key is even resolved. Composed voice serves. Exit: an OpenAI key saved with the default endpoint. The real routes prove both sides in the e2e.

A ChatGPT sign-in is not refused: its bearer is minted for the realtime URL and is no key saved with an endpoint.

The operator's STT-only overrides STARNET_/SKYNET_GROQ_BASE and _OPENAI_BASE stay ahead of the provider's endpoint, as at trunk. They are a deployment's own choice, and dropping them would send its speech to the public host.

Users with an OpenRouter proxy now send audio and web calls to their proxy, and a gateway OpenAI key no longer opens native Live Voice.
