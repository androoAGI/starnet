/* sidecar/credits.js — the managed-credit BACKEND adapter that turns sidecar/billing.js's injected
   `payment` client into a real thing, behind explicit config.

   billing.js owns the run-scoped admission math (reserve on beginRun, refund headroom on finishRun) and
   calls its payment client SYNCHRONOUSLY — `payment.balance(accountId)` must return a number right now,
   not a promise. A live HTTP round-trip can't answer synchronously, so this module keeps a CACHED balance
   (refreshed out-of-band by the host before admission) and makes debit/credit OPTIMISTIC: they adjust the
   cache immediately and POST the truth to the backend in the background. The backend ledger stays the
   source of truth; refresh() reconciles the cache to it.

   HONESTY LAW: when STARNET_CREDITS_URL is unset, configured() is false and NOTHING here is live — no
   payment client is built, beginRun/finishRun are inert pass-throughs, and the host renders no STORE UI
   and exposes no /api/credits surface. A managed-credit account only exists when the operator wires it.

   Contract with the credits backend (all under the configured base URL, bearer-authed when a key is set):
     GET  {url}/v1/balance?account=<id>            -> { balanceUsd: number }
     POST {url}/v1/debit   { account, usd, meta }  -> { ok: true, balanceUsd? } | { ok:false, reason }
     POST {url}/v1/credit  { account, usd, meta }  -> { ok: true, balanceUsd? } | { ok:false, reason }
     GET  {url}/v1/history?account=<id>&limit=<n>  -> { entries: [{ ts, kind, usd, runId?, balanceUsd? }] }
   The PURCHASE flow is deliberately NOT an API: buying credits opens {purchaseUrl} in the browser — this
   app never renders a payment form or touches card data.

   Pure-ish: all IO is the injected `fetch` + `clock`; no globals. Unit-testable with a fake fetch. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./billing.js') : (root.SK && root.SK.billing));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).credits = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (billingMod) {
  'use strict';

  const makeBilling = billingMod && billingMod.makeBilling;

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function trimSlash(u) { return str(u).replace(/\/+$/, ''); }

  // an inert credits adapter — the shape the host always gets, so call sites never branch on null. When
  // unconfigured every method is a no-op and configured() is false, so no managed run, UI, or API appears.
  function inert() {
    return {
      configured() { return false; },
      accountId() { return ''; },
      purchaseUrl() { return ''; },
      mode() { return 'byok'; },
      beginRun() { return { ok: true, mode: 'byok', managed: false, skipped: true }; },
      finishRun() { return { ok: true, settled: true, skipped: true }; },
      refresh() { return Promise.resolve(null); },
      snapshot() { return { configured: false, accountId: '', balanceUsd: null, purchaseUrl: '', authStatus: 'absent', lastErrorStatus: 0 }; },
      history() { return Promise.resolve({ entries: [] }); }
    };
  }

  /* opts: {
       url, apiKey, accountId, purchaseUrl,   // config (url empty => inert)
       fetch, clock, ledger,                  // injected IO + the shared spend ledger (managed final truth)
       onError,                               // optional: (stage, err) => void — background POST failures
       lowBalanceUsd,                         // number OR () => number — warn at/below this balance; 0 disables
       emit                                   // optional: (name, payload) => void — bus emit for 'credits.low'
     } */
  function makeCredits(opts) {
    opts = opts || {};
    const url = trimSlash(opts.url);
    if (!url || typeof makeBilling !== 'function') return inert();

    const apiKey = str(opts.apiKey);
    const accountId = str(opts.accountId) || 'default';
    const purchaseUrl = str(opts.purchaseUrl) || (url + '/buy');
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    const clock = opts.clock || { now() { return 0; } };   // host injects the wall clock (index.js); default is inert (determinism law)
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {};

    // cached balance snapshot the SYNC payment client reads. null = never fetched -> fail closed (a managed
    // run refuses rather than spending against an unknown balance). refresh() populates/reconciles it.
    // `subscription` and `manageUrl` ride the same /v1/balance response (a backend that doesn't send them
    // simply leaves them null, and the STORE renders no plan line — never an invented one).
    // `authStatus` is the server's verdict on this credential, not mere local token presence:
    //   unknown     — no balance round-trip has completed yet
    //   valid       — the backend accepted the bearer for this account
    //   invalid     — a definitive 401/403; the device was revoked or belongs to another account
    //   unavailable — transport/5xx failure; do not mislabel it as revocation
    // The distinction matters for linked stations: the account page can revoke a device while this app
    // still has its old keychain token. Local presence must never keep painting "LINKED" after the cloud
    // has rejected it.
    const cache = { balanceUsd: null, at: 0, subscription: null, manageUrl: '', authStatus: 'unknown', lastErrorStatus: 0 };

    /* ---- LOW-BALANCE WARNING ------------------------------------------------------------------
       Without this, a managed run just stops at $0 with no warning — the user's first signal that
       they ran out is work failing. That is the same dishonesty as a silent gauge: the harness knew
       and did not say.

       WHY IT LIVES HERE: every path that can move the balance (refresh, the optimistic debit, the
       authoritative debit/credit responses) funnels through setBalance() below, so this is the one
       choke point where "the balance went down" is observable. Detecting it at the call sites would
       mean four detectors and a missed one.

       LATCHING: fire ONCE per crossing, not once per run. Nagging every turn is how a warning gets
       ignored, and the balance moves on every debit. The latch clears only when the balance climbs
       back above threshold × REARM (hysteresis) — a bare `> threshold` re-arm would re-fire on the
       cent-level jitter of a refund settling against a debit.

       TWO LEVELS, SEPARATE LATCHES: 'low' (you should top up) and 'exhausted' (<= 0, work WILL be
       refused). Exhausted must be able to fire even when low already did, or the one that actually
       stops the station is the one that stays silent. */
    const REARM = 1.25;
    const warned = { low: false, exhausted: false };
    // Local reservations are already subtracted from cache.balanceUsd. Add them back only when deciding whether
    // the ACCOUNT is low; otherwise two concurrent healthy runs could make each other's temporary holds look
    // like settled spend. Admission continues to use the raw cache and therefore cannot oversubscribe funds.
    const reservations = new Map();
    const emitFn = typeof opts.emit === 'function' ? opts.emit : null;
    // number or getter — index.js passes a getter so a live per-run cap change is picked up without a restart
    function lowThreshold() {
      const raw = typeof opts.lowBalanceUsd === 'function' ? opts.lowBalanceUsd() : opts.lowBalanceUsd;
      const n = num(raw);
      return n > 0 ? n : 0;   // 0 (or unset/garbage) disables the warning entirely
    }

    // Warning evaluation is separate from cache mutation because a managed debit is a RESERVATION, not spend.
    // An uncapped run reserves the whole wallet, temporarily taking spendable balance to $0; treating that hold
    // as exhaustion produced a false "$0 left" warning on every input. Settlement below calls this explicitly,
    // while refresh/refund paths evaluate it through setBalance as before.
    function evaluateWarning(available) {
      if (available == null) return;              // unknown ≠ low
      let b = available;
      for (const held of reservations.values()) b += held;
      const t = lowThreshold();
      if (!emitFn || !(t > 0)) return;

      if (b <= 0 && !warned.exhausted) {
        warned.exhausted = true; warned.low = true;
        try { emitFn('credits.low', { balanceUsd: b, thresholdUsd: t, purchaseUrl, exhausted: true }); } catch (_) {}
        return;
      }
      if (b > 0 && b <= t && !warned.low) {
        warned.low = true;
        try { emitFn('credits.low', { balanceUsd: b, thresholdUsd: t, purchaseUrl, exhausted: false }); } catch (_) {}
        return;
      }
      if (b > t * REARM) { warned.low = false; warned.exhausted = false; }   // topped up — arm for next time
    }

    // The ONLY writer of cache.balanceUsd. Every caller goes through here so authority ordering and warning
    // classification cannot drift apart. `warn === false` is reserved for temporary billing holds.
    function setBalance(v, warn) {
      const b = (typeof v === 'number' && isFinite(v)) ? v : null;
      cache.balanceUsd = b;
      cache.at = clock.now();
      if (warn !== false) evaluateWarning(b);
    }

    // A background debit/credit POST FAILED, so the optimistic cache no longer reflects a state we can trust
    // (the debit may or may not have landed on the backend). Rather than let the cache DRIFT — and admit later
    // runs against a fictional balance — INVALIDATE it (null). The next admission then fail-closes cleanly
    // (payment.balance() throws -> billing returns managed_credit_unavailable) and refresh() re-reads the
    // authoritative backend balance right before that admission, self-healing the drift. Loud on the way out.
    function onPostFailure(stage, e, seq) {
      const current = seq == null || seq === authoritySeq;
      if (current) setBalance(null);   // fail-closed until the next authoritative refresh reconciles
      try { console.warn('[credits] ' + stage + ' POST failed (status ' + ((e && e.status) || '?') + '); ' + (current ? 'invalidating cached balance -> next managed run fail-closes until refresh reconciles' : 'newer balance authority already won; leaving it intact')); } catch (_) {}
      onError(stage, e);
    }

    function headers(extra) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
      if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
      return h;
    }
    // The bearer and account are one identity established when this adapter is built. Callers may not redirect
    // a linked token's balance/debit/history to an arbitrary or stale account id; env setups already build their
    // adapter with the env account, while linked setups build it with the confirmed account from credits.json.
    function acct() { return accountId; }

    const requestTimeoutMs = (typeof opts.requestTimeoutMs === 'number' && isFinite(opts.requestTimeoutMs) && opts.requestTimeoutMs > 0)
      ? Math.floor(opts.requestTimeoutMs) : 8000;
    async function boundedJson(target, init, parseErrorBody) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      const request = Object.assign({}, init || {}, ctl ? { signal: ctl.signal } : {});
      if (ctl) timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
      try {
        const response = await doFetch(target, request);
        // Fetch resolves at headers, not at the end of the response body. The timeout owns both phases so a
        // half-responsive credits service cannot strand admission/status/history on an endless JSON body.
        let body = {};
        if (response && typeof response.json === 'function' && (response.ok || parseErrorBody)) {
          try { body = await response.json(); }
          catch (error) {
            if (error && error.name === 'AbortError') throw error;
            body = {};
          }
        }
        return { response, body };
      }
      finally { if (timer) clearTimeout(timer); }
    }

    async function getJson(pathAndQuery) {
      if (!doFetch) throw new Error('no fetch');
      const result = await boundedJson(url + pathAndQuery, { method: 'GET', headers: headers() }, false);
      const r = result.response;
      if (!r || !r.ok) { const e = new Error('credits GET ' + pathAndQuery + ' failed'); e.status = r && r.status; throw e; }
      return result.body;
    }
    async function postJson(pathName, payload) {
      if (!doFetch) throw new Error('no fetch');
      const result = await boundedJson(url + pathName, { method: 'POST', headers: headers(), body: JSON.stringify(payload || {}) }, true);
      const r = result.response;
      const body = result.body;
      if (!r || !r.ok) { const e = new Error('credits POST ' + pathName + ' failed'); e.status = r && r.status; e.body = body; throw e; }
      return body || {};
    }

    // pull the authoritative balance and reconcile the cache. Awaited by the host at boot and right before
    // a managed run's admission, so the sync balance() below is fresh. Never throws to the caller.
    // Every balance-affecting network request gets one ticket. A delayed old GET/POST may finish, but it cannot
    // overwrite a newer top-up refresh, debit, credit, or auth verdict with yesterday's zero/failure.
    let authoritySeq = 0;
    async function refresh() {
      const seq = ++authoritySeq;
      try {
        const j = await getJson('/v1/balance?account=' + encodeURIComponent(acct()));
        const rawBalance = j && (j.balanceUsd != null ? j.balanceUsd : j.balance);
        // The cloud contract says NUMBER. Missing/NaN/string data is "unavailable", never zero: num(undefined)
        // used to turn a malformed 200 into $0 and the onboarding screen then told a paid customer to buy more.
        if (typeof rawBalance !== 'number' || !isFinite(rawBalance)) {
          const malformed = new Error('credits balance response missing a finite numeric balance');
          malformed.code = 'credits_balance_invalid';
          throw malformed;
        }
        const b = rawBalance;
        // Plan state is whatever the backend just said, INCLUDING null — a cancelled subscription must be
        // able to clear the tier line, not leave the last-known plan on screen forever.
        // Requests can overlap (creator poll, STORE refresh, WAKE). An older `$0` response must never arrive
        // after a newer funded response and overwrite it. Only the newest-started refresh may mutate truth.
        if (seq === authoritySeq) {
          cache.subscription = (j && typeof j.subscription === 'object') ? j.subscription : null;
          if (j && j.manageUrl) cache.manageUrl = str(j.manageUrl);
          cache.authStatus = 'valid';
          cache.lastErrorStatus = 0;
          setBalance(b);
        }
        return b;
      } catch (e) {
        // Never keep a stale dollar amount after an authoritative refresh failed. This was the 0.10.8
        // escape: a station revoked on the account site kept its cached $0, so the app asserted both
        // "LINKED" and "no credits" while the real account held $22 and listed no linked stations.
        const status = Number(e && e.status) || 0;
        if (seq === authoritySeq) {
          setBalance(null);
          cache.lastErrorStatus = status;
          cache.authStatus = (status === 401 || status === 403) ? 'invalid' : 'unavailable';
        }
        onError('refresh', e);
        return null;
      }
    }

    // the SYNCHRONOUS payment client billing.js drives. balance() reads the cache; debit/credit adjust it
    // optimistically and POST the truth in the background (fire-and-forget, reconciled on the next refresh).
    const payment = {
      balance(id) {
        if (cache.balanceUsd == null) throw new Error('credit_balance_unknown');   // -> managed_credit_unavailable (fail closed)
        return cache.balanceUsd;
      },
      debit(id, usd, meta) {
        const amt = num(usd);
        const seq = ++authoritySeq;
        // The optimistic hold keeps synchronous admission safe while the debit POST is in flight.
        // Warning evaluation deliberately waits for settlement: this number includes reserved funds.
        // This is available balance after a temporary reservation, not settled account spend. In the default
        // uncapped path `amt` is the whole wallet, so evaluating it would fabricate exhaustion every run.
        if (cache.balanceUsd != null) setBalance(Math.max(0, cache.balanceUsd - amt), false);
        postJson('/v1/debit', { account: acct(), usd: amt, meta: meta || {} })
          .then(body => {
            if (!body || body.balanceUsd == null) return;
            if (typeof body.balanceUsd !== 'number' || !isFinite(body.balanceUsd)) {
              const malformed = new Error('credits debit response contained a non-numeric balance');
              malformed.code = 'credits_balance_invalid';
              return onPostFailure('debit', malformed, seq);
            }
            if (seq === authoritySeq) setBalance(body.balanceUsd, false);
          })
          .catch(e => onPostFailure('debit', e, seq));
        return { ok: true };
      },
      credit(id, usd, meta) {
        const amt = num(usd);
        const seq = ++authoritySeq;
        // The owning reservation remains in reservations until billing.finishRun returns. Suppress this
        // intermediate mutation; finishRun evaluates after removing that hold, and the POST response below
        // evaluates the authoritative balance as well.
        if (cache.balanceUsd != null) setBalance(cache.balanceUsd + amt, false);   // optimistic refund
        postJson('/v1/credit', { account: acct(), usd: amt, meta: meta || {} })
          .then(body => {
            if (!body || body.balanceUsd == null) return;
            if (typeof body.balanceUsd !== 'number' || !isFinite(body.balanceUsd)) {
              const malformed = new Error('credits credit response contained a non-numeric balance');
              malformed.code = 'credits_balance_invalid';
              return onPostFailure('credit', malformed, seq);
            }
            if (seq === authoritySeq) setBalance(body.balanceUsd);
          })
          .catch(e => onPostFailure('credit', e, seq));
        return { ok: true };
      }
    };

    const billing = makeBilling({ payment, ledger: opts.ledger || null, clock });

    // wrap billing so callers pass a run and we stamp the managed mode + account automatically. Callers still
    // get billing.js's exact result shape (ok/mode/managed/reason/...). Missing capUsd => byok fall-through.
    function beginRun(o) {
      o = o || {};
      const capUsd = num(o.capUsd);
      if (!(capUsd > 0)) return billing.beginRun({ mode: 'byok', runId: str(o.runId), agentId: str(o.agentId) });
      const out = billing.beginRun({ mode: 'managed', accountId: acct(), runId: str(o.runId), agentId: str(o.agentId), capUsd });
      const status = out && out.ok && out.managed ? billing.status(str(o.runId)) : null;
      if (status && !status.settled) reservations.set(str(o.runId), num(out.reservedUsd));
      return out;
    }
    function finishRun(o) {
      o = o || {};
      const runId = str(o.runId);
      const out = billing.finishRun(o);
      // Refunds synchronously update the cache before billing returns. Remove this run's hold, then evaluate
      // the settled account balance (raw availability + any OTHER live reservations). A run that consumes its
      // entire reservation has no refund call, so this seam is also what preserves real exhaustion warnings.
      if (out && out.ok && out.mode === 'managed' && out.settled) {
        reservations.delete(runId);
        evaluateWarning(cache.balanceUsd);
      }
      return out;
    }

    async function history(id, limit) {
      try {
        const j = await getJson('/v1/history?account=' + encodeURIComponent(acct()) + '&limit=' + (Number(limit) > 0 ? Math.floor(Number(limit)) : 20));
        return { entries: Array.isArray(j && j.entries) ? j.entries : [] };
      } catch (e) { onError('history', e); return { entries: [], error: 'unreachable' }; }
    }

    return {
      configured() { return true; },
      mode() { return 'managed'; },
      accountId() { return accountId; },
      purchaseUrl() { return purchaseUrl; },
      beginRun, finishRun, refresh, history,
      snapshot() {
        return {
          configured: true, accountId, balanceUsd: cache.balanceUsd, at: cache.at, purchaseUrl,
          subscription: cache.subscription,                 // null until the backend reports one
          manageUrl: cache.manageUrl || purchaseUrl,        // where "manage subscription" opens in the browser
          authStatus: cache.authStatus,
          lastErrorStatus: cache.lastErrorStatus
        };
      }
    };
  }

  return { makeCredits, _internals: { inert } };
});
