/* Central, pure recovery decisions for model-stream failures.
 *
 * The loop performs the actions; this module owns ordering and boundedness so provider adapters, fallback
 * wiring, and future UIs read one policy instead of reimplementing subtly different retry ladders. Tool retries
 * are deliberately much narrower: only host-defined reads with a clearly transient failure may be repeated. */
'use strict';

const RETRY_DELAYS_MS = [400, 1200, 4000, 10000, 30000, 60000];
// The ladder's total LOCAL patience for one model turn (~105.6s). Jitter may reshape the rungs but never
// stretches the sum past this; a server-stated Retry-After is honored on top (each capped at MAX_SERVER_WAIT_MS,
// at most one per rung), exactly as before.
const RETRY_PATIENCE_MS = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const MAX_SERVER_WAIT_MS = 60000;
/* ±20% JITTER. Seven to ten agents commonly share ONE provider key; when that provider blips they all fail in
   the same second and — on a fixed ladder — all come back in the same second too, re-creating the spike that
   tripped the limit. The caller passes the DRAWN sample (the loop's injectable o.random), so this module stays
   pure and tests stay deterministic: a sample of 0.5 is the un-jittered rung. */
const RETRY_JITTER = 0.2;
/* Classes a loop may keep retrying AFTER an adapter exhausted its own pre-stream ladder. Deliberately the
   genuinely transient ones only: auth / billing / quota_exhausted / content-policy / format / output_cap are
   non-retryable anyway, and `unknown` is excluded because "the same unrecognized refusal three times in a row"
   is evidence, not a blip. `unreachable` continues as `timeout` did in 0.14.1: a public host rides the ladder, and a local
   one is held to its retryBudget of one (errorClass unreachableIsLocal), which the adapter has already spent. */
const PRESTREAM_CONTINUABLE = { overloaded: 1, server_error: 1, timeout: 1, rate_limit: 1, unreachable: 1 };

