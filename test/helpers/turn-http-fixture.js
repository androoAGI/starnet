'use strict';
/* Real routes and real provider loop. Only the model and the page/phone transports are controlled. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { SidecarFixture } = require('./sidecar-fixture.js');
const { allocatePort } = require('./ports.js');
const Phone = require('../../relay/app/phone-client.js');
const { userWords, runContextOf } = require('./host-notes.js');
const { PageModel } = require('./page-model.js');
const { check, key, dialogue } = require('./turn-oracle.js');
const Merge = require('../../frontend/app/turnmerge.js');
const RunOutcome = require('../../frontend/app/runoutcome.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(25); }
  throw Error('timeout: ' + label);
}
const eventsOf = text => String(text).split('\n').filter(Boolean).map(line => JSON.parse(line));
class TurnHttpFixture {
  constructor(seed, rng) { this.seed = seed; this.rng = rng; this.requests = []; this.phone = null; this.serial = 0; this.holdRequest = null; this.failNext = false; this.held = null; this.heldRequest = null; }
  async start() {
    this.mock = http.createServer((req, res) => {
      if (/\/models(?:\?|$)/.test(req.url)) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
      if (!/\/chat\/completions$/.test(req.url) || req.method !== 'POST') { res.writeHead(404); return res.end(); }
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        let body; try { body = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end(); }
        this.requests.push(body);
        if (this.failNext) { this.failNext = false; res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'fixture controlled permanent failure' } })); }
        const messages = body.messages || [], last = [...messages].reverse().find(m => m.role === 'user');
        const words = last ? userWords(last) : '';
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
        const finish = reason => { res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); res.end('data: [DONE]\n\n'); };
        if (this.holdRequest && words === this.holdRequest.words) {
          const intent = this.holdRequest;
          this.holdRequest = null; emit({ content: intent.token });
          const run = /Run id:\s*([^\s<]+)/.exec(runContextOf(messages));
          this.held = res;
          this.heldRequest = { response: res, body, runId: run && run[1], token: intent.token };
          res.once('close', () => { if (this.held === res) { this.held = null; this.heldRequest = null; } }); return;
        }
        const brief = (body.tools || []).find(t => t.function && t.function.name === 'brief_proceed');
        const alreadyBriefed = messages.some(m => m.role === 'assistant' && (m.tool_calls || []).some(t => t.function && t.function.name === 'brief_proceed'));
        if (brief && !alreadyBriefed) { emit({ tool_calls: [{ index: 0, id: 'brief-' + (++this.serial), type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify({ objective: words.slice(0, 120) || 'Answer the supplied turn' }) } }] }); return finish('tool_calls'); }
        emit({ content: 'ANSWER_' + (++this.serial) + ': ' + words.slice(0, 70) }); finish('stop');
      });
    });
    this.mock.listen(await allocatePort(), HOST); await once(this.mock, 'listening');
    const base = 'http://' + HOST + ':' + this.mock.address().port + '/api/v1';
    this.lanPort = await allocatePort(); this.lan = 'http://' + HOST + ':' + this.lanPort;
    this.fx = new SidecarFixture({ prefix: 'turn-http-' + this.seed + '-', timeoutMs: 30000, env: {
      SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-turn-property-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-turn-property-fixture',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      STARNET_REMOTE_PORT: String(this.lanPort), STARNET_REMOTE_LAN: '1', STARNET_REMOTE_RELAY: 'off',
      SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0',
      SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH_MS: '0', SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SKILL_REVIEW: '0'
    } });
    await this.fx.start();
    await this.json('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'TURN', system: 'Answer the supplied message.', model: 'test/model', provider: 'openrouter' }, { agentId: 'turnpeer', name: 'PEER', system: 'Answer the supplied message.', model: 'test/model', provider: 'openrouter' }] });
    await this.json('POST', '/api/save', { schema: 'starnet.save', version: require('../../frontend/app/save.js').CURRENT, _saveRevision: 0, _saveClient: 'turn-http-page', updatedAt: Date.now(), agent: { id: 'agent', createdAt: 1, name: 'TURN' }, workstreams: [{ id: 's', agentId: 'agent', title: 'Property', history: [] }], station: require('./saved-floor.js').emptyFloor() });
    await this.json('POST', '/api/remote/enable', { on: true });
    const pair = await this.json('POST', '/api/remote/pair', { name: 'Property phone' });
    this.deviceKey = await Phone.makeDeviceKey();
    this.paired = await Phone.pair({ base: this.lan, pairingId: pair.pairingId, code: pair.code, name: 'Property phone', key: this.deviceKey });
    this.stationPub = pair.stationPub; this.connectPhone();
    this.page = new PageModel({ streamId: 's', now: () => Date.now(), rng: this.rng,
      model: { getModel: () => 'test/model', contextLimitOf: () => 128000 }, // matches this fixture provider's actual catalog
      read: sid => this.read(sid), dispatch: body => this.dispatch(body),
      redactAsk: async rows => {
        const out = await this.json('POST', '/api/transcript/redact', { texts: rows.map(r => r.content) });
        assert.ok(Array.isArray(out.texts), 'real redact route replies with texts');
        return new Map(rows.map((r, i) => [r.content, out.texts[i]]));
      } });
    return this;
  }
  connectPhone() { this.phone = Phone.connect({ base: this.lan, deviceId: this.paired.deviceId, stationPub: this.stationPub, key: this.deviceKey }); }
  async json(method, route, body) { const result = await this.fx.json(method, route, body); assert.equal(result.status, 200, route + ': ' + result.text.slice(0, 300)); return result.body; }
  async read(stream = 's') { return this.json('GET', '/api/transcript?stream=' + encodeURIComponent(stream) + '&limit=2000'); }
  async upload(name, type, data) { return this.json('POST', '/api/attachments', { agent: 'agent', name, dataUrl: 'data:' + type + ';base64,' + Buffer.from(data).toString('base64') }); }
  async dispatch(body) {
    const response = await this.fx.json('POST', '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', isTask: false, system: 'Answer briefly.' }, body));
    assert.equal(response.status, 200, 'run admission: ' + response.text.slice(0, 300));
    const events = eventsOf(response.text);
    assert.ok(events.some(e => e.name === 'agent.run.start'), 'actual run started');
    assert.ok(events.some(e => e.name === 'agent.run.end'), 'actual run ended');
    return response.text;
  }
  async phoneCall(verb, args) { const result = await this.phone.call(verb, args); assert.equal(result.ok, true, 'sealed phone ' + verb + ': ' + JSON.stringify(result)); return result.data; }
  async phoneSend(text) {
    const sent = await this.phoneCall('send', { agentId: 'agent', streamId: 's', text });
    const ended = await until(async () => { const recent = await this.json('GET', '/api/remote/recent'); return recent.runs.find(r => r.runId === sent.runId && r.live === false); }, 'phone run ended');
    assert.equal(ended.ok, true, 'actual phone run succeeded');
    return sent;
  }
  async restart() { this.page.save(); if (this.phone) this.phone.close(); await this.fx.restart(); this.connectPhone(); await this.page.reload(); }
  async seedRows(rows) {
    // Pre-upgrade/long-history fixture setup while the only station writer is stopped. The run under test
    // still goes through the real route and its real coverage reader after the next boot.
    this.phone.close(); await this.fx.stop();
    const quick = Object.create(fs); quick.fsyncSync = () => {};
    const io = require('../../sidecar/transcript-history.js').makeSegmentedTranscriptIo({ fs: quick, path, root: path.join(this.fx.workspace, 'transcript-history-v2') });
    try { for (const row of rows) io.appendDurable(row); } finally { io.close(); }
    await this.fx.start(); this.connectPhone();
  }
  async restartDegraded() {
    this.phone.close(); await this.fx.stop();
    const entry = this.fx.entry, wrapper = path.join(this.fx.workspace, 'fixture-degraded-entry.cjs');
    const root = path.join(this.fx.workspace, 'transcript-history-v2');
    fs.writeFileSync(wrapper, "const fs=require('node:fs'),path=require('node:path'); const original=fs.mkdirSync; let fired=false; fs.mkdirSync=function(p,...args){if(!fired && path.resolve(String(p))===" + JSON.stringify(root) + "){fired=true;throw Object.assign(Error('fixture one-shot transcript initialization failure'),{code:'EIO'});}return original.call(fs,p,...args);}; require(" + JSON.stringify(entry) + ");\n");
    this.fx.entry = wrapper;
    try { await this.fx.start(); } finally { this.fx.entry = entry; }
    assert.ok(this.fx.output().includes('fixture one-shot transcript initialization failure'), 'degraded boot fault actually fired');
    this.connectPhone();
  }
  diskRows() {
    const root = path.join(this.fx.workspace, 'transcript-history-v2');
    return fs.readdirSync(root).filter(name => /^segment-\d{6}\.jsonl$/.test(name)).flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  async verify(label) {
    const read = await this.read(); await this.page.load(); check(this.page, read, this.diskRows(), { label });
    const again = Merge.merge(this.page.ws.history, read.turns, { identity: read.identity }); assert.deepEqual(again.rows, this.page.ws.history, label + ': idempotent page merge');
    const phone = await this.phoneCall('thread', { streamId: 's', limit: 200, page: true });
    const expected = read.turns.filter(dialogue).filter(r => r.content && r.content !== '[SILENT]');
    assert.deepEqual(phone.turns.map(key), expected.slice(-phone.turns.length).map(key), label + ': I5 actual sealed phone keys');
    for (const request of this.requests) for (const row of request.messages || []) for (const field of ['rowId', 'turnId', 'sourceRunId', 'streamId', 'typedText', 'directive', 'turnAt']) assert.ok(!(field in row), label + ': no provider-bound ' + field);
    assert.ok(!JSON.stringify(read).includes('ghp_' + 'AbCd1234'.repeat(5)), label + ': readback scrubs token shape');
    this.page.save(); return read;
  }
  async recoveryEvidence(start, records, source, raw) {
    // Failure-only, read-only evidence. The original first-page predicate remains the assertion;
    // finding the source on a later page does not retroactively turn that failed check green.
    const brief = row => row ? { runId: row.runId, status: row.status, canAutoContinue: row.canAutoContinue,
      damage: row.damage, forensicOnly: row.forensicOnly, repairError: row.repairError,
      uncertain: row.uncertain, continuation: row.continuation,
      checkpoint: { phase: row.checkpoint?.phase, turn: row.checkpoint?.turn, messages: row.checkpoint?.messages?.length } } : null;
    const evidence = { sourceRunId: start.runId, firstPage: { total: records.total, offset: records.offset,
      limit: records.limit, nextOffset: records.nextOffset, source: brief(source), listed: records.recoveries.map(brief) },
      ownTokens: 0, ownTerminal: [], laterPages: [] };
    try {
      const events = eventsOf(raw.slice(0, raw.lastIndexOf('\n'))).filter(e => e.payload?.runId === start.runId);
      evidence.ownTokens = events.filter(e => e.name === 'agent.token' && String(e.payload.delta).includes('INTERRUPTED_PARTIAL')).length;
      evidence.ownTerminal = events.filter(e => e.name === 'agent.run.end').map(e => ({ reason: e.payload.reason, outcome: e.payload.outcome }));
      const { _internals: J } = require('../../sidecar/run-journal.js');
      const file = path.join(this.fx.workspace, '.run-journal', J.runFileName(start.runId));
      const size = fs.statSync(file).size;
      if (size > 4 * 1024 * 1024) evidence.journal = { bytes: size, inspection: 'over diagnostic bound' };
      else {
        const parsed = J.parseRecords(fs.readFileSync(file, 'utf8')), state = J.analyze(parsed.records, parsed.corrupt, parsed.damage);
        let plan;
        try { const result = require('../../sidecar/run-recovery.js').automaticContinuationPlan(state); plan = { ok: true, messages: result.messages.length }; }
        catch (error) { plan = { ok: false, code: error.code, reason: String(error.message).slice(0, 300) }; }
        evidence.journal = { bytes: size, status: state.status, records: state.records, terminal: state.terminal,
          damage: state.damage, forensic: state.forensic, retirable: state.retirable, plan,
          checkpoint: { phase: state.checkpoint.phase, turn: state.checkpoint.turn,
            rows: (state.checkpoint.messages || []).slice(-200).map(m => ({ role: m.role, tool_call_id: m.tool_call_id,
              calls: (m.tool_calls || []).map(c => ({ id: c.id, name: c.function?.name })) })) } };
      }
    } catch (error) { evidence.inspectionError = { code: error.code, reason: String(error.message).slice(0, 300) }; }
    try {
      let offset = records.nextOffset;
      for (let n = 0; offset != null && n < 10; n++) {
        const response = await this.fx.json('GET', '/api/run-recoveries?offset=' + offset + '&limit=100', undefined, { signal: AbortSignal.timeout(1000) });
        if (response.status !== 200) { evidence.pagingStatus = response.status; break; }
        const page = response.body;
        evidence.laterPages.push({ total: page.total, offset: page.offset, nextOffset: page.nextOffset,
          source: brief(page.recoveries.find(r => r.runId === start.runId)) });
        if (page.nextOffset != null && page.nextOffset <= offset) { evidence.pagingError = 'nonadvancing offset'; break; }
        offset = page.nextOffset;
      }
    } catch (error) { evidence.pagingError = String(error.message).slice(0, 300); }
    return evidence;
  }
  async interruptAndContinue() {
    const marker = String(this.seed) + '-' + (++this.serial);
    const words = 'recover this exact directive [fixture interruption ' + marker + ']';
    const sent = await this.page.prepare(words);
    const token = 'INTERRUPTED_PARTIAL_' + marker;
    this.holdRequest = { words, token };
    const response = await this.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ model: 'test/model', provider: 'openrouter', isTask: false }, sent)) });
    assert.equal(response.status, 200); const reader = response.body.getReader(), decoder = new TextDecoder(); let raw = '';
    const reading = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; raw += decoder.decode(part.value, { stream: true }); } } catch (_) {} })();
    const start = await until(() => {
      const events = eventsOf(raw.slice(0, raw.lastIndexOf('\n')));
      const own = events.find(e => e.name === 'agent.run.start')?.payload;
      if (!own) return false;
      assert.ok(!events.some(e => e.name === 'agent.run.end' && e.payload?.runId === own.runId), 'interrupted source cannot finish before its owned partial');
      const held = this.heldRequest;
      return held && this.held === held.response && !held.response.destroyed && held.runId === own.runId && held.token === token &&
        events.some(e => e.name === 'agent.token' && e.payload?.runId === own.runId && String(e.payload.delta).includes(token)) && own;
    }, 'interrupted source owns held provider response and partial token');
    this.phone.close(); await this.fx.crash(); await reading;
    this.page.consume(raw.slice(0, raw.lastIndexOf('\n')), sent); await this.fx.start(); this.connectPhone();
    const records = await this.json('GET', '/api/run-recoveries'), source = records.recoveries.find(r => r.runId === start.runId);
    try { assert.ok(source && source.canAutoContinue, 'real interrupted run is continuable'); }
    catch (error) { error.recoveryEvidence = await this.recoveryEvidence(start, records, source, raw); throw error; }
    const continuationId = 'property-' + this.seed + '-' + (++this.serial);
    assert.ok(/^[A-Za-z0-9._:-]{8,100}$/.test(continuationId), 'fixture satisfies the actual recovery route identifier grammar');
    const prepared = await this.json('POST', '/api/run-recoveries/continue', { runId: start.runId, agentId: 'agent', recoveryToken: source.recoveryToken, continuationId, mode: 'automatic' });
    const request = { agentId: 'agent', streamId: 's', messages: [], turnId: Merge.newTurnId(this.rng), retryOf: Merge.newTurnId(this.rng), recovery: { sourceRunId: start.runId, continuationId, continuationToken: prepared.continuationToken } };
    const text = await this.dispatch(request), next = this.page.consume(text, request);
    assert.equal(next.turnId, start.turnId, 'real recovery ignores conflicting page identities');
    assert.ok(RunOutcome.ofEnd(next.ended).ok, 'actual recovery continuation succeeded');
  }
  async dispose() { if (this.phone) this.phone.close(); if (this.fx) await this.fx.dispose(); if (this.held) this.held.destroy(); if (this.mock) { this.mock.closeAllConnections(); await new Promise(resolve => this.mock.close(resolve)); } }
}
module.exports = { TurnHttpFixture, until, eventsOf };
