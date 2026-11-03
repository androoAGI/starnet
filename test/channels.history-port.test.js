'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const Port = require('../sidecar/channels/history-port.js');
const Store = require('../sidecar/transcriptstore.js');
const View = require('../sidecar/turn-view.js');
const Delivery = require('../sidecar/turn-delivery.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
async function rejected(fn) { try { await fn(); return null; } catch (error) { return error; } }
function fixture() {
  const io = require('../sidecar/transcript-history.js').makeMemoryTranscriptIo();
  const store = Store.makeTranscriptStore({ io, clock: { now: () => 10 }, hash,
    runOf: id => id === 'legacy-refused' ? { taskKey: 'chain:legacy' } : null });
  const records = new Map(), files = new Map(), notes = [], outcomes = new Map(), writes = [];
  let legacyReads = 0, serial = 0, view = (...args) => store.view(...args);
  const legacyStore = {
    getChatRecord: id => records.get(id),
    saveChatRecord(id, patch) { const row = Object.assign({}, records.get(id), patch); records.set(id, row); return row; },
    loadHistory(id) { legacyReads++; return (files.get(id) || []).map(row => Object.assign({}, row)); },
    appendTurn(id, role, text) { const rows = files.get(id) || []; rows.push({ role, content: text, ts: 10 }); files.set(id, rows); writes.push([id, role, text]); },
    clearHistory(id) { const n = (files.get(id) || []).length; files.set(id, []); return n; }
  };
  const port = Port.make({ view: (...args) => view(...args), append: row => store.appendStrict(row), hash, now: () => 10,
    cacheRetractions: (...args) => store.cacheRetractions(...args),
    legacyStore, outcomeOf: id => outcomes.get(id) ?? null, newId: () => 'fresh' + (++serial),
    writeDelivery: input => Delivery.write(store, input), failNote: (tag, error) => notes.push([tag, error.message]) });
  const chat = extra => port.context(Object.assign({ channel: 'telegram', chatId: 'room', legacyKey: 'tg_room' }, extra));
  const add = row => store.appendStrict(Object.assign({ streamId: 'channel_telegram_room', agentId: 'agent', role: 'user', kind: 'turn', content: 'ordinary' }, row));
  return { port, store, io, records, files, notes, outcomes, writes, chat, add,
    get legacyReads() { return legacyReads; }, setView(fn) { view = fn; } };
}
(async () => {
  {
    const f = fixture(), sid = 'channel_telegram_room';
    const user = f.add({ content: 'expanded current words', typed: 'original words', turnId: 'ordinary_turn_01' });
    const answer = f.add({ role: 'assistant', content: 'ordinary answer', turnId: 'ordinary_turn_01' });
    f.add({ kind: 'station', role: 'assistant', content: 'INTERNAL NEVER REPLAY' });
    function hop(runId, outcome, kind = 'hop', line = 'work@dock') {
      if (outcome !== null) f.outcomes.set(runId, outcome);
      const row = { sourceRunId: runId, kind, line, turnId: 'turn_' + runId.replace(/-/g, '_') };
      const directive = f.add(Object.assign({}, row, { directive: true, content: runId + ' handoff' }));
      f.add(Object.assign({}, row, { role: 'assistant', content: '', toolCalls: [{ id: runId + '-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }));
      f.add(Object.assign({}, row, { role: 'tool', content: runId + ' tool', toolCallId: runId + '-call' }));
      const final = f.add(Object.assign({}, row, { role: 'assistant', content: runId + ' answer' }));
      return { directive, final };
    }
    hop('failed', 'failed'); hop('refused', 'refused'); hop('legacy-refused', 'refused', null);
    for (const outcome of ['cut_short', 'stopped', 'out_of_budget', 'step_limit', 'empty']) hop(outcome, outcome);
    hop('unrecorded', null); hop('other-dock', 'succeeded', 'hop', 'work@other');
    const ctx = { chat: f.chat(), agentId: 'agent', streamId: sid, shape: 'pairs' };
    const entry = await f.port.replay(ctx);
    A.eq(entry.map(row => row.content), ['original words', 'ordinary answer'], 'entry replay excludes hidden station work and every line hop');
    A.eq(entry[View.ROW_IDS].map(row => row.rowId), [user.rowId, answer.rowId], 'entry replay keeps the original durable identities');
    A.eq(await f.port.count(ctx), entry.length, 'status count uses exactly entry replay semantics');
    A.eq(f.legacyReads, 0, 'an established canonical stream never reads a legacy agent file');
    const line = await f.port.replay(Object.assign({}, ctx, { line: 'work@dock' }));
    for (const runId of ['failed', 'refused', 'legacy-refused']) {
      A.ok(line.some(row => row.content === runId + ' handoff'), runId + ' keeps its directive');
      A.ok(!line.some(row => row.content === runId + ' answer' || row.content === runId + ' tool' || row.tool_calls?.some(call => call.id === runId + '-call')), runId + ' omits both answer and tool pair');
    }
    for (const outcome of ['cut_short', 'stopped', 'out_of_budget', 'step_limit', 'empty']) {
      A.ok(line.some(row => row.content === outcome + ' answer') && line.some(row => row.role === 'tool' && row.tool_call_id === outcome + '-call'), outcome + ' retains the admitted answer and pair');
    }
    A.ok(!line.some(row => /other-dock/.test(row.content)), 'a line never replays another dock history');
    A.ok(line.some(row => row.content === 'unrecorded answer'), 'missing outcome admits rows under the specified compatibility policy');
    A.ok(f.notes.some(([tag, message]) => tag === 'channels.hop.outcome-unknown' && JSON.parse(message).runIds.includes('unrecorded')), 'missing outcome is counted by run identity');
    A.ok(!JSON.stringify(f.notes).includes('unrecorded answer'), 'outcome diagnostics contain no transcript text');
    A.eq(await f.port.replay(Object.assign({}, ctx, { excludeTurnId: 'ordinary_turn_01' })), [], 'retry assembly excludes the exact prior turn without content matching');
    A.ok(!!await rejected(() => f.port.replay(Object.assign({}, ctx, { shape: 'prose' }))), 'prose shape cannot flatten channel tool pairs');
    A.ok(!!await rejected(() => f.port.replay(Object.assign({}, ctx, { streamId: 'other_chat' }))), 'a caller cannot exchange the host-owned stream identity');
    f.setView(() => { throw Error('canonical read fault'); });
    A.ok(!!await rejected(() => f.port.replay(ctx)), 'canonical read failure propagates instead of falling back');
    A.eq(f.legacyReads, 0, 'read failure cannot borrow an agent legacy file');
  }
  {
    const f = fixture(); f.files.set('tg_room', [{ role: 'user', content: 'old imported words', ts: 1 }]);
    const ctx = { chat: f.chat(), agentId: 'agent', shape: 'pairs' };
    const observed = await f.port.observe(Object.assign({}, ctx, { text: 'overheard line', taint: 'forwarded message' }));
    let rows = f.store.view('proof', 'channel_telegram_room', { complete: true });
    A.eq(rows.map(row => row.content), ['old imported words', 'overheard line'], 'first observation waits until complete import');
    A.ok(observed.rowId > rows[0].rowId && rows[1].kind === 'observed' && !rows[1].sourceRunId && rows[1].taint === 'forwarded message', 'observation is a durable runless row with its explicit provenance');
    const delivery = await f.port.deliver(Object.assign({}, ctx, { runId: 'routine-run', text: 'routine result', taint: null }));
    A.eq(await f.port.deliver(Object.assign({}, ctx, { runId: 'routine-run', text: 'same run retry', taint: null })), delivery, 'delivery delegates to the single idempotent writer');
    rows = f.store.view('proof', 'channel_telegram_room', { complete: true });
    A.eq(rows.filter(row => row.kind === 'delivery').map(row => [row.role, row.content]), [['assistant', 'routine result']], 'routine delivery creates one public answer and no fake user prompt');
    A.eq(f.writes, [], 'bound observe and delivery never write legacy history');
    A.ok((await f.port.replay(ctx)).some(row => row.content === 'routine result'), 'the next channel replay remembers its routine delivery');
    A.ok(!!await rejected(() => f.port.legacyMirror('agent', 'user', 'wrong write', ctx)), 'a bound chat cannot opt into legacy writes');
  }
  {
    const f = fixture(); f.add({ content: 'OLD UNIQUE WORDS' });
    const ctx = { chat: f.chat({ streamIdFor: () => undefined }), agentId: 'agent', shape: 'pairs' };
    const rotated = await f.port.rotate(ctx);
    A.ok(rotated.newStreamId !== 'channel_telegram_room', 'a present resolver with no explicit id still rotates the chat-owned stream');
    A.eq(await f.port.replay({ chat: f.chat({ streamIdFor: () => undefined }), agentId: 'agent', shape: 'pairs' }), [], 'next replay has no pre-new content');
    A.ok(!!await rejected(() => f.port.replay(ctx)), 'a stale pre-new context cannot publish the old stream after rotation');
    A.ok(f.store.view('recall', 'channel_telegram_room', { complete: true }).some(row => row.content === 'OLD UNIQUE WORDS'), 'rotation leaves the old canonical stream recallable');
    const explicit = f.chat({ streamIdFor: () => 'job_stream' });
    A.eq((await f.port.rotate({ chat: explicit, agentId: 'agent' })).newStreamId, 'job_stream', 'an explicit per-job stream is retained');
  }
  {
    const f = fixture(); f.files.set('agent', [{ role: 'user', content: 'unbound fixture history', ts: 1 }]);
    f.records.set('room', { streamId: 'other_record_stream' });
    const ctx = { chat: f.chat({ bindChats: false }), agentId: 'agent', shape: 'pairs' };
    A.eq((await f.port.replay(ctx))[0].content, 'unbound fixture history', 'explicitly unbound history uses its actual legacy store without adopting the record stream');
    f.port.legacyMirror('agent', 'assistant', 'unbound result', ctx);
    A.eq(f.writes, [['agent', 'assistant', 'unbound result']], 'only the unbound owner may retain its downgrade mirror');
    f.add({ streamId: 'one_job', content: 'canonical job history' });
    const job = { chat: f.chat({ bindChats: false, streamIdFor: () => 'one_job' }), agentId: 'agent', shape: 'pairs' };
    A.eq((await f.port.replay(job))[0].content, 'canonical job history', 'an unbound per-job explicit stream still uses canonical replay');
  }
  A.report('channels.history-port');
})().catch(error => { console.error(error); process.exitCode = 1; });
