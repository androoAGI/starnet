'use strict';
/* node test/routine-delivery.session-return.e2e.test.js — a routine's return to the session it came from is a row of the station's own
   transcript BEFORE it is a page command (turn identity, commit 10; design §10 "Session return").

   Legs 1-5 boot the real sidecar with a scripted local model and a station page played over the real SSE feed (it acks, ignores or
   refuses station.command, as a connected page, an absent one and a refusing one do). Four counts are kept apart on every routine:
   provider calls (the model server), outbound channel transport (channel.delivery events: none, a session return uses none), page calls
   (station.deliver commands) and durable delivery rows (GET /api/transcript).
     1. connected   when the page is asked, the delivery row is ALREADY in GET /api/transcript; the command carries that row's rowId and
                    turnId and the same redacted text; the cron records the delivery done; one provider call, one page call, one row;
     2. no page     nobody answers (the bridge times out): the delivery fails as before and is asked again later, and the row is there
                    for the next reader of the session, once;
     3. refusing    a page that refuses leaves the row too;
     4. write fails the disk refuses the delivery row (a real EIO under the real writer): the page is never asked, no row exists, and the
                    cron records the delivery NOT done, with the cause, so it asks again;
     5. restart     the same station restarted still holds each row, with the same row id.
   Legs 6-8 run the module index.js builds (makeRoutineDelivery) over the real disk store, with only the page scripted:
     6. retry       the cron's second ask after a failed page finds the same row and sends the same identity; a third ask after success
                    writes nothing; a restart of the store in between changes nothing;
     7. strict      a write the store refuses, and a proof it cannot read, make zero page calls and return { ok:false } with the cause;
                    once the disk heals the next ask writes the one row and asks the page once;
     8. scope       a script routine's reply is proved untrusted (the row says so) and a chat-bound routine writes no session row.
   RED at 4152883a1: station.deliver goes out with no row and no row id. On http.list. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { sseQuery } = require('./_httpToken.js');
const Kinds = require('../frontend/app/turnkinds.js');
const { makeRoutineDelivery } = require('../sidecar/routine-delivery.js');
const TurnDelivery = require('../sidecar/turn-delivery.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REPLY = 'Routine result: three things moved overnight.';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-session-return-'));

/* ---- the model: every call answers REPLY, and every call is counted ---- */
function startModel(requests) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        try { requests.push(JSON.parse(raw)); } catch (_) { requests.push({}); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    server.listen(0, HOST, () => resolve(server));
  });
}

/* ---- the station page, over the real SSE feed ---- */
async function openPage(fixture, onCommand) {
  const ac = new AbortController(), seen = [];
  const res = await fetch(fixture.baseUrl + '/api/channels/events?' + sseQuery(fixture.token), { signal: ac.signal });
  A.eq(res.status, 200, 'the SSE feed opens');
  const reader = res.body.getReader(), dec = new TextDecoder();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let event; try { event = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          seen.push(event);
          if (event.name === 'station.command' && event.payload && event.payload.verb === 'station.deliver') await onCommand(event.payload);
        }
      }
    } catch (_) { /* closed */ }
  })();
  return { seen, close() { try { ac.abort(); } catch (_) {} } };
}

const rowsOf = body => (body && Array.isArray(body.turns) ? body.turns : []);
const deliveriesOf = body => rowsOf(body).filter(r => r.kind === 'delivery');

