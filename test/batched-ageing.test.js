/* node test/batched-ageing.test.js — unit cover for W2.1 batched ageing (sidecar/history-edit.js makeAgeing), where the
   request after a batch can still read the cache (readFloor: the payback's T, from the W2.1 review), how many later
   requests a payback may count on (the horizon, from the same review) and the route cache prices it weighs a batch with
   (sidecar/cost.js cacheRates). The end-to-end invariants (the real loop, a binding
   upstream, the real fs.read read-back, the switch-off golden, the documented cache's bill) live in
   batched-ageing.invariant.test.js.
   Pure: no network, no files (an in-memory parker). */
'use strict';
// hermetic: no operator switch from the shell (the cache-TTL tier, a price override) reaches the prices read here
for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_/.test(k)) delete process.env[k];
const A = require('./_assert.js');
const HE = require('../sidecar/history-edit.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const prices = require('../sidecar/providers/prices.js');
const Provider = require('../sidecar/providers/provider.js');
const { makeAgeing, makeRequestView, readFloor, ARG_ELIDED, ELIDED, AGEING } = HE;

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
    const r = run(reads(10));
    const before = JSON.stringify(r.list);
    const p = parker();
    const ag = makeAgeing({ originOf: r.originOf });
    const b = await ag.plan(r.list, ctxOf({ park: p.park }));
    A.ok(!!b, 'batch: six turns behind the newest four (~148k freeable) age');
    A.eq(b && [b.editAt, b.results, b.args], [3, 6, 0], 'batch: from the first old result (message 3): six results, no arguments');
    A.eq(JSON.stringify(r.list), before, 'batch: the run\'s messages are untouched (the transcript keeps every full body)');
    const v = ag.view(r.list);
    A.ok(v !== r.list && stubs(v) === 6 && stubs(r.list) === 0, 'view: the six old results are stubs on the wire, the list itself is not');
    A.ok(v.slice(-8).every((m, k) => m === r.list[r.list.length - 8 + k]), 'view: the newest four tool turns are the very same objects');
    const again = ag.view(r.list);
    A.ok(again.every((m, k) => m === v[k]), 'view: the same copies on every request (the prefix stays cached between batches)');
    A.ok(ag.agedOf(r.list[3]) === v[3] && ag.originalOf(v[3]) === r.list[3] && ag.agedOf(r.list[r.list.length - 1]) === null, 'agedOf / originalOf pair each copy with its original');
    A.eq(p.saved.map(s => s.text), [3, 5, 7, 9, 11, 13].map(i => r.list[i].content), 'batch: each aged body is parked exactly as it was');
    A.ok(/; the whole result is saved: read it with fs\.read \{"path":"\.output\/p1\.txt"\}\]$/.test(String(v[3].content).split('\n')[0]), 'batch: a result stub is the micro tier\'s, naming its saved copy');
    // the next request adds ONE more turn behind the window: never a batch on two requests in a row
    const r2 = run(reads(11));
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
    // EXACT, on ten turns: a ruler that sizes a whole result 100, a stub 10, anything else 0. F = 6 x 90 = 540 and
    // T = 6 x 10 + 4 x 100 = 460, so R x 540 x 0.1 > 460 x (1.25 - 0.1) = 529 needs R > 9.8 (a turn ceiling sets R under 12)
    const measure = m => (m.role === 'tool' ? (String(m.content).indexOf(ELIDED) === 0 ? 10 : 100) : 0);
    A.eq(await at10({ requests: 20, maxIters: 29, measure }), false, 'payback: R 9 (a 29-turn ceiling, 20 made) x F 540 x r 0.1 = 486 does not beat T 460 x (1.25 - 0.1) = 529');
    A.eq(await at10({ requests: 20, maxIters: 30, measure }), true, 'payback: R 10 x 540 x 0.1 = 540 beats 529');
    const b = await makeAgeing({ originOf: r10.originOf }).plan(r10.list, ctxOf({ requests: 20, maxIters: 30, measure, park: parker().park }));
    A.eq(b && [b.remaining, b.freed, b.suffix, b.read, b.write, Math.round(b.saving * 10) / 10, Math.round(b.rewrite * 10) / 10, b.assumed], [10, 540, 460, 0.1, 1.25, 540, 529, false], 'payback: the batch reports the numbers it was weighed on');
    // THE HORIZON: the payback credits at most 12 more requests, however long the run has gone on
    const far = await makeAgeing({ originOf: r10.originOf }).plan(r10.list, ctxOf({ requests: 400, measure, park: parker().park }));
    A.eq(far && [far.remaining, Math.round(far.saving * 10) / 10], [12, 648], 'horizon: 400 requests made are credited 12 more, not as many again');
    // seven turns: F = 3 x 90 = 270, T = 3 x 10 + 4 x 100 = 430: 12 x 27 = 324 never beats 494.5 (as many again aged them from request 19)
    A.eq(await tryOn(run(reads(7)))({ requests: 400, measure }), false, 'horizon: three old turns behind four whole ones never pay back within 12 requests: no batch at any age');
    // a provider that holds the run's history re-writes ALL of it after any edit: T counts from message 0
    const sysToo = m => (m.role === 'system' ? 200 : measure(m));
    A.eq(await at10({ requests: 40, measure: sysToo, holdsHistory: true }), false, 'payback: on a provider that holds the history, the whole re-sent history is the re-write (648 does not beat 660 x 1.15 = 759)');
    A.eq(await at10({ requests: 40, measure: sysToo, holdsHistory: false }), true, 'payback: (the same run on a provider that does not)');
    // a route that names no cache rates is weighed at 0.10 / 1.25
    const assumed = await makeAgeing({ originOf: r10.originOf }).plan(r10.list, ctxOf({ requests: 40, measure, park: parker().park, rates: () => ({ read: 1, write: 1, published: false }) }));
    A.eq(assumed && [assumed.read, assumed.write, assumed.assumed], [0.1, 1.25, true], 'payback: no published cache rates -> weighed at the assumed 0.10 / 1.25');
    // cheap reads need a far bigger batch: DeepSeek-like 0.02 / 1.00 needs 12 x F x 0.02 > T x 0.98
    const cheap = () => ({ read: 0.02, write: 1.0, published: true });
    A.eq(await at10({ requests: 40, measure, rates: cheap }), false, 'payback: reads at 0.02x: 12 x 540 x 0.02 = 129.6 does not beat 460 x 0.98 = 450.8');
    // thirty-three old turns: F 2970, T 730: 712.8 does not beat 715.4; thirty-four: F 3060, T 740: 734.4 beats 725.2
    A.eq([await tryOn(run(reads(37)))({ requests: 40, measure, rates: cheap }), await tryOn(run(reads(38)))({ requests: 40, measure, rates: cheap })], [false, true], 'payback: ... thirty-three turns behind the window do not pay, thirty-four do');
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
    ].concat(reads(9)));                                                   // 7-11 old reads; 12-15 the newest four
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
    A.ok([7, 8, 9, 10, 11].every(k => v[at(k) + 1] !== r.list[at(k) + 1]) && v[at(12) + 1] === r.list[at(12) + 1], 'eligibility: the five old reads age, the newest four ride whole');
    const savedArgs = p.saved.filter(s => s.meta.reason === 'argument-elided-at-compaction');
    A.eq(savedArgs.map(s => s.text), [big, big], 'arguments: the saved copy is the exact argument (the write\'s content, the edit\'s find)');
    A.eq(p.saved.length, 7, 'parks: the two arguments and the five old reads, nothing for quoted, unproduced, registry-parked or small bodies');
    A.ok(!p.saved.some(s => s.meta && Array.isArray(s.meta.quotedStreams)), 'parks: the parker is never asked to save quoted words');
  }

  // ================= a park that fails: the body rides whole, and is never tried again =================
  {
    const r = run(reads(16));
    let calls = 0;
    const flaky = async () => { calls++; return calls === 1 ? null : { path: '.output/ok' + calls + '.txt' }; };
    const ag = makeAgeing({ originOf: r.originOf });
    const first = r.list.slice(0, 2 + 2 * 10);   // ten tool turns: turns 1-6 behind the window
    const b = await ag.plan(first, ctxOf({ park: flaky }));
    A.ok(!!b && b.results === 5 && b.editAt === 5, 'park failure: the batch ages the rest, from the first body it could save');
    A.ok(ag.view(first)[3] === first[3], 'park failure: that body rides whole');
    const b2 = await ag.plan(r.list, ctxOf({ park: flaky }));   // sixteen turns: turns 7-12 are the next batch
    A.ok(!!b2 && b2.results === 6 && b2.editAt === 15, 'park failure: the next batch ages only the new turns behind the window');
    A.eq(calls, 12, 'park failure: never tried again (one park per body: 6, then 6)');
    A.ok(ag.view(r.list)[3] === r.list[3], 'park failure: the body still rides whole');
  }

  // ================= thinking: the copy follows its original; a strip is durable on both =================
  {
    const r = run(writes(60000).concat(reads(4)));
    const ag = makeAgeing({ originOf: r.originOf });
    A.ok(!!(await ag.plan(r.list, ctxOf({ park: parker().park }))), 'thinking: two old writes age (their arguments)');
    delete r.list[2].reasoning;   // a failover deletes foreign blocks from the run's own messages
    A.ok(!('reasoning' in ag.view(r.list)[2]), 'thinking: an aged copy drops the thinking its original lost');
    const r3 = run(writes(60000).concat(reads(4)));
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

  // ================= where the next read lands (readFloor, the W2.1 review) =================
  {
    const isNote = Provider.isRunContextNote;
    const NOTE = { role: 'system', content: Provider.runContextNote('[TASK BRIEF] carry on') };
    // a resumed conversation: 0 the system prompt, 1-4 two transcript pairs, 5 the note, 6 the newest message, 7-12 tool turns
    const conv = [{ role: 'system', content: 'STABLE ORDERS\n\nper-conversation tail' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }, NOTE, { role: 'user', content: 'do it' }];
    for (let k = 0; k < 3; k++) conv.push({ role: 'assistant', content: '', tool_calls: [{ id: 't' + k, type: 'function', function: { name: 'fs_read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't' + k, content: 'r' + k });
    const claude = (history, system, more) => Object.assign({ anchors: { history, system }, isHistoryEnd: isNote }, more);
    A.eq(readFloor(conv, 8, {}), { from: 8, systemTail: null }, 'readFloor: a route with no breakpoints declared (automatic prefix caching) reads up to the edit');
    A.eq(readFloor(conv, 8, { anchors: null, isHistoryEnd: isNote, stable: 'STABLE ORDERS' }), { from: 8, systemTail: null }, 'readFloor: anchors null is the same automatic prefix');
    A.eq(readFloor(conv, 8, claude(true, 'all', { holdsHistory: true })), { from: 0, systemTail: null }, 'readFloor: a provider that holds the history re-sends all of it');
    A.eq(readFloor(conv, 8, claude(false, 'all')), { from: 1, systemTail: null }, 'readFloor: Claude, cache TTL 5m: the read lands on the system prompt, so the resumed conversation is re-written');
    A.eq(readFloor(conv, 8, claude(false, 'prefix', { stable: 'STABLE ORDERS' })), { from: 1, systemTail: { role: 'system', content: '\n\nper-conversation tail' } },
      'readFloor: beside a tool anchor only the stable prefix of a split system is anchored: its tail is re-written too');
    A.eq([readFloor(conv, 8, claude(false, 'prefix', { stable: '' })).systemTail, readFloor(conv, 8, claude(false, 'prefix', { stable: 'OTHER' })).systemTail], [null, null],
      'readFloor: an unsplit system (no stable prefix, or one it does not start with) is anchored whole');
    const parts = [{ role: 'system', content: [{ type: 'text', text: 'STABLE ORDERS' }, { type: 'text', text: '\n\ntail' }] }].concat(conv.slice(1));
    A.eq(readFloor(parts, 8, claude(false, 'prefix', { stable: 'STABLE ORDERS' })).systemTail, { role: 'system', content: [parts[0].content] },
      'readFloor: a system in parts beside a tool anchor counts all of it as re-written (the dearer answer: no part is flattened here)');
    A.eq(readFloor(conv, 8, claude(true, 'all')), { from: 5, systemTail: null }, 'readFloor: Claude, cache TTL mixed: the read lands on the end of history, so only the note on is re-written');
    A.eq(readFloor(conv, 3, claude(true, 'all')).from, 1, 'readFloor: mixed, an edit inside the history moves that anchor too: back to the system prompt');
    A.eq(readFloor([conv[0], NOTE].concat(conv.slice(6)), 4, claude(true, 'all')).from, 1, 'readFloor: mixed, a conversation\'s first message: the note follows the system prompt, nothing to read past it');
    A.eq(readFloor(conv, 8, claude(true, 'all', { isHistoryEnd: () => { throw new Error('x'); } })).from, 1, 'readFloor: a note predicate that throws finds no note (the dearer answer)');
    A.eq([readFloor(conv, 0, claude(false, 'all')).from, readFloor(conv, 99, {}).from, readFloor(conv, -3, {}).from], [0, conv.length, 0], 'readFloor: an edit in the system run re-writes from the edit; out of range is clamped');
  }

  // ================= a resumed conversation: no batch when re-writing it outweighs the saving (the W2.1 review) =================
  {
    // tool turns behind a resumed conversation: 0 system, 1-4 two transcript pairs, 5 the note, 6 the newest message,
    // then the tool turns (results from 8 on age; the newest four ride whole)
    function resumed(pairs, turns, chars, system) {
      const r = run(turns);
      const hist = [];
      for (let k = 0; k < pairs; k++) hist.push({ role: 'user', content: chars ? body('Q' + k, chars / 4) : 'q' + k }, { role: 'assistant', content: chars ? body('A' + k, chars * 3 / 4) : 'a' + k });
      r.list.splice(1, 0, ...hist, { role: 'system', content: Provider.runContextNote('[TASK BRIEF] carry on') });
      if (system) r.list[0] = { role: 'system', content: system };
      return Object.assign(r, { hist: new Set(hist) });
    }
    // the exact ruler of the payback above (a whole result 100, a stub 10), each transcript message 100, a system tail 50
    const ruler = rr => m => (rr.hist.has(m) ? 100 : m.role === 'system' ? (/TAIL$/.test(String(m.content)) ? 50 : 0) : (m.role === 'tool' ? (String(m.content).indexOf(ELIDED) === 0 ? 10 : 100) : 0));
    const at = (rr, o) => makeAgeing({ originOf: rr.originOf }).plan(rr.list, ctxOf(Object.assign({ requests: 40, measure: ruler(rr), park: parker().park, isHistoryEnd: Provider.isRunContextNote }, o)));
    const five = { history: false, system: 'all' };
    // ten tool turns: F = 6 x 90 = 540 and, from the first aged message, T = 460: 12 x 54 = 648 beats 529
    const r10 = resumed(2, reads(10));
    const auto = await at(r10);
    A.eq(auto && [auto.editAt, auto.from, auto.freed, auto.suffix], [8, 8, 540, 460], 'resumed, automatic prefix: T from the first aged message (460): 12 x 54 = 648 beats 529');
    A.eq(await at(r10, { anchors: five }), null, 'resumed, Claude 5m: T from the system prompt, 400 + 460: 648 does not beat 860 x 1.15 = 989');
    A.eq(await at(r10, { anchors: five, requests: 400 }), null, 'resumed, Claude 5m: nor however long the run has gone on (the payback credits 12 requests; as many again aged it from request 19)');
    // the batch waits for a bigger one: nine old turns (F 810, T 400 + 90 + 400) do not pay, ten (F 900, T 900) do
    A.eq(await at(resumed(2, reads(13)), { anchors: five }), null, 'resumed, Claude 5m: nine turns behind the window: 12 x 81 = 972 does not beat 890 x 1.15 = 1023.5');
    const c14 = await at(resumed(2, reads(14)), { anchors: five });
    A.eq(c14 && [c14.editAt, c14.from, c14.suffix, Math.round(c14.rewrite * 10) / 10], [8, 1, 900, 1035], 'resumed, Claude 5m: ten turns behind the window: 1080 beats 1035, and the batch reports where the re-write starts (message 1)');
    const mixed = await at(r10, { anchors: { history: true, system: 'all' } });
    A.eq(mixed && [mixed.from, mixed.suffix], [5, 460], 'resumed, Claude mixed: the read lands on the end of history, T from the note (460): it ages where 5m waits');
    const prefix = { history: false, system: 'prefix' };
    A.eq(await at(resumed(2, reads(14), 0, 'STABLE\n\nTAIL'), { anchors: prefix, stable: 'STABLE' }), null, 'resumed, a split system beside a tool anchor: its unanchored tail (50) is re-written too: 1080 does not beat 950 x 1.15 = 1092.5');
    const c15 = await at(resumed(2, reads(15), 0, 'STABLE\n\nTAIL'), { anchors: prefix, stable: 'STABLE' });
    A.eq(c15 && [c15.from, c15.suffix], [1, 960], 'resumed, a split system: eleven turns behind the window, 12 x 99 = 1188 beats 960 x 1.15 = 1104');
    // in characters (the default ruler): forty requests into a run behind a 200,000-character resumed conversation
    const big = resumed(20, reads(10), 10000);
    const plain = anchors => makeAgeing({ originOf: big.originOf }).plan(big.list, ctxOf({ requests: 40, park: parker().park, anchors, isHistoryEnd: Provider.isRunContextNote }));
    const [bAuto, b5m, bMixed] = [await plain(null), await plain(five), await plain({ history: true, system: 'all' })];
    A.ok(!!bAuto && b5m === null && !!bMixed, 'resumed 200,000 characters: an automatic-prefix route ages, Claude 5m does not (re-writing the conversation outweighs the saving), Claude mixed does');
    A.ok(!!bAuto && !!bMixed && bAuto.from === bAuto.editAt && bMixed.from === 41 && bMixed.suffix < bAuto.suffix + 100, 'resumed 200,000 characters: mixed re-writes from the note (41), about what the automatic route re-writes');
  }

  // ================= the stand-in a stub is priced with: the run's own handle shape (W1.7's micro tier stand-in) =================
  {
    const r = run(reads(10));
    const asked = [];
    const long = 'C:/Users/commander/projects/station/.output/untrusted-' + 'x'.repeat(40) + '-run-0000.txt';
    const callLen = p => ('fs.read ' + JSON.stringify({ path: p })).length;
    const plan = standIn => makeAgeing({ originOf: r.originOf }).plan(r.list, ctxOf({ park: parker().park, standIn }));
    const fixed = await plan(undefined);
    const own = await plan(async (text, meta) => { asked.push([text, meta && meta.tool && meta.tool.length, meta && meta.reason]); return { path: long }; });
    A.eq(fixed && own && fixed.freed - own.freed, 6 * (callLen(long) - callLen('.output/' + 'x'.repeat(48) + '.txt')), 'stand-in: each of the six stubs is priced with the run\'s own (longer) handle');
    A.eq(asked, [['', 40, 'elided-at-compaction']], 'stand-in: asked once a plan, at the longest tool stem the host keeps, with nothing to save');
    A.eq((await plan(async () => ({ path: '.output/a.txt' }))).freed, fixed.freed, 'stand-in: a shorter handle never prices a stub cheaper than the fixed stand-in');
    A.eq((await plan(async () => { throw new Error('x'); })).freed, fixed.freed, 'stand-in: one that throws falls back to the fixed stand-in');
  }

  // ================= a throw mid-batch: the view and agedOf still agree =================
  {
    const r = run(reads(10));
    let n = 0;
    const park = async () => { n++; return n === 2 ? { get path() { throw new Error('boom'); } } : { path: '.output/q' + n + '.txt' }; };
    const ag = makeAgeing({ originOf: r.originOf });
    let threw = false;
    try { await ag.plan(r.list, ctxOf({ park })); } catch (_) { threw = true; }
    const v = ag.view(r.list);
    A.ok(threw && ag.agedOf(r.list[3]) !== null, 'mid-batch throw: (the planner threw on the second body, after the first aged)');
    A.ok(r.list.every((m, i) => { const c = ag.agedOf(m); return c ? v[i] === c : v[i] === m; }), 'mid-batch throw: every copy agedOf answers is the one the view sends, and nothing else changed');
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

  A.eq([AGEING.KEEP_TURNS, AGEING.BATCH_CHARS, AGEING.MIN_TURNS, AGEING.SHORT_RUN, AGEING.HORIZON], [4, 60000, 2, 24, 12], 'the measured constants: keep 4 tool turns, 60k characters, 2 turns a batch, never for 24 requests or fewer, a payback within 12 requests');
  A.report('batched-ageing.test');
})().catch(e => { console.log('FAIL: batched-ageing.test threw -- ' + (e && e.stack || e)); process.exit(1); });
