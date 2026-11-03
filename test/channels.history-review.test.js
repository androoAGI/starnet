'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const Store = require('../sidecar/transcriptstore.js');
const Memory = require('../sidecar/transcript-history.js').makeMemoryTranscriptIo;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function load(file, saved) {
  if (!saved) return require(file);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(saved, 'utf8'), file); return loaded.exports;
}
const Port = load(require.resolve('../sidecar/channels/history-port.js'), process.env.CHANNEL_HISTORY_PORT_SOURCE);
const ChannelStore = load(require.resolve('../sidecar/channels/store.js'), process.env.CHANNEL_HISTORY_STORE_SOURCE);
async function rejected(fn) { try { await fn(); return null; } catch (error) { return error; } }
const legacy = [{ role: 'user', content: 'RAW LEGACY WORDS', ts: 0 }, { role: 'assistant', content: 'legacy answer', ts: 2 }];
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-history-review-'));
  const channel = ChannelStore.makeChannelStore({ fs: options.fs || fs, pathMod: path, root, clock: { now: () => 100 },
    timers: { setTimeout() {}, clearTimeout() {} }, ...(options.writeDurable ? { writeDurable: options.writeDurable } : {}) });
  const io = Memory(), store = Store.makeTranscriptStore({ io, clock: { now: () => 100 }, hash, ramPerStream: 3000 });
  let append = row => store.appendStrict(row), redact = text => text;
  const batches = [];
  const port = Port.make({ view: (...args) => store.view(...args), append: row => append(row), legacyStore: channel, hash, now: () => 100,
    redact: text => redact(text), cacheRetractions: (stream, ids) => { batches.push(ids.length); return store.cacheRetractions(stream, ids); } });
  const context = () => ({ chat: port.context({ channel: 'telegram', chatId: 'room', legacyKey: 'tg_room' }), agentId: 'agent', shape: 'pairs' });
  const seed = () => fs.writeFileSync(path.join(root, 'tg_room.history.json'), JSON.stringify({ version: 1, messages: legacy }));
  const marker = () => channel.saveChatRecord('room', { legacyImport: { v: 1, state: 'importing', at: 100,
    sources: [{ tag: 'tg_room', count: legacy.length, sha256: hash(JSON.stringify(legacy.map(row => [row.role, row.ts, row.content]))) }] } });
  const expected = index => Object.assign({ streamId: 'channel_telegram_room', agentId: 'agent', kind: 'observed',
    importKey: 'lg:tg_room:' + index + ':' + hash(legacy[index].role + '\0' + legacy[index].ts + '\0' + legacy[index].content).slice(0, 12) }, legacy[index]);
  return { root, channel, io, store, port, context, seed, marker, expected, batches,
    rows: () => store.view('proof', 'channel_telegram_room', { complete: true }),
    setAppend(fn) { append = fn; }, setRedact(fn) { redact = fn; }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
(async () => {
  for (const [name, change] of [
    ['content', { content: 'different accepted text' }], ['role', { role: 'assistant' }], ['timestamp', { ts: 3 }],
    ['agent', { agentId: 'other_agent' }], ['kind', { kind: 'turn' }], ['manufactured clean provenance', { taint: null }]
  ]) {
    const f = fixture();
    try {
      f.seed(); f.marker(); f.store.appendStrict(Object.assign(f.expected(0), change)); const before = f.rows();
      A.ok(!!await rejected(() => f.port.ensureImported(f.context())), 'resume refuses a matching importKey with wrong ' + name);
      A.eq(f.rows(), before, name + ': refusal appends no missing suffix');
      A.eq(f.channel.getChatRecord('room').legacyImport.state, 'importing', name + ': refusal does not advance marker');
    } finally { f.close(); }
  }
  for (const [name, change] of [['stream', { streamId: 'other_stream' }], ['content', { content: 'wrong ack' }], ['role', { role: 'assistant' }],
    ['timestamp', { ts: 9 }], ['agent', { agentId: 'other_agent' }], ['kind', { kind: 'turn' }], ['clean stamp', { taintKnown: true }]]) {
    const f = fixture();
    try {
      f.seed(); f.setAppend(row => Object.assign({}, f.store.appendStrict(row), change));
      A.ok(!!await rejected(() => f.port.ensureImported(f.context())), 'append acknowledgement refuses mismatched ' + name);
      A.eq(f.channel.getChatRecord('room').legacyImport.state, 'importing', name + ': invalid acknowledgement leaves import incomplete');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(); f.setAppend(row => Object.assign({ rowId: 77 }, row));
      A.ok(!!await rejected(() => f.port.ensureImported(f.context())), 'an exact-looking acknowledgement without stored bytes is not a complete import');
      A.eq(f.rows(), [], 'unwritten acknowledgement does not invent canonical rows');
      A.eq(f.channel.getChatRecord('room').legacyImport.state, 'importing', 'unwritten acknowledgement never advances to done');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(); f.setRedact(() => 'R'.repeat(200001));
      A.ok(!!await rejected(() => f.port.ensureImported(f.context())), 'redactor expansion beyond the Store cap refuses import');
      A.eq(f.rows(), [], 'oversized redacted import appends nothing');
      A.eq(f.channel.getChatRecord('room')?.legacyImport, undefined, 'oversized redacted import writes no initial marker');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.store.appendStrict({ streamId: 'channel_telegram_room', agentId: 'agent', role: 'user', content: 'existing canonical' });
      f.setRedact(() => 'R'.repeat(200001)); const before = f.rows();
      A.ok(!!await rejected(() => f.port.observe(Object.assign(f.context(), { text: 'short raw input' }))), 'redactor expansion refuses observation before append');
      A.eq(f.rows(), before, 'observation expansion cannot store truncated content');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(); f.marker(); const row = f.store.appendStrict(f.expected(0));
      f.io.appendDurable(Object.assign({}, row, { streamId: 'another_chat' })); const before = f.rows();
      A.ok(!!await rejected(() => f.port.ensureImported(f.context())), 'an actual global rowId collision cannot prove an import prefix');
      A.eq(f.rows(), before, 'collision refusal appends no suffix');
      A.eq(f.channel.getChatRecord('room').legacyImport.state, 'importing', 'collision refusal preserves incomplete marker');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      for (let i = 0; i < 2001; i++) f.store.appendStrict({ streamId: 'channel_telegram_room', agentId: 'agent', role: 'user', content: 'canonical ' + i });
      A.eq((await f.port.ensureImported(f.context())).n, 0, 'existing long canonical stream remains canonical');
      A.eq(f.batches, [2000, 1], 'global identity proof batches never exceed the existing 2000-id owner contract');
    } finally { f.close(); }
  }
  // These are actual primary-file writes/reads. A warm getChatRecord cache is not marker proof.
  {
    const f = fixture();
    try {
      const file = path.join(f.root, 'chatmap.json');
      A.eq(f.channel.getChatRecord('room', { readOnly: true }), undefined, 'both absent marker files mean a new chat');
      f.channel.saveChatRecord('room', { arbitrary: { retained: true } });
      A.eq(f.channel.getChatRecord('room', { readOnly: true }).arbitrary, { retained: true }, 'fresh marker reads preserve unknown record fields');
      const good = fs.readFileSync(file, 'utf8');
      for (const bytes of ['{ malformed', JSON.stringify({ version: 1, chats: [] }), JSON.stringify({ version: 1, chats: { room: null } })]) {
        fs.writeFileSync(file, bytes); const before = fs.readdirSync(f.root).sort();
        A.ok(!!await rejected(() => f.port.context({ channel: 'telegram', chatId: 'room', legacyKey: 'tg_room' })), 'malformed primary marker refuses before context authority');
        A.eq(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, bytes, 'strict marker read preserves malformed primary bytes');
        A.eq(fs.readdirSync(f.root).sort(), before, 'strict marker read does not quarantine or recover');
      }
      fs.writeFileSync(file, good); fs.writeFileSync(file + '.bak', good); fs.unlinkSync(file);
      A.ok(!!await rejected(() => f.port.context({ channel: 'telegram', chatId: 'room', legacyKey: 'tg_room' })), 'a backup behind a missing primary cannot supply fresh marker authority');
      A.eq(fs.existsSync(file), false, 'ambiguous backup is not silently restored');
    } finally { f.close(); }
  }
  {
    const blockedFs = Object.create(fs); let block = false;
    blockedFs.readFileSync = (file, ...args) => {
      if (block && path.basename(String(file)) === 'chatmap.json') throw Object.assign(Error('marker temporarily locked'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    };
    const f = fixture({ fs: blockedFs });
    try {
      f.seed(); const ctx = f.context(), realSave = f.channel.saveChatRecord.bind(f.channel);
      f.channel.saveChatRecord = (...args) => { const result = realSave(...args); block = true; return result; };
      A.ok(!!await rejected(() => f.port.ensureImported(ctx)), 'a landed marker write still refuses when fresh readback fails');
      A.eq(f.rows(), [], 'fresh marker readback failure precedes the first canonical append');
      const bytes = fs.readFileSync(path.join(f.root, 'chatmap.json'), 'utf8');
      A.eq(JSON.parse(bytes).chats.room.legacyImport.state, 'importing', 'the actual landed marker remains recoverable on disk');
      block = false; f.channel.saveChatRecord = realSave;
      A.eq((await f.port.ensureImported(f.context())).n, 2, 'restored access resumes the durable marker');
    } finally { f.close(); }
  }
  A.report('channels.history-review');
})().catch(error => { console.error(error); process.exitCode = 1; });
