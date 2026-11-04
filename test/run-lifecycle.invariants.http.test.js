/* node test/run-lifecycle.invariants.http.test.js — EVERY ADMITTED RUN ENDS EXACTLY ONCE, and A THROWN RUN NEVER RECORDS A KNOWN $0
   (run-table lane S2; pure half: test/run-table.test.js).

   A run's start and end were hand-written at nineteen sites, and only COMMS (handleRun's catch) ended a run its host threw out
   of. Proven at 0b8441064: a /v1 chat whose host failed after its start answered 502 while the station floor saw the run start
   and never end; Run Now's own stream carried the start and the error and no end; and a Run Now that threw after its first
   priced call recorded { usd: 0, no spendUnknown, no usageMissing } over a call its stream had priced at $0.00014. The run table
   now gives each run ONE terminal emitter (sidecar/run-table.js guard -> finish) and a BELT (runOnce's finally: settle).

   This boots the REAL sidecar (test/helpers/run-fault-host.cjs: the production wiring, with a fault injected at the agent-loop
   boundary) against a mock model at the HTTP edge, and drives every run surface through every fault:
     surfaces  COMMS (/api/run), Run Now, a scheduled fire, /v1 chat (sync and stream), /v1/runs, the dev channel hub (the
               production makeChannelHub every Telegram/Discord/Slack/Matrix/Signal hub uses), a group session turn, a line
               hop, a loop iteration, a phone task (the real relay/app/phone-client.js pairing)
     faults    throw-before-start, throw-after-start, throw-after-cost (a host failure after a priced call was booked), and a
               provider error (the provider refuses the call: the loop's own error end, the control). A provider 500 takes
               the loop's whole retry ladder (~105 s a run) to end the same way, so the control uses a refusal it ends at once.
               (S3) Three stops of a run held at the provider: STOP BY ID (POST /api/cancel with the run's id: its run-table
               stop, or `runs`' own abort), E-STOP (POST /api/halt, then RESUME), and a PROCESS FAULT (POST /api/dev/fault on
               a third boot that keeps serving degraded: every surface's run is held at once, and the station's own
               containment ends them all; the station then answers only /api/health and /api/diagnostics, so the rows are
               read from runs.jsonl and the dev hub's reply from the fault host's witness, and the chat's notice must name
               the station's fault, never an E-STOP nobody pressed).
   For each cell, on the run's id (named by the fault host, which sees the run's own turn):
     - its OWN sink carries exactly one agent.run.start and one agent.run.end, the end stamped with its outcome (read where
       the surface hands it out: the COMMS, Run Now and line streams; every other surface's own sink forwards its run to the
       station floor, read below);
     - on the station floor its starts and ends balance (one and one, or none for a run that never started) and every end is
       stamped;
     - it wrote exactly one history row; a row of a run that threw after a priced call books at least what its stream booked,
       with usageMissing (spendUnknown only when nothing was booked), and a run that threw before any call stays a known $0;
       a stopped run's row and its end say cancelled;
     - afterwards the run table is empty.
   GOLDEN refusals (a second boot, STARNET_MAX_CONCURRENT_AGENTS=1): concurrency_limit (a run of another agent held at the
   provider) and model_no_tools (a model the catalog lists without tools) reach COMMS byte for byte as the base triple. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { allocatePort, allocatePorts } = require('./helpers/ports.js');
const { sseQuery } = require('./_httpToken.js');
const Phone = require('../relay/app/phone-client.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const HOST = '127.0.0.1';
const V1KEY = 'rt-lifecycle-v1-key-0123456789abcdef0123456789abcdef';
const PRICE = 5 * 0.00001 + 3 * 0.00003;   // one call of the mock: 5 prompt tokens at $0.00001, 3 completion tokens at $0.00003
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(60); }
  throw new Error('timed out waiting for ' + label);
}
const within = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error('timed out waiting for ' + label); })]);
const userTexts = body => (body.messages || []).filter(m => m && m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
const lastUserText = body => { const u = userTexts(body); return u.length ? u[u.length - 1] : ''; };
const ndjson = text => String(text || '').split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(e => e && e.name);

/* THE MODEL. Every request is answered at once with a priced reply, except: a request whose run's own turn carries a mark the cell
   made a PROVIDER ERROR is refused (HTTP 400, a call the loop ends on); a line's first stage, told its seed, answers with the hop's
   mark so the hop carries it; and a HOLD (the golden concurrency cell) is left open until released. */
