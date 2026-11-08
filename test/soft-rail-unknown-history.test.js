/* GHSA-2hpj-9wm7-rvg5 #8: the shipped $25/day soft rail over UNKNOWN spend history.
   Before: while one charge was unsettled (a crash, a force quit, a restart mid-run) the soft rail recorded the dispatch
   receipt and proceeded WITHOUT evaluating any total, so routines and BYOK runs had no dollar ceiling until it was
   settled by hand. Now (sidecar/budget.js check, opts.attended):
     - work nobody watches PAUSES (paused: true), naming the way to settle it, and books no dispatch receipt;
     - a watched run keeps going against a FLOOR: recorded spend + live spend + every open item at its bound, else at
       its COUNT AS figure; over the cap it stops, naming settlement (RESUME stays closed);
     - a chosen cap stays strict exactly as before (attended never loosens it).
   Also: the governor's attended mapping, the loop's sentence, the chat headline, and the host wiring (source-locked). */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const BillingClass = require('../sidecar/billing-class.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { friendlyError } = require('../frontend/app/friendlyerror.js');

const DAY = 86400000, NOW = 10 * DAY, clock = { now: () => NOW };
const SOFT = () => false, CHOSEN = () => true;
const WATCHED = { attended: true };
function ledgerWith(rows, receipts) {
  const begun = [];
  const io = { readAll: () => rows.map(r => Object.assign({}, r)), unsettled: () => receipts.map(r => Object.assign({}, r)),
    append: r => rows.push(r), beginRun: r => begun.push(r.runId), finishRun() {} };
  const L = makeLedger({ io, clock, nextId: () => crypto.randomUUID() });
  return { L, begun };
}
const prior = (usd, ts) => ({ runId: 'prior-' + usd, agentId: 'agent', usd, ts: ts == null ? NOW - 3600000 : ts });

// ---- 1. nobody watching: paused, with its exit, and no dispatch receipt ----
{
  const { L, begun } = ledgerWith([prior(1)], [{ runId: 'open', agentId: 'agent', ts: NOW - 60000 }]);
  const B = makeBudget({ caps: { day: 25 }, ledger: L, clock, strictScope: SOFT });
  for (const opts of [undefined, null, {}, { attended: false }, { attended: 'true' }, { attended: 1 }]) {
    const v = B.check('r-unwatched', 'agent', 0, NOW, null, null, opts);
    A.eq(v && [v.paused, v.unknown, v.code, v.scope, v.cause, v.countAsUsd], [true, true, 'spend_history_unavailable', 'day', 'unsettled', 2],
      'unwatched (' + JSON.stringify(opts) + '): paused over the open item, its COUNT AS figure named');
  }
  const v = B.check('r-unwatched', 'agent', 0, NOW);
  A.eq(v.exit, 'press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0', 'the pause names its one-click exits');
  A.eq(begun.length, 0, 'a paused run books no dispatch receipt');
  A.eq(B.resume('day'), null, 'RESUME cannot lift a pause over unknown history');
  // settling it makes history whole: the same unwatched work proceeds under the ordinary soft rail again
  L.settleUnsettled('open', 0.4, 'entered');
  A.eq(B.check('r-after', 'agent', 0, NOW), null, 'after settlement the unwatched run proceeds');
  A.eq(begun, ['r-after'], '...and books its dispatch receipt');
}

// ---- 2. someone watching: a floor of recorded + every open item at its bound, else its COUNT AS ----
{
  const receipts = [
    { runId: 'capped', agentId: 'agent', ts: NOW - 60000, runCapUsd: 3 },             // bound: its recorded per-run limit
    { runId: 'open', agentId: 'agent', ts: NOW - 60000 },                             // no bound: COUNT AS = the assumption
    { runId: 'damaged-' + 'c'.repeat(24), kind: 'damaged', lineHash: 'c'.repeat(64), recordedUsd: 0.7 },   // its line's own figure
    { runId: 'old', agentId: 'agent', ts: NOW - 3 * DAY, runCapUsd: 50 }              // outside today's window: not in the day
  ];
  const { L, begun } = ledgerWith([prior(4)], receipts);
  const items = L.unknownItems();
  A.eq(items.find(i => i.runId === 'open').countAs, { usd: 4, source: 'assumed' }, 'the assumption is the largest recorded single charge ($4, over the $2 floor)');
  const B = makeBudget({ caps: { day: 12 }, ledger: L, clock, strictScope: SOFT });
  A.eq(B.check('w1', 'agent', 0, NOW, null, null, WATCHED), null, 'watched: $4 recorded + $3 bound + $4 COUNT AS + $0.70 = $11.70 is under $12');
  A.ok(begun.indexOf('w1') >= 0, 'a watched run books its dispatch receipt');
  const over = B.check('w2', 'agent', 0.5, NOW, null, null, WATCHED);
  A.eq(over && [over.scope, over.cap, !!over.unknown, !!over.paused], ['day', 12, false, false], 'watched: its own live $0.50 tips the floor-counted day over the cap: an ordinary stop, not a pause');
  A.ok(over && Math.abs(over.usd - 12.2) < 1e-9 && Math.abs(over.unknownUsd - 7.7) < 1e-9, 'the stop counts $7.70 of unknown spend in its $12.20: ' + JSON.stringify(over));
  A.eq(over.exit, 'press COUNT AS $3.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0', 'its way on is settlement (RESUME stays closed, a raised limit would be a chosen, strict one)');
  A.eq(B.resume('day'), null, 'RESUME stays closed while history is unknown');
  const words = BillingClass.makeGovernor({ budget: B, classOfProvider: () => 'metered' }).admit('run', { providerId: 'p', agentId: 'agent', runId: 'w2', spentUsd: 0.5, attended: true });
  A.eq(words && [words.gate, words.exit], ['dollars', over.exit], 'the governor passes the stop\'s own exit through, not "RESUME it"');
  A.ok(/the day spending cap is reached \(\$12\.20 of \$12\.00\)/.test(words.why), 'and says which cap: ' + words.why);
  // the old receipt's $50 limit is outside today's window: the day floor leaves it out, a global cap counts it
  const G = makeBudget({ caps: { day: 100, global: 1000 }, ledger: L, clock, strictScope: SOFT });
  A.eq(G.check('w3', 'agent', 0, NOW, null, null, WATCHED), null, 'every soft pool under its floor-counted cap proceeds');
  const G2 = makeBudget({ caps: { day: 100, global: 60 }, ledger: L, clock, strictScope: SOFT });
  const g2 = G2.check('w4', 'agent', 0, NOW, null, null, WATCHED);
  A.eq(g2 && [g2.scope, g2.unknownUsd], ['global', 57.7], 'all-time: $4 + $3 + $4 + $0.70 + the old $50 = $61.70 passes a $60 soft cap');
}

// ---- 3. the floor never reads as $0, and a crossing is announced on the run's own bus ----
{
  const { L } = ledgerWith([], [{ runId: 'first-ever', agentId: 'agent', ts: NOW - 1000 }]);
  A.eq(L.unknownItems()[0].countAs.usd, 2, 'with nothing on record the assumption is its $2 floor, never $0');
  const B = makeBudget({ caps: { day: 2.4 }, ledger: L, clock, strictScope: SOFT });
  const evs = [];
  const v = B.check('w', 'agent', 0, NOW, (name, payload) => evs.push({ name, payload }), null, WATCHED);
  A.eq(v, null, '$2 of $2.40: proceeds');
  A.eq(evs.map(e => [e.name, e.payload.scope]), [['budget.threshold', 'day']], 'the warn crossing the floor makes is announced once');
  B.check('w', 'agent', 0, NOW, (name, payload) => evs.push({ name, payload }), null, WATCHED);
  A.eq(evs.length, 1, '...and not again for the same run');
  const stop = B.check('w', 'agent', 0.5, NOW, (name, payload) => evs.push({ name, payload }), null, WATCHED);
  A.eq([stop && stop.scope, evs.length, evs[1] && evs[1].payload.cap], ['day', 2, 2.4], 'the cap crossing is announced too');
}

// ---- 4. a chosen cap stays strict: attended never loosens it; known history ignores the flag ----
{
  const { L } = ledgerWith([prior(1)], [{ runId: 'open', agentId: 'agent', ts: NOW - 60000, runCapUsd: 0.1 }]);
  for (const strictScope of [CHOSEN, s => s !== 'day']) {
    const B = makeBudget({ caps: { day: 25, global: 500 }, ledger: L, clock, strictScope });
    const v = B.check('r', 'agent', 0, NOW, null, null, WATCHED);
    A.eq(v && [v.unknown, v.code, !!v.paused], [true, 'spend_history_unavailable', false], 'a chosen cap refuses uncertain history even for a watched run (' + (strictScope === CHOSEN ? 'all chosen' : 'chosen global beside the soft day') + ')');
  }
  const broken = makeBudget({ caps: { day: 25 }, ledger: L, clock, strictScope: () => { throw new Error('boom'); } });
  const b = broken.check('r', 'agent', 0, NOW, null, null, WATCHED);
  A.eq(b && [b.unknown, !!b.paused], [true, false], 'a broken classifier still fails closed (strict), watched or not');
  const known = ledgerWith([prior(30)], []).L;
  const K = makeBudget({ caps: { day: 25 }, ledger: known, clock, strictScope: SOFT });
  A.eq([K.check('a', 'agent', 0, NOW).scope, K.check('b', 'agent', 0, NOW, null, null, WATCHED).scope], ['day', 'day'], 'known history: the ordinary soft cap stop, watched or not');
  A.eq(makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior(1)], []).L, clock, strictScope: SOFT }).check('c', 'agent', 0, NOW), null, 'known history under the cap: unwatched work runs as before');
  A.eq(makeBudget({ caps: {}, ledger: L, clock, strictScope: SOFT }).check('d', 'agent', 0, NOW), null, 'no governed pool: no pause (unlimited stays opt-in)');
}

