/* sidecar/spend.js - pure helpers for honest run spend/model bookkeeping.

   The run host writes two durable rows at run end (ledger + runstore). These helpers keep the
   effective model and final USD calculation in one place so those rows cannot drift. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).spend = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNKNOWN_MODEL = '(unknown)';
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function cleanModel(v, max) {
    const s = str(v).trim();
    return (s || UNKNOWN_MODEL).slice(0, max || 80);
  }
  function priceDollars(price, tokensIn, tokensOut) {
    if (!price) return 0;
    const inPrice = num(price.in != null ? price.in : price.prompt);
    const outPrice = num(price.out != null ? price.out : price.completion);
    if (!inPrice && !outPrice) return 0;
    return (num(tokensIn) * inPrice + num(tokensOut) * outPrice) / 1e6;
  }

  function effectiveModel(o) {
    o = o || {};
    const result = o.result || {};
    const candidates = [
      result.model,
      o.requestedModel,
      o.usingCodex ? o.codexDefaultModel : '',
      o.defaultModel
    ];
    for (const c of candidates) {
      const s = str(c).trim();
      if (s) return cleanModel(s);
    }
    return UNKNOWN_MODEL;
  }

  // Backfill only genuinely unpriced metered usage: no provider-reported usage.cost, base run USD is
  // still zero, and a catalog price is now available. Subscription/unmetered runs stay out of USD.
  function effectiveUsd(o) {
    o = o || {};
    const base = Math.max(0, num(o.usd));
    if (o.unmetered || base !== 0 || typeof o.priceOf !== 'function') return base;
    const rows = Array.isArray(o.unpricedUsage) ? o.unpricedUsage : [];
    let extra = 0;
    for (const r of rows) {
      const model = cleanModel(r && r.model);
      const tokensIn = num(r && (r.tokensIn != null ? r.tokensIn : r.prompt_tokens));
      const tokensOut = num(r && (r.tokensOut != null ? r.tokensOut : r.completion_tokens));
      if (tokensIn + tokensOut <= 0) continue;
      extra += priceDollars(o.priceOf(model), tokensIn, tokensOut);
    }
    return extra > 0 ? extra : base;
  }

  // Auxiliary media is real metered spend even when the conversation uses a subscription.
  // Keep legacy subscription-only estimates unchanged; mixed runs show only actual dollars.
  function effectiveRunUsd(o) {
    const media = Math.max(0, num(o && o.mediaUsd));
    if (!media) return effectiveUsd(o);
    if (o.unmetered) return media;
    return effectiveUsd(Object.assign({}, o, { usd: Math.max(0, num(o.usd) - media) })) + media;
  }
  /* #164: may this run start a paid generation? spentUsd: what the loop has booked; pendingUsd: media charges it has not
     drained yet (they drain when the turn's tools end, so a second image in one turn must count the first); capUsd: the
     per-run limit; verdict: the cross-run check's answer ({ scope, usd, cap } | { unknown } | null; a hold never gets here:
     makeMediaSpendCheck waits it out). -> why not, or ''. A call whose price nobody knows yet can still pass a limit; only
     a limit already reached stops it. */
  function mediaSpendStop(o) {
    o = o || {};
    const spent = Math.max(0, num(o.spentUsd)) + Math.max(0, num(o.pendingUsd));
    const money = n => '$' + Math.max(0, num(n)).toFixed(2);
    if (typeof o.capUsd === 'number' && isFinite(o.capUsd) && spent >= o.capUsd) return 'this run has spent ' + money(spent) + ' of its ' + money(o.capUsd) + ' spending limit';
    const v = o.verdict;
    if (!v) return '';
    if (v.unknown) return 'the spending limits you set can\u2019t be checked right now';
    return 'the ' + String(v.scope || 'spending') + ' spending limit is reached' + (typeof v.cap === 'number' ? ' (' + money(v.usd) + ' of ' + money(v.cap) + ')' : '');
  }
  /* #164: the run host's answer to image_generate, before it spends. o: readView() the loop's own figures ({ spentUsd,
     maxCostUsd }, or null before it starts); pendingUsd() media charges not drained yet; mediaUsd() every media charge of this
     run; pool the run's spend pool; runId; unmetered: a subscription chat; crossRun(spentUsd) the day/global limits' answer.
     THE POOL'S RULES, not a second set of them:
     - it is told only what the loop has BOOKED. A pending charge reaches it through agent.cost (booked), so handing it the
       pending too counted a second image twice: two $0.20 images under a $0.50 cap read $0.60 and stopped the family early.
       The pending charge counts here, read-only, against the pool's cap.
     - a generation is a call with no price, so while it runs its family's other calls wait, and it waits for theirs: a hold
       means "not yet", never "no". It asks again when the call in flight settles, and only the run's abort ends the wait.
     - a subscription chat's tokens are an estimate against a flat plan, so they are not dollars here. Only what this run's
       media really cost goes to the day/global limits. That run has no per-run limit unless a caller set one (runCapUsd is
       Infinity there), and its media is not booked to the pool: the PER RUN setting does not stop a subscription chat's
       paid images. The day, agent and all-time limits do, and SETTINGS says so.
     AN IMAGE WHOSE COST NOBODY KNOWS adds $0 to all of this, so no dollar limit can stop those, and SETTINGS says that too. The
     family's COUNT of them does (unknownCap, MEDIA_UNKNOWN_COST_MAX). No price is invented for it. Past the cap: refused. A
     sibling's generation in flight is not over the cap yet, since it may fail or come back priced: that waits, never refuses.
     So every wait here needs an end of its own: holdMaxMs bounds it for the whole call, and the tool's own timeout is paused
     while it waits (holdTimeout, registry.js), so a wait never eats the generation's time.
     -> mediaSpend({ signal, holdTimeout }): '' when it may start, or { why, todo }. Every '' MUST be answered by mediaSpend.end.
     mediaSpend.end({ unknown: unpriced charges of that call, charged: did any provider answer book }): an unbilled call releases
     its count and its place in the pool, so a failed or cancelled generation holds nobody up. */
  const MEDIA_UNKNOWN_COST_MAX = 10;
  const MEDIA_HOLD_MAX_MS = 120000;   // about one generation (image.js GEN_TIMEOUT_MS, 110 s): a sibling's call can finish in it
  function makeMediaSpendCheck(o) {
    const unknownCap = Number(o.unknownCap) > 0 ? Math.floor(Number(o.unknownCap)) : MEDIA_UNKNOWN_COST_MAX;
    const holdMaxMs = Number(o.holdMaxMs) > 0 ? Number(o.holdMaxMs) : MEDIA_HOLD_MAX_MS;
    const overCount = n => ({
      why: 'this run and its workers have generated ' + n + (n === 1 ? ' image' : ' images') + ' whose cost is unknown (the provider reported none and StarNet has no price for the model). Spending limits cannot count those, so StarNet stops at ' + unknownCap + ' in one run',
      todo: 'To make more, start a new run, or use an image model the provider reports a cost for.' });
    async function mediaSpend(call) {
      const signal = call && call.signal;
      let expired = false, timer = null, resume = null, expiry = null;
      const waitOn = hold => new Promise(resolve => {
        if (signal && signal.aborted) return resolve();
        const done = () => { if (signal) signal.removeEventListener('abort', done); resolve(); };
        if (signal) signal.addEventListener('abort', done);
        Promise.resolve(hold).then(done, done);
        expiry.then(done);
      });
      try {
        for (;;) {
          const count = o.pool.mediaCount();
          if (count.unknown >= unknownCap) return overCount(count.unknown);
          const view = o.readView();
          const pendingUsd = Math.max(0, num(o.pendingUsd()));
          const spentUsd = view ? num(view.spentUsd) : Math.max(0, num(o.mediaUsd()) - pendingUsd);
          let verdict = null, admitted = false;
          try {
            if (count.unknown + count.running >= unknownCap) verdict = { hold: o.pool.nextMediaEnd() };   // they may fail or be priced: not refused yet
            else if (o.unmetered) verdict = o.crossRun(num(o.mediaUsd()));
            else {
              const family = o.pool.status();
              if (typeof family.capUsd === 'number' && isFinite(family.capUsd) && num(family.spentUsd) + pendingUsd >= family.capUsd) verdict = { scope: 'run', usd: num(family.spentUsd) + pendingUsd, cap: family.capUsd };
              else {
                verdict = o.pool.admit(o.runId, spentUsd, 0);
                if (!verdict) {
                  admitted = true;
                  verdict = o.crossRun(spentUsd + pendingUsd);
                }
              }
            }
          } catch (_) { verdict = { unknown: true }; if (typeof o.onCheckError === 'function') o.onCheckError(_); }
          if (verdict && verdict.hold) {
            if (!expiry) {   // one bound for the whole call, however many holds it meets
              expiry = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, holdMaxMs); });
              if (call && typeof call.holdTimeout === 'function') resume = call.holdTimeout();
            }
            await waitOn(verdict.hold);
            if (signal && signal.aborted) return { why: 'the run was stopped while it waited for its other calls to finish', todo: '' };
            if (expired) return { why: 'its other calls were still running after a wait of ' + Math.round(holdMaxMs / 1000) + ' seconds', todo: 'No limit was reached. Try again when they have finished.' };
            continue;
          }
          const stop = mediaSpendStop({ spentUsd, pendingUsd, capUsd: view ? view.maxCostUsd : undefined, verdict });
          if (stop) { if (admitted) o.pool.withdraw(o.runId); return stop; }   // this generation never goes out
          o.pool.mediaBegin();
          return '';
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (typeof resume === 'function') resume();
      }
    }
    mediaSpend.end = r => {
      o.pool.mediaEnd(r && r.unknown);
      if (!(r && r.charged) && !o.unmetered) o.pool.withdraw(o.runId);   // nothing will book: its place in the pool is over now
    };
    mediaSpend.unknownCap = unknownCap;
    return mediaSpend;
  }
  /* #164: what a run's two spend rows say about its media. A generation with no provider figure and no catalog price books $0,
     which is not a known $0: the row is marked unpriced (its usd is a floor). A subscription run stays a subscription run
     (the insights fold keeps its tokens and its label); its unpriced flag can only come from the image, since a plan's own
     tokens are never marked unpriced (index.js runUnpriced), and the recap says so. */
  function mediaRunFlags(o) {
    o = o || {};
    const unknownMedia = num(o.mediaUnpriced) > 0;
    return { unmetered: !!o.runUnmetered && num(o.mediaUsd) === 0, unpriced: !!o.runUnpriced || unknownMedia };
  }
  return { UNKNOWN_MODEL, cleanModel, effectiveModel, effectiveUsd, effectiveRunUsd, priceDollars, mediaSpendStop, makeMediaSpendCheck, MEDIA_UNKNOWN_COST_MAX, MEDIA_HOLD_MAX_MS, mediaRunFlags };
});
