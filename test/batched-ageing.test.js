/* node test/batched-ageing.test.js — unit cover for W2.1 batched ageing (sidecar/history-edit.js makeAgeing) and the
   route cache prices it weighs a batch with (sidecar/cost.js cacheRates). The end-to-end invariants (the real loop, a
   binding upstream, the real fs.read read-back, the switch-off golden) live in batched-ageing.invariant.test.js.
   Pure: no network, no files (an in-memory parker). */
'use strict';
// hermetic: no operator switch from the shell (the cache-TTL tier, a price override) reaches the prices read here
for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_/.test(k)) delete process.env[k];
const A = require('./_assert.js');
const HE = require('../sidecar/history-edit.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const prices = require('../sidecar/providers/prices.js');
const { makeAgeing, makeRequestView, ARG_ELIDED, ELIDED, AGEING } = HE;

const BIG = 25000;   // one result: a stub frees ~24.6k characters of it
const body = (tag, n) => { let s = ''; let i = 0; while (s.length < n) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet\n'; return s.slice(0, n); };
/* a run's messages: system, user, then one tool turn per entry of `turns` ({ name, args, result, ok, quoted, parked,
   origin: false }); origins as the loop records them (toolOrigin) */
function run(turns) {
  const list = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do it' }];
  const origins = new Map();
  turns.forEach((t, k) => {
    const id = 'c' + (k + 1);
    list.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: t.name || 'fs_read', arguments: JSON.stringify(t.args || { path: 'f' + k }) } }], reasoning: [{ type: 'thinking', signature: 's' + (k + 1) }] });
    const r = { role: 'tool', tool_call_id: id, content: t.result != null ? t.result : body('R' + (k + 1), BIG) };
    list.push(r);
    if (t.origin !== false) origins.set(r, { parkedPath: t.parked || null, parkMeta: t.quoted ? { quotedStreams: ['s2'] } : {}, ok: t.ok !== false });
  });
  return { list, originOf: m => origins.get(m) || null };
}
const reads = n => Array.from({ length: n }, () => ({}));
function parker() {
  const saved = [];
  const park = async (text, meta) => { saved.push({ text, meta }); return { path: '.output/p' + saved.length + '.txt' }; };
  return { saved, park };
}
const anth = () => ({ read: 0.10, write: 1.25, published: true });
const ctxOf = (o) => Object.assign({ requests: 40, maxIters: Infinity, rates: anth, holdsHistory: false }, o);
const stubs = list => list.filter(m => m.role === 'tool' && String(m.content).indexOf(ELIDED) === 0).length;
const writes = chars => [{ name: 'fs_write', args: { path: 'a.js', content: body('W', chars) }, result: 'Wrote' }, { name: 'fs_write', args: { path: 'b.js', content: body('V', chars) }, result: 'Wrote' }];

