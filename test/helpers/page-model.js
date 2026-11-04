'use strict';
/* A page cache driven through the production send/reconcile exports. The only transport here is injected.
   Window fitting uses shared HistoryFit; asynchronous admission remains the actual chat.js function. */
const fs = require('node:fs');
const vm = require('node:vm');
const { fnBody } = require('../_fnbody.js');
const TurnMerge = require('../../frontend/app/turnmerge.js');
const HistoryFit = require('../../frontend/app/historyfit.js');
const { legacyControl } = require('./turn-property-control.js');
const frozenLegacy = require('../fixtures/merge-canonical-d5024f5a2.js');
if (legacyControl && TurnMerge.legacyMerge.toString().replace('function legacyMerge', 'function mergeCanonicalHistory') !== frozenLegacy.toString()) throw Error('legacy property control does not match d5024f5a2');
const chat = fs.readFileSync(require.resolve('../../frontend/app/chat.js'), 'utf8');
const functions = ['utf8Bytes', 'fitHistoryBytes', 'contextEstimateMessages', 'historyWindowFrom', 'fitHistoryTokens',
  'windowModelOf', 'modelFitHistory', 'historyWindow', 'endOnUserTurn', 'changedBeforeSending', 'untilAborted', 'ensureHistoryReady',
  'steerEchoesOf', 'sentNowIdFor', 'fileRunSteers', 'placeSteerNotes'];   // the last four: the page's own reading, filing and placing of a SEND NOW line's echo
