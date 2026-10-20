/* sidecar/providers/opencode-identity.js — OpenCode's client contract for THIRD-PARTY agents, in one pure place.

   OpenCode's own docs (opencode.ai/docs/console/go) tell a foreign coding agent exactly how to talk to their
   inference gateway:
     - identify itself with its OWN user agent (not a generic SDK / HTTP-library name), and
     - send a STABLE session id in `x-opencode-session`, so the gateway can route the traffic and cache prompts.
   A client that sends neither is handled as an anonymous caller of the RESERVED free tier and gets
   403 "FreeTierError: OpenCode's free tier can only be used from within OpenCode" — a sentence that reads like a
   rejected API key and sent a whole diagnosis down the wrong path (2026-10-20).

   Three more facts from the same docs, encoded here so no caller has to rediscover them:
     - the console key is a SERVICE-ACCOUNT key (oc_sk_...); a member/session token is refused as "Invalid credential";
     - the free chat models (catalog ids ending in "-free") are served ONLY inside the OpenCode app, so a
       third-party client can never answer with them, however good the key is;
     - paid / Go models (e.g. deepseek-v4.1-flash) answer a third-party client normally, with the key as bearer.

   Pure: no IO, no clock, no env. The host supplies the version and the session id.
 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.opencodeIdentity = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPENCODE_HOST = /(^|\.)opencode\.ai$/i;

  // The inference host. Also matches the console and the zen path, which all live on opencode.ai.
  function isOpenCodeHost(baseUrl) {
    try { return OPENCODE_HOST.test(new URL(String(baseUrl || '')).hostname); }
    catch (_) { return false; }
  }

  /* The OpenCode GO plan has its OWN endpoint: https://opencode.ai/zen/go/v1 (chat + /models). A GO key on the
     pay-as-you-go inference path (/inference/openai/v1) has NO model access there — the gateway answers
     403 "Model access is disabled" (measured 2026-10-20). The GO path in turn REQUIRES the session header:
     without it the gateway answers 400 "MissingSessionID" and points at opencode.ai/docs/go. */
  const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
  function isGoPath(baseUrl) {
    return /\/zen\/go(\/|$)/i.test(String(baseUrl || ''));
  }

  /* The reserved free chat models. OpenCode serves them ONLY inside its own app — a third-party client gets
     403 FreeTierError for them no matter which key it holds. Their catalog id carries the "-free" suffix. */
  function isFreeOnlyModel(modelId) {
    const id = String(modelId || '').trim().toLowerCase();
    return id.length > 0 && id.endsWith('-free');
  }

  /* The headers OpenCode asks a third-party client for. Empty for every other endpoint: StarNet must not
     announce itself as an OpenCode client anywhere else. */
  function identityHeaders(opts) {
    const o = opts || {};
    if (!isOpenCodeHost(o.baseUrl)) return {};
    const out = {};
    const version = String(o.version || '').trim().replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 40);
    out['User-Agent'] = 'starnet/' + (version || '0');
    // A stable id per conversation (the chat stream), so the gateway can route and cache the traffic.
    const sessionId = String(o.sessionId || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
    if (sessionId) out['x-opencode-session'] = sessionId;
    return out;
  }

  /* What the failure MEANS, in one sentence the agent can relay. The upstream text stays in the error (it is the
     truth); this says what to DO about it, so an agent no longer reports "the API key is not accepted" for a
     problem that has nothing to do with the key. Empty when we have nothing better than the upstream text. */
  function failureHint(opts) {
    const o = opts || {};
    if (!isOpenCodeHost(o.baseUrl)) return '';
    const status = Number(o.status || 0);
    const detail = String(o.detail || '');
    if (status === 403 && /free tier/i.test(detail)) {
      return "OpenCode serves its free chat models only inside the OpenCode app itself — a third-party client (StarNet) always gets this 403, whatever key it holds. Pick a Go/paid model instead (e.g. deepseek-v4.1-flash) and use a console service-account key (oc_sk_...) on a workspace with credits or an OpenCode Go subscription.";
    }
    if (status === 403 && /model access is disabled/i.test(detail)) {
      return 'this key has no model access on the pay-as-you-go inference path — an OpenCode GO key belongs on the GO endpoint (' + GO_BASE_URL
        + '). Point the CUSTOM base URL there; the GO plan also demands the x-opencode-session header, which StarNet sends.';
    }
    if (status === 400 && /missing x-opencode-session/i.test(detail)) {
      return 'the OpenCode GO endpoint needs a conversation id in x-opencode-session — StarNet sends one per run, so this means the request did not come from a run (a manual probe against a raw endpoint).';
    }
    if (status === 401 && /invalid credential/i.test(detail)) {
      return 'OpenCode refused this key. It wants a console SERVICE-ACCOUNT key (oc_sk_...) with the "Inference" permission — a member token, a session token or a key from another account is refused with exactly this message. Create a new one under opencode.ai/console → Keys.';
    }
    if (status === 401 && /go requires a credential/i.test(detail)) {
      return 'the OpenCode GO endpoint wants a credential: paste the console key (oc_sk_...) of the workspace that carries the Go subscription. The Go plan itself is not a key.';
    }
    if (status === 401 && /missing api key/i.test(detail)) {
      return 'no API key is connected to this provider card — paste the console service-account key (oc_sk_...) into SETTINGS → PROVIDERS.';
    }
    if (status === 403 && /allowlist|not allowed|forbidden/i.test(detail)) {
      return 'OpenCode refused this account for this endpoint. Check the workspace policies and the model permissions in the console (opencode.ai/console).';
    }
    return '';
  }

  return { isOpenCodeHost, isFreeOnlyModel, identityHeaders, failureHint, isGoPath, GO_BASE_URL };
});
