'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const crypto = require('node:crypto');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const storeFile = require.resolve('../sidecar/channels/store.js');
let channelStore = require(storeFile);
if (process.env.CHANNEL_IMPORT_STORE_SOURCE) {
  const loaded = new Module(storeFile, module); loaded.filename = storeFile; loaded.paths = Module._nodeModulePaths(path.dirname(storeFile));
  loaded._compile(fs.readFileSync(process.env.CHANNEL_IMPORT_STORE_SOURCE, 'utf8'), storeFile); channelStore = loaded.exports;
}
function thrown(fn) { try { fn(); return null; } catch (error) { return error; } }
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-history-readonly-'));
  try {
    const store = channelStore.makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 10 }, timers: { setTimeout() {}, clearTimeout() {} } });
    const file = path.join(root, 'tg_chat.history.json');
    const good = JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'saved history', ts: 5 }] });
    A.eq(store.loadHistory('tg_chat', { readOnly: true }), [], 'genuinely absent legacy history is empty');
    fs.writeFileSync(file + '.bak', good);
    A.eq(store.loadHistory('tg_chat', { readOnly: true })[0].content, 'saved history', 'missing main may read its valid backup without rewriting it');
    A.eq(fs.existsSync(file), false, 'backup read does not recreate a legacy main');
    fs.writeFileSync(file, good);
    store.loadHistory('tg_chat'); // prime the ordinary stat cache
    const cases = ['{ malformed', JSON.stringify({ version: 1, messages: 'not rows' }),
      JSON.stringify({ version: 1, messages: [{ role: 'tool', content: 'invalid role', ts: 5 }] }),
      JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'missing timestamp' }] })];
    for (const bytes of cases) {
      fs.writeFileSync(file, bytes);
      const before = fs.readdirSync(root).sort();
      A.ok(!!thrown(() => store.loadHistory('tg_chat', { readOnly: true })), 'malformed legacy source holds instead of filtering or recovering it');
      A.eq(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, bytes, 'strict read preserves malformed source bytes at their original path');
      A.eq(fs.readdirSync(root).sort(), before, 'strict read creates no quarantine or replacement file');
    }
    fs.writeFileSync(file, good);
    const blockedFs = Object.create(fs);
    blockedFs.readFileSync = (name, ...args) => { if (String(name) === file) throw Object.assign(Error('locked'), { code: 'EACCES' }); return fs.readFileSync(name, ...args); };
    const blocked = channelStore.makeChannelStore({ fs: blockedFs, pathMod: path, root, clock: { now: () => 10 }, timers: { setTimeout() {}, clearTimeout() {} } });
    A.eq(thrown(() => blocked.loadHistory('tg_chat', { readOnly: true }))?.code, 'ESTORE_UNREADABLE', 'unreadable primary never imports a stale backup as current');
    A.eq(fs.readFileSync(file, 'utf8'), good, 'unreadable proof leaves the source intact');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
{
  const Store = require('../sidecar/transcriptstore.js'), View = require('../sidecar/turn-view.js');
  const io = require('../sidecar/transcript-history.js').makeMemoryTranscriptIo();
  let reads = 0; const context = io.retractionsFor.bind(io);
  io.retractionsFor = ids => { reads++; return context(ids); };
  const store = Store.makeTranscriptStore({ io, clock: { now: () => 10 }, hash,
    runOf: runId => /^legacy-hop-/.test(runId) ? { taskKey: 'chain:legacy-line' } : null });
  const add = fields => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', kind: 'turn', sourceRunId: 'normal-run', role: 'user', content: 'question', turnId: 'normal_turn_001' }, fields));
  const typed = add({ content: 'expanded attachment', typed: 'typed original' });
  add({ role: 'assistant', content: 'ordinary answer' });
  add({ kind: 'station', role: 'assistant', content: 'HIDDEN_EXECUTION' });
  const prompt = add({ sourceRunId: 'dispatch-run', content: 'old prompt', typed: 'STALE_TYPED', dispatchState: 'pending' });
  const answer = 'accepted result';
  add({ sourceRunId: 'dispatch-run', role: 'assistant', content: answer, dispatchState: 'final', dispatchPrompt: 'accepted prompt', textLength: answer.length, textSha256: hash(answer) });
  const steer = add({ kind: 'steer', role: 'system', content: 'new direction' });
  const handoff = add({ sourceRunId: 'failed-hop', kind: 'hop', line: 'line@dock', directive: true, content: 'handoff instruction' });
  add({ sourceRunId: 'failed-hop', kind: 'hop', line: 'line@dock', role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] });
  add({ sourceRunId: 'failed-hop', kind: 'hop', line: 'line@dock', role: 'tool', toolCallId: 'call', content: 'failed-hop tool result' });
  add({ sourceRunId: 'failed-hop', kind: 'hop', line: 'line@dock', role: 'assistant', content: 'failed-hop partial answer' });
  const legacyHop = add({ sourceRunId: 'legacy-hop-refused', kind: undefined, line: 'line@dock', directive: true, content: 'legacy handoff instruction' });
  add({ sourceRunId: 'legacy-hop-refused', kind: undefined, line: 'line@dock', role: 'assistant', content: '', toolCalls: [{ id: 'legacy-call', type: 'function', function: { name: 'read', arguments: '{}' } }] });
  add({ sourceRunId: 'legacy-hop-refused', kind: undefined, line: 'line@dock', role: 'tool', toolCallId: 'legacy-call', content: 'legacy refused tool' });
  add({ sourceRunId: 'legacy-hop-refused', kind: undefined, line: 'line@dock', role: 'assistant', content: 'legacy refused answer' });
  const cutHop = add({ sourceRunId: 'legacy-hop-cut', kind: undefined, line: 'line@dock', directive: true, content: 'legacy cut handoff' });
  const cutAnswer = add({ sourceRunId: 'legacy-hop-cut', kind: undefined, line: 'line@dock', role: 'assistant', content: 'legacy cut answer admitted' });
  const rows = store.view('model-replay', 's', { complete: true, rows: true, shape: 'pairs', form: 'pre', line: 'line@dock' });
  const kinds = [];
  const shaped = View.messages(rows, (row, classification) => {
    if (row.sourceRunId === 'legacy-hop-refused') kinds.push(classification.kind);
    return classification.kind !== 'hop' || !['failed-hop', 'legacy-hop-refused'].includes(row.sourceRunId) || row.directive === true;
  });
  A.eq(reads, 1, 'filtered replay uses the same context assembly without a second history read');
  A.eq(shaped[0].content, 'typed original', 'the existing pre-shaper retains original typed words');
  A.ok(shaped.some(row => row.content === 'accepted prompt') && !shaped.some(row => row.content === 'STALE_TYPED'), 'accepted final context keeps the projected dispatch prompt authoritative');
  A.ok(shaped.some(row => row.role === 'user' && row.content === '[steering] new direction'), 'the original steer shaper survives filtering');
  A.ok(!shaped.some(row => row.role === 'tool' || /failed-hop|HIDDEN_EXECUTION/.test(row.content)), 'visibility stays applied and rejected hop tool/reply rows stay excluded');
  A.eq(kinds, ['hop', 'hop', 'hop', 'hop'], 'predicate receives legacy hop classification from the retained run owner context');
  A.ok(shaped.some(row => row.content === 'legacy handoff instruction') && !shaped.some(row => /legacy refused/.test(row.content)), 'refused legacy hop keeps only its directive');
  A.ok(shaped.some(row => row.content === 'legacy cut answer admitted'), 'an admitted legacy hop keeps its answer');
  A.eq(shaped[View.ROW_IDS].map(row => row.rowId), [typed.rowId, typed.rowId + 1, prompt.rowId, prompt.rowId + 1, steer.rowId, handoff.rowId, legacyHop.rowId, cutHop.rowId, cutAnswer.rowId], 'shaped rows retain their exact durable identity alignment');
  A.ok(!JSON.stringify(shaped).includes('rowId') && !JSON.stringify(rows).includes('projected-rows'), 'private context and ids do not leak into provider or serialized row bytes');
  A.ok(!!thrown(() => View.messages(rows.slice())), 'a raw/copy array cannot bypass the view visibility boundary');
  const marked = add({ importKey: 'lg:tg_chat:0:0123456789ab' });
  A.eq(marked.importKey, 'lg:tg_chat:0:0123456789ab', 'valid resumable import identity survives Store persistence');
  A.eq(add({ importKey: 'lg:../unsafe:0:0123456789ab' }).importKey, undefined, 'malformed import identity is not persisted');
  A.eq(add({ importKey: 'lg:tg_chat:1:0123456789ab', ts: 0 }).ts, 0, 'a proved legacy import preserves the valid epoch timestamp exactly');
  A.eq(add({ ts: 0 }).ts, 10, 'ordinary transcript timestamp defaults remain unchanged');
}
A.report('channels.history-adapters');
