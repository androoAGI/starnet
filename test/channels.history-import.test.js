'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Port = require('../sidecar/channels/history-port.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function rejected(fn) { try { await fn(); return null; } catch (error) { return error; } }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-import-'));
  const channel = makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  const io = makeMemoryTranscriptIo();
  let store = makeTranscriptStore({ io, clock: { now: () => 100 }, hash });
  let append = row => store.appendStrict(row), deleted = 0, serial = 0;
  const notes = [];
  const make = () => Port.make({ view: (...args) => store.view(...args), append: row => append(row), legacyStore: channel,
    cacheRetractions: (...args) => store.cacheRetractions(...args),
    hash, now: () => 100, newId: () => 'fresh' + (++serial), deletedAt: () => deleted, failNote: (tag, error) => notes.push([tag, error.message]) });
  let port = make();
  const context = (extra, owner = port) => owner.context(Object.assign({ channel: 'telegram', chatId: 'chat', legacyKey: 'tg_chat' }, extra));
  const seed = (rows, key = 'tg_chat') => fs.writeFileSync(path.join(root, key + '.history.json'), JSON.stringify({ version: 1, messages: rows }));
  const rows = () => store.view('proof', 'channel_telegram_chat', { complete: true });
  return { root, channel, io, notes, seed, rows, context, get store() { return store; }, get port() { return port; },
    setAppend(fn) { append = fn || (row => store.appendStrict(row)); }, forget() { deleted = 101; },
    restart() { store = makeTranscriptStore({ io, clock: { now: () => 100 }, hash }); port = make(); return port; },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const legacy = [{ role: 'user', content: 'BEFORE NEW UNIQUE', ts: 0 }, { role: 'assistant', content: 'legacy answer', ts: 2 }];
(async () => {
  {
    const f = fixture();
    try {
      f.seed(legacy); const bytes = fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8');
      const ctx = { chat: f.context(), agentId: 'agent' };
      A.eq(await f.port.ensureImported(ctx), { state: 'done', n: 2 }, 'first canonical read strictly imports every legacy row');
      const rows = f.rows();
      A.eq(rows.map(row => [row.role, row.content, row.ts, row.kind]), legacy.map(row => [row.role, row.content, row.ts, 'observed']), 'import preserves file order, text and timestamp including zero');
      A.ok(rows.every(row => /^lg:tg_chat:[01]:[a-f0-9]{12}$/.test(row.importKey)), 'each imported row has its deterministic source identity');
      A.eq(fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8'), bytes, 'import leaves legacy source bytes untouched');
      f.restart();
      A.eq(await f.port.ensureImported({ chat: f.context(), agentId: 'agent' }), { state: 'done', n: 2 }, 'durable done marker survives owner restart');
      A.eq(f.rows(), rows, 'restart does not append duplicate imports');
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: JSON.parse(JSON.stringify(ctx.chat)), agentId: 'agent' })), 'serialized context cannot grant a new history owner');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy); let attempts = 0;
      f.setAppend(row => { if (++attempts === 2) throw Error('append interrupted'); return f.store.appendStrict(row); });
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' })), 'partial import failure propagates to the caller');
      const importing = f.channel.getChatRecord('chat').legacyImport;
      A.eq(importing.state, 'importing', 'partial append never advances the durable marker to done');
      A.eq([importing.sources[0].count, importing.sources[0].sha256.length], [2, 64], 'marker binds both count and normalized source digest');
      const prefix = f.rows(); A.eq(prefix.length, 1, 'one row actually reached durable storage before the fault');
      f.restart(); f.setAppend();
      A.eq(await f.port.ensureImported({ chat: f.context(), agentId: 'agent' }), { state: 'done', n: 2 }, 'restart resumes an importing marker');
      A.eq(f.rows()[0], prefix[0], 'resume retains the original accepted identity and bytes');
      A.eq(f.rows().length, 2, 'resume appends only the missing source identity');
      A.ok(f.notes.some(note => note[0] === 'channels.import.incomplete'), 'incomplete import has a named diagnostic');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy); let attempts = 0;
      f.setAppend(row => { if (++attempts === 2) throw Error('append interrupted'); return f.store.appendStrict(row); });
      await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' }));
      const prefix = f.rows();
      const changed = legacy.map(row => Object.assign({}, row)); changed[1].content = 'same count, different source'; f.seed(changed);
      const bytes = fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8');
      f.restart(); f.setAppend();
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' })), 'same-count source mutation cannot falsely finish an old import');
      A.eq(f.rows(), prefix, 'digest mismatch has no canonical mutation');
      A.eq(f.channel.getChatRecord('chat').legacyImport.state, 'importing', 'digest mismatch preserves the incomplete marker');
      A.eq(fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8'), bytes, 'digest mismatch preserves the changed evidence');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy);
      const missingAck = Object.assign(Object.create(f.channel), { saveChatRecord() { return { legacyImport: { state: 'importing' } }; } });
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: f.context({ store: missingAck }), agentId: 'agent' })), 'marker write without durable readback cannot authorize import');
      A.eq(f.rows(), [], 'failed marker acknowledgement precedes every append');
      const realSave = f.channel.saveChatRecord.bind(f.channel);
      f.channel.saveChatRecord = (id, patch) => { if (patch.legacyImport.state === 'done') throw Error('done marker fault'); return realSave(id, patch); };
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' })), 'completion marker failure is visible after accepted rows');
      A.eq(f.rows().length, 2, 'all rows were accepted before the final marker fault');
      f.channel.saveChatRecord = realSave; f.restart();
      A.eq(await f.port.ensureImported({ chat: f.context(), agentId: 'agent' }), { state: 'done', n: 2 }, 'publication retries the marker without rewriting accepted rows');
      A.eq(f.rows().length, 2, 'final marker recovery appends no duplicate rows');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy); let attempts = 0;
      f.setAppend(row => { if (++attempts === 2) throw Error('append interrupted'); return f.store.appendStrict(row); });
      await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' }));
      const before = f.rows(); f.setAppend();
      const next = await f.port.rotate({ chat: f.context(), agentId: 'agent' });
      A.ok(next.newStreamId !== 'channel_telegram_chat', '/new rotates an ordinary chat while import is incomplete');
      A.eq(f.channel.getChatRecord('chat').legacyImport.state, 'abandoned', '/new durably abandons the old import');
      f.restart();
      A.eq(await f.port.ensureImported({ chat: f.context(), agentId: 'agent' }), { state: 'abandoned', n: 0 }, 'restart does not resume the abandoned import');
      A.eq(f.store.view('model-replay', next.newStreamId, { shape: 'pairs' }), [], 'new stream cannot re-import old unique words');
      A.eq(f.rows(), before, '/new preserves old canonical evidence without tombstoning it');
      A.ok(fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8').includes('BEFORE NEW UNIQUE'), 'trunk bound-agent clear does not rewrite the per-chat legacy source');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy); f.setAppend(() => { throw Error('before first append'); });
      A.ok(!!await rejected(() => f.port.replay({ chat: f.context(), agentId: 'agent', shape: 'pairs' })), 'a crash after the marker never serves partial replay');
      A.eq(f.channel.getChatRecord('chat').legacyImport.state, 'importing', 'the first strict append fault leaves an importing marker');
      A.eq(f.rows(), [], 'the first strict append fault accepted no row');
      f.restart(); f.setAppend();
      const reply = await f.port.replay({ chat: f.context(), agentId: 'agent', shape: 'pairs' });
      A.eq(reply.map(row => row.content), legacy.map(row => row.content), 'restart after marker-before-row-one imports every original word');
      const observed = await f.port.observe({ chat: f.context(), agentId: 'agent', text: 'next inbound observation', taint: null });
      A.ok(observed.rowId > f.rows()[1].rowId, 'the next live observation lands after every resumed import row');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed([{ role: 'assistant', content: 'X'.repeat(200001), ts: 1 }]);
      const bytes = fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8');
      A.ok(!!await rejected(() => f.port.ensureImported({ chat: f.context(), agentId: 'agent' })), 'an oversized legacy row cannot be silently truncated and marked done');
      A.eq(f.rows(), [], 'unpreservable legacy source appends no row');
      A.eq(f.channel.getChatRecord('chat')?.legacyImport, undefined, 'unpreservable source is rejected before an import marker');
      A.eq(fs.readFileSync(path.join(f.root, 'tg_chat.history.json'), 'utf8'), bytes, 'oversized source remains intact for recovery');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seed(legacy);
      const bot = name => Object.assign(Object.create(f.channel), {
        getChatRecord: (id, options) => f.channel.getChatRecord(name + '|' + id, options),
        saveChatRecord: (id, patch) => f.channel.saveChatRecord(name + '|' + id, patch)
      });
      for (const name of ['botA', 'botB']) {
        const ctx = { chat: f.context({ channel: 'telegram:' + name, store: bot(name) }), agentId: 'agent' };
        A.ok(!!await rejected(() => f.port.ensureImported(ctx)), 'nonempty global tg_ file cannot be assigned to ' + name + ' namespace');
      }
      A.eq(f.io.streamRows('channel_telegram_botA_chat'), 0, 'ambiguous source imports into neither bot stream');
      f.seed([]);
      A.eq((await f.port.ensureImported({ chat: f.context({ channel: 'telegram:empty', store: bot('empty') }), agentId: 'agent' })).state, 'done', 'empty legacy source does not hold a new bot chat');
      f.seed(legacy);
      f.store.appendStrict({ streamId: 'channel_telegram_canonical_chat', agentId: 'agent', role: 'assistant', content: 'canonical already owns this chat' });
      A.eq((await f.port.ensureImported({ chat: f.context({ channel: 'telegram:canonical', store: bot('canonical') }), agentId: 'agent' })).n, 0, 'already-canonical bot stream never borrows ambiguous legacy text');
    } finally { f.close(); }
  }
  A.report('channels.history-import');
})().catch(error => { console.error(error); process.exitCode = 1; });