function finite(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function jitteredDelay(ms, sample) {
  const base = Math.max(0, finite(ms, 0));
  const r = Number(sample);
  if (!Number.isFinite(r)) return base;                      // no sample -> the plain rung (pure callers, old tests)
  const u = Math.min(1, Math.max(0, r));
  return Math.round(base * (1 + RETRY_JITTER * (2 * u - 1)));
}

/* COUNT THE ADAPTER'S ATTEMPTS AGAINST THE LADDER. An adapter that exhausted its own pre-stream retries already
   spent the ladder's first rungs (its 400/1200ms delays ARE rungs 0 and 1). Returns what it spent so the loop
   can advance its rung index and patience clock by exactly that much — the combined ladder is then never longer
   than the mid-stream one, instead of the old choice between multiplying (3 POSTs x 5 loop rounds = 15) and
   giving up after 1.6s. Adapters stamp preStreamAttempts / preStreamWaitMs (provider.js
   markPreStreamRetriesExhausted); an unstamped marker is assumed to be the standard two-retry ladder. */
function preStreamSpend(err) {
  const e = err || {};
  if (!e.preStreamRetriesExhausted) return { rungs: 0, waitedMs: 0 };
  const attempts = Number.isFinite(Number(e.preStreamAttempts)) && Number(e.preStreamAttempts) >= 1
    ? Math.floor(Number(e.preStreamAttempts)) : 3;
  const rungs = Math.max(0, attempts - 1);
  let assumed = 0;
  for (let k = 0; k < rungs; k++) assumed += RETRY_DELAYS_MS[Math.min(k, RETRY_DELAYS_MS.length - 1)];
  const waitedMs = Number.isFinite(Number(e.preStreamWaitMs)) && Number(e.preStreamWaitMs) >= 0 ? Number(e.preStreamWaitMs) : assumed;
  return { rungs, waitedMs };
}

/* A STALLED PROVIDER (Step 2 F4, Hermes audit 2026-09-22). The idle watchdog (providers/provider.js timeoutError)
   stamps its error { code: 'PROVIDER_STREAM_TIMEOUT', phase: 'idle' }: the stream connected and then sent NOTHING
   for the whole idle window (300s by default). That classifies as an ordinary retryable `timeout`, so the ladder
   below used to spend every rung on it — up to 7 attempts x 300s, ~37 minutes of silence on one turn. One stall
   can be a slow deep-reasoning turn; two in a row on the same provider/model is a provider that has stopped
   answering. MAX_IDLE_STALLS consecutive stalls (counted by the caller, reset by any other failure class or a
   fallback switch) end the ladder: a configured fallback is taken, otherwise the turn fails 'provider_stalled'.
   A CONNECT-phase timeout (30s, no headers) is deliberately NOT a stall — it is cheap and stays on the ladder. */
const MAX_IDLE_STALLS = 2;
function isIdleStall(err) {
  return !!(err && typeof err === 'object' && err.code === 'PROVIDER_STREAM_TIMEOUT' && err.phase === 'idle');
}

function providerFailure(input) {
  const i = input || {};
  const cls = i.classification || {};
  if (i.cancelled) return { action: 'fail', reason: 'cancelled', retryable: false, delayMs: 0 };
  /* OUTPUT CAP: the provider refused the requested max_tokens and NAMED its ceiling. Retry the same turn ONCE with
     the output budget lowered to it — no fold (the prompt was never the problem), no fallback, no wait. A second
     refusal, or one with no readable ceiling, is terminal: the same body would be refused identically. */
  if (cls.reason === 'output_cap') {
    const allowed = Math.floor(finite(cls.allowedMaxTokens, 0));
    if (allowed > 0 && !i.outputCapRetried) return { action: 'lower_output', reason: 'output_cap', retryable: true, delayMs: 0, maxTokens: allowed };
    return { action: 'fail', reason: 'output_cap', retryable: false, delayMs: 0 };
  }
  // STALLED PROVIDER — see isIdleStall. Callers that do not count stalls (idleStalls absent) are unaffected.
  const maxIdle = Math.max(0, Math.floor(finite(i.maxIdleStalls, MAX_IDLE_STALLS)));
  if (maxIdle > 0 && Math.floor(finite(i.idleStalls, 0)) >= maxIdle) {
    if (i.hasFallback && finite(i.recoveriesUsed, 0) < finite(i.maxRecoveries, 0)) {
      return { action: 'fallback', reason: 'provider_stalled', retryable: true, delayMs: 0, rotate: false };
    }
    return { action: 'fail', reason: 'provider_stalled', retryable: true, delayMs: 0 };
  }
  if (cls.shouldCompress && i.canCompress && finite(i.recoveriesUsed, 0) < finite(i.maxRecoveries, 0)) {
    return { action: 'compress', reason: String(cls.reason || 'context_overflow'), retryable: true, delayMs: 0 };
  }
  if ((cls.shouldFallback || cls.shouldRotateCredential) && i.hasFallback
      && finite(i.recoveriesUsed, 0) < finite(i.maxRecoveries, 0)) {
    return { action: 'fallback', reason: String(cls.reason || 'provider_failure'), retryable: true, delayMs: 0, rotate: !!cls.shouldRotateCredential };
  }
  const retriesUsed = Math.max(0, finite(i.retriesUsed, 0));
  // a class that names a smaller budget (errorClass unreachable: ONE retry) caps the ladder; the adapters cap their own
  // pre-stream ladders the same way (provider.runtime.retryLimit), so the two together still make one retry
  const budget = typeof cls.retryBudget === 'number' && cls.retryBudget >= 0 ? cls.retryBudget : Infinity;
  const maxRetries = Math.min(budget, Math.max(0, finite(i.maxRetries, RETRY_DELAYS_MS.length)));
  const fallbackUnavailable = !cls.shouldFallback || !i.hasFallback;
  /* An adapter-exhausted pre-stream failure used to end the run outright (a 4x503 blip killed a single-provider
     run in 1.6s). It now CONTINUES the same bounded ladder for the transient classes — the caller has already
     advanced retriesUsed/waitedMs by the adapter's spend (preStreamSpend), so nothing is multiplied. */
  const ladderOpen = !i.preStreamRetriesExhausted || PRESTREAM_CONTINUABLE[cls.reason] === 1;
  if (ladderOpen && cls.retryable && fallbackUnavailable && retriesUsed < maxRetries) {
    // a class that names a floor for its wait (errorClass retryDelayMs: a failed name lookup waits out a blip) waits at least that
    const floorMs = Math.max(0, finite(cls.retryDelayMs, 0));
    const local = Math.max(floorMs, jitteredDelay(RETRY_DELAYS_MS[Math.min(retriesUsed, RETRY_DELAYS_MS.length - 1)], i.jitterSample));
    const stated = Math.min(MAX_SERVER_WAIT_MS, Math.max(0, finite(cls.retryAfterMs, 0)));
    if (stated > 0 && stated >= local) {
      // The server named its wait: honor it (never earlier), capped, with UPWARD-only jitter so agents sharing a
      // key do not all return on the same tick. It does not draw on the local patience budget.
      const up = Number.isFinite(Number(i.jitterSample)) ? Math.round(stated * RETRY_JITTER * Math.min(1, Math.max(0, Number(i.jitterSample)))) : 0;
      return { action: 'retry', reason: String(cls.reason || 'transient'), retryable: true, delayMs: Math.min(MAX_SERVER_WAIT_MS, stated + up), ladderMs: 0 };
    }
    let delayMs = Math.min(MAX_SERVER_WAIT_MS, local);
    // Local patience (only when the caller tracks it): the jittered ladder may never exceed RETRY_PATIENCE_MS in
    // total — the last rung shrinks to fit, and a spent budget ends the ladder like a spent rung count does.
    if (i.waitedMs != null) {
      const remaining = Math.max(0, finite(i.patienceMs, RETRY_PATIENCE_MS)) - Math.max(0, finite(i.waitedMs, 0));
      if (remaining <= 0) return { action: 'fail', reason: String(cls.reason || 'unrecoverable'), retryable: !!cls.retryable, delayMs: 0 };
      delayMs = Math.min(delayMs, remaining);
    }
    return { action: 'retry', reason: String(cls.reason || 'transient'), retryable: true, delayMs, ladderMs: delayMs };
  }
  return { action: 'fail', reason: String(cls.reason || 'unrecoverable'), retryable: !!cls.retryable, delayMs: 0 };
}

function transientToolReason(result) {
  const r = result || {};
  const summary = String(r.summary || '').toLowerCase();
  const content = String(r.content || '').toLowerCase();
  if (summary === 'timeout' || /\btimed out\b/.test(content)) return 'timeout';
  if (/\b(?:econnreset|econnrefused|etimedout|enotfound|eai_again)\b|socket hang up|network error|fetch failed|temporar(?:y|ily) unavailable|connection (?:reset|closed|lost)/.test(content)) return 'network';
  if (/\bhttp (?:408|425|429|500|502|503|504)\b|\bstatus (?:408|425|429|500|502|503|504)\b|\brate limit(?:ed)?\b|\btoo many requests\b/.test(content)) return 'upstream';
  return '';
}

function toolFailure(input) {
  const i = input || {};
  const tool = i.tool || {};
  const result = i.result || {};
  if (i.cancelled) return { action: 'fail', reason: 'cancelled', retryable: false, delayMs: 0 };
  // `scope` and `readOnly` are trusted only for host registrations. MCP annotations never cross this gate.
  if (tool.provenance !== 'host' || tool.scope !== 'read' || tool.readOnly !== true || !result.isError) {
    return { action: 'fail', reason: 'not_retry_safe', retryable: false, delayMs: 0 };
  }
  const reason = transientToolReason(result);
  if (!reason) return { action: 'fail', reason: 'not_transient', retryable: false, delayMs: 0 };
  const retriesUsed = Math.max(0, finite(i.retriesUsed, 0));
  const maxRetries = Math.max(0, finite(i.maxRetries, 1));
  if (retriesUsed >= maxRetries) return { action: 'fail', reason, retryable: true, delayMs: 0 };
  return { action: 'retry', reason, retryable: true, delayMs: RETRY_DELAYS_MS[Math.min(retriesUsed, RETRY_DELAYS_MS.length - 1)] };
}

module.exports = {
  providerFailure, preStreamSpend, jitteredDelay, toolFailure, transientToolReason, isIdleStall,
  RETRY_DELAYS_MS, RETRY_PATIENCE_MS, RETRY_JITTER, PRESTREAM_CONTINUABLE, MAX_IDLE_STALLS
};