// ---- 5. causes with nothing to list: a failed save pauses with "restart", a watched run counts what is on record ----
{
  const W = makeLedger({ clock, io: { readAll: () => [], append() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  W.record({ runId: 'x', usd: 1 });
  const B = makeBudget({ caps: { day: 25 }, ledger: W, clock, strictScope: SOFT });
  const v = B.check('r', 'agent', 0, NOW);
  A.eq(v && [v.paused, v.cause], [true, 'write'], 'a failed save pauses unwatched work');
  A.ok(/^restart StarNet/.test(v.exit), 'naming the restart that replays it: ' + v.exit);
}

// ---- 6. the governor: who is watching ----
{
  const seen = [];
  const budget = { check: (...a) => { seen.push(a[6]); return null; } };
  const g = BillingClass.makeGovernor({ budget, classOfProvider: () => 'metered', auxTokenGate: () => ({ blocked: false }) });
  g.admit('run', { providerId: 'p', agentId: 'a', runId: 'r', attended: true });
  g.admit('run', { providerId: 'p', agentId: 'a', runId: 'r' });
  g.admit('media', { agentId: 'a', runId: 'r', attended: true });
  g.admit('oneshot', { providerId: 'p', agentId: 'agent', attended: true });
  g.admit('skill-evaluation', { providerId: 'p', agentId: 'a', attended: true });
  g.admit('nightshift', { providerId: 'p', agentId: 'a' });
  g.admit('aux', { providerId: 'p', agentId: 'a', attended: true });
  g.admit('quest-refresh', { providerId: 'p', agentId: 'station', trigger: 'commander' });
  g.admit('skill-curator', { providerId: 'p', agentId: 'a' });
  A.eq(seen.map(o => o && o.attended), [true, false, true, true, true, false, false, true, false],
    'foreground kinds: the caller\'s literal true; background kinds: only the Commander\'s trigger; the night shift is nobody\'s');
}

// ---- 7. through the loop: the paused sentence and its chat headline; a watched run goes on ----
(async () => {
  function loopUnder(budget, attended) {
    const governor = BillingClass.makeGovernor({ budget, classOfProvider: () => 'metered' });
    return async runId => {
      let calls = 0; const events = [];
      const provider = { priceOf: () => ({ in: 0, out: 0 }), contextLimit: () => 0, stream: async function* () { calls++; yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' }; } };
      const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: (name, payload) => events.push({ name, payload }),
        cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }), model: 'm', agentId: 'agent', runId,
        budget: { check: spent => governor.admit('run', { providerId: 'openrouter', agentId: 'agent', runId, spentUsd: spent, attended }) } });
      return { res, calls, error: (events.find(e => e.name === 'agent.run.error') || {}).payload };
    };
  }
  const soft = () => makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior(0.5)], [{ runId: 'open', agentId: 'agent', ts: NOW - 60000 }]).L, clock, strictScope: SOFT });
  const paused = await loopUnder(soft())('routine-run');
  A.eq([paused.calls, paused.res.reason, paused.res.failureCode], [0, 'error', 'spend_history_unavailable'], 'an unwatched run pauses before any paid call');
  const SENTENCE = 'An earlier call has no settled charge, so StarNet pauses unattended work (routines, lines, background workers) while the daily spending limit can’t be checked. ' +
    'Press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0.';
  A.eq(paused.error && paused.error.message, SENTENCE, 'the loop says what paused and why, then the way to settle');
  const head = friendlyError(paused.error.message);
  A.eq(head.kind, 'spend_unknown', 'the chat reads it as the local spend state, never a provider\'s billing');
  A.eq(head.userMessage, "StarNet paused this unattended run: its spend history is incomplete, so the daily spending limit can't count what was spent. " +
    'Press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0.', 'the headline keeps the one-click exit word for word');
  A.ok(!/limits you set/i.test(head.userMessage), 'and never blames a limit the user did not set');
  const strictHead = friendlyError('An earlier call has no settled charge, so the spending limits you set can’t be checked. Press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set GLOBAL to 0.');
  A.ok(/^Your spending limits can't be checked/.test(strictHead.userMessage), 'a chosen limit\'s refusal keeps its own headline');
  const restartHead = friendlyError('Spend history could not be saved to disk, so StarNet pauses unattended work (routines, lines, background workers) while the daily spending limit can’t be checked. Restart StarNet: it replays the spend it could not save.');
  A.ok(/paused this unattended run/.test(restartHead.userMessage) && /Restart StarNet to recover it\.$/.test(restartHead.userMessage), 'a failed save keeps its own exit: ' + restartHead.userMessage);
  const watched = await loopUnder(soft(), true)('desk-run');
  A.eq([watched.calls, watched.res.reason, watched.error], [1, 'done', undefined], 'a watched run proceeds against the floor');

  // ---- 8. the host wiring, source-locked (runOnceCore cannot run here) ----
  const idx = require('./helpers/source').readSidecarSource();
  A.ok(/const spendAttended = \(\) => !isRoutineTrigger\(trigger\) && \(\s*\(surface === 'interactive' && typeof prompt === 'function'\)\s*\|\| \(!o\.delegatedBy && ownerTrusted && !workflowLine\)\s*\|\| \(!!o\.delegatedBy && typeof o\.connectorAuthority\?\.attended === 'function' && o\.connectorAuthority\.attended\(\) === true\)\);/.test(idx),
    'watched = not a routine, and the desk\'s live card channel, the owner\'s own message, or a worker of a watched lead');
  A.ok(/governor\.admit\('run', \{[^}]*attended: spendAttended\(\),/.test(idx), 'a run\'s own calls say who watches');
  A.ok(/crossRun: spent => governor\.admit\('media', \{[^}]*attended: spendAttended\(\) \}\)/.test(idx), 'so does an image the run makes');
  A.ok(/attended: \(\) => !signal\?\.aborted && spendAttended\(\),/.test(idx), 'a worker learns it from its lead, and not after the lead\'s run is cancelled');
  A.ok(/governor\.admit\('oneshot', \{ providerId, agentId: 'agent', attended: true \}\)/.test(idx), 'a press (NOT RIGHT? / SET IT UP FOR ME) is watched');
  A.eq((idx.match(/governor\.admit\('skill-evaluation', \{[^}]*attended: true \}\)/g) || []).length, 2, 'EVALUATE is the Commander\'s press, at both of its checks');
  A.ok(!/governor\.admit\('nightshift', \{[^}]*attended/.test(idx), 'the night shift never claims a watcher');
  // index.js's own callers (the exact file: billing-class.js reads o.attended by design): every attended the host hands the
  // governor is host-minted (spendAttended() or a literal press), never a value forwarded from a request or a run's options
  const own = require('./helpers/source').readSidecarIndex();
  const handed = (own.match(/governor\.admit\('[^']+', \{[^}]*\battended: [^,}\s]+/g) || []).map(s => s.replace(/^[\s\S]*\battended: /, ''));
  A.eq([...new Set(handed)].sort(), ['spendAttended()', 'true'], 'every attended the host hands the governor is host-minted: ' + JSON.stringify(handed));
  A.ok(!/\bo\.attended\b|body\.attended|opts\.attended/.test(own), 'no caller forwards a request-supplied attended flag');
  A.report('soft-rail-unknown-history.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
