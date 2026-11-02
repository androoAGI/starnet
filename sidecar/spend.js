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
     run; pool the run's spend pool; runId; unmetered: a subscription chat (a boolean, or a getter read at each call); crossRun(spentUsd) the day/global limits' answer.
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
     THE STATION'S 24 HOURS (dayGate, MEDIA_UNKNOWN_COST_DAY_MAX): the family's count resets with each run, and a line's next bay
     is a new family (a hop's run gets no spendPool, only team tools pass one), so a routine or a line could still make any number.
     The same rules over the spend log's own rows (ledger.js unknownImageWindow), so they survive a restart and count every run.
     A price is known only after the answer, so a cap refuses the next image whatever its model.
     -> mediaSpend({ signal, holdTimeout }): '' when it may start, or { why, todo }. Every '' MUST be answered by mediaSpend.end.
     mediaSpend.end({ unknown: unpriced charges of that call, charged: did any provider answer book }): an unbilled call releases
     its count and its place in the pool, so a failed or cancelled generation holds nobody up. */
  const MEDIA_UNKNOWN_COST_MAX = 10;
  const MEDIA_UNKNOWN_COST_DAY_MAX = 50;
  /* makeMediaDayGate({ read: () => ledger.unknownImageWindow(), limit }): one per station. The log holds the images that came
     back unknown; this holds the ones still running in any run, which no log has yet. */
  function makeMediaDayGate(o) {
    const limit = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : MEDIA_UNKNOWN_COST_DAY_MAX;
    let running = 0, wake = null;
    return {
      limit,
      state() {
        let w = null;
        try { w = o.read(); } catch (_) { w = null; }
        if (!w || w.ok !== true || !Array.isArray(w.times)) return { unreadable: true };
        const used = w.times.length;
        return { used, running, limit, roomInMs: used >= limit ? Math.max(0, w.times[used - limit] + w.dayMs - w.now) : 0 };
      },
      begin() { running++; },
      end() { running = Math.max(0, running - 1); if (wake) { const x = wake; wake = null; x.resolve(); } },
      next() { if (!wake) { let resolve; const p = new Promise(r => { resolve = r; }); wake = { p, resolve }; } return wake.p; }
    };
  }
  function roomInWords(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return 'about ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
    const hours = Math.ceil(minutes / 60);
    return 'about ' + hours + (hours === 1 ? ' hour' : ' hours');
  }
  const MEDIA_HOLD_MAX_MS = 120000;   // about one generation (image.js GEN_TIMEOUT_MS, 110 s): a sibling's call can finish in it
  function makeMediaSpendCheck(o) {
    const unknownCap = Number(o.unknownCap) > 0 ? Math.floor(Number(o.unknownCap)) : MEDIA_UNKNOWN_COST_MAX;
    const holdMaxMs = Number(o.holdMaxMs) > 0 ? Number(o.holdMaxMs) : MEDIA_HOLD_MAX_MS;
    /* unmetered: a boolean, or a getter read at every call. The host passes a getter: a plan run that falls back to a key
       (#158) is metered from then on, so its next image meets the run cap and the pool. A getter that throws reads as
       metered, the stricter answer. */
    const unmeteredNow = () => {
      if (typeof o.unmetered !== 'function') return !!o.unmetered;
      try { return !!o.unmetered(); } catch (e) { if (typeof o.onCheckError === 'function') o.onCheckError(e); return false; }
    };
    const overCount = n => ({
      why: 'this run and its workers have generated ' + n + (n === 1 ? ' image' : ' images') + ' whose cost is unknown (the provider reported none and StarNet has no price for the model). Spending limits cannot count those, so StarNet stops at ' + unknownCap + ' in one run',
      todo: 'To make more, start a new run. A price is known only after an image comes back, so this holds for every image model until then.' });
    const overDay = day => ({
      why: 'StarNet has recorded ' + day.used + (day.used === 1 ? ' image' : ' images') + ' whose cost is unknown in the last 24 hours across all runs. Spending limits cannot count those, so it stops at ' + day.limit + ' in any 24 hours',
      todo: 'Room comes back in ' + roomInWords(day.roomInMs) + '. Until then no run on this station can start an image on any route except a ChatGPT plan (flat-rate, so not counted), whatever the model, because a price is known only after an image comes back.' });
    const dayUnreadable = {
      why: 'StarNet could not read its spend log, so it cannot tell how many images of unknown cost were made in the last 24 hours',
      todo: 'Nothing about the limit was reached. SETTINGS › SPENDING LIMITS shows what is wrong with the log; resolve that and try again.' };
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
          const day = o.dayGate ? o.dayGate.state() : null;
          if (day && day.unreadable) return dayUnreadable;
          if (day && day.used >= day.limit) return overDay(day);
          const view = o.readView();
          const pendingUsd = Math.max(0, num(o.pendingUsd()));
          const spentUsd = view ? num(view.spentUsd) : Math.max(0, num(o.mediaUsd()) - pendingUsd);
          let verdict = null, admitted = false;
          try {
            if (count.unknown + count.running >= unknownCap) verdict = { hold: o.pool.nextMediaEnd() };   // they may fail or be priced: not refused yet
            else if (day && day.used + day.running >= day.limit) verdict = { hold: o.dayGate.next() };   // the same, in any run on this station
            else if (unmeteredNow()) verdict = o.crossRun(num(o.mediaUsd()));
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
          if (o.dayGate) o.dayGate.begin();
          return '';
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (typeof resume === 'function') resume();
      }
    }
    mediaSpend.end = r => {
      const unknown = Math.max(0, Math.floor(Number(r && r.unknown) || 0));
      // booked first, so a waiting call that wakes on this end reads it
      try { if (typeof o.recordUnknownImage === 'function') for (let i = 0; i < unknown; i++) o.recordUnknownImage(); }
      catch (e) { if (typeof o.onCheckError === 'function') o.onCheckError(e); }
      if (o.dayGate) o.dayGate.end();
      o.pool.mediaEnd(r && r.unknown);
      if (!(r && r.charged) && !unmeteredNow()) o.pool.withdraw(o.runId);   // nothing will book: its place in the pool is over now (a no-op when it held none)
    };
    mediaSpend.unknownCap = unknownCap;
    mediaSpend.dayLimit = o.dayGate ? o.dayGate.limit : 0;
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
  return { UNKNOWN_MODEL, cleanModel, effectiveModel, effectiveUsd, effectiveRunUsd, priceDollars, mediaSpendStop, makeMediaSpendCheck, makeMediaDayGate, MEDIA_UNKNOWN_COST_MAX, MEDIA_UNKNOWN_COST_DAY_MAX, MEDIA_HOLD_MAX_MS, mediaRunFlags };
});