function startModel() {
  let failing = '';   // the CURRENT cell's provider-error mark only: a later run's context quotes earlier runs' titles (RECENT ACTIVITY)
  const holds = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'test/model', context_length: 32000, pricing: { prompt: '0.00001', completion: '0.00003' }, supported_parameters: ['tools'] },
        { id: 'test/notools', context_length: 32000, pricing: { prompt: '0.00001', completion: '0.00003' }, supported_parameters: [] }
      ] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const last = lastUserText(body);
      const tooled = Array.isArray(body.tools) && body.tools.length > 0;
      const said = userTexts(body);   // a loop iteration composes its own turns around its objective
      const hold = tooled && holds.find(h => !h.res && said.some(t => t.includes(h.mark)));
      if (hold) { res.on('error', () => {}); hold.res = res; hold.waiters.splice(0).forEach(w => w()); return; }
      if (failing && last.includes(failing)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'the provider refused this request (invalid request parameters)', code: 400 } }));
      }
      const seed = /LINE-START seed-(\w+)/.exec(last);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: seed ? 'HOP-PAYLOAD RLM' + seed[1] + ' gathered for the writer' : 'Done.' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({
    server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1',
    fail(mark) { failing = mark || ''; },
    hold(mark) { const h = { mark, res: null, waiters: [] }; holds.push(h); return () => within(h.res ? Promise.resolve() : new Promise(r => h.waiters.push(r)), 30000, 'the held run to reach the provider'); },
    release() {
      for (const h of holds) {
        if (!h.res || h.res.writableEnded) continue;
        try {
          h.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          h.res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] }) + '\n\n');
          h.res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n');
        } catch (_) {}
      }
    }
  })));
}

// the station floor: every event the live feed carries (a line deploy folds through the page, so the feed acks it as the page would)
function watchFloor(fx) {
  const ac = new AbortController(), events = [];
  const ready = fetch(fx.baseUrl + '/api/channels/events?' + sseQuery(fx.token), { signal: ac.signal }).then(res => {
    (async () => {
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let ev = null; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) {}
            if (!ev || !ev.name) continue;
            events.push(ev);
            if (ev.name === 'station.command') await fx.json('POST', '/api/station/ack', { id: ev.payload.id, ok: true, result: { folded: true } });
          }
        }
      } catch (_) { /* the feed closes at the end */ }
    })();
  });
  return { events, ready, close: () => ac.abort() };
}
const of = (events, name, runId) => events.filter(e => e.name === name && e.payload && String(e.payload.runId) === String(runId));
const costOf = (events, runId) => of(events, 'agent.cost', runId).reduce((s, e) => s + (Number(e.payload.usd) || 0), 0);

