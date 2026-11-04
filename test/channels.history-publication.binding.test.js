'use strict';
/* The exact source02 ambiguity used a two-field destination before this private
   schema was activated. That shape must now remain unknown, never be inferred. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const Kinds = require('../frontend/app/turnkinds.js');
function owner(rel, env, dependency) {
  const file = require.resolve(rel), saved = process.env[env];
  if (!saved && !dependency) return require(file);
  const source = fs.readFileSync(saved || file, 'utf8');
  if (saved) console.log('CONTROL_SOURCE ' + env + ' ' + saved + ' SHA256=' + crypto.createHash('sha256').update(source).digest('hex'));
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  if (dependency) { const original = loaded.require.bind(loaded); loaded.require = name => name === './history-publication.js' ? dependency : original(name); }
  loaded._compile(source, file); return loaded.exports;
}
const Publication = owner('../sidecar/channels/history-publication.js', 'CHANNEL_PUBLICATION_SCHEMA_SOURCE');
const Ledger = owner('../sidecar/channels/delivery-ledger.js', 'CHANNEL_PUBLICATION_LEDGER_SOURCE', Publication);
const runId = 'run-12345', target = 'a:' + runId + ':b', id = 'routine:job:' + runId + ':' + target;
const row = { id, chat: 'telegram|room', channel: 'telegram', chatId: 'room', kind: 'routine', reason: 'routine', runId, agentId: 'agent',
  receiptIds: [], route: null, seed: '', parts: [{ kind: 'text', n: 0, text: 'accepted answer', sent: true, messageId: 'm1' }], delayed: false,
  state: 'done', release: 'caller', tries: 0, nextAt: 0, lastError: '', ts: 1, edit: null, doneAt: 2,
  historyDestination: { v: 1, streamId: 'original_stream' },
  sessionTurns: { v: 2, at: 100, streamId: 'original_stream', rowId: 7, turnId: Kinds.runTurnId(runId) } };
function fixture(record) {
  let bytes = JSON.stringify({ version: 1, receipts: [], deliveries: [record], tombstones: [], chats: {}, openAsks: [], migrated: { inbox: [], outbox: [] } });
  const original = bytes, read = () => JSON.parse(bytes);
  const ledger = Ledger.makeDeliveryLedger({ io: { read, readConfirmed: read, write: doc => { bytes = JSON.stringify(doc); } },
    clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  return { ledger, original, bytes: () => bytes, read };
}
{
  const f = fixture(row);
  try {
    A.eq(f.ledger.load(), false, 'a pre-activation binding without captured job/target remains unknown');
    const forged = { v: 1, target: 'b', deliveryId: id, channel: 'telegram', chatId: 'room', streamId: 'original_stream', agentId: 'agent',
      runId, rowId: 7, turnId: Kinds.runTurnId(runId) };
    let released = false;
    try { released = f.ledger.release(id, forged); } catch (error) { released = false; }
    A.eq(released, false, 'matching suffix cannot replace actual target a:run-12345:b with b');
    A.eq(f.ledger.flush({ probe: true }), false, 'unknown binding cannot be normalized into writeable authority');
    A.eq(f.bytes(), f.original, 'refusal preserves the exact original acknowledged record');
  } finally { f.ledger.close(); }
}
{
  const legacy = Object.assign({}, row, { sessionTurns: { at: 100 } }); delete legacy.historyDestination;
  const f = fixture(legacy);
  try {
    A.eq(f.ledger.load(), true, 'ordinary legacy record without new metadata stays readable');
    A.eq(f.ledger.release(id), true, 'legacy release behavior remains available');
    A.eq(f.read().deliveries, [], 'legacy release persists normally');
  } finally { f.ledger.close(); }
}
A.report('channels.history-publication.binding');
