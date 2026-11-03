/* sidecar/respond.js — tiny shared HTTP response/validation helpers for index.js routes.

   index.js grew ~95 per-handler copies of the same three-line `json(code, obj)` closure (plus
   `sendJson` variants) and a dozen copies of the agent-id regex. This module is the ONE canonical
   copy, adopted INCREMENTALLY: new routes and touched handlers rebind their local closure to
   `json(res, ...)` here; untouched handlers keep their inline copy until a change brings them in.
   (Mass-migrating all of index.js at once is deliberately avoided — many parallel branches merge
   into that file, and a 95-site sweep would conflict with all of them.)

   ONE FAILURE SHAPE ON THE WIRE: every answer >= 400 names itself in X-StarNet-Code, a code from CODES.
   fail() is the canonical failure path (json() stays for success); stampFailureCodes() runs first in the
   main request handler, so a failure no change has brought in yet still carries its status default. A
   reader decides from the code, never from a bare status or a word ("forbidden" is not "the station
   restarted").

     json(res, code, obj)                 — application/json + no-store; no-op once headersSent
     fail(res, status, code, message, extra)
                                          — {...extra, ok:false, code, error: message} with X-StarNet-Code set to
                                            the same code (+ no-store); a code outside CODES is written as the
                                            status default; true when it answered, false (no-op) once headersSent
     stampFailureCodes(res)               — wraps res.writeHead once: a status >= 400 with no code yet gets
                                            failureCodeFor(status), on an explicit writeHead or an implicit one
                                            (write()/end() after a statusCode assignment). An explicit code always
                                            wins (writeHead's own headers override setHeader). It never changes a
                                            status, a body or another header, never touches a 1xx/2xx/3xx answer or
                                            a stream, and leaves a writeHead after the head went out to Node.
     failureCodeFor(status)               — an unlabelled failure's code: its status row, else refused (4xx) or
                                            station_error (5xx); '' below 400
     CODES                                — code -> the HTTP status it rides (frozen)
     readJsonBody(req, readBody, max, res)-> parsed body ({} for empty/null) | null on bad JSON /
                                            read failure. Pass index.js's own readBody in (it owns
                                            the 413-too-large answer when res is provided).
     isAgentId(s)                         — the ID_RE shape every roster/cron/orchestration route
                                            enforces on agent ids (defense in depth over the fs jail).
     refuseBadAgentId(res, id)            — the ONE answer to a malformed agent id on every agent route: 400
                                            bad_agent_id in the fail() envelope. True when the id was refused (the
                                            caller returns), even once the head went out; false for a valid id. A
                                            malformed id is a bad request, never a 403 (a reader must not take it
                                            for a refused key or a lost station).

   Pure over (res, req) — no fs, no stores, no secrets; nothing here may synthesize state
   (truthful telemetry applies to JSON, not just pixels). */
'use strict';

// The canonical agent-id shape (ID_RE across roster/cron/orchestration surfaces): a crafted id
// must not be able to key outside its own workspace/checkpoint/grant lane.
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isAgentId(s) { return typeof s === 'string' && AGENT_ID_RE.test(s); }

/* THE ONE TABLE: every code the station writes in X-StarNet-Code (and in a fail() body), with the status it rides.
   The names deliberately differ from the run's failureCode and provider-reason vocabulary (providers/errorClass.js:
   auth, rate_limit, server_error, timeout, model_not_found...), so no station refusal reads as a provider's. */
const CODES = Object.freeze({
  // the token gate (index.js refuseAtGate); its bodies stay the legacy text an older page's recovery reads
  token_stale: 403,         // a key or a ticket rode and was wrong: a page from before a restart (reload it)
  token_missing: 403,       // no key and no ticket rode: a page the station withheld its key from, or not a StarNet page
  forbidden_origin: 403,    // a browser page from an origin that is not this station's
  forbidden_host: 403,      // a Host that is not loopback (the DNS-rebinding floor)
  // routes
  bad_request: 400,
  bad_json: 400,
  bad_agent_id: 400,
  refused: 400,             // a refusal with no more specific name; an unlisted 4xx (401, 416, 422) keeps its own status
  forbidden: 403,
  wrong_owner: 403,
  path_refused: 403,
  ticket_refused: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  too_large: 413,
  frozen: 423,
  rate_limited: 429,
  station_error: 500,       // also an unlisted 5xx (501, 507)
  upstream_error: 502,
  unavailable: 503,
  upstream_timeout: 504
});
// an unlabelled failure's name, by status (several codes share 400 and 403; this is the plain one)
const STATUS_DEFAULTS = Object.freeze({
  400: 'bad_request', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large',
  423: 'frozen', 429: 'rate_limited', 500: 'station_error', 502: 'upstream_error', 503: 'unavailable', 504: 'upstream_timeout'
});
const CODE_HEADER = 'X-StarNet-Code';

function failureCodeFor(status) {
  const s = Number(status) | 0;
  if (s < 400) return '';
  return STATUS_DEFAULTS[s] || (s < 500 ? 'refused' : 'station_error');
}

// One JSON answer, exactly like the inline closures it replaces: no-store (telemetry must never
// cache-lie), and a silent no-op when headers already went out (e.g. readBody answered 413 first).
function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// One failure answer: the header and the body name the same code, and `extra` can never overwrite ok, code or error.
function fail(res, status, code, message, extra) {
  if (res.headersSent) return false;
  const name = Object.prototype.hasOwnProperty.call(CODES, code) ? code : failureCodeFor(status);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', [CODE_HEADER]: name });
  res.end(JSON.stringify(Object.assign({}, extra, { ok: false, code: name, error: String(message == null || message === '' ? name : message) })));
  return true;
}

// A missing id and a malformed one are both bad_agent_id; the sentence says which, so the page's line is true.
function refuseBadAgentId(res, id) {
  if (isAgentId(id)) return false;
  fail(res, 400, 'bad_agent_id', id == null || id === '' ? 'choose an agent first: no agent id came with this request'
    : 'that agent id is not valid (1-40 letters, digits, _ or -)');
  return true;   // refused even when the head already went out: a malformed id never reaches a store or the jail
}

const STAMPED = Symbol('starnet.failureCodes');
function stampFailureCodes(res) {
  if (!res || res[STAMPED] || typeof res.writeHead !== 'function') return res;
  const writeHead = res.writeHead;
  res[STAMPED] = true;
  res.writeHead = function stampedWriteHead(statusCode) {
    // headersSent first: setHeader after the head went out throws, and that writeHead is Node's to refuse
    if ((Number(statusCode) | 0) >= 400 && !this.headersSent && !this.hasHeader(CODE_HEADER)) this.setHeader(CODE_HEADER, failureCodeFor(statusCode));
    return writeHead.apply(this, arguments);
  };
  return res;
}

// Parse-or-null body reader matching the `JSON.parse(await readBody(...)) || {}` pattern used by
// every POST handler. Returns {} for an empty/`null` body (the existing `|| {}`), and null on ANY
// failure (bad JSON, or a readBody rejection — incl. 413 too-large, which readBody itself already
// answered when `res` was passed; the caller's json() no-ops after that thanks to the guard above).
async function readJsonBody(req, readBody, max, res) {
  try {
    const raw = await readBody(req, max, res);
    return String(raw == null ? '' : raw).trim() ? (JSON.parse(raw) || {}) : {};
  }
  catch (_) { return null; }
}

module.exports = { json, fail, stampFailureCodes, failureCodeFor, CODES, readJsonBody, isAgentId, refuseBadAgentId };
