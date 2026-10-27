'use strict';

/* sidecar/speech-outcome.js — SpeechOutcome: ONE typed verdict for every speech attempt.

   Four ladders speak (the desk's /api/tts, the agent's voice tool, the paired device's `speak`, push-to-talk STT) and
   each used to explain a failure with a free-text `reason` the desk then re-read with regexes. A reason no regex knew
   (Microsoft's HTTP 403 on 10-26) fell through as "transient", so a permanent refusal was retried as a blip on every
   sentence and the tooltip could only say "unreachable". Now every leg a ladder tries reports a CODE, and the ladder
   reports one outcome:

     { ok:false, terminal, retryAfterMs, code, engine, legs:[{ engine, code, http, detail }] }

   - legs     every engine tried, in order: engine = 'edge' | 'openrouter' | 'gemini' | 'openai' | 'elevenlabs' |
              'local-kokoro' | 'keyed' (the keyed tier as a whole, for no_key) | 'groq' | 'request' | 'station'
   - terminal true only when EVERY leg failed for a reason that seconds will not fix — a ladder with one transient leg
              (the free floor timed out) is worth asking again even if an earlier leg is out of credits
   - code     the leg the user should hear about: an empty wallet, then a rejected key, then the first transient leg,
              then the last real refusal, then a missing credential, then a switched-off floor
   - retryAfterMs  > 0 only when every transient leg named how long to wait (Retry-After / "retry in 23s")

   The legacy `reason` string stays beside it for one release (an older desk reads only that); each ladder builds it
   from the same legs it reports, through ladder(). Pure: no I/O, no clock — status() takes the injected now. */

// code -> terminal? false = transient (may succeed in seconds); true = retrying in seconds cannot fix it.
const CODES = Object.freeze({
  timeout: false,               // a leg (or the sentence's deadline) ran out of time
  network: false,               // the connection failed (DNS, reset, refused socket)
  cut_stream: false,            // the audio stream ended before the engine said it was complete
  empty_audio: false,           // the engine answered with no audio
  rate_limited: false,          // HTTP 429 without an empty-wallet body
  upstream_unavailable: false,  // HTTP 5xx, or a 1xx-5xx Edge refusal of the overloaded kind
  local_failed: false,          // the built-in engine failed this clip (it may load or recover)
  no_key: true,                 // the keyed tier holds no credential
  disabled: true,               // the engine is switched off on this station (SKYNET_EDGE_TTS=0)
  refused: true,                // the engine refused the request itself (Edge's 403: a token it will not accept)
  auth: true,                   // HTTP 401/403 from a keyed provider: the key is wrong or revoked
  billing: true,                // HTTP 402 or an insufficient-credits/quota body
  bad_request: true,            // another HTTP 4xx
  bad_response: true,           // a 2xx with no usable audio (bad JSON, unexpected content type)
  text_too_long: true,          // over the per-request cap (refused, never truncated)
  no_text: true,                // nothing to say
  bad_input: true,              // the request itself was malformed (bad JSON, bad voice id)
  local_unavailable: true,      // the built-in engine is not installed on this station
  internal_error: true,         // the handler threw: a bug, not a blip
  cancelled: true,              // the caller went away (barge-in, a closed page)
  unknown: true                 // a code this build does not know: terminal, and named
});

const isKnownCode = code => Object.prototype.hasOwnProperty.call(CODES, code);
const isTerminalCode = code => !isKnownCode(code) || CODES[code] !== false;

function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 300); }

// One leg's verdict. An unknown code is kept as 'unknown' with the original named in the detail.
function leg(engine, code, opts) {
  const o = opts || {};
  const known = isKnownCode(code);
  const out = {
    engine: String(engine || 'station'),
    code: known ? code : 'unknown',
    http: Number(o.http) > 0 ? Math.floor(Number(o.http)) : 0,
    detail: clip(known ? o.detail : (String(code) + (o.detail ? ': ' + o.detail : '')))
  };
  if (Number(o.retryAfterMs) > 0) out.retryAfterMs = Math.floor(Number(o.retryAfterMs));
  return out;
}

const BILLING_BODY = /insufficient[ _-]?(?:credit|quota|funds|balance)|payment[ _-]required|out of credit|billing[ _-]hard[ _-]limit|credit balance is too low/i;

// "Retry-After: 23", or a provider body that says "retry in 23s" / "retryDelay": "23s".
function retryAfterMsOf(headers, body) {
  let v = '';
  try { v = String((headers && typeof headers.get === 'function' ? headers.get('retry-after') : headers && headers['retry-after']) || '').trim(); }
  catch (_) { v = ''; }
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const m = /retry(?:ing)?\s+in\s+(\d+(?:\.\d+)?)\s*s\b|"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(String(body || ''));
  return m ? Math.round(Number(m[1] || m[2]) * 1000) : 0;
}

// An HTTP failure from a keyed provider, read ONCE: status first, then the body for an empty wallet.
function httpCode(status, body) {
  const s = Number(status) || 0;
  if (s === 402 || BILLING_BODY.test(String(body || ''))) return 'billing';
  if (s === 401 || s === 403) return 'auth';
  if (s === 429) return 'rate_limited';
  if (s === 408 || s === 504) return 'timeout';
  if (s >= 500) return 'upstream_unavailable';
  if (s >= 400) return 'bad_request';
  return 'bad_response';
}
function httpLeg(engine, status, body, headers, detail) {
  return leg(engine, httpCode(status, body), {
    http: status,
    detail: detail != null ? detail : clip(body, 300),
    retryAfterMs: Number(status) === 429 ? retryAfterMsOf(headers, body) : 0
  });
}

const NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
// A TLS failure (a TLS-intercepting proxy's certificate, an expired or self-signed chain, a protocol mismatch): the
// connection was refused on the way to the provider — never a bug in the station's own handler.
const TLS_CODE = /^(?:CERT_|ERR_TLS_|ERR_SSL_|SELF_SIGNED_CERT|UNABLE_TO_(?:VERIFY|GET)_|DEPTH_ZERO_SELF_SIGNED|HOSTNAME_MISMATCH|INVALID_CA)/;

/* A THROWN failure: a coded error (edgetts.js sets err.speechCode) keeps its code; an abort the CALLER caused is
   'cancelled'; a timeout or connection (socket or TLS) failure is transient; anything else threw from our own code:
   internal_error. */
function errorLeg(engine, err, ctx) {
  const e = err || {};
  const msg = clip((e && e.message) || e, 300);
  if (typeof e.speechCode === 'string') return leg(engine, e.speechCode, { http: e.http, detail: msg, retryAfterMs: e.retryAfterMs });
  if (ctx && ctx.cancelled) return leg(engine, 'cancelled', { detail: msg });
  const code = String(e.code || (e.cause && e.cause.code) || '');
  if (/^UND_ERR_.*TIMEOUT$/.test(code) || e.name === 'TimeoutError' || e.name === 'AbortError' || /\btime(?:d)?[ -]?out\b/i.test(msg)) return leg(engine, 'timeout', { detail: msg });
  if (NET_CODES.has(code) || TLS_CODE.test(code) || /fetch failed|socket|network|ECONN|ENOTFOUND|EAI_AGAIN|certificate|\bSSL\b|\bTLS\b/i.test(msg)) return leg(engine, 'network', { detail: msg });
  return leg(engine, 'internal_error', { detail: msg });
}

// The public leg shape is exactly {engine, code, http, detail}; retryAfterMs rolls up to the outcome.
const publicLeg = l => ({ engine: l.engine, code: l.code, http: l.http, detail: l.detail });

function outcome(legs) {
  const list = (legs || []).filter(Boolean);
  if (!list.length) list.push(leg('station', 'internal_error', { detail: 'no leg was tried' }));
  const transient = list.filter(l => !isTerminalCode(l.code));
  const find = c => list.find(l => l.code === c);
  const deciding = find('billing') || find('auth') || transient[0]
    || list.slice().reverse().find(l => l.code !== 'no_key' && l.code !== 'disabled')
    || find('no_key') || list[list.length - 1];
  const retryAfterMs = transient.length && transient.every(l => l.retryAfterMs > 0)
    ? Math.min.apply(null, transient.map(l => l.retryAfterMs)) : 0;
  return { ok: false, terminal: transient.length === 0, retryAfterMs, code: deciding.code, engine: deciding.engine, legs: list.map(publicLeg) };
}
function success(engine) {
  return { ok: true, terminal: false, retryAfterMs: 0, code: 'ok', engine: String(engine || ''), legs: [{ engine: String(engine || ''), code: 'ok', http: 0, detail: '' }] };
}

/* A ladder records each failed leg ONCE, with the legacy text that leg contributed to the old reason string, so the
   typed outcome and the one-release `reason` can never disagree about what was tried. */
function ladder() {
  const legs = [], texts = [];
  return {
    legs,
    fail(l, text) { if (l) legs.push(l); if (text) texts.push(String(text)); return l; },
    reason(fallback) { return texts.join('; ') || String(fallback || ''); },
    outcome() { return outcome(legs); }
  };
}

/* LAST OUTCOME PER LEG (GET /api/tts/status): every attempt any ladder makes is recorded here, so the speaker
   tooltip, the canary and a diagnostic can name the leg that actually failed (or answered) — and when. Bounded by
   the engine vocabulary. No secrets: a leg carries a code, a status and a short detail only. */
function makeSpeechStatus(o) {
  const now = typeof (o && o.now) === 'function' ? o.now : (() => 0);
  const byEngine = new Map();
  let last = null;
  function note(engine, entry) {
    byEngine.set(engine, entry);
    if (byEngine.size > 32) byEngine.delete(byEngine.keys().next().value);
  }
  return {
    // result = a success(engine) or an outcome(legs); source = 'tts' | 'agent' | 'remote' | 'stt' | 'self-probe'
    record(result, source) {
      if (!result) return;
      // a malformed request says nothing about an engine, and a caller that went away is not the engine's failure
      const legs = (result.legs || []).filter(l => l && l.engine !== 'request' && l.code !== 'cancelled');
      if (!legs.length) return;
      const at = now();
      const src = String(source || 'tts');
      for (const l of legs) note(l.engine, { at, ok: l.code === 'ok', code: l.code, http: l.http || 0, detail: l.detail || '', source: src });
      last = { at, ok: !!result.ok, terminal: !!result.terminal, code: result.code, engine: result.engine || '', source: src };
    },
    snapshot() {
      const legs = {};
      for (const [engine, entry] of byEngine) legs[engine] = Object.assign({}, entry);
      return { legs, last: last ? Object.assign({}, last) : null };
    }
  };
}

module.exports = { CODES, isKnownCode, isTerminalCode, leg, httpLeg, httpCode, errorLeg, retryAfterMsOf, outcome, success, ladder, makeSpeechStatus };
