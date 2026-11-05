'use strict';
/* Fast-tier run glue. Turn decisions and writes are production calls in run-order.js order; no alternate algorithms. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeSegmentedTranscriptIo } = require('../../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../../sidecar/transcriptstore.js');
const { makeRunTranscript } = require('../../sidecar/transcript-run.js');
const Directive = require('../../sidecar/turn-directive.js');
const Window = require('../../sidecar/turn-window.js');
const Kinds = require('../../frontend/app/turnkinds.js');
const UserText = require('../../frontend/app/usertext.js');
const { redact } = require('../../sidecar/context.js');
const Dual = require('../../sidecar/turn-dual.js');
const { makeRemoteHost } = require('../../sidecar/remote/host.js');
const TurnDelivery = require('../../sidecar/turn-delivery.js');
const View = require('../../sidecar/turn-view.js');
const { makeArtifactCollector } = require('../../sidecar/artifacts.js');
const { makeRoutineDelivery } = require('../../sidecar/routine-delivery.js');
const { steeredLoop } = require('./steer-run.js');
const { upTo } = require('./run-order.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
class TurnFixture {
  constructor(root, clock, options) {
    this.root = root; this.now = clock; this.serial = 0; this.records = new Map(); this.live = new Set(); this.calls = []; this.titles = [];
    this.deleted = new Map();   // the deleted-session ledger the store and the projection read (streamId -> ms), as sessionTombstones answers them in index.js
    this.dual = Dual.make({ now: clock, hash, env: key => key === 'STARNET_TURNID_WINDOW' ? options && options.window : undefined });
    fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
    this.attachments = require('../../sidecar/attachments.js')({ fsp: fs.promises, path, crypto, workspaces: root,
      resolveInside: (agentId, rel) => { const base = path.join(root, agentId), abs = path.resolve(base, rel); if (!abs.startsWith(base + path.sep)) throw Error('outside fixture agent'); return { base, abs }; } });
    this.restart();
    this.desk = [];
    this.pendingRuns = [];
    this.phone = makeRemoteHost({ now: clock, newId: () => this.newId(), roster: () => [{ agentId: 'agent' }],
      broadcast() {}, deskSessions: () => this.desk, liveRuns: () => [...this.live].map(runId => ({ runId })),
      credentials: () => ({ ok: true, model: 'test/model', provider: 'test', system: '' }), classify: () => false,
      transcript: { view: (...args) => this.store.view(...args), cacheRetractions: (...args) => this.store.cacheRetractions(...args),
        cacheRetractionsBatch: (...args) => this.store.cacheRetractionsBatch(...args) },
      turnDual: this.dual, turnProjection: (s, rows) => this.project(s, rows), redact,
      runOnce: request => { const p = this.run(request).then(result => { for (const event of result.events) request.emit(event.name, event.payload); return { text: result.reply, outcome: 'succeeded' }; }); this.pendingRuns.push(p); return p; },
      runRow: runId => this.records.get(runId) });
  }
  newId() { return 'run-' + String(++this.serial).padStart(8, '0'); }
  restart(options) {
    if (this.io) this.io.close();
    this.io = makeSegmentedTranscriptIo(Object.assign({ fs, path, root: path.join(this.root, 'history'), segmentBytes: 64 * 1024, onWarning: message => { this.warnings = (this.warnings || []).concat(message); }, schedule() {} }, options || {}));
    this.store = makeTranscriptStore({ io: this.io, clock: { now: this.now }, redact, hash, runOf: id => this.records.get(id),
      live: () => this.live, pick: this.dual.pick, quotedMaterial: require('../../sidecar/trusted-learning.js').quotedMaterial,
      deletedAt: id => this.deleted.get(String(id)) || 0, latestDeleteAt: () => Math.max(0, ...this.deleted.values()) });
    this.window = Window.make({ transcriptStore: this.store, turnDual: this.dual });
  }
  display(streamId, options) {
    const limit = options && options.limit || 200;
    return this.store.view('display', streamId, { limit });
  }
  project(streamId, rows) {
    // index.js transcriptProjection: what the quote and tombstone rules hid from this read is the page's affirmative drop proof (TurnMerge R2/R4)
    return this.dual.project(streamId, rows, { liveRunIds: this.live, isCollided: id => this.io.isCollided(id), forgottenAt: this.deleted.get(streamId) || 0,
      forgotten: rows && rows[Symbol.for('starnet.transcript.forgotten')] || undefined });
  }
  // the Commander deletes a session: the ledger stamps it, and every reader (the store's rules, the projection) answers as if it were gone
  deleteSession(streamId) { const at = this.now(); this.deleted.set(String(streamId), at); return at; }
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
    messages = call('turnWindow.apply(', () => this.window.apply(messages, Object.assign({}, o, Kinds.clientTurnTime(o, this.now()), { windowCaller: Window.callerOf(o) }), { agentId, runId, directive, reused: found }));
    messages = await call('attachments.expandForRun(', () => this.attachments.expandForRun(messages, agentId, o.projectRoot));
    const report = this.attachments.resentOf(messages);   // index.js: attachReport, read right after the expansion (size and sha256 of each file read)
    const kinds = call('const kinds = TurnKinds.ofRun(', () => Kinds.ofRun(o, { internal: !!o.internal, trigger: o.trigger || 'manual-page' }));
    const writer = call('const runTranscript = makeRunTranscript(', () => makeRunTranscript({ store: this.store, streamId: o.streamId, agentId, runId,
      turnId: () => turnId, stamp: true, rowKind: kinds.rowKind, directiveKind: kinds.directiveKind, line: kinds.line, quotes: opts.quotes,
      onFailure: (_stage, error) => { throw error; } }));
    const reused = call('let retryDirective = TurnDirective.reuse(', () => Directive.reuse(this.store, Object.assign({}, o, { found, streamId: o.streamId, turnId, runId, agentId, rekey, messages, directive, redact, latestUserText: list => UserText.latest(list, UserText.DIRECTIVE) })));
    const words = UserText.latest(messages, UserText.DIRECTIVE);
    call('TurnDirective.install(runTranscript, directive,', () => { Directive.install(writer, directive, words, kinds.directiveKind, report, reused); if (reused || o.recovery) writer.markDirectiveWritten(); });
    const directiveTitle = call('directiveTitle: TurnDirective.title(', () => Directive.title(directive, words));
    const title = call('TurnDirective.runTitle(', () => Directive.runTitle(directiveTitle));
    const expected = upTo(8).map(r => r.anchor);
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
    const steered = !!opts.steer && !opts.interrupt && !opts.fail;
    if (reply && !steered) events.push({ name: 'agent.token', payload: { runId, delta: reply } });
    if (!opts.interrupt && !opts.fail) {
      if (steered) {
        // SEND NOW notes through the real buffer, loop and run writer (test/helpers/steer-run.js): the notes arrive while the first tool runs and
        // fold at the next message boundary; the wire carries the loop's own tokens (the '[steering]' echoes included) and tool calls
        const out = await steeredLoop({ writer, messages, runId, agentId, notes: opts.steer, lead: opts.lead, reply, tools: opts.tools });
        for (const e of out.events) events.push({ name: e.name, payload: Object.assign({}, e.payload, { runId }) });
      } else messages.push(...(opts.extraMessages || []), { role: 'assistant', content: reply });
      // the host's run-end line (index.js): the run's files, as rows of their own, before the final drain writes the reply
      if (opts.files) {
        const ledger = makeArtifactCollector();
        for (const file of opts.files) ledger.add(file);
        const wrote = TurnDelivery.fileRows(this.store, { streamId: o.streamId, agentId, runId, turnId, root: '', artifacts: ledger.list() });
        if (wrote.skipped.length) throw Error('fixture files were not all eligible: ' + JSON.stringify(wrote.skipped));
      }
      writer.drain(messages);
    } else if (opts.persistPartial) { messages.push({ role: 'assistant', content: reply }); writer.drain(messages); }
    this.live.delete(runId);
    const reason = opts.interrupt ? 'interrupted' : opts.fail ? 'error' : 'done';
    this.records.set(runId, { runId, streamId: o.streamId, agentId, reason, title, turnId, ts: this.now() });
    this.titles.push({ runId, title, directive: Directive.wording(directive), packet: Directive.packet(directive, { row: writer.directiveRow() || reused, redact }) });
    events.push({ name: 'agent.run.end', payload: { runId, reason, outcome: reason === 'done' ? 'succeeded' : 'failed' } });
    return { events, start, reply, turnId, runId, directive, reused, messages };
  }
  async dispatch(request, options) { const result = await this.run(request, options); return result.events.map(e => JSON.stringify(e)).join('\n'); }
  // what the model would be handed from the station's own rows right now: the whole stream through the one model-replay view, with the row
  // id behind each message (View.ROW_IDS; null for a message no row stands behind)
  modelWindow(streamId) {
    const messages = this.store.view('model-replay', streamId, { shape: 'prose', form: 'pre', complete: true });
    return { messages, ids: Array.isArray(messages[View.ROW_IDS]) ? messages[View.ROW_IDS] : [] };
  }
  /* A routine's result handed back to a session, through the module index.js builds (makeRoutineDelivery) over this store, with the row
     writer index.js gives it. `station` is the page's answer to station.deliver (a function over the command's args), or none: no page. */
  async sessionReturn(streamId, runId, text, station) {
    const asked = [];
    const delivery = makeRoutineDelivery({ channelStore: {}, channelOutbound: { provide() {} }, channelReach: () => ({ ok: false }), channelRegistry: { get: () => null },
      redact, runStore: { list: () => [] }, egressReader: {}, transcriptStore: this.store, writeDelivery: fields => TurnDelivery.write(this.store, fields),
      stationBridge: { request: async (_verb, args) => { asked.push(JSON.parse(JSON.stringify(args))); return station ? station(args) : { ok: false, error: 'no station page answered — open StarNet to run station commands', unattended: true }; } },
      now: this.now });
    const job = { id: 'job-property', name: 'Property routine', agentId: 'agent', deliver: 'local', attachToSession: true, prompt: 'routine prompt',
      origin: { sessionId: streamId, streamId, sessionTitle: 'Property session' } };
    const out = await delivery.deliverCronResult(job, { outcome: 'ok', runId, text });
    return { out, asked };
  }
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
