/* node test/credits.test.js — the managed-credit BACKEND adapter (sidecar/credits.js): config-gating (unconfigured
   = ZERO surface) + the HTTP contract (fake fetch, no real network/money), incl. the sync-balance / optimistic
   debit-credit design billing.js relies on. */
'use strict';
const A = require('./_assert.js');
const { makeCredits } = require('../sidecar/credits.js');

const flush = () => new Promise(r => setTimeout(r, 0));   // let a fire-and-forget POST's .then run

// a fake credits backend: records every request, answers balance/debit/credit/history from an in-memory book.
function fakeFetch(seed) {
  const book = Object.assign({ default: 0 }, seed || {});
  const calls = [];
  const json = (obj, ok) => Promise.resolve({ ok: ok !== false, status: ok === false ? 500 : 200, json: () => Promise.resolve(obj) });
  const self = {
    calls, book,
    fail: false,   // set true to make every mutating POST 500 (drives the fail-closed / cache-invalidation paths)
    fetch(url, init) {
      const u = String(url);
      const method = (init && init.method) || 'GET';
      let body = {};
      try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (_) {}
      calls.push({ url: u, method, headers: (init && init.headers) || {}, body });
      if (u.indexOf('/v1/balance') >= 0) { const acct = /account=([^&]+)/.exec(u); const id = acct ? decodeURIComponent(acct[1]) : 'default'; return json({ balanceUsd: book[id] || 0 }); }
      if (self.fail && (u.indexOf('/v1/debit') >= 0 || u.indexOf('/v1/credit') >= 0)) return json({ ok: false, reason: 'backend down' }, false);
      if (u.indexOf('/v1/debit') >= 0) { const id = body.account || 'default'; book[id] = (book[id] || 0) - (body.usd || 0); return json({ ok: true, balanceUsd: book[id] }); }
      if (u.indexOf('/v1/credit') >= 0) { const id = body.account || 'default'; book[id] = (book[id] || 0) + (body.usd || 0); return json({ ok: true, balanceUsd: book[id] }); }
      if (u.indexOf('/v1/history') >= 0) { return json({ entries: [{ ts: 1, kind: 'debit', usd: 1 }] }); }
      return json({}, false);
    }
  };
  return self;
}