const declarations = functions.map(name => {
  const text = fnBody(chat, (name === 'ensureHistoryReady' ? 'async ' : '') + 'function ' + name + '(');
  if (!text || text.length > 15000) throw Error('page model cannot locate bounded production ' + name);
  return text;
}).join('\n');
const constants = ['HISTORY_CAP', 'HISTORY_WIRE_MAX_BYTES', 'HISTORY_SEND_READ_MS', 'HISTORY_SEND_WAIT_MS'].map(name => {
  const match = chat.match(new RegExp('const ' + name + ' = [^;]+;'));
  if (!match) throw Error('page model cannot locate production ' + name);
  return match[0];
}).join('\n');
class PageModel {
  constructor(deps) {
    this.d = deps; this.legacyControl = legacyControl; this.ws = { id: deps.streamId || 's', agentId: deps.agentId || 'agent', history: [] };
    this.created = []; this.events = []; this.saved = '[]'; this.historyLoads = new WeakMap();
    const page = this;
    class Clock extends Date { static now() { return page.d.now(); } }
    this.context = vm.createContext({ Date: Clock, TextEncoder, setTimeout, clearTimeout, Promise, AbortController,
      TurnMerge, HistoryFit, stationModes: { window: 'legacy' }, stationCaps: null,
      CtxGauge: require('../../frontend/app/ctxgauge.js'), Harness: Object.assign({ turnIdentityCaps: async () => typeof deps.caps === 'function' ? deps.caps() : null }, deps.model || {}),
      historyLoads: this.historyLoads, historyPinSeq: 1, sentNow: this.sentNow = new Map(), Workstreams: { get: id => id === page.ws.id ? page.ws : null },
      noteContinuity: (_ws, e) => page.events.push(e), loadServerHistory: () => page.load() });
    vm.runInContext(constants + '\n' + declarations + '\nthis.pageFns={ensureHistoryReady,historyWindow,endOnUserTurn,windowModelOf,steerEchoesOf,sentNowIdFor,fileRunSteers,placeSteerNotes};', this.context);
  }
  remember(row) { this.created.push(JSON.parse(JSON.stringify(row))); this.ws.history.push(row); return row; }
  pending(text, attachments) {
    const row = Object.assign({ role: 'user', content: text, ts: this.d.now() }, attachments && attachments.length ? { attachments } : null);
    return this.remember(this.legacyControl ? row : TurnMerge.pendingRow(row, this.d.rng));
  }
  async load() {
    const read = { history: this.ws.history, retryable: false, promise: null };
    this.historyLoads.set(this.ws, read);
    read.promise = Promise.resolve().then(() => this.d.read(this.ws.id)).then(async response => {
      this.context.stationModes = !this.legacyControl && response.identity && response.identity.v === 2 && response.identity.modes
        ? response.identity.modes : { window: 'legacy' };
      this.context.stationCaps = this.legacyControl ? null : HistoryFit.capsOf(response.identity);
      // Exercise the exact frozen rollback owner through production reconciliation, including its redaction
      // pass. Only the old client identity behavior is selected; the station stays the real current fixture.
      if (this.legacyControl) response = Object.assign({}, response, { identity: Object.assign({}, response.identity, { v: 2,
        modes: Object.assign({}, response.identity && response.identity.modes, { merge: 'legacy' }) }) });
      const out = await TurnMerge.reconcile(this.ws.history, response, { getLocal: () => this.ws.history,
        redactAsk: this.d.redactAsk, note: e => this.events.push(e) });
      // chat.js ensureHistory: the merged rows, with each SEND NOW echo still waiting for its station row placed where the agent read it
      if (this.historyLoads.get(this.ws) === read) { this.lastMergeReport = out.report; this.ws.history = this.legacyControl ? out.rows : this.context.pageFns.placeSteerNotes(out.rows); }
      return true;
    });
    return read.promise;
  }
  async prepare(text, options) {
    const o = options || {};
    if (!o.retry && !o.resend && !o.recovery) this.pending(text, o.attachments);
    const signal = o.signal || new AbortController().signal;
    const historyRead = await this.context.pageFns.ensureHistoryReady(this.ws, signal, { degradedOk: !o.recovery && !this.legacyControl, caps: this.context.stationCaps });
    const ids = o.recovery || this.legacyControl ? {} : TurnMerge.sendIds(this.ws.history, { retry: !!o.retry, now: this.d.now() });
    const plan = HistoryFit.sendPlan(this.ws.history, { ids, retry: !!o.retry, recovery: !!o.recovery || this.legacyControl,
      historyRead, model: this.context.pageFns.windowModelOf(this.ws) });
    return Object.assign({ streamId: this.ws.id, agentId: this.ws.agentId, messages: plan.messages }, plan.post, o.post || {});
  }
  consume(text, sent, options) {
    const o = options || {}, events = String(text || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
    let runId = '', turnId = sent.turnId || '', reply = '', ended = null;
    const runSteers = [], fns = this.context.pageFns;   // every '[steering]' note this run streamed (chat.js send: runSteers)
    for (const event of events) {
      const p = event.payload || {};
      if (event.name === 'agent.run.start' && !p.parentRunId && !runId) {
        runId = p.runId;
        if (this.legacyControl) {
          const directive = [...this.ws.history].reverse().find(row => row && row.role === 'user' && !row.sys);
          if (directive && !directive.sourceRunId) directive.sourceRunId = runId;
        } else turnId = TurnMerge.bindStart(this.ws.history, p, runId, sent).turnId;
        // the SEND NOW lines this page handed the run (chat.js sendQueuedNow: kept in sentNow, by the id it posted with the note)
        if (Array.isArray(o.steer)) this.sentNow.set(this.ws.id, o.steer.filter(n => n.noteId).map(n => ({ id: n.noteId, text: n.text, wire: n.text, runId, accepted: true, landed: false })));
      }
      if (event.name === 'agent.token' && (!p.runId || p.runId === runId)) {
        const delta = p.delta || '';
        reply += delta;
        // chat.js onToken: an echo of a note the run read is collected with the id of the line it carried
        if (delta.indexOf('[steering] ') >= 0 && !this.legacyControl) for (const t of fns.steerEchoesOf(delta)) runSteers.push({ text: t, ts: this.d.now(), noteId: runId ? fns.sentNowIdFor(this.ws.id, runId, t, runSteers) : '' });
      }
      // a tool call starts the visible reply over (harness.js: full = ''), so the saved reply is the last stretch since it
      if (event.name === 'agent.tool_call' && (!p.runId || p.runId === runId)) reply = '';
      if (event.name === 'agent.run.end' && p.runId === runId) ended = p;
    }
    // chat.js, at the run's end: each note it read is filed as an echo row unless the saved reply already shows it
    if (runSteers.length) fns.fileRunSteers(this.ws, runSteers, runId, ended && ended.reason === 'error' ? '' : reply);
    this.sentNow.delete(this.ws.id);
    if (reply) this.remember(TurnMerge.ofTurn({ role: 'assistant', content: reply, ts: this.d.now() }, { turnId, sourceRunId: runId }));
    if (o.error || (ended && ended.reason === 'error')) this.remember(TurnMerge.ofTurn({ role: 'assistant', content: 'run failed', error: true, ts: this.d.now() }, { turnId, sourceRunId: runId }));
    return { events, runId, turnId, reply, ended };
  }
  async send(text, options) { const request = await this.prepare(text, options); this.lastRequest = JSON.parse(JSON.stringify(request)); return this.consume(await this.d.dispatch(request, options || {}), request, options); }
  save() { this.saved = JSON.stringify(this.ws.history); }
  async reload(wipe) { this.ws.history = wipe ? [] : JSON.parse(this.saved); this.historyLoads.delete(this.ws); return this.load(); }
  // the window this page would send the model right now: the page's own rows through the one window owner, in the mode the station last advertised
  window() { return TurnMerge.windowRows(this.ws.history, { window: this.context.stationModes && this.context.stationModes.window || 'legacy' }); }
  /* The station page's own answer to a station.deliver command (a routine's return): the REAL stationcommands.js handler, folding into this
     page's session, with the page's bridges stubbed. -> { ok, result | error }, as the page would ack it. */
  async station(args) {
    if (!this.stationRun) {
      const page = this, acks = [], ws = this.ws;
      const Workstreams = { get: id => (id === ws.id ? ws : null), list: () => [ws], generalId: () => '', activeId: () => null, adopt: () => null, touch() {}, markUnread() {}, noteRunEnd: () => false,
        appendRun: (_id, runId) => { ws.runIds = ws.runIds || []; if (!ws.runIds.includes(String(runId))) ws.runIds.push(String(runId)); return true; } };
      const sandbox = { TurnMerge, Workstreams, Channels: { end() {}, isBusy: () => false }, GoalLoop: require('../../frontend/app/goalloop.js'),
        App: { refreshRail() {}, persist: () => page.save(), agents: () => [] }, CloudSave: { flush: async () => true, pull: async () => null }, Delegated: { repaint() {} },
        Chat: { deliverTurns() {}, load() {}, canFocusSession: () => true }, U: { bus: { on() {} } },
        fetch: async (_url, init) => { acks.push(JSON.parse(init.body)); return { ok: true }; }, document: { addEventListener() {} }, console, setTimeout, clearTimeout, Date, JSON };
      sandbox.globalThis = sandbox; vm.createContext(sandbox);
      const S = vm.runInContext(fs.readFileSync(require.resolve('../../frontend/app/stationcommands.js'), 'utf8') + '\n;StationCommands;', sandbox, { filename: 'stationcommands.js' });
      this.stationRun = async a => { const before = acks.length; await S.run('property-' + before, 'station.deliver', a); const ack = acks[acks.length - 1]; return ack && ack.ok ? { ok: true, result: ack.result } : { ok: false, error: ack && ack.error }; };
    }
    return this.stationRun(args);
  }
}
module.exports = { PageModel };