(async () => {
  // ================= nothing ages until a batch is due =================
  {
    const r = run(reads(10));
    const ag = makeAgeing({ originOf: r.originOf });
    A.ok(ag.view(r.list) === r.list, 'view: before any batch the list itself comes back (byte-identical requests)');
    const p = parker();
    // the keep window: the four newest tool turns ride whole; one turn behind them is never a batch (two at least)
    const five = run(reads(5));
    A.eq(await makeAgeing({ originOf: five.originOf }).plan(five.list, ctxOf({ park: p.park })), null, 'batch: one tool turn behind the newest four is never a batch (AGE_MIN_TURNS 2)');
    // two turns behind them hold ~49k characters a stub would free: under 60k, it waits
    const six = run(reads(6));
    A.eq(await makeAgeing({ originOf: six.originOf }).plan(six.list, ctxOf({ park: p.park })), null, 'batch: under 60,000 freeable characters it waits');
    // one giant result in ONE turn is still one turn
    const giant = run([{ result: body('G', 200000) }].concat(reads(4)));
    A.eq(await makeAgeing({ originOf: giant.originOf }).plan(giant.list, ctxOf({ park: p.park })), null, 'batch: a single turn never ages alone, however large');
    A.eq(p.saved.length, 0, 'batch: deciding parks nothing');
  }

  // ================= a batch: everything behind the newest four tool turns, in the view only =================
  {
    const r = run(reads(7));
    const before = JSON.stringify(r.list);
    const p = parker();
    const ag = makeAgeing({ originOf: r.originOf });
    const b = await ag.plan(r.list, ctxOf({ park: p.park }));
    A.ok(!!b, 'batch: three turns behind the newest four (~74k freeable) age');
    A.eq(b && [b.editAt, b.results, b.args], [3, 3, 0], 'batch: from the first old result (message 3): three results, no arguments');
    A.eq(JSON.stringify(r.list), before, 'batch: the run\'s messages are untouched (the transcript keeps every full body)');
    const v = ag.view(r.list);
    A.ok(v !== r.list && stubs(v) === 3 && stubs(r.list) === 0, 'view: the three old results are stubs on the wire, the list itself is not');
    A.ok(v.slice(-8).every((m, k) => m === r.list[r.list.length - 8 + k]), 'view: the newest four tool turns are the very same objects');
    const again = ag.view(r.list);
    A.ok(again.every((m, k) => m === v[k]), 'view: the same copies on every request (the prefix stays cached between batches)');
    A.ok(ag.agedOf(r.list[3]) === v[3] && ag.originalOf(v[3]) === r.list[3] && ag.agedOf(r.list[r.list.length - 1]) === null, 'agedOf / originalOf pair each copy with its original');
    A.eq(p.saved.map(s => s.text), [r.list[3].content, r.list[5].content, r.list[7].content], 'batch: each aged body is parked exactly as it was');
    A.ok(/; the whole result is saved: read it with fs\.read \{"path":"\.output\/p1\.txt"\}\]$/.test(String(v[3].content).split('\n')[0]), 'batch: a result stub is the micro tier\'s, naming its saved copy');
    // the next request adds ONE more turn behind the window: never a batch on two requests in a row
    const r2 = run(reads(8));
    const ag2 = makeAgeing({ originOf: r2.originOf });
    A.ok(!!(await ag2.plan(r2.list.slice(0, -2), ctxOf({ park: p.park }))), 'batch: (the same run, one request earlier)');
    A.eq(await ag2.plan(r2.list, ctxOf({ park: p.park })), null, 'batch: the very next request never ages again (one new turn behind the window)');
  }

  // ================= the projection and the payback =================
  {
    const r10 = run(reads(10));
    const tryOn = (r) => async (o) => !!(await makeAgeing({ originOf: r.originOf }).plan(r.list, ctxOf(Object.assign({ park: parker().park }, o))));
    const at10 = tryOn(r10);
    A.eq(await at10({ requests: 12 }), false, 'projection: 12 requests made projects 24: never aged');
    A.eq(await at10({ requests: 13 }), true, 'projection: 13 made projects 26: may age');
    A.eq(await at10({ requests: 20, maxIters: 24 }), false, 'projection: a 24-turn ceiling never projects past 24');
    A.eq(await at10({ requests: 13, maxIters: 26 }), true, 'projection: a 26-turn ceiling at 13 projects 26');
    A.eq(await at10({ rates: () => null }), false, 'payback: an unpriced route (a sign-in, a local model) never ages');
    A.eq(await at10({ rates: () => { throw new Error('x'); } }), false, 'payback: rates that throw are no rates');
    // EXACT, on seven turns: a ruler that sizes a whole result 100, a stub 10, anything else 0. F = 3 x 90 = 270 and
    // T = 3 x 10 + 4 x 100 = 430, so R x 270 x 0.1 > 430 x (1.25 - 0.1) = 494.5 needs R > 18.31
    const r7 = run(reads(7));
    const at7 = tryOn(r7);
    const measure = m => (m.role === 'tool' ? (String(m.content).indexOf(ELIDED) === 0 ? 10 : 100) : 0);
    A.eq(await at7({ requests: 18, measure }), false, 'payback: R 18 x F 270 x r 0.1 = 486 does not beat T 430 x (1.25 - 0.1) = 494.5');
    A.eq(await at7({ requests: 19, measure }), true, 'payback: R 19 x 270 x 0.1 = 513 beats 494.5');
    const b = await makeAgeing({ originOf: r7.originOf }).plan(r7.list, ctxOf({ requests: 19, measure, park: parker().park }));
    A.eq(b && [b.remaining, b.freed, b.suffix, b.read, b.write, Math.round(b.saving * 10) / 10, Math.round(b.rewrite * 10) / 10, b.assumed], [19, 270, 430, 0.1, 1.25, 513, 494.5, false], 'payback: the batch reports the numbers it was weighed on');
    // a provider that holds the run's history re-writes ALL of it after any edit: T counts from message 0
    const sysToo = m => (m.role === 'system' ? 100 : measure(m));
    A.eq(await at7({ requests: 19, measure: sysToo, holdsHistory: true }), false, 'payback: on a provider that holds the history, the whole re-sent history is the re-write');
    A.eq(await at7({ requests: 19, measure: sysToo, holdsHistory: false }), true, 'payback: (the same run on a provider that does not)');
    // a route that names no cache rates is weighed at 0.10 / 1.25
    const assumed = await makeAgeing({ originOf: r7.originOf }).plan(r7.list, ctxOf({ requests: 19, measure, park: parker().park, rates: () => ({ read: 1, write: 1, published: false }) }));
    A.eq(assumed && [assumed.read, assumed.write, assumed.assumed], [0.1, 1.25, true], 'payback: no published cache rates -> weighed at the assumed 0.10 / 1.25');
    // cheap reads need far more requests left: DeepSeek-like 0.02 / 1.00 needs R x 5.4 > 421.4, R > 78
    const cheap = () => ({ read: 0.02, write: 1.0, published: true });
    A.eq(await at7({ requests: 78, measure, rates: cheap }), false, 'payback: reads at 0.02x: R 78 x 270 x 0.02 = 421.2 does not beat 430 x 0.98 = 421.4');
    A.eq(await at7({ requests: 79, measure, rates: cheap }), true, 'payback: ... R 79 does');
  }

  // ================= what ages, and what never does =================
  {
    const big = body('W', 5000);
    const r = run([
      { quoted: true },                                                    // 0: quoted words: never a file
      { origin: false },                                                   // 1: a body this run did not produce
      { parked: '.output/build-r1-0.txt' },                                // 2: the registry parked it: named, not parked again
      { name: 'fs_write', args: { path: 'a.js', content: big }, result: 'Wrote 5000 chars to a.js' },
      { name: 'fs_write', args: { path: 'b.js', content: big }, result: 'ERROR: b.js is read-only', ok: false },
      { name: 'fs.edit', args: { path: 'a.js', find: big, replace: 'short' }, result: 'Edited a.js' },
      { result: body('S', 400) }                                           // 6: a stub would not halve it
    ].concat(reads(6)));                                                   // 7, 8 old reads; 9-12 the newest four
    const p = parker();
    const ag = makeAgeing({ originOf: r.originOf });
    const b = await ag.plan(r.list, ctxOf({ park: p.park }));
    A.ok(!!b, 'eligibility: the batch runs');
    const v = ag.view(r.list);
    const at = k => 2 + 2 * k;   // turn k's assistant message; its result is at + 1
    A.ok(v[at(0) + 1] === r.list[at(0) + 1], 'eligibility: words quoted from another session ride whole');
    A.ok(v[at(1) + 1] === r.list[at(1) + 1], 'eligibility: a body this run did not produce rides whole');
    A.ok(/; the output saved before it was cut: read it with fs\.read \{"path":"\.output\/build-r1-0\.txt"\}\]$/.test(String(v[at(2) + 1].content).split('\n')[0]), 'eligibility: a registry-parked result names that park');
    const wrote = JSON.parse(v[at(3)].tool_calls[0].function.arguments);
    A.eq(wrote.path, 'a.js', 'arguments: the short ones stay');
    A.ok(new RegExp('^' + ARG_ELIDED.replace(/[[\]]/g, '\\$&') + '5000 bytes; the whole argument is saved: read it with fs\\.read \\{"path":"\\.output\\/p\\d+\\.txt"\\}\\]$').test(wrote.content), 'arguments: a successful write\'s content is a stub naming its saved copy: ' + wrote.content);
    A.ok(v[at(3)].reasoning === r.list[at(3)].reasoning, 'arguments: the copy carries its turn\'s thinking (until the request view strips it)');
    A.ok(v[at(4)] === r.list[at(4)], 'arguments: a write that FAILED keeps its arguments whole');
    const edited = JSON.parse(v[at(5)].tool_calls[0].function.arguments);
    A.ok(edited.find.indexOf(ARG_ELIDED) === 0 && edited.replace === 'short', 'arguments: fs.edit (a dotted name too) ages its long find, keeps a short replace');
    A.ok(v[at(6) + 1] === r.list[at(6) + 1], 'eligibility: a body its stub would not halve rides whole');
    A.ok(v[at(3) + 1] === r.list[at(3) + 1], 'eligibility: a short receipt rides whole');
    A.ok(v[at(7) + 1] !== r.list[at(7) + 1] && v[at(8) + 1] !== r.list[at(8) + 1], 'eligibility: the two old reads age');
    const savedArgs = p.saved.filter(s => s.meta.reason === 'argument-elided-at-compaction');
    A.eq(savedArgs.map(s => s.text), [big, big], 'arguments: the saved copy is the exact argument (the write\'s content, the edit\'s find)');
    A.eq(p.saved.length, 4, 'parks: the two arguments and the two old reads, nothing for quoted, unproduced, registry-parked or small bodies');
    A.ok(!p.saved.some(s => s.meta && Array.isArray(s.meta.quotedStreams)), 'parks: the parker is never asked to save quoted words');
  }

  // ================= a park that fails: the body rides whole, and is never tried again =================
  {
    const r = run(reads(11));
    let calls = 0;
    const flaky = async () => { calls++; return calls === 1 ? null : { path: '.output/ok' + calls + '.txt' }; };
    const ag = makeAgeing({ originOf: r.originOf });
    const first = r.list.slice(0, 2 + 2 * 8);   // eight tool turns: turns 1-4 behind the window
    const b = await ag.plan(first, ctxOf({ park: flaky }));
    A.ok(!!b && b.results === 3 && b.editAt === 5, 'park failure: the batch ages the rest, from the first body it could save');
    A.ok(ag.view(first)[3] === first[3], 'park failure: that body rides whole');
    const b2 = await ag.plan(r.list, ctxOf({ park: flaky }));   // eleven turns: turns 5-7 are the next batch
    A.ok(!!b2 && b2.results === 3 && b2.editAt === 11, 'park failure: the next batch ages only the new turns behind the window');
    A.eq(calls, 7, 'park failure: never tried again (one park per body: 4, then 3)');
    A.ok(ag.view(r.list)[3] === r.list[3], 'park failure: the body still rides whole');
  }

  // ================= thinking: the copy follows its original; a strip is durable on both =================
  {
    const r = run(writes(31000).concat(reads(4)));
    const ag = makeAgeing({ originOf: r.originOf });
    A.ok(!!(await ag.plan(r.list, ctxOf({ park: parker().park }))), 'thinking: two old writes age (their arguments)');
    delete r.list[2].reasoning;   // a failover deletes foreign blocks from the run's own messages
    A.ok(!('reasoning' in ag.view(r.list)[2]), 'thinking: an aged copy drops the thinking its original lost');
    const r3 = run(writes(31000).concat(reads(4)));
    const ag3 = makeAgeing({ originOf: r3.originOf });
    const rv3 = makeRequestView({ ownerOf: ag3.originalOf });
    rv3.messages(ag3.view(r3.list), { tools: [], binds: true });   // the run's first request proves no block: all go
    r3.list.forEach((m, k) => { if (m.role === 'assistant') m.reasoning = [{ type: 'thinking', signature: 'late' + k }]; });   // blocks minted since
    rv3.messages(ag3.view(r3.list), { tools: [], binds: true });
    A.ok(r3.list.every(m => m.role !== 'assistant' || Array.isArray(m.reasoning)), 'thinking: an append-only request strips nothing');
    A.ok(!!(await ag3.plan(r3.list, ctxOf({ park: parker().park }))), 'thinking: (the batch)');
    const sent = ag3.view(r3.list);
    const out = rv3.messages(sent, { tools: [], binds: true });
    A.eq(out.editAt, 2, 'thinking: the request view sees the batch as an edit at the first aged message');
    A.ok(!('reasoning' in sent[2]) && !('reasoning' in r3.list[2]) && !('reasoning' in r3.list[4]), 'thinking: the blocks the batch unbound are gone from the copy AND its original (durable for the journal)');
    A.ok(!('reasoning' in ag3.view(r3.list)[2]), 'thinking: and stay gone on the next request');
  }

  // ================= the route's cache prices (cost.js cacheRates) =================
  {
    const anthropic = makeCostEngine({ priceOf: id => prices.priceOf('anthropic', id) });
    A.eq(anthropic.cacheRates('claude-opus-5-5'), { read: 0.1, write: 1.25, published: true }, 'cacheRates: the Anthropic row\'s published rates (W1.13: the 5-minute write by default)');
    A.eq(makeCostEngine({ priceOf: () => ({ in: 3, out: 15 }) }).cacheRates('m'), { read: 1, write: 1, published: false }, 'cacheRates: a row with no cache rates books 1.0x and says it published none');
    A.eq(makeCostEngine({ priceOf: () => null }).cacheRates('m'), null, 'cacheRates: unpriced is null');
    A.eq(makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }).cacheRates('m'), null, 'cacheRates: a free (local) model is unpriced');
    A.eq(makeCostEngine({ priceOf: () => ({ in: 1, out: 1, cache: { read: 0.02, write: 1.0 } }) }).cacheRates('m'), { read: 0.02, write: 1, published: true }, 'cacheRates: any family\'s own rates');
  }

  A.eq([AGEING.KEEP_TURNS, AGEING.BATCH_CHARS, AGEING.MIN_TURNS, AGEING.SHORT_RUN], [4, 60000, 2, 24], 'the measured constants: keep 4 tool turns, 60k characters, 2 turns a batch, never for 24 requests or fewer');
  A.report('batched-ageing.test');
})().catch(e => { console.log('FAIL: batched-ageing.test threw -- ' + (e && e.stack || e)); process.exit(1); });