// ---- CONFIG GATING: no url => fully inert, zero surface, no payment calls ever ----
(async () => {
  {
    const ff = fakeFetch();
    const c = makeCredits({ url: '', fetch: ff.fetch });
    A.eq(c.configured(), false, 'no CREDITS_URL => configured() is false (renders no UI, /api/credits 404s)');
    A.eq(c.snapshot().configured, false, 'inert snapshot reports unconfigured');
    A.eq(c.mode(), 'byok', 'inert adapter is byok mode');
    const b = c.beginRun({ runId: 'r1', agentId: 'a', capUsd: 5 });
    A.eq(b.ok, true, 'inert beginRun is a pass-through (never blocks a BYOK run)');
    A.eq(b.managed, false, 'inert beginRun never marks a run managed');
    A.eq(c.finishRun({ runId: 'r1', usd: 1 }).ok, true, 'inert finishRun is a no-op success');
    await c.refresh();
    A.eq(ff.calls.length, 0, 'inert adapter makes NO network calls at all');
  }

  // ---- CONFIGURED: configured() true, snapshot exposes balance + purchaseUrl, no secret leaks ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example/', apiKey: 'sekret-key', accountId: 'acct', purchaseUrl: 'https://buy.example', fetch: ff.fetch });
    A.eq(c.configured(), true, 'a CREDITS_URL makes the adapter live');
    A.eq(c.mode(), 'managed', 'configured adapter is managed mode');
    A.eq(c.purchaseUrl(), 'https://buy.example', 'purchase url is the configured external link');
    const bal = await c.refresh('acct');
    A.eq(bal, 10, 'refresh() reads the authoritative balance from the backend');
    A.eq(c.snapshot().balanceUsd, 10, 'snapshot reflects the refreshed balance');
    A.eq(c.snapshot().authStatus, 'valid', 'an accepted balance read proves the credential is valid');
    // the api key rides Authorization, never the account/display surface
    const auth = ff.calls[0].headers['Authorization'];
    A.eq(auth, 'Bearer sekret-key', 'the api key is sent as a bearer header (never in the snapshot payload)');
    A.eq(JSON.stringify(c.snapshot()).indexOf('sekret-key'), -1, 'the api key never appears in the snapshot (no secret leak)');
  }

  // ---- REMOTE REVOCATION: the account page can delete the device while this process still holds its token.
  //      The cloud's 401/403 must erase the cached number and become an explicit invalid-auth verdict. This is
  //      the 0.10.8 field report: cached $0 + remote unlink was painted as "LINKED · no credits" beside a paid
  //      account with $22 and no linked stations. ----
  {
    let status = 200;
    const fetchImpl = async () => status === 200
      ? { ok: true, status: 200, json: async () => ({ balanceUsd: 0 }) }
      : status === 299
        ? { ok: true, status: 200, json: async () => ({ error: 'unexpected success shape' }) }
      : { ok: false, status, json: async () => ({ error: status === 401 ? 'unauthorized' : 'down' }) };
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl });
    A.eq(await c.refresh('acct'), 0, 'precondition: the linked station cached a real $0 response');
    A.eq(c.snapshot().balanceUsd, 0, 'the real zero is cached while the credential is valid');
    status = 401;
    A.eq(await c.refresh('acct'), null, 'the remotely revoked bearer no longer yields a balance');
    A.eq(c.snapshot().balanceUsd, null, 'a rejected refresh discards the stale cached $0');
    A.eq(c.snapshot().authStatus, 'invalid', '401 becomes the definitive invalid-link verdict');
    A.eq(c.snapshot().lastErrorStatus, 401, 'the rejection status is available to the host authority seam');

    status = 503;
    await c.refresh('acct');
    A.eq(c.snapshot().authStatus, 'unavailable', 'a service outage stays distinct from revocation');
    A.eq(c.snapshot().balanceUsd, null, 'an outage also cannot keep presenting a stale dollar amount');

    status = 299;
    A.eq(await c.refresh('acct'), null, 'a malformed HTTP 200 is not coerced into a balance');
    A.eq(c.snapshot().authStatus, 'unavailable', 'malformed success data is unavailable, not revoked or empty');
    A.eq(c.snapshot().balanceUsd, null, 'missing balance data can never become a fabricated $0');
  }

  // A response is not complete merely because headers arrived. Keep the request deadline armed while the
  // JSON body is consumed or a half-responsive balance service can hang WAKE/status forever.
  {
    const stalledBody = (url, init) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })
    });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: stalledBody, requestTimeoutMs: 5 });
    A.eq(await c.refresh(), null, 'a stalled balance body terminates at the configured request deadline');
    A.eq(c.snapshot().balanceUsd, null, 'body timeout cannot fabricate or retain a dollar value');
    A.eq(c.snapshot().authStatus, 'unavailable', 'body timeout is availability trouble, not revocation');
  }

  // ---- MANAGED RUN via the backend: reserve holds the balance, refund returns the unspent headroom ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-1', agentId: 'a', capUsd: 4 });
    A.eq(adm.ok, true, 'managed admission succeeds when the balance covers the cap');
    A.eq(adm.managed, true, 'a run with a cap + a configured backend is a managed run');
    await flush();
    const debited = ff.calls.filter(x => x.url.indexOf('/v1/debit') >= 0);
    A.eq(debited.length, 1, 'admission posts exactly one debit (the reservation) to the backend');
    A.eq(debited[0].body.usd, 4, 'the reservation debits the full per-run cap');
    A.eq(ff.book.acct, 6, 'backend balance is reduced by the reservation');

    const done = c.finishRun({ runId: 'run-1', agentId: 'a', usd: 1.5, turns: 2, tokens: 100 });
    A.eq(done.ok, true, 'managed settle succeeds');
    await flush();
    const credited = ff.calls.filter(x => x.url.indexOf('/v1/credit') >= 0);
    A.eq(credited.length, 1, 'settle posts exactly one credit (the refund) to the backend');
    A.eq(credited[0].body.usd, 2.5, 'refund returns the unused headroom (cap 4 − spend 1.5)');
    A.ok(Math.abs(ff.book.acct - 8.5) < 1e-9, 'backend balance ends at start − actual spend (10 − 1.5)');
  }

  // ---- ACCOUNT IDENTITY IS ADAPTER-BOUND: no stale caller/env value may redirect a linked bearer. ----
  {
    const ff = fakeFetch({ acct: 9, stale_account: 0 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    A.eq(await c.refresh('stale_account'), 9, 'refresh ignores a caller-supplied account and reads the adapter account');
    A.ok(ff.calls[0].url.includes('account=acct'), 'the balance request carries the account bound to this bearer');
    const adm = c.beginRun({ accountId: 'stale_account', runId: 'identity-run', agentId: 'a', capUsd: 1 });
    A.eq(adm.ok, true, 'the bound funded account admits even when a stale caller account is supplied');
    await flush();
    const debit = ff.calls.find(x => x.url.includes('/v1/debit'));
    A.eq(debit.body.account, 'acct', 'the debit cannot be redirected away from the bearer-bound account');
    await c.history('stale_account', 5);
    const history = ff.calls.find(x => x.url.includes('/v1/history'));
    A.ok(history.url.includes('account=acct'), 'history also stays on the bearer-bound account');
  }

  // ---- OVERLAPPING REFRESHES: a slower old zero/failure cannot overwrite a newer funded answer. ----
  {
    const pending = [];
    const fetchImpl = () => new Promise(resolve => pending.push(resolve));
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl });
    const old = c.refresh();
    const fresh = c.refresh();
    pending[1]({ ok: true, status: 200, json: async () => ({ balanceUsd: 22 }) });
    A.eq(await fresh, 22, 'newer funded refresh completes');
    pending[0]({ ok: true, status: 200, json: async () => ({ balanceUsd: 0 }) });
    A.eq(await old, 0, 'the older request may still return its own historical answer to its caller');
    A.eq(c.snapshot().balanceUsd, 22, 'but the older $0 cannot overwrite the newer funded cache');
    A.eq(c.snapshot().authStatus, 'valid', 'the newer successful authority remains valid');
  }
  {
    const pending = [];
    const fetchImpl = () => new Promise(resolve => pending.push(resolve));
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl });
    const old = c.refresh();
    const fresh = c.refresh();
    pending[1]({ ok: true, status: 200, json: async () => ({ balanceUsd: 22 }) });
    await fresh;
    pending[0]({ ok: false, status: 503, json: async () => ({ error: 'old outage' }) });
    await old;
    A.eq(c.snapshot().balanceUsd, 22, 'a stale failed refresh cannot erase a newer funded balance');
    A.eq(c.snapshot().authStatus, 'valid', 'a stale failure cannot downgrade newer valid authentication');
  }

  // A delayed mutation response is the same race in the other direction: an old debit that once reached $0
  // must not land after a top-up refresh and strand the newly funded user again.
  {
    let balanceReads = 0;
    let resolveDebit;
    const fetchImpl = (url) => {
      const u = String(url);
      if (u.includes('/v1/balance')) {
        balanceReads++;
        const amount = balanceReads === 1 ? 10 : 22;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ balanceUsd: amount }) });
      }
      if (u.includes('/v1/debit')) return new Promise(resolve => { resolveDebit = resolve; });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl });
    await c.refresh();
    A.eq(c.beginRun({ runId: 'old-debit', agentId: 'a', capUsd: 2 }).ok, true, 'precondition: the old debit starts');
    A.eq(await c.refresh(), 22, 'a newer top-up refresh sees the funded balance');
    resolveDebit({ ok: true, status: 200, json: async () => ({ balanceUsd: 0 }) });
    await flush(); await flush();
    A.eq(c.snapshot().balanceUsd, 22, 'the delayed old debit zero cannot overwrite the newer top-up truth');
  }

  // ---- BOUNDED AUTHORITY: a hung cloud balance check becomes unavailable instead of hanging WAKE forever. ----
  {
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl, requestTimeoutMs: 5 });
    A.eq(await c.refresh(), null, 'a hung balance request settles as unavailable within the configured bound');
    A.eq(c.snapshot().balanceUsd, null, 'timeout never fabricates a dollar value');
    A.eq(c.snapshot().authStatus, 'unavailable', 'timeout is availability trouble, not zero or revocation');
  }

  // ---- EXHAUSTED balance: admission fails CLOSED before any debit/model work ----
  {
    const ff = fakeFetch({ acct: 0.5 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-x', agentId: 'a', capUsd: 3 });
    A.eq(adm.ok, false, 'insufficient managed balance refuses the run');
    A.eq(adm.reason, 'managed_credits_exhausted', 'exhaustion reason is explicit (drives the STORE upsell)');
    await flush();
    A.eq(ff.calls.filter(x => x.url.indexOf('/v1/debit') >= 0).length, 0, 'no debit is posted after an exhausted preflight');
  }

  // ---- unknown balance (backend never answered): fail CLOSED, never spend against an unknown balance ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    // deliberately DO NOT refresh — the cache is empty
    const adm = c.beginRun({ runId: 'run-u', agentId: 'a', capUsd: 3 });
    A.eq(adm.ok, false, 'a managed run with an unknown balance is refused (fail closed)');
    A.eq(adm.reason, 'managed_credit_unavailable', 'unknown balance surfaces as unavailable, not a false success');
  }

  // ---- no cap => a byok pass-through even when configured (an ungoverned run can't be pre-authorized) ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-nocap', agentId: 'a', capUsd: 0 });
    A.eq(adm.ok, true, 'a capless run admits');
    A.eq(adm.managed, false, 'a capless run is byok (no reservation held)');
  }

  // ---- history: reads the backend ledger for the STORE card ----
  {
    const ff = fakeFetch({ acct: 5 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    const h = await c.history('acct', 10);
    A.eq(Array.isArray(h.entries), true, 'history returns an entries array');
    A.eq(h.entries.length, 1, 'history surfaces the backend rows for the STORE activity list');
  }

  // ---- DRIFT GUARD: a failed debit/credit POST INVALIDATES the optimistic cache so it can't drift; the next
  //      managed admission then fail-closes (until refresh() reconciles) instead of spending a fictional balance.
  {
    let debitOk = true;   // flip to make the /v1/debit POST fail
    const book = { acct: 10 };
    const errors = [];
    const json = (obj, ok) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(obj) });
    const fetchImpl = (url, init) => {
      const u = String(url);
      if (u.indexOf('/v1/balance') >= 0) return json({ balanceUsd: book.acct }, true);
      if (u.indexOf('/v1/debit') >= 0) { if (!debitOk) return json({ ok: false, reason: 'backend down' }, false); book.acct -= (JSON.parse(init.body).usd || 0); return json({ ok: true, balanceUsd: book.acct }, true); }
      return json({}, true);
    };
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl, onError: (stage, e) => errors.push({ stage, status: e && e.status }) });
    await c.refresh('acct');
    A.eq(c.snapshot().balanceUsd, 10, 'cache warmed to the authoritative balance');

    // a managed run reserves capUsd=4 via a debit whose POST will FAIL
    debitOk = false;
    const adm = c.beginRun({ runId: 'run-drift', agentId: 'a', capUsd: 4 });
    A.eq(adm.ok, true, 'admission passed the preflight (balance covered the cap) before the debit POST');
    await flush();
    A.eq(c.snapshot().balanceUsd, null, 'a failed debit POST invalidates the cache (no silent drift)');
    A.ok(errors.some(e => e.stage === 'debit'), 'onError is still notified of the debit failure');

    // the NEXT admission now fails CLOSED against the unknown balance instead of spending a fictional cache value
    const adm2 = c.beginRun({ runId: 'run-drift-2', agentId: 'a', capUsd: 2 });
    A.eq(adm2.ok, false, 'the next managed run fail-closes on the invalidated balance');
    A.eq(adm2.reason, 'managed_credit_unavailable', 'unknown balance surfaces as unavailable, never a false success');

    // and a refresh() self-heals: the cache reconciles to the authoritative backend value again
    const healed = await c.refresh('acct');
    A.eq(healed, 10, 'refresh() re-reads the authoritative balance and heals the cache');
    A.eq(c.snapshot().balanceUsd, 10, 'cache is trustworthy again after refresh');
  }

  // ---- MALFORMED MUTATION RESPONSE: a string/NaN balance is UNKNOWN, never numeric zero. ----
  {
    const fetchImpl = async (url) => String(url).includes('/v1/balance')
      ? { ok: true, status: 200, json: async () => ({ balanceUsd: 10 }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, balanceUsd: '6.00' }) };
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: fetchImpl });
    await c.refresh();
    A.eq(c.beginRun({ runId: 'malformed-post', agentId: 'a', capUsd: 4 }).ok, true, 'precondition: funded admission succeeds');
    await flush(); await flush();
    A.eq(c.snapshot().balanceUsd, null, 'a malformed POST balance invalidates the cache instead of becoming $0');
  }

  /* ---- LOW-BALANCE WARNING -------------------------------------------------------------------
     The value of this feature is entirely in WHEN it fires. Firing every debit makes it noise the
     user learns to ignore; firing once and never re-arming means the second time they run dry it
     is silent. Both failure modes are tested here, not just the happy path. */

  // helper: a configured adapter with the warning armed at $5 and every emit captured
  function withWarn(seedBalance, opts) {
    const f = fakeFetch({ acct: seedBalance });
    const events = [];
    const c = makeCredits(Object.assign({
      url: 'https://c.example', apiKey: 'k', accountId: 'acct', purchaseUrl: 'https://c.example/account',
      fetch: f.fetch, clock: { now: () => 1000 },
      lowBalanceUsd: 5,
      emit: (name, payload) => events.push({ name, payload })
    }, opts || {}));
    return { c, f, events, low: () => events.filter(e => e.name === 'credits.low') };
  }

  {
    const { c, low } = withWarn(20);
    await c.refresh('acct');
    A.eq(low().length, 0, 'a healthy balance emits nothing');
  }

  {
    const { c, low } = withWarn(4);
    await c.refresh('acct');
    A.eq(low().length, 1, 'crossing the threshold warns');
    const p = low()[0].payload;
    A.eq(p.balanceUsd, 4, 'the warning carries the REAL balance, not the threshold');
    A.eq(p.thresholdUsd, 5, 'and what tripped it');
    A.eq(p.exhausted, false, 'still spendable, so not exhausted');
    A.eq(p.purchaseUrl, 'https://c.example/account', 'and where to fix it');
  }

  {
    // the anti-nag property: the balance moves on EVERY debit, so without a latch this fires per run
    const { c, low } = withWarn(4.5);
    await c.refresh('acct');
    A.eq(low().length, 1, 'first crossing warns');
    c.beginRun({ accountId: 'acct', runId: 'r1', capUsd: 0.5 }); await flush();
    c.beginRun({ accountId: 'acct', runId: 'r2', capUsd: 0.5 }); await flush();
    await c.refresh('acct');
    A.eq(low().length, 1, 'still ONE warning after further spend — the latch holds');
  }

  {
    // exhaustion must break through the low latch: it is the one that actually stops the station
    const { c, f, low } = withWarn(4);
    await c.refresh('acct');
    A.eq(low().length, 1, 'low fired');
    f.book.acct = 0;
    await c.refresh('acct');
    A.eq(low().length, 2, 'hitting zero warns AGAIN even though low already fired');
    A.eq(low()[1].payload.exhausted, true, 'and is flagged exhausted');
  }

  {
    // re-arm after a top-up, with hysteresis: $5.10 on a $5 threshold must NOT re-arm (a refund settling
    // against a debit jitters around the line), $10 must
    const { c, f, low } = withWarn(4);
    await c.refresh('acct');
    A.eq(low().length, 1, 'warned once');
    f.book.acct = 5.10; await c.refresh('acct');
    f.book.acct = 4;    await c.refresh('acct');
    A.eq(low().length, 1, 'a hair above the line does NOT re-arm — no flapping');
    f.book.acct = 10;   await c.refresh('acct');   // clears threshold x 1.25
    f.book.acct = 4;    await c.refresh('acct');
    A.eq(low().length, 2, 'a real top-up re-arms, so the NEXT time they run dry they are told');
  }

  {
    // Regression (2026-08-24 field report): an uncapped managed run reserves the WHOLE wallet, so the
    // temporary hold takes the spendable cache to $0 before settlement refunds the unused headroom. That
    // reservation is not account exhaustion and must never produce the scary $0 warning on every input.
    const { c, low } = withWarn(22);
    await c.refresh('acct');
    for (let i = 1; i <= 3; i++) {
      const balance = c.snapshot().balanceUsd;
      c.beginRun({ accountId: 'acct', runId: 'wallet-' + i, capUsd: balance });
      c.finishRun({ runId: 'wallet-' + i, usd: 0.10 });
      await flush(); await flush();
      await c.refresh('acct');
    }
    A.eq(low().length, 0, 'full-wallet reservation/refund cycles never masquerade as account exhaustion');
    A.ok(Math.abs(c.snapshot().balanceUsd - 21.70) < 1e-9, 'the settled cache still tracks the three real debits');
  }

  {
    // Suppressing the temporary hold must not suppress a REAL exhausted balance: when a run consumes its
    // entire reservation there is no refund POST to carry the final $0, so finishRun must evaluate settlement.
    const { c, low } = withWarn(20);
    await c.refresh('acct');
    c.beginRun({ accountId: 'acct', runId: 'spent-all', capUsd: 20 });
    c.finishRun({ runId: 'spent-all', usd: 20 });
    await flush(); await flush();
    A.eq(low().length, 1, 'a run that truly spends the remaining wallet emits one warning at settlement');
    A.eq(low()[0].payload.balanceUsd, 0, 'real exhaustion still reports the settled $0 balance');
    A.eq(low()[0].payload.exhausted, true, 'real exhaustion remains classified as exhausted');
  }

  {
    // Other live runs' reservations are holds too. Settling run A while run B still holds the rest of the
    // wallet must evaluate the account total, not the temporarily spendable cache left under B's hold.
    const { c, low } = withWarn(22);
    await c.refresh('acct');
    c.beginRun({ accountId: 'acct', runId: 'concurrent-a', capUsd: 11 });
    c.beginRun({ accountId: 'acct', runId: 'concurrent-b', capUsd: 11 });
    c.finishRun({ runId: 'concurrent-a', usd: 1 });
    await flush(); await flush();
    A.eq(low().length, 0, 'settling beside another live reservation does not fabricate a low balance');
    c.finishRun({ runId: 'concurrent-b', usd: 1 });
    await flush(); await flush();
    A.eq(low().length, 0, 'both healthy concurrent settlements remain quiet');
    A.ok(Math.abs(c.snapshot().balanceUsd - 20) < 1e-9, 'concurrent settlements retain the real account balance');
  }

  {
    // A partial refund can leave the account genuinely low. Its settled balance, not the temporary $0 hold,
    // is the number the warning must carry.
    const { c, low } = withWarn(20);
    await c.refresh('acct');
    c.beginRun({ accountId: 'acct', runId: 'settled-low', capUsd: 20 });
    c.finishRun({ runId: 'settled-low', usd: 16 });
    await flush(); await flush();
    A.eq(low().length, 1, 'a genuinely low post-settlement balance still warns once');
    A.eq(low()[0].payload.balanceUsd, 4, 'the warning reports the settled balance instead of the reservation hold');
    A.eq(low()[0].payload.exhausted, false, 'a positive settled balance is low, not exhausted');
  }

  {
    // An idempotent begin for an already-settled run must not resurrect its old reservation in warning math.
    const { c, f, low } = withWarn(20);
    await c.refresh('acct');
    c.beginRun({ accountId: 'acct', runId: 'settled-replay', capUsd: 10 });
    c.finishRun({ runId: 'settled-replay', usd: 1 });
    await flush(); await flush();
    A.eq(c.beginRun({ accountId: 'acct', runId: 'settled-replay', capUsd: 10 }).ok, true, 'settled admission replay stays idempotent');
    f.book.acct = 4;
    await c.refresh('acct');
    A.eq(low().length, 1, 'settled admission replay cannot hide a later genuine low balance');
    A.eq(low()[0].payload.balanceUsd, 4, 'the replay adds no phantom reservation to warning math');
  }

  {
    // an invalidated cache is UNKNOWN, not empty — warning on it would cry wolf on every network blip
    const { c, f, low } = withWarn(20);
    await c.refresh('acct');
    f.fail = true;
    c.beginRun({ accountId: 'acct', runId: 'r1', capUsd: 1 }); await flush(); await flush();
    A.eq(c.snapshot().balanceUsd, null, 'cache invalidated by the failed POST');
    A.eq(low().length, 0, 'unknown balance never emits a low-credit warning');
  }

  {
    const { c, low } = withWarn(1, { lowBalanceUsd: 0 });
    await c.refresh('acct');
    A.eq(low().length, 0, 'lowBalanceUsd 0 disables the warning entirely');
  }

  {
    // the threshold is a GETTER in production (effectiveCaps.perRun is live-tunable) — prove it is read
    // per-check, not captured once at construction
    let cap = 1;
    const { c, low } = withWarn(4, { lowBalanceUsd: () => cap });
    await c.refresh('acct');
    A.eq(low().length, 0, 'above a $1 threshold — quiet');
    cap = 5;
    await c.refresh('acct');
    A.eq(low().length, 1, 'raising the cap live makes the SAME balance low, with no restart');
  }

  {
    const c = makeCredits({ url: '', emit: () => { throw new Error('must never be called'); } });
    A.eq(c.configured(), false, 'an unconfigured (BYOK) station stays inert');
    A.eq(c.snapshot().balanceUsd, null, 'and has no balance to warn about');
  }

  A.report('credits.test');
})();