function boot(model, extraEnv, lanPort) {
  let firstPort = null;
  return SidecarFixture.create({ prefix: 'sk-run-lifecycle-', entry: path.join(__dirname, 'helpers', 'run-fault-host.cjs'),
    portAllocator: () => { const p = firstPort; firstPort = 0; return p ? Promise.resolve(p) : allocatePort(); },
    env: Object.assign({
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-run-lifecycle-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-run-lifecycle-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      SKYNET_V1_MODEL: 'test/model', STARNET_V1_MODEL: 'test/model',
      SKYNET_API_KEY: V1KEY, STARNET_API_KEY: V1KEY,
      SKYNET_DEV: '1',                                     // the dev channel hub (POST /api/dev/inbound): the production makeChannelHub
      SKYNET_CRON_TICK_MS: '250', STARNET_CRON_TICK_MS: '250',
      SKYNET_LOOP_TICK_MS: '5000',                         // the loop tick's floor
      SKYNET_FULL_ACCESS: '1'
    }, lanPort ? { STARNET_REMOTE_PORT: String(lanPort), STARNET_REMOTE_LAN: '1', STARNET_REMOTE_RELAY: 'off' } : {}, extraEnv || {}) });
}
const ROSTER = [
  { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You coordinate work.' },
  { agentId: 'forge', name: 'FORGE', model: 'test/model', provider: 'openrouter', system: 'You are FORGE, a builder.' },
  { agentId: 'mira', name: 'Mira', model: 'test/model', provider: 'openrouter', system: 'You research.' },
  { agentId: 'gagent', name: 'Groupie', model: 'test/model', provider: 'openrouter', approvalMode: 'full', system: 'You answer in a group.' },
  { agentId: 'research-agent', name: 'Research', model: 'test/model', provider: 'openrouter', system: 'You research.' },
  { agentId: 'writer-agent', name: 'Writer', model: 'test/model', provider: 'openrouter', system: 'You write.' }
];

// one boot's helpers: the fault host's control and its log, the run history, the run table, and each surface's door
function bind(fx) {
  const B = fx.baseUrl;
  const logOf = file => { try { return fs.readFileSync(path.join(fx.workspace, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  return {
    ctl: m => fs.writeFileSync(path.join(fx.workspace, 'run-fault.json'), JSON.stringify(m || {})),
    faulted: mark => logOf('run-fault.log').find(r => r.mark === mark) || null,
    replies: chatId => logOf('run-fault-replies.log').filter(r => r.chatId === chatId).map(r => r.text),
    rowsOf: async runId => ((await fx.json('GET', '/api/runs?agent=*&runId=' + encodeURIComponent(runId))).body.runs || []),
    liveRuns: async () => { const d = await fx.json('GET', '/api/diagnostics'); const rt = d.body && d.body.report && d.body.report.runTable; return rt ? rt.live : -1; },
    desk: (streamId, text, agentId, extra) => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ provider: 'openrouter', model: 'test/model', agentId: agentId || 'forge', streamId, isTask: true, messages: [{ role: 'user', content: text }] }, extra || {})) })
      .then(r => r.text()).catch(e => 'ERR ' + e.message),
    v1: (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + V1KEY }, body: JSON.stringify(body) }),
    press: id => fx.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.text()),
    groups: b => fx.json('POST', '/api/groups', b).then(r => r.body && r.body.result)
  };
}
// the crew, a group session, the two-stage line and the phone pairing every cell of theirs reuses
async function setup(fx, lanPort, label) {
  const { groups } = bind(fx);
  A.eq((await fx.json('POST', '/api/roster', { updatedAt: Date.now(), agents: ROSTER })).status, 200, label + ': the crew roster is saved');
  const group = await groups({ op: 'create', members: ['gagent'], title: 'Run lifecycle group' });
  A.ok(group && group.id, label + ': a group session');
  const belt = (x, y, dir) => ({ x, y, dir });
  await publishFloor(fx, floorOf({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
      { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' }, { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  }), { label: label + ': the two-stage line' });
  A.eq((await fx.json('POST', '/api/remote/enable', { on: true })).body.enabled, true, label + ': Remote switched on');
  const pr = await fx.json('POST', '/api/remote/pair', { name: 'RL phone' });
  const key = await Phone.makeDeviceKey();
  const paired = await Phone.pair({ base: 'http://' + HOST + ':' + lanPort, pairingId: pr.body.pairingId, code: pr.body.code, name: 'RL phone', key });
  const phone = Phone.connect({ base: 'http://' + HOST + ':' + lanPort, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key });
  return { group, phone };
}
// a run's history rows as runs.jsonl holds them (read from disk: a faulted station answers no /api/runs)
function rowsOnDisk(fx, runId) {
  try {
    return fs.readFileSync(path.join(fx.workspace, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && r.runId === runId && !r.kind && typeof r.reason === 'string');
  } catch (_) { return []; }
}

(async () => {
  const model = await startModel();
  const [lanPort] = await allocatePorts(1);
  const fx = boot(model, null, lanPort);
  let floor = null, phone = null;
  const cellTimes = [];
  try {
    await fx.start();
    const B = fx.baseUrl;
    floor = watchFloor(fx);
    await floor.ready;
    const { ctl, faulted, rowsOf, liveRuns, desk, v1, press, groups } = bind(fx);
    let group = null;
    ({ group, phone } = await setup(fx, lanPort, 'matrix'));

    /* THE SURFACES. Each starts its run with the cell's mark in the run's own turn and resolves with the run's own sink where the
       surface hands it out ({ own: events }), else { own: null } (its own sink forwards to the floor, which every cell reads). */
    const SURFACES = {
      comms: async mark => ({ own: ndjson(await desk('rl-' + mark, mark + ' answer this')) }),
      runNow: async mark => {
        const job = (await fx.json('POST', '/api/cron', { name: 'RL ' + mark, prompt: mark + ' run me by hand', schedule: 'every 1h', agentId: 'forge', model: 'test/model', provider: 'openrouter' })).body.job;
        const own = ndjson(await press(job.id));
        await fx.json('POST', '/api/cron/remove', { id: job.id });
        return { own };
      },
      scheduled: async mark => {
        const job = (await fx.json('POST', '/api/cron', { name: 'RL ' + mark, prompt: mark + ' fire on time', schedule: 'in 1s', agentId: 'forge', model: 'test/model', provider: 'openrouter' })).body.job;
        await fx.json('POST', '/api/cron/arm', { enabled: true });
        try { await until(async () => { const f = faulted(mark); return f && (await rowsOf(f.runId)).length > 0; }, 20000, 'the scheduled fire to run'); }
        finally { await fx.json('POST', '/api/cron/arm', { enabled: false }); await fx.json('POST', '/api/cron/remove', { id: job.id }); }
        return { own: null };
      },
      v1sync: async mark => { await (await v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: mark + ' answer' }] })).text(); return { own: null }; },
      v1stream: async mark => { await (await v1('/v1/chat/completions', { model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: mark + ' answer' }] })).text(); return { own: null }; },
      v1runs: async mark => {
        const j = await (await v1('/v1/runs', { model: 'starnet-agent', input: mark + ' answer' })).json();
        await until(async () => { const s = await (await fetch(B + '/v1/runs/' + j.run_id, { headers: { Authorization: 'Bearer ' + V1KEY } })).json(); return !/^(queued|running|stopping)$/.test(String(s.status)); }, 20000, 'the /v1/runs run to settle');
        return { own: null };
      },
      hub: async mark => { await fx.json('POST', '/api/dev/inbound', { text: mark + ' answer this', chatId: 'rl' + mark.slice(-8) }); return { own: null }; },
      group: async mark => {   // the send queues the turn; the turn runs after it answers (resume: an earlier cell's E-STOP paused the group)
        await groups({ op: 'send', id: group.id, key: 'rl-' + mark, text: mark + ' answer the group', resume: true });
        await until(async () => { const f = faulted(mark); return f && (await rowsOf(f.runId)).length > 0; }, 20000, 'the group turn to run');
        return { own: null };
      },
      hop: async mark => {
        const job = (await fx.json('POST', '/api/cron', { name: 'RL line ' + mark, prompt: 'LINE-START seed-' + mark.slice(3) + ' gather the news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter', runsLine: true })).body.job;
        const own = ndjson(await press(job.id));
        await fx.json('POST', '/api/cron/remove', { id: job.id });
        return { own };
      },
      loop: async mark => {
        const lp = (await fx.json('POST', '/api/loops', { name: 'RL ' + mark, objective: mark + ' keep iterating', model: 'test/model', provider: 'openrouter' })).body.loop;
        try { await until(async () => { const f = faulted(mark); return f && (await rowsOf(f.runId)).length > 0; }, 30000, 'the loop iteration to run'); }
        finally { await fx.json('POST', '/api/loops/control', { id: lp.id, action: 'stop' }); }
        return { own: null };
      },
      phone: async mark => {
        await phone.call('send', { agentId: 'forge', text: mark + ' answer from the phone' });
        await until(async () => { const f = faulted(mark); return f && (await rowsOf(f.runId)).length > 0; }, 20000, 'the phone task to run');
        return { own: null };
      }
    };
    const FAULTS = { tbs: 'throw-before-start', tas: 'throw-after-start', tac: 'throw-after-cost', perr: 'provider-error', sbi: 'stop-by-id', est: 'estop' };
    const THROWS = new Set(['throw-before-start', 'throw-after-start', 'throw-after-cost']);
    const STOPS = new Set(['stop-by-id', 'estop']);
    // (S3) a run held at the provider, then stopped: by its id through POST /api/cancel, or by E-STOP (RESUMEd after the cell)
    async function stopHeld(cell, fault, mark, reached) {
      await reached();
      const f = await until(() => faulted(mark), 5000, cell + ': its run named');
      if (fault === 'stop-by-id') {
        const r = await fx.json('POST', '/api/cancel', { runId: f.runId });
        A.eq(r.body, { ok: true, stopped: true }, cell + ': POST /api/cancel by its id stops it');
        return;
      }
      const h = await fx.json('POST', '/api/halt', {});
      const b = h.body || {};
      A.ok(h.status === 200 && (b.halted + b.cronAborted + b.loopAborted) >= 1, cell + ': E-STOP reached it (' + JSON.stringify({ halted: b.halted, cronAborted: b.cronAborted, loopAborted: b.loopAborted }) + ')');
    }

    const only = String(process.env.RL_ONLY || '').split(',').filter(Boolean);   // a debugging aid: RL_ONLY=hop,group runs those surfaces alone
    const onlyFaults = String(process.env.RL_FAULTS || '').split(',').filter(Boolean);   // and RL_FAULTS=sbi,est those faults alone
    for (const surface of Object.keys(SURFACES).filter(s => !only.length || only.includes(s))) {
      for (const code of Object.keys(FAULTS).filter(c => !onlyFaults.length || onlyFaults.includes(c))) {
        const fault = FAULTS[code];
        const mark = 'RLM' + surface + 'x' + code;
        const cell = surface + ' x ' + fault;
        const t0 = Date.now();
        let reached = null;
        if (fault === 'provider-error') { model.fail(mark); ctl({ mode: 'tag', mark }); }
        else if (STOPS.has(fault)) { ctl({ mode: 'tag', mark }); reached = model.hold(mark); }
        else ctl({ mode: fault, mark });
        let own = null;
        try {
          const ran = SURFACES[surface](mark);
          ran.catch(() => {});   // awaited below, after the stop
          if (reached) await stopHeld(cell, fault, mark, reached);
          own = (await within(ran, 45000, cell)).own;
        } catch (e) { A.ok(false, cell + ': the surface ran (' + (e && e.message) + ')'); }
        if (fault === 'estop') {
          const back = await fx.json('POST', '/api/halt/resume', { confirm: true });
          A.eq(back.status, 200, cell + ': RESUME lifts the E-STOP for the next cell');
        }
        const f = faulted(mark);
        A.ok(f && f.runId, cell + ': the fault host saw the run\'s own turn');
        if (!f || !f.runId) { ctl({}); model.fail(null); continue; }
        const runId = f.runId;
        // the run is over once its row is written and its floor (and own sink) settle; a run left open times out here and is reported
        let rows = [];
        try { await until(async () => { rows = await rowsOf(runId); return rows.length > 0; }, 20000, cell + ' row'); } catch (_) {}
        try { await until(() => of(floor.events, 'agent.run.start', runId).length === of(floor.events, 'agent.run.end', runId).length, 3000, cell + ' floor'); } catch (_) {}
        ctl({}); model.fail(null);
        if (own) {
          const starts = of(own, 'agent.run.start', runId), ends = of(own, 'agent.run.end', runId);
          A.eq([starts.length, ends.length], [1, 1], cell + ': its own stream carries exactly one start and one end (' + JSON.stringify(own.filter(e => e.payload && e.payload.runId === runId).map(e => e.name)) + ')');
          A.ok(ends.every(e => typeof e.payload.outcome === 'string'), cell + ': the end on its own stream is stamped with its outcome');
          if (STOPS.has(fault)) A.ok(ends.every(e => e.payload.reason === 'cancelled'), cell + ': and says the run was stopped (cancelled)');
        }
        const fs0 = of(floor.events, 'agent.run.start', runId).length, fe0 = of(floor.events, 'agent.run.end', runId).length;
        A.ok(fs0 === fe0 && fs0 <= 1, cell + ': on the floor its starts and ends balance (start=' + fs0 + ' end=' + fe0 + ')');
        A.ok(of(floor.events, 'agent.run.end', runId).every(e => typeof e.payload.outcome === 'string'), cell + ': every end on the floor is stamped');
        A.eq(rows.length, 1, cell + ': it wrote exactly one history row');
        const row = rows[0] || {};
        if (fault === 'throw-after-cost') {
          const streamed = Math.max(costOf(floor.events, runId), own ? costOf(own, runId) : 0, PRICE);
          A.ok(row.usd >= streamed - 1e-12 && row.usageMissing === true && !row.spendUnknown,
            cell + ': its row books at least what its stream booked ($' + streamed + '), with usageMissing (got ' + JSON.stringify({ usd: row.usd, usageMissing: row.usageMissing, spendUnknown: row.spendUnknown }) + ')');
        } else if (THROWS.has(fault)) {
          A.ok(row.usd === 0 && !row.usageMissing && !row.spendUnknown, cell + ': a run that threw before any provider call stays a known $0 (got ' + JSON.stringify({ usd: row.usd, usageMissing: row.usageMissing, spendUnknown: row.spendUnknown }) + ')');
        }
        if (THROWS.has(fault)) A.eq([row.outcome, row.failureCode], ['failed', 'no_terminal_outcome'], cell + ': its row says nothing proved how it ended');
        if (STOPS.has(fault)) A.eq([row.reason, row.outcome], ['cancelled', 'stopped'], cell + ': its row says it was stopped');
        let live = -1;
        try { await until(async () => { live = await liveRuns(); return live === 0 || live === -1; }, 10000, cell + ' table'); } catch (_) {}   // -1: a station without the table
        A.eq(live, 0, cell + ': afterwards the run table is empty');
        cellTimes.push(cell + ' ' + (Date.now() - t0) + 'ms');
      }
    }
    const swallowed = (((await fx.json('GET', '/api/diagnostics')).body.report.swallowed || {}).tags || []).map(t => t.tag);
    A.eq(swallowed.filter(t => /^runtable\./.test(t)), [], 'no run-table bookkeeping fault was swallowed (no duplicate start or end was ever dropped)');
  } catch (e) {
    A.ok(false, 'run-lifecycle matrix threw: ' + (e && e.stack || e) + '\n--- sidecar output (tail) ---\n' + fx.output().slice(-4000));
  } finally {
    try { if (phone) phone.close(); } catch (_) {}
    try { if (floor) floor.close(); } catch (_) {}
    await fx.dispose();
  }
  if (process.env.RL_TIMES) console.log(cellTimes.join('\n'));

  /* ---- (S3) PROCESS FAULT: every surface's run held at once, then the station's own containment (POST /api/dev/fault) ends each
     once. A third boot that keeps serving degraded (UNCAUGHT_KEEP_SERVING, the test opt-out), since a faulted station refuses
     every request but /api/health and /api/diagnostics: each run is read on the streams already open (its own, the floor), its
     row in runs.jsonl, the chat's notice in the fault host's witness, and the run table in GET /api/diagnostics. ---- */
  const wanted = String(process.env.RL_FAULTS || '').split(',').filter(Boolean);
  if (!process.env.RL_ONLY && (!wanted.length || wanted.includes('pf'))) {
    const [faultLan] = await allocatePorts(1);
    const px = boot(model, { STARNET_UNCAUGHT_KEEP_SERVING: '1', SKYNET_UNCAUGHT_KEEP_SERVING: '1' }, faultLan);
    let pfloor = null, pphone = null;
    try {
      await px.start();
      pfloor = watchFloor(px);
      await pfloor.ready;
      const P = bind(px);
      let pgroup = null;
      ({ group: pgroup, phone: pphone } = await setup(px, faultLan, 'fault'));
      const marks = { comms: 'RLFcomms', runNow: 'RLFrunnow', scheduled: 'RLFsched', v1sync: 'RLFv1sync', v1stream: 'RLFv1stream', v1runs: 'RLFv1runs',
        hub: 'RLFhub', group: 'RLFgroup', hop: 'RLMfhop', loop: 'RLFloop', phone: 'RLFphone' };   // the hop's mark is what its first stage hands on
      P.ctl({ mode: 'tag', marks: Object.values(marks) });
      const reached = {};
      for (const s of Object.keys(marks)) reached[s] = model.hold(marks[s]);
      const job = async (name, prompt, agentId, extra) => (await px.json('POST', '/api/cron', Object.assign({ name, prompt, schedule: 'every 1h', agentId, model: 'test/model', provider: 'openrouter' }, extra || {}))).body.job;
      const own = {
        comms: P.desk('rf-comms', marks.comms + ' answer this').then(ndjson),
        runNow: job('RF run now', marks.runNow + ' run me by hand', 'forge').then(j => P.press(j.id)).then(ndjson),
        hop: job('RF line', 'LINE-START seed-fhop gather the news', 'research-agent', { runsLine: true }).then(j => P.press(j.id)).then(ndjson)
      };
      for (const s of Object.keys(own)) own[s].catch(() => {});
      await job('RF scheduled', marks.scheduled + ' fire on time', 'mira', { schedule: 'in 1s' });
      await px.json('POST', '/api/cron/arm', { enabled: true });
      const settle = [
        P.v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: marks.v1sync + ' answer' }] }).then(r => r.text()),
        P.v1('/v1/chat/completions', { model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: marks.v1stream + ' answer' }] }).then(r => r.text()),
        px.json('POST', '/api/dev/inbound', { text: marks.hub + ' answer this', chatId: 'rfhub' })
      ].map(p => p.catch(e => 'ERR ' + e.message));
      await P.v1('/v1/runs', { model: 'starnet-agent', input: marks.v1runs + ' answer' });
      await P.groups({ op: 'send', id: pgroup.id, key: 'rf-group', text: marks.group + ' answer the group', resume: true });
      await px.json('POST', '/api/loops', { name: 'RF loop', objective: marks.loop + ' keep iterating', model: 'test/model', provider: 'openrouter' });
      await pphone.call('send', { agentId: 'forge', text: marks.phone + ' answer from the phone' });
      for (const s of Object.keys(marks)) { try { await reached[s](); } catch (e) { A.ok(false, 'fault: the ' + s + ' run reached the provider (' + e.message + ')'); } }
      const ids = {};
      for (const s of Object.keys(marks)) ids[s] = (P.faulted(marks[s]) || {}).runId || '';
      A.ok(Object.values(ids).every(Boolean), 'fault: the fault host named every held run ' + JSON.stringify(ids));
      const before = await P.liveRuns();
      A.ok(before >= Object.keys(marks).length, 'fault: the run table holds every held run (live ' + before + ')');
      const raised = await px.json('POST', '/api/dev/fault', {});
      A.eq(raised.status, 202, 'fault: POST /api/dev/fault raises the station\'s own fault');
      const ofP = (name, id) => pfloor.events.filter(e => e.name === name && e.payload && String(e.payload.runId) === String(id));
      for (const s of Object.keys(marks)) {
        if (!ids[s]) continue;
        try { await until(() => rowsOnDisk(px, ids[s]).length > 0, 20000, s + ' row'); } catch (_) {}
        try { await until(() => ofP('agent.run.start', ids[s]).length === ofP('agent.run.end', ids[s]).length, 5000, s + ' floor'); } catch (_) {}
      }
      const owns = {};
      for (const s of Object.keys(own)) { try { owns[s] = await within(own[s], 30000, s + ' stream'); } catch (e) { A.ok(false, 'fault: the ' + s + ' stream ended (' + e.message + ')'); } }
      await Promise.all(settle);
      for (const s of Object.keys(marks)) {
        const id = ids[s], cell = s + ' x process-fault';
        if (!id) continue;
        if (owns[s]) {
          const starts = of(owns[s], 'agent.run.start', id), ends = of(owns[s], 'agent.run.end', id);
          A.eq([starts.length, ends.length], [1, 1], cell + ': its own stream carries exactly one start and one end');
          A.ok(ends.every(e => typeof e.payload.outcome === 'string' && e.payload.reason === 'cancelled'), cell + ': stamped, and stopped (cancelled)');
        }
        const fs0 = ofP('agent.run.start', id).length, fe0 = ofP('agent.run.end', id).length;
        A.ok(fs0 === fe0 && fs0 <= 1, cell + ': on the floor its starts and ends balance (start=' + fs0 + ' end=' + fe0 + ')');
        A.ok(ofP('agent.run.end', id).every(e => typeof e.payload.outcome === 'string'), cell + ': every end on the floor is stamped');
        const rows = rowsOnDisk(px, id);
        A.eq(rows.length, 1, cell + ': it wrote exactly one history row');
        A.eq((rows[0] || {}).reason, 'cancelled', cell + ': its row says it was stopped');
      }
      let notice = null;
      try { notice = await until(() => P.replies('rfhub').find(t => /^⏹ Stopped/.test(t)), 10000, 'the chat\'s stop notice'); } catch (_) {}
      A.ok(notice && /the station hit an internal fault/.test(notice) && !/E-STOP/.test(notice), 'fault: the chat\'s stop notice names the station\'s fault, never an E-STOP nobody pressed (' + JSON.stringify(P.replies('rfhub')).slice(0, 300) + ')');
      let live = -1;
      try { await until(async () => { live = await P.liveRuns(); return live === 0; }, 10000, 'the fault boot\'s table'); } catch (_) {}
      A.eq(live, 0, 'fault: afterwards the run table is empty');
    } catch (e) {
      A.ok(false, 'run-lifecycle process-fault threw: ' + (e && e.stack || e) + '\n--- sidecar output (tail) ---\n' + px.output().slice(-4000));
    } finally {
      try { if (pphone) pphone.close(); } catch (_) {}
      try { if (pfloor) pfloor.close(); } catch (_) {}
      model.release();
      await px.dispose();
    }
  }

  /* ---- GOLDEN refusals, byte for byte the base triples, on a station that admits one agent at a time ---- */
  const gx = boot(model, { STARNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_MAX_CONCURRENT_AGENTS: '1' });
  try {
    await gx.start();
    A.eq((await gx.json('POST', '/api/roster', { updatedAt: Date.now(), agents: ROSTER })).status, 200, 'golden: the crew roster is saved');
    const desk = (streamId, text, agentId, modelId) => gx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: modelId || 'test/model', agentId, streamId, isTask: true, messages: [{ role: 'user', content: text }] }) }).then(r => r.text());
    const triple = (events, runId) => events.filter(e => e.payload && e.payload.runId === runId && /^agent\.run\.(start|error|end)$/.test(e.name)).map(e => [e.name, e.payload]);
    // the base wrote { agentId, runId, trigger, model, ...runStartExtra }: a COMMS run's extra is its conversation and the C5 station-minted turn (streamId, turnId)
    const base = (runId, agentId, modelId, error, streamId) => [
      ['agent.run.start', { agentId, runId, trigger: 'directive', model: modelId, streamId, turnId: 'r' + runId }],
      ['agent.run.error', error],
      ['agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0, outcome: 'failed', failureCode: error.failureCode }]
    ];
    // concurrency_limit: FORGE's run is held at the provider, so Mira's is a new distinct agent over the limit of one
    const held = model.hold('RLGOLD-HELD');
    const first = desk('rl-gold-held', 'RLGOLD-HELD keep working', 'forge');
    await held();
    const refused = ndjson(await desk('rl-gold-refused', 'RLGOLD-REFUSED answer', 'mira'));
    const rid = ((refused.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
    A.ok(rid, 'golden concurrency_limit: the refused run started on its stream');
    A.eq(JSON.stringify(triple(refused, rid)), JSON.stringify(base(rid, 'mira', 'test/model', { agentId: 'mira', runId: rid, transient: true,
      message: 'Too many agents are working at once (limit 1). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.', failureCode: 'concurrency_limit' }, 'rl-gold-refused')),
      'golden concurrency_limit: the refusal reaches COMMS byte for byte as the base triple');
    model.release();
    await within(first, 30000, 'the held run to finish');
    // model_no_tools: a task on a model the catalog lists without tools
    const noTools = ndjson(await desk('rl-gold-notools', 'RLGOLD-NOTOOLS do a task', 'forge', 'test/notools'));
    const nid = ((noTools.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
    A.ok(nid, 'golden model_no_tools: the refused run started on its stream');
    A.eq(JSON.stringify(triple(noTools, nid)), JSON.stringify(base(nid, 'forge', 'test/notools', { agentId: 'forge', runId: nid, transient: false,
      message: 'The model "test/notools" does not support tool calls, so it can\'t run tasks. Pick a tool-capable model (e.g. anthropic/claude-sonnet-4.6 or openai/gpt-4o) on the connect screen.', failureCode: 'model_no_tools' }, 'rl-gold-notools')),
      'golden model_no_tools: the refusal reaches COMMS byte for byte as the base triple');
  } catch (e) {
    A.ok(false, 'run-lifecycle golden threw: ' + (e && e.stack || e) + '\n--- sidecar output (tail) ---\n' + gx.output().slice(-4000));
  } finally {
    model.release();
    await gx.dispose();
    await new Promise(r => model.server.close(r));
  }
  A.report('run-lifecycle.invariants.http.test');
})().catch(e => { console.log('FAIL: run-lifecycle.invariants.http.test threw - ' + (e && e.stack || e)); process.exit(1); });
