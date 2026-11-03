'use strict';
/* Fast-tier run glue. Turn decisions and writes are production calls in run-order.js order; no alternate algorithms. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeSegmentedTranscriptIo } = require('../../sidecar/transcript-history.js');
const { makeTranscriptStore, projectConversation } = require('../../sidecar/transcriptstore.js');
const { makeRunTranscript } = require('../../sidecar/transcript-run.js');
const Directive = require('../../sidecar/turn-directive.js');
const Kinds = require('../../frontend/app/turnkinds.js');
const UserText = require('../../frontend/app/usertext.js');
const { redact } = require('../../sidecar/context.js');
const Dual = require('../../sidecar/turn-dual.js');
const { makeRemoteHost } = require('../../sidecar/remote/host.js');
const { upTo } = require('./run-order.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
class TurnFixture {
  constructor(root, clock) {
    this.root = root; this.now = clock; this.serial = 0; this.records = new Map(); this.live = new Set(); this.calls = []; this.titles = [];
    this.dual = Dual.make({ now: clock, hash });
    fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
    this.attachments = require('../../sidecar/attachments.js')({ fsp: fs.promises, path, crypto, workspaces: root,
      resolveInside: (agentId, rel) => { const base = path.join(root, agentId), abs = path.resolve(base, rel); if (!abs.startsWith(base + path.sep)) throw Error('outside fixture agent'); return { base, abs }; } });
    this.restart();
    this.desk = [];
    this.pendingRuns = [];
    this.phone = makeRemoteHost({ now: clock, newId: () => this.newId(), roster: () => [{ agentId: 'agent' }],
      broadcast() {}, deskSessions: () => this.desk, liveRuns: () => [...this.live].map(runId => ({ runId })),
      credentials: () => ({ ok: true, model: 'test/model', provider: 'test', system: '' }), classify: () => false,
      transcript: { history: (s, o) => this.display(s, o), streams: o => this.store.streams(o) },
      turnDual: this.dual, turnProjection: (s, rows) => this.project(s, rows), redact,
      runOnce: request => { const p = this.run(request).then(result => { for (const event of result.events) request.emit(event.name, event.payload); return { text: result.reply, outcome: 'succeeded' }; }); this.pendingRuns.push(p); return p; },
      runRow: runId => this.records.get(runId) });
  }
  newId() { return 'run-' + String(++this.serial).padStart(8, '0'); }
  restart(options) {
    if (this.io) this.io.close();
    this.io = makeSegmentedTranscriptIo(Object.assign({ fs, path, root: path.join(this.root, 'history'), segmentBytes: 64 * 1024, onWarning: message => { this.warnings = (this.warnings || []).concat(message); }, schedule() {} }, options || {}));
    this.store = makeTranscriptStore({ io: this.io, clock: { now: this.now }, redact });
  }
  display(streamId, options) {
    const limit = options && options.limit || 200;
    return projectConversation(this.store.history(streamId, { limit: limit + 500 }).filter(r => !this.live.has(r.sourceRunId)), id => this.records.get(id), hash).slice(-limit);
  }
  project(streamId, rows) { return this.dual.project(streamId, rows, { liveRunIds: this.live, isCollided: id => this.io.isCollided(id) }); }
  read(streamId, limit) { return this.project(streamId, this.display(streamId, { limit: limit || 200 })); }
  async upload(name, mime, bytes) { const out = await this.attachments.saveAttachment('agent', name, 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64')); if (!out.ok) throw Error('fixture attachment upload failed'); return out; }
  async run(request, options) {
    const o = Object.assign({}, request), opts = options || {}, runId = o.runId || this.newId(), agentId = o.agentId || 'agent';
    const order = [], call = (anchor, fn) => { order.push(anchor); return fn(); };
    let turnId = call('TurnDirective.turnOf(', () => Directive.turnOf(o, runId));
    const rekey = id => { turnId = id; };
    const found = call('TurnDirective.reuseByTurn(', () => Directive.reuseByTurn(this.store, Object.assign({}, o, Kinds.clientTurnTime(o, this.now()), { turnId, runId, agentId, rekey })));
    let messages = JSON.parse(JSON.stringify(o.messages || []));
    const directive = call('TurnDirective.capture(', () => Directive.capture(messages, { turnId, recovery: o.recovery }));
    messages = await call('attachments.expandForRun(', () => this.attachments.expandForRun(messages, agentId, o.projectRoot));
    const kinds = call('const kinds = TurnKinds.ofRun(', () => Kinds.ofRun(o, { internal: !!o.internal, trigger: o.trigger || 'manual-page' }));
    const writer = call('const runTranscript = makeRunTranscript(', () => makeRunTranscript({ store: this.store, streamId: o.streamId, agentId, runId,
      turnId: () => turnId, stamp: true, rowKind: kinds.rowKind, directiveKind: kinds.directiveKind, line: kinds.line,
      onFailure: (_stage, error) => { throw error; } }));
    const reused = call('let retryDirective = TurnDirective.reuse(', () => Directive.reuse(this.store, Object.assign({}, o, { found, streamId: o.streamId, turnId, runId, agentId, rekey, messages, directive, redact, latestUserText: list => UserText.latest(list, UserText.DIRECTIVE) })));
    const words = UserText.latest(messages, UserText.DIRECTIVE);
    call('runTranscript.setDirective(TurnDirective.row(', () => { if (reused || o.recovery) writer.markDirectiveWritten(); else writer.setDirective(Directive.row(directive, words, kinds.directiveKind)); });
    const directiveTitle = call('directiveTitle: TurnDirective.title(', () => Directive.title(directive, words));
    const title = call('TurnDirective.runTitle(', () => Directive.runTitle(directiveTitle));
    const expected = upTo(5).map(r => r.anchor);
    if (JSON.stringify(order) !== JSON.stringify(expected)) throw Error('fast driver deviated from production run-order');
    if (o.recovery) writer.adoptRecovery(messages, { base: o.recovery.base || 0,
      rows: this.store.history(o.streamId, { sourceRunId: o.recovery.sourceRunId, limit: 2000 }) });
    else this.store.markPersisted(messages);
    this.live.add(runId); writer.start(messages);
    const start = Object.assign({ runId, agentId, streamId: o.streamId, turnId }, Directive.echo({ turnId }, writer, reused));
    const events = [{ name: 'agent.run.start', payload: start }];
    // This is the injected provider response only; all transcript admission, directive and kind choices are above.
    const reply = opts.reply == null ? 'Done.' : opts.reply;
    this.calls.push({ runId, messages: JSON.parse(JSON.stringify(messages)) });
    if (reply) events.push({ name: 'agent.token', payload: { runId, delta: reply } });
    if (!opts.interrupt && !opts.fail) { messages.push(...(opts.extraMessages || []), { role: 'assistant', content: reply }); writer.drain(messages); }
    else if (opts.persistPartial) { messages.push({ role: 'assistant', content: reply }); writer.drain(messages); }
    this.live.delete(runId);
    const reason = opts.interrupt ? 'interrupted' : opts.fail ? 'error' : 'done';
    this.records.set(runId, { runId, streamId: o.streamId, agentId, reason, title, turnId, ts: this.now() });
    this.titles.push({ runId, title, directive: Directive.wording(directive), packet: Directive.packet(directive, { row: writer.directiveRow() || reused, redact }) });
    events.push({ name: 'agent.run.end', payload: { runId, reason, outcome: reason === 'done' ? 'succeeded' : 'failed' } });
    return { events, start, reply, turnId, runId, directive, reused, messages };
  }
  async dispatch(request, options) { const result = await this.run(request, options); return result.events.map(e => JSON.stringify(e)).join('\n'); }
  async phoneSend(streamId, text) {
    const before = this.pendingRuns.length;
    const out = await this.phone.send({ agentId: 'agent', streamId, text });
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(this.pendingRuns.slice(before));
    await new Promise(resolve => setImmediate(resolve));
    return out;
  }
  close() { this.io.close(); }
}
module.exports = { TurnFixture };