(async () => {
  const requests = [];
  const model = await startModel(requests);
  const base = 'http://' + HOST + ':' + model.address().port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'starnet-session-return-', timeoutMs: 40000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-session-return-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-session-return-fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_CRON_TICK_MS: '1000', STARNET_CRON_TICK_MS: '1000',
    SKYNET_AUX_BUDGET: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_EDGE_TTS: '0', SKYNET_QUEST_REFRESH_MS: '0', SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0',
    NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'fixtures', 'delivery-rows-fault.cjs'))   // inert until the arm file exists (leg 4)
  } });
  const mode = {};   // sessionId -> how the page answers its station.deliver: 'ack' | 'ignore' | 'refuse'
  const commands = [];   // every station.deliver the page was asked, with the transcript as it stood at that moment
  let page = null;
  const armFile = path.join(fixture.workspace, 'delivery-fault.arm');
  try {
    await fixture.start();
    A.eq((await fixture.json('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Lead', model: 'test/model', provider: 'openrouter' }] })).status, 200, 'fixture: roster saved');
    page = await openPage(fixture, async payload => {
      const args = payload.args || {}, sid = args.sessionId;
      const atCommand = await fixture.json('GET', '/api/transcript?stream=' + encodeURIComponent(args.streamId) + '&limit=50');
      commands.push({ sid, args, rows: deliveriesOf(atCommand.body), at: Date.now() });
      const how = mode[sid] || 'ack';
      if (how === 'ignore') return;
      await fixture.json('POST', '/api/station/ack', how === 'ack' ? { id: payload.id, ok: true, result: { folded: true } } : { id: payload.id, ok: false, error: 'the page refused it' });
    });

    // one scheduled routine returning to `sid`; resolves with its job row once `done(job)` holds
    async function routine(name, sid, extra) {
      const before = { provider: requests.length, commands: commands.length, transport: page.seen.filter(e => e.name === 'channel.delivery').length };
      const made = await fixture.json('POST', '/api/cron', Object.assign({ name, prompt: name + ': summarize the night', schedule: 'in 1s', agentId: 'agent', model: 'test/model', provider: 'openrouter', deliver: 'origin',
        origin: { sessionId: sid, streamId: sid, sessionTitle: name + ' session' } }, extra || {}));
      A.eq(made.status, 200, name + ': the routine is created');
      A.eq((await fixture.json('POST', '/api/cron/arm', { enabled: true })).status, 200, name + ': the scheduler is armed');
      return { id: made.body.job.id, before, counts: () => ({ provider: requests.length - before.provider, pageCalls: commands.length - before.commands, transport: page.seen.filter(e => e.name === 'channel.delivery').length - before.transport }) };
    }
    async function settle(job, done, ms) {
      for (let i = 0; i < Math.ceil(ms / 150); i++) {
        const jobs = (await fixture.json('GET', '/api/cron')).body.jobs || [];
        const row = jobs.find(j => j.id === job.id);
        if (row && done(row)) { await fixture.json('POST', '/api/cron/arm', { enabled: false }); return row; }
        await sleep(150);
      }
      await fixture.json('POST', '/api/cron/arm', { enabled: false });
      return (((await fixture.json('GET', '/api/cron')).body.jobs) || []).find(j => j.id === job.id);
    }
    const read = async sid => (await fixture.json('GET', '/api/transcript?stream=' + encodeURIComponent(sid) + '&limit=100')).body;

    /* 1. a connected page */
    mode.ws_connected = 'ack';
    const connected = await routine('Connected', 'ws_connected');
    const done1 = await settle(connected, j => j.lastDeliveryOk === true, 30000);
    A.eq(done1 && done1.lastDeliveryOk, true, '1. the page took it and the cron recorded the delivery done');
    const body1 = await read('ws_connected'), rows1 = deliveriesOf(body1), r1 = rows1[0] || {};
    A.eq(rows1.length, 1, '1. exactly one delivery row in the session');
    const c1 = commands.filter(c => c.sid === 'ws_connected'), k1 = c1[0] || { args: {}, rows: [] };
    A.eq(c1.length, 1, '1. the page was asked exactly once');
    A.eq(k1.rows.length, 1, '1. when the page was asked, the delivery row was already in GET /api/transcript (written first)');
    A.eq([r1.role, r1.sourceRunId && r1.turnId, r1.content], ['assistant', Kinds.runTurnId(r1.sourceRunId), '✦ Connected\n\n' + REPLY], '1. an assistant delivery row for the run, the routine\'s words');
    A.eq([k1.args.rowId, k1.args.turnId, k1.args.text], [r1.rowId, r1.turnId, r1.content], '1. station.deliver names that row (rowId and turnId) and carries the same text');
    A.eq(k1.args.runId, r1.sourceRunId, '1. and the run');
    A.eq(connected.counts(), { provider: 1, pageCalls: 1, transport: 0 }, '1. counts kept apart: one model call, one page call, no channel transport');

    /* 2. nobody answers */
    mode.ws_away = 'ignore';
    const away = await routine('Away', 'ws_away');
    const done2 = await settle(away, j => j.lastDeliveryOk === false, 40000);
    A.eq([done2 && done2.lastDeliveryOk, /no station page answered/.test(String(done2 && done2.lastDeliveryError))], [false, true], '2. with no page the delivery fails as it always did (asked again later)');
    const rows2 = deliveriesOf(await read('ws_away')), c2 = commands.filter(c => c.sid === 'ws_away'), r2 = rows2[0] || {}, k2 = c2[0] || { args: {}, rows: [] };
    A.eq(rows2.length, 1, '2. the row is in the session all the same, once');
    A.eq([c2.length, k2.args.rowId, k2.rows.length], [1, r2.rowId, 1], '2. the one page call named that row, which was already there');
    A.eq(away.counts(), { provider: 1, pageCalls: 1, transport: 0 }, '2. counts kept apart');

    /* 3. a page that refuses */
    mode.ws_refuse = 'refuse';
    const refuse = await routine('Refused', 'ws_refuse');
    const done3 = await settle(refuse, j => j.lastDeliveryOk === false, 30000);
    A.eq([done3 && done3.lastDeliveryOk, /the page refused it/.test(String(done3 && done3.lastDeliveryError))], [false, true], '3. a refusing page fails the delivery, with its reason');
    const rows3 = deliveriesOf(await read('ws_refuse')), r3 = rows3[0] || {};
    A.eq(rows3.length, 1, '3. and the row stays');

    /* 4. the disk refuses the row */
    mode.ws_fault = 'ack';
    fs.writeFileSync(armFile, '1');
    const fault = await routine('Faulted', 'ws_fault');
    const done4 = await settle(fault, j => j.lastDeliveryOk === false, 30000);
    fs.rmSync(armFile, { force: true });
    A.ok(fs.existsSync(path.join(fixture.workspace, 'delivery-fault-observed.jsonl')), '4. fixture: the fault hit the delivery row\'s disk write');
    A.eq([done4 && done4.lastDeliveryOk, /could not be saved to the conversation/.test(String(done4 && done4.lastDeliveryError))], [false, true], '4. the cron records the delivery NOT done, with the cause');
    A.eq(commands.filter(c => c.sid === 'ws_fault').length, 0, '4. the page was never asked');
    A.eq(deliveriesOf(await read('ws_fault')).length, 0, '4. and no row exists');
    A.eq(fault.counts(), { provider: 1, pageCalls: 0, transport: 0 }, '4. counts kept apart: the run happened, nothing was delivered anywhere');

    /* 5. a restart changes nothing */
    const ids = { ws_connected: r1.rowId, ws_away: r2.rowId, ws_refuse: r3.rowId };
    await fixture.restart();
    for (const sid of Object.keys(ids)) {
      const rows = deliveriesOf(await read(sid));
      A.eq(rows.map(r => r.rowId), [ids[sid]], '5. ' + sid + ': after a restart the same single row, the same row id');
    }
  } finally {
    if (page) page.close();
    await fixture.dispose();
    model.close();
  }

  /* ---- the module index.js builds, over the real disk store ---- */
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  let tick = 1000;
  const clock = () => ++tick;
  const open = dir => {
    const io = makeSegmentedTranscriptIo({ fs, path, root: dir, segmentBytes: 64 * 1024, onWarning() {}, schedule() {} });
    return { io, store: makeTranscriptStore({ io, clock: { now: clock }, redact: t => t, hash }) };
  };
  const build = (store, answers) => {
    const asked = [];
    const delivery = makeRoutineDelivery({ channelStore: {}, channelOutbound: { provide() {} }, channelReach: () => ({ ok: false }), channelRegistry: { get: () => null },
      redact: t => String(t).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]'), runStore: { list: () => [] }, egressReader: {}, transcriptStore: store, writeDelivery: fields => TurnDelivery.write(store, fields),
      stationBridge: { request: async (verb, args) => { asked.push({ verb, args: JSON.parse(JSON.stringify(args)) }); const a = answers.shift(); return typeof a === 'function' ? a() : a || { ok: true, result: { folded: true } }; } }, now: () => 5000 });
    return { deliver: delivery.deliverCronResult, asked };
  };
  const job = { id: 'job-s', name: 'Recap', agentId: 'agent', deliver: 'local', attachToSession: true, prompt: 'Recap the plan', origin: { sessionId: 'ws_s1', streamId: 'ws_s1', sessionTitle: 'Planning' } };
  const result = { outcome: 'ok', runId: 'cron-run-9', text: 'Recap done. key sk-ABCDEFGH12345678 was rotated.' };
  const dir = fs.mkdtempSync(path.join(scratch, 'store-'));
  const deliveries = store => store.view('proof', 'ws_s1', { complete: true }).filter(r => r.kind === 'delivery');

  /* 6. the retry */
  {
    let { io, store } = open(dir);
    let owner = build(store, [{ ok: false, error: 'no station page answered — open StarNet to run station commands', unattended: true }]);
    const first = await owner.deliver(job, result);
    A.eq([first.ok, owner.asked.length, deliveries(store).length], [false, 1, 1], '6. page away: the delivery fails and the row is already there');
    const row = deliveries(store)[0] || { content: '' };
    A.eq([owner.asked[0].verb, owner.asked[0].args.rowId, owner.asked[0].args.turnId], ['station.deliver', row.rowId, row.turnId], '6. the page command names that row');
    A.eq(row.content.includes('sk-ABCDEFGH12345678') || owner.asked[0].args.text.includes('sk-ABCDEFGH12345678'), false, '6. the key is redacted in the row and in the command');
    A.eq(owner.asked[0].args.text, row.content, '6. the same text goes both ways');
    io.close();
    ({ io, store } = open(dir));   // the station restarted between the two asks
    owner = build(store, []);
    const second = await owner.deliver(job, result);
    A.eq([second.ok, owner.asked.length, deliveries(store).length, owner.asked[0].args.rowId], [true, 1, 1, row.rowId], '6. the retry after a restart finds the same row and sends the same identity');
    const third = await owner.deliver(job, result);
    A.eq([third.ok, deliveries(store).length, owner.asked[1].args.rowId], [true, 1, row.rowId], '6. a third ask after success writes nothing new');
    io.close();
  }

  /* 7. strict: a write or a proof the store cannot make is a failed delivery, and the page is never asked */
  {
    const { io, store } = open(fs.mkdtempSync(path.join(scratch, 'strict-')));
    const real = io.appendDurable;
    io.appendDurable = () => { throw Object.assign(new Error('EIO: injected disk failure'), { code: 'EIO' }); };
    const owner = build(store, []);
    const refused = await owner.deliver(job, result);
    A.eq([refused.ok, /could not be saved to the conversation/.test(String(refused.error)), /EIO: injected disk failure/.test(String(refused.error)), owner.asked.length, deliveries(store).length], [false, true, true, 0, 0],
      '7. a write the disk refuses: { ok:false } with the cause, zero page calls, no row');
    const unproven = build(Object.assign({}, store, { view: () => { throw new Error('proof unavailable'); } }), []);
    const noProof = await unproven.deliver(job, result);
    A.eq([noProof.ok, unproven.asked.length], [false, 0], '7. a proof the store cannot read: the same, zero page calls');
    io.appendDurable = real;
    const healed = await owner.deliver(job, result);
    A.eq([healed.ok, owner.asked.length, deliveries(store).length], [true, 1, 1], '7. once the disk heals the next ask writes the one row and asks the page once');
    io.close();
  }

  /* 8. scope */
  {
    const { io, store } = open(fs.mkdtempSync(path.join(scratch, 'scope-')));
    const owner = build(store, []);
    const script = Object.assign({}, job, { id: 'job-script', noAgent: true });
    await owner.deliver(script, { outcome: 'ok', runId: 'cron-run-10', text: 'disk 40% used' });
    const row = deliveries(store)[0] || {};
    A.eq([row.taint, row.taintKnown], ['scheduled script output', true], '8. a script routine\'s reply is proved untrusted, and the row says so');
    const plain = await owner.deliver(job, result);
    const agentRow = deliveries(store).find(r => r.sourceRunId === 'cron-run-9');
    A.eq([plain.ok, agentRow && agentRow.taint, agentRow && agentRow.taintKnown], [true, undefined, undefined], '8. an agent routine\'s taint is not provable from the result: the row claims none');
    const chat = await owner.deliver({ id: 'job-chat', name: 'Chat', agentId: 'agent', deliver: 'origin', origin: { channel: 'telegram', chatId: '4242' } }, { outcome: 'silent', runId: 'cron-run-11' });
    A.eq([chat.skipped, owner.asked.length, deliveries(store).length], [true, 2, 2], '8. a silent result and a chat-bound routine write no session row and ask no page');
    io.close();
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  A.report('routine-delivery.session-return.e2e.test');
})().catch(e => { console.log('FAIL: routine-delivery.session-return.e2e.test threw - ' + (e && e.stack || e)); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
