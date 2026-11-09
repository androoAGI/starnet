/* node test/cross-run-replay.test.js — W1.8 CROSS-RUN REPLAY, the resolver's own rules (sidecar/cross-run-replay.js), the provenance
   a 'pairs' view puts on what it replays (turn-view.js REPLAYED), the content-addressed park (output-artifacts.js parkOnce) and the
   one seam in index.js. The end-to-end proof through a real sidecar is test/cross-run-replay.invariant.test.js.
   1. A 'pairs' view (a real memory store) tags every message with its row and the row's own word: the tool its call named,
      taint, taintKnown, quotes. A prose view tags nothing, and no tag reaches a JSON copy or a spread.
   2. A replayed result over the 240-char head becomes the W1.7 stub naming the park; a short one, an untagged one and an
      already elided one ride as they are; the input is never changed.
   3. Provenance: a tainted or unprovable row parks with taintedBy (untrusted-*), a clean row and the bare attachment stamp do not;
      a quoting tool, a row stamped with quotes and a result with no named call are never parked (old wording, no handle); a park
      that fails or throws leaves the same no-handle stub.
   4. The window: the row cap, the byte cap and the token budget, cut on a user turn (never an orphan result), in steps that keep
      the first replayed message put while the chat grows; the directive and a leading system message are never cut; row ids
      stay aligned; a block followed by more replayed messages is only stubbed.
   5. parkOnce: written once, named again for the same bytes (reused), null for a file that holds other bytes (never rewritten),
      one file under concurrent parks of one name.
   6. index.js: one call, after the replayed-taint proof, never on a recovery, with its kill switch; the replay park has no run id. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Replay = require('../sidecar/cross-run-replay.js');
const View = require('../sidecar/turn-view.js');
const Store = require('../sidecar/transcriptstore.js');
const HistoryEdit = require('../sidecar/history-edit.js');
const Fit = require('../frontend/app/historyfit.js');
const { ATTACHMENT_TAINT } = require('../sidecar/taint.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Learning = require('../sidecar/trusted-learning.js');
const Dual = require('../sidecar/turn-dual.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');
const { readSidecarSource, readSidecarIndex } = require('./helpers/source');

const ELIDED = HistoryEdit.ELIDED;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const big = (n, seed) => { let s = seed || 'body'; while (s.length < n) s += ' filler line of a replayed result ' + s.length + '.'; return s.slice(0, n); };
const handleOf = content => { const h = /read it with fs\.read (\{[^\n]*?\})\]/.exec(String(content)); return h ? JSON.parse(h[1]) : null; };

// a fake host parker: records each call, answers a content-named path (or what `answer` says)
function parker(answer) {
  const calls = [];
  const park = async (text, meta) => {
    calls.push({ text, meta });
    if (answer) return answer(text, meta);
    return { path: '.output/' + (meta.taintedBy ? 'untrusted-' : '') + meta.tool + '-replay-' + hash(text).slice(0, 16) + '.txt' };
  };
  return { park, calls };
}
// a synthetic replayed message: the tag a 'pairs' view would put on it
let nextRow = 1;
function tagged(m, extra) {
  Object.defineProperty(m, View.REPLAYED, { value: Object.freeze(Object.assign({ streamId: 's', rowId: nextRow++, role: m.role, tool: '', taint: null, taintKnown: true, quoted: false }, extra)), enumerable: false, configurable: true, writable: true });
  return m;
}
// one replayed exchange: a user turn, a call, its result, a reply (4 messages)
function exchange(k, o) {
  o = o || {};
  const id = 'call_' + k;
  return [
    tagged({ role: 'user', content: 'question ' + k }),
    tagged({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: o.tool || 'fs_read', arguments: '{"path":"f' + k + '.txt"}' } }] }),
    tagged({ role: 'tool', content: o.result || big(1000, 'result ' + k), tool_call_id: id }, { tool: o.tool || 'fs_read', taint: o.taint || null, taintKnown: o.taintKnown !== false, quoted: !!o.quoted }),
    tagged({ role: 'assistant', content: o.reply || ('answer ' + k) })
  ];
}
function withIds(list) {
  Object.defineProperty(list, View.ROW_IDS, { value: list.map(m => { const t = View.replayedOf(m); return t ? { streamId: t.streamId, rowId: t.rowId } : null; }), enumerable: false });
  return list;
}
function pairsValid(list) {
  const open = new Set();
  for (const m of list) {
    if (m.role === 'assistant') { open.clear(); for (const c of (m.tool_calls || [])) open.add(c.id); }
    else if (m.role === 'tool') { if (!open.has(m.tool_call_id)) return false; }
    else if (m.role === 'user') open.clear();
  }
  return true;
}
const directive = () => ({ role: 'user', content: 'the new directive' });

(async () => {
  // ---------------------------------------------------------------- 1. the tag, through a real store view
  {
    const runs = new Map([['r1', { runId: 'r1', streamId: 's', agentId: 'agent', ownerDirective: true, internal: false }]]);
    const dual = Dual.make({ now: () => 10, hash, save() {} });
    const store = Store.makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 10 }, runOf: id => runs.get(id) || null,
      quotedMaterial: Learning.quotedMaterial, live: new Set(), pick: dual.pick, hash, deletedAt: () => 0 });
    const add = extra => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', sourceRunId: 'r1', role: 'user', content: 'q', kind: 'turn', taint: null, ts: 10 }, extra));
    const calls = [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }, { id: 'c2', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://x"}' } }];
    add({ content: 'read both', turnId: 't1' });
    add({ role: 'assistant', content: '', toolCalls: calls, turnId: 't1' });
    add({ role: 'tool', content: big(1000, 'FILE BODY'), toolCallId: 'c1', turnId: 't1' });
    add({ role: 'tool', content: big(1000, 'PAGE BODY'), toolCallId: 'c2', turnId: 't1', taint: 'web page https://x' });
    add({ role: 'assistant', content: 'read them', turnId: 't1' });
    add({ content: 'recall', turnId: 't2' });
    add({ role: 'assistant', content: '', toolCalls: [{ id: 'c3', type: 'function', function: { name: 'recall_conversation', arguments: '{"query":"x"}' } }], turnId: 't2', quotes: ['other'] });
    add({ role: 'tool', content: big(1000, 'QUOTED WORDS'), toolCallId: 'c3', turnId: 't2', quotes: ['other'] });
    add({ role: 'assistant', content: 'recalled', turnId: 't2', quotes: ['other'] });
    const pairs = store.view('model-replay', 's', { limit: 100, shape: 'pairs', form: 'post' });
    const tags = pairs.map(View.replayedOf);
    A.ok(pairs.length === 9 && tags.every(Boolean), 'a pairs view tags every message it replays (' + pairs.length + ')');
    A.eq(tags.map(t => t.rowId), pairs[View.ROW_IDS].map(id => id.rowId), 'each tag names the row its message stands on');
    A.eq(tags.filter(t => t.role === 'tool').map(t => t.tool), ['fs_read', 'web_fetch', 'recall_conversation'], 'a result carries the tool its paired call named');
    A.eq(tags.filter(t => t.role === 'tool').map(t => [t.taint, t.taintKnown, t.quoted]), [[null, true, false], ['web page https://x', true, false], [null, true, true]], 'a result carries its row\'s taint, clean stamp and quotes');
    A.ok(pairs.every(m => Object.keys(m).every(k => ['role', 'content', 'tool_calls', 'tool_call_id'].includes(k))) && JSON.stringify(pairs).indexOf('rowId') < 0
      && !View.replayedOf(Object.assign({}, pairs[2])), 'the tag never reaches a key list, a JSON copy or a spread');
    const prose = store.view('model-replay', 's', { limit: 100, shape: 'prose', form: 'post' });
    A.ok(prose.length > 0 && prose.every(m => !View.replayedOf(m)), 'a prose view tags nothing');
    // the real shaper's output through the resolver: the file is parked clean, the page untrusted, the quoted recall never
    const p = parker();
    const out = await Replay.resolve(View.concat(pairs, [directive()]), { park: p.park });
    const results = out.messages.filter(m => m.role === 'tool').map(m => m.content);
    A.ok(results.every(c => c.indexOf(ELIDED) === 0), 'every replayed result of the store\'s view rides as the stub');
    A.eq(p.calls.map(c => [c.meta.tool, c.meta.taintedBy || null]), [['fs_read', null], ['web_fetch', 'web page https://x']], 'the file parks clean, the page parks tainted, the recall is never parked');
    A.ok(!!handleOf(results[0]) && !!handleOf(results[1]) && !handleOf(results[2]) && results[2].indexOf('re-run the tool for the full output') > 0, 'the recall keeps the old wording and no handle');
    A.ok(p.calls.every(c => c.text.indexOf('QUOTED WORDS') < 0), 'no park is handed the quoted words');
  }

  // ---------------------------------------------------------------- 2. stubs
  {
    const body = big(20000, 'TWENTYK HEAD');
    const list = withIds([...exchange(1, { result: body }), ...exchange(2, { result: 'short result' }), directive()]);
    const posted = { role: 'tool', content: big(5000), tool_call_id: 'posted' };
    const before = JSON.stringify(list);
    const p = parker();
    const out = await Replay.resolve(list, { park: p.park });
    const stub = out.messages[2];
    A.ok(stub.content.indexOf(ELIDED + 'fs_read, 20000 bytes; first 240 chars kept below; the whole result is saved: read it with fs.read ') === 0, 'a 20k result becomes the W1.7 stub (' + stub.content.slice(0, 90) + ')');
    A.ok(stub.content.length < 600 && stub.content.indexOf(body.slice(0, 200)) > 0, 'the stub keeps the 240-char head (' + stub.content.length + ' chars)');
    A.eq(handleOf(stub.content), { path: '.output/fs_read-replay-' + hash(body).slice(0, 16) + '.txt' }, 'the stub names the file the parker answered');
    A.eq(p.calls.length, 1, 'only the result over the head is parked');
    A.ok(p.calls[0].text === body, 'the parker is handed the replayed bytes exactly');
    A.ok(out.messages[6] === list[6], 'a result the head keeps whole rides as it is (same object)');
    A.ok(View.replayedOf(stub) && View.replayedOf(stub).rowId === View.replayedOf(list[2]).rowId, 'the stub keeps the replay tag');
    A.eq(JSON.stringify(list), before, 'the input list is not changed');
    A.eq(out.messages[View.ROW_IDS].map(id => id && id.rowId), list[View.ROW_IDS].map(id => id && id.rowId), 'row ids stay aligned');
    A.ok(out.stubbed === 1 && out.saved === 1 && out.dropped === 0, 'the result counts what it did (' + [out.stubbed, out.saved, out.dropped] + ')');
    // the same replay resolved again: byte-identical (a stable cached prefix)
    const again = await Replay.resolve(list, { park: parker().park });
    A.eq(JSON.stringify(again.messages), JSON.stringify(out.messages), 'the same replay resolves to the same bytes');
    // untagged and already-elided messages are not the resolver's
    const elided = tagged({ role: 'tool', content: ELIDED + 'fs_read, 9 bytes; first 9 chars kept below; re-run the tool for the full output]\nabc', tool_call_id: 'call_x' }, { tool: 'fs_read' });
    const mixed = [{ role: 'user', content: 'page window' }, { role: 'assistant', content: '', tool_calls: [{ id: 'posted', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] }, posted, directive()];
    const untouched = await Replay.resolve(mixed, { park: parker().park });
    A.ok(untouched.messages === mixed, 'a list with nothing replayed comes back as it is');
    const pe = parker();
    const re = await Replay.resolve([tagged({ role: 'user', content: 'u' }), tagged({ role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] }), elided, directive()], { park: pe.park });
    A.ok(re.messages[2] === elided && pe.calls.length === 0, 'an already elided result is left as it is (idempotent)');
  }

  // ---------------------------------------------------------------- 3. provenance
  {
    const cases = [
      ['clean', { taint: null, taintKnown: true }, null],
      ['tainted', { taint: 'web page https://evil' }, 'web page https://evil'],
      ['unprovable', { taint: null, taintKnown: false }, Store.UNVERIFIED_ROW],
      ['bare attachment', { taint: ATTACHMENT_TAINT }, null]
    ];
    for (const [label, prov, want] of cases) {
      const p = parker();
      await Replay.resolve([...exchange(1, prov), directive()], { park: p.park });
      A.eq(p.calls.map(c => c.meta.taintedBy || null), [want], label + ' row: the park is handed taintedBy ' + JSON.stringify(want));
    }
    A.ok(ATTACHMENT_TAINT.length > 0, 'the bare attachment stamp is known here');
    for (const [label, o] of [['recall_conversation', { tool: 'recall_conversation' }], ['session.peek (dotted)', { tool: 'session.peek' }],
      ['session_peek', { tool: 'session_peek' }], ['a row stamped with quotes', { quoted: true }], ['a result with no named call', { tool: '' }]]) {
      const p = parker();
      const list = exchange(1, Object.assign({ result: big(3000, 'SOMEONE ELSE SAID') }, o));
      if (o.tool === '') Object.defineProperty(list[2], View.REPLAYED, { value: Object.freeze(Object.assign({}, View.replayedOf(list[2]), { tool: '' })) });
      const out = await Replay.resolve([...list, directive()], { park: p.park });
      const c = out.messages[2].content;
      A.ok(p.calls.length === 0 && c.indexOf(ELIDED) === 0 && c.indexOf('re-run the tool for the full output]') > 0 && !handleOf(c), label + ': cut to the stub, never parked, no handle');
    }
    for (const [label, answer] of [['returns null', () => null], ['throws', () => { throw new Error('disk full'); }], ['returns no path', () => ({})]]) {
      const out = await Replay.resolve([...exchange(1), directive()], { park: parker(answer).park });
      const c = out.messages[2].content;
      A.ok(c.indexOf(ELIDED) === 0 && !handleOf(c) && c.indexOf('re-run the tool for the full output]') > 0 && out.saved === 0, 'a park that ' + label + ' leaves the no-handle stub');
    }
    const noPark = await Replay.resolve([...exchange(1), directive()], {});
    A.ok(noPark.messages[2].content.indexOf('re-run the tool for the full output]') > 0, 'no parker: the no-handle stub');
  }

  // ---------------------------------------------------------------- 4. the window
  {
    // the row cap, on a user turn, with a leading system message and the directive kept
    const sys = { role: 'system', content: 'carried system message' };
    const block = []; for (let k = 1; k <= 5; k++) block.push(...exchange(k));
    const list = withIds([sys, ...block, directive()]);
    const out = await Replay.resolve(list, { park: parker().park, rows: 8 });
    const kept = out.messages.slice(1, -1);
    A.ok(out.messages[0] === sys && out.messages.at(-1) === list.at(-1), 'the leading system message and the directive are never cut');
    A.ok(kept.length <= 8 && kept.length > 0 && kept[0].role === 'user', 'the row cap keeps at most 8 replayed messages and starts on a user turn (' + kept.length + ')');
    A.ok(pairsValid(out.messages), 'no result is left without its call');
    A.eq(out.dropped, block.length - kept.length, 'dropped counts the replayed messages the window left out');
    A.eq(out.messages[View.ROW_IDS].map(id => id && id.rowId), out.messages.map(m => { const t = View.replayedOf(m); return t ? t.rowId : null; }), 'row ids stay aligned after a cut');
    // a fit that lands inside an exchange moves on to the next user turn
    const s = Replay._internals.startOf([{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }], 2, 1);
    A.eq(s, 4, 'a cut that falls on a result starts at the next user turn');
    A.eq(Replay._internals.startOf([{ role: 'user' }, { role: 'assistant' }], 1, 1), 2, 'no user turn after the fit: nothing of the block is kept');
    A.eq(Replay._internals.startOf([{ role: 'assistant' }, { role: 'user' }], 0, 4), 0, 'no cut: the block starts where it starts');

    // STEPS, at the production caps (the page's 120 rows, a step of 30 messages): a chat that grows one 4-message exchange a
    // turn keeps its first replayed message put between step marks instead of sliding every turn once it is over the cap
    const starts = [], grown = [];
    let monotonic = true, bounded = true, valid = true, whole = true, cutAt = 0;
    for (let k = 1; k <= 60; k++) {
      grown.push(...exchange(100 + k));
      const r = await Replay.resolve([...grown, directive()], { park: parker().park });
      const keptBlock = r.messages.slice(0, -1);
      const first = View.replayedOf(keptBlock[0]).rowId;
      if (starts.length && first < starts[starts.length - 1]) monotonic = false;
      if (keptBlock.length > Fit.HISTORY_CAP) bounded = false;
      if (!pairsValid(r.messages) || keptBlock[0].role !== 'user') valid = false;
      if (grown.length <= Fit.HISTORY_CAP && r.dropped !== 0) whole = false;
      if (r.dropped && !cutAt) cutAt = k;
      starts.push(first);
    }
    const cutTurns = starts.slice(cutAt - 1);
    const moves = cutTurns.filter((x, i) => i > 0 && x !== cutTurns[i - 1]).length;
    A.ok(whole && cutAt === 31, 'a replay inside the caps is kept whole; the first cut comes with the 121st message (exchange ' + cutAt + ')');
    A.ok(bounded && valid && monotonic, 'every window is inside the row cap, starts on a user turn, keeps every pair, and never moves back');
    A.ok(moves >= 3 && moves <= 5, 'over the cap the window\'s first message moves in steps (' + moves + ' moves over ' + (cutTurns.length - 1) + ' growing turns; a sliding window moves on every one)');
    const runs = []; let len = 1; for (let i = 1; i < cutTurns.length; i++) { if (cutTurns[i] === cutTurns[i - 1]) len++; else { runs.push(len); len = 1; } } runs.push(len);
    A.ok(runs.slice(1, -1).every(n => n >= 7), 'between two steps the first message stays put for 7-8 turns, the cached prefix with it (' + runs.join(',') + ')');

    // the token budget, on what will be sent
    const long = []; for (let k = 1; k <= 6; k++) long.push(...exchange(200 + k, { reply: big(4000, 'long reply ' + k) }));
    const limit = 20000, budget = Fit.uncalibratedBudget(limit, 0.65);
    const noBudget = await Replay.resolve([...long, directive()], { park: parker().park });
    const fitted = await Replay.resolve([...long, directive()], { park: parker().park, limit, compactAt: 0.65 });
    A.ok(noBudget.dropped === 0, 'no window size known: no token fit');
    A.ok(fitted.dropped > 0 && fitted.messages[0].role === 'user' && pairsValid(fitted.messages), 'the token budget cuts the replay, on a user turn (' + fitted.dropped + ' dropped)');
    A.ok(Fit.contextEstimateMessages(fitted.messages) <= budget, 'what is kept fits the budget (' + Fit.contextEstimateMessages(fitted.messages) + ' <= ' + budget + ')');
    // the wire byte cap
    const huge = []; for (let k = 1; k <= 3; k++) huge.push(...exchange(300 + k, { reply: big(400 * 1024, 'huge ' + k) }));
    const capped = await Replay.resolve([...huge, directive()], { park: parker().park });
    A.ok(capped.dropped > 0 && Fit.utf8Bytes(JSON.stringify(capped.messages)) <= Fit.HISTORY_WIRE_MAX_BYTES, 'the wire byte cap cuts the replay (' + capped.dropped + ' dropped)');
    // nothing of the block fits: only the directive rides
    const none = await Replay.resolve([...exchange(400, { reply: big(9000) }), directive()], { park: parker().park, limit: 2000, compactAt: 0.65 });
    A.ok(none.messages.length === 1 && none.messages[0].content === 'the new directive', 'a block that cannot fit at all leaves the directive alone');
    // a replayed block followed by more replayed messages is only stubbed, never cut
    const split = [...exchange(500), directive(), ...exchange(501), directive()];
    const sp = await Replay.resolve(split, { park: parker().park, rows: 2 });
    A.ok(sp.messages.length === split.length && sp.dropped === 0 && sp.messages[2].content.indexOf(ELIDED) === 0 && sp.messages[7].content.indexOf(ELIDED) === 0, 'two replayed blocks: both stubbed, neither cut');
  }

  // ---------------------------------------------------------------- 5. parkOnce
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w18-parkonce-'));
    try {
      const oa = makeOutputArtifacts({ fsp: fs.promises, fs, pathMod: path, root });
      const body = big(5000, 'park once ✓ — ünïcode 🚀');
      const first = await oa.parkOnce('agent', 'fs_read-replay-' + hash(body).slice(0, 16), body);
      A.ok(first && first.path === '.output/fs_read-replay-' + hash(body).slice(0, 16) + '.txt' && first.reused === false, 'the first park writes the content-named file (' + (first && first.path) + ')');
      A.ok(fs.readFileSync(path.join(root, 'agent', first.path)).equals(Buffer.from(body, 'utf8')), 'the file holds the bytes exactly');
      const second = await oa.parkOnce('agent', 'fs_read-replay-' + hash(body).slice(0, 16), body);
      A.ok(second && second.path === first.path && second.reused === true && second.sha256 === first.sha256, 'the same bytes name the same file again (reused)');
      A.eq(fs.readdirSync(path.join(root, 'agent', '.output')).length, 1, 'nothing is written twice');
      fs.writeFileSync(path.join(root, 'agent', first.path), 'edited since');
      const tampered = await oa.parkOnce('agent', 'fs_read-replay-' + hash(body).slice(0, 16), body);
      A.ok(tampered === null && fs.readFileSync(path.join(root, 'agent', first.path), 'utf8') === 'edited since', 'a file holding other bytes is never the handle, and never rewritten');
      const other = big(3000, 'concurrent');
      const all = await Promise.all([1, 2, 3, 4, 5].map(() => oa.parkOnce('agent', 'shell_exec-replay-' + hash(other).slice(0, 16), other)));
      A.ok(all.every(r => r && r.path === all[0].path) && all.filter(r => r.reused === false).length === 1, 'five concurrent parks of one name: one write, one file, five handles');
      A.ok(fs.readFileSync(path.join(root, 'agent', all[0].path)).equals(Buffer.from(other, 'utf8')), 'and the file holds the bytes exactly');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // ---------------------------------------------------------------- 6. the seam in index.js
  {
    const idx = readSidecarIndex();   // this section pins index.js's own structure (test/helpers/source.js, H5)
    const at = idx.indexOf('CrossRunReplay.resolve(');
    A.ok(at > 0 && idx.indexOf('CrossRunReplay.resolve(', at + 1) < 0 && readSidecarSource().split('CrossRunReplay.resolve(').length === 2, 'the replay is resolved at exactly one place');
    const proof = idx.indexOf('const replayed = replayedTaint({ recovery: o.recovery, streamId, msgs });');
    const align = idx.indexOf('EarlierConversation.align(rows, window, redact)');
    A.ok(proof > 0 && align > 0 && proof < at && at < align, 'after the replayed-taint proof reads the replay as it came, before the earlier-conversation note places the window');
    A.ok(/if \(!o\.recovery && !o\.groupTools && !internal && String\(ENV\('CROSS_RUN_REPLAY'\) \|\| ''\)\.trim\(\) !== '0'\) \{\s*try \{\s*const replay = await CrossRunReplay\.resolve\(/.test(idx.slice(at - 300, at + 40)),
      'never on a recovery checkpoint, a group session or an internal run, and STARNET_CROSS_RUN_REPLAY=0 turns it off');
    A.ok(/if \(meta && meta\.replay === true\) \{[\s\S]{0,700}outputArtifacts\.parkOnce\(agentId \|\| 'agent', \(untrustedRow \? taintPolicy\.UNTRUSTED_PARK_PREFIX : ''\) \+ safeTool \+ '-replay-' \+ digest, content\)/.test(idx),
      'the replay park is content-named ([untrusted-]<tool>-replay-<digest>), with no run id, through parkOnce');
  }

  A.report('cross-run-replay.test');
})().catch(e => { A.ok(false, 'test error: ' + ((e && e.stack) || e)); A.report('cross-run-replay.test'); });
