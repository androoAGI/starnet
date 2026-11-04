/* node test/run-registry-coverage.http.test.js — EVERY LIVE RUN IS IN THE ONE REGISTRY (run-table lane, sidecar/run-table.js).

   The station kept its live runs in four host maps (runs, runsMeta, hostLiveRuns, runStopHandles), the hubs' inflight records
   and the subagent manager's view, and every reader hand-listed the ones it knew: a /v1 run held at the provider was in no
   snapshot source at 0b8441064. The run table is the one registry those readers move onto. Before any reader may, the table must
   be a proven SUPERSET of the registries it replaces, and it must empty on every exit, or the update drain's count sticks.

   This boots the REAL sidecar (test/helpers/run-fault-host.cjs: the production wiring, with a fault armed only by the two fault
   cells) against a mock model at the HTTP edge, then holds one run of each surface at the provider and reads GET
   /api/diagnostics, whose runTable names every run id the older registries hold that the table does not:
     S1 cells — COMMS (/api/run), a run QUEUED behind its conversation (then stopped while queued), Run Now, a scheduled fire,
     /v1 chat (sync and stream), /v1/runs, the dev channel hub, a group session turn, a line hop, a loop iteration, a phone task
     (the real relay/app/phone-client.js pairing), a background worker, the overseer's review (the one run that drives the run
     core without runOnce) and a force-fired night-shift beat (an id that spans the runs it drives, as Run Now's spans its
     line): while held, missing is empty, the older registries really hold the run (legacy >= 1, so the check is not vacuous)
     and the table holds it (live >= held); once the run ends, the table is empty again;
     release on every exit — a throw inside the run (after its start) and a throw in the conversation queue (before it runs)
     each leave the table empty, as does the stop of a queued run.
   The pasted report says it too: its text carries the "Live runs:" line.

   S3 cells — EVERY LIVE RUN IS IN THE ONE REGISTRY, and its readers read it. While each run above is held (its id named by the
   fault host's tag), GET /api/state/snapshot lists it, stoppable unless a manager owns its stop (the background worker's), the
   phone's status lists it (the real phone-client pairing), the update drain counts it (POST /api/update/prepare refuses with
   UPDATE_RUNS_ACTIVE), and POST /api/cancel by its id ends it (stopped:true; the queued turn included); afterwards the snapshot
   lists none. At 0b8441064 a /v1 run and the dev hub's were in no snapshot source, and the phone missed every hub, /v1 and
   background-worker run. Then ESTOP-STOPS-V1: COMMS, the dev hub and /v1 chat (sync and stream) and /v1/runs held at once,
   one E-STOP: halted counts each exactly once (COMMS by `runs`, the hub by its own record, the three /v1 runs, which no owner
   kill reaches, by the run table), each ends cancelled once (finish_reason cancelled on chat, /v1/runs status cancelled, one
   start and one end on the floor), the chat is told E-STOP was pressed, and the snapshot and the table are empty after. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { allocatePort, allocatePorts } = require('./helpers/ports.js');
const { sseQuery } = require('./_httpToken.js');
const { userWords } = require('./helpers/host-notes.js');
const Phone = require('../relay/app/phone-client.js');
const { floorOf, emptyFloor, seedSavedFloor, publishFloor } = require('./helpers/saved-floor.js');

const HOST = '127.0.0.1';
const V1KEY = 'rt-coverage-v1-key-0123456789abcdef0123456789abcdef';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(60); }
  throw new Error('timed out waiting for ' + label);
}
const within = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error('timed out waiting for ' + label); })]);

/* THE MODEL. A cell names the one request to HOLD (left open: its run is live at the provider) until the cell finishes it with an
   ordinary reply. Only a run's own requests carry tools, so a tool-less call (classification, titles) is never mistaken for one.
   Every other request gets the scripted reply its conversation needs. */
function startModel() {
  const holds = [];
  const seen = [];
  const userWordsOf = body => (body.messages || []).filter(m => m && m.role === 'user').map(m => userWords(m)).filter(w => w && w.trim());
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const messages = body.messages || [];
      const tooled = Array.isArray(body.tools) && body.tools.length > 0;
      const words = userWordsOf(body);
      const last = words.length ? words[words.length - 1] : '';
      if (tooled) seen.push(words.join('\n'));
      const hold = holds.find(h => !h.res && (tooled || h.toolless) && h.test(last, words, body));
      if (hold) { res.on('error', () => {}); hold.res = res; hold.waiters.splice(0).forEach(w => w()); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const said = (content) => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      const call = (name, args) => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: name + '_' + seen.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      if (!tooled) return said('Ready.');
      // scripts read the LAST thing the user side said (a review's or a hop's job is its own last turn, never an earlier one)
      // the background-worker lead: settle its Task Brief, spawn one watchable background worker, then answer
      if (words.some(w => w.includes('SPAWN-BG')) && !/^Review the background work/.test(last)) {
        const made = messages.filter(m => m && m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        if (!made.includes('brief_proceed')) return call('brief_proceed', { objective: 'Start a background helper', deliverable: 'A running background helper' });
        if (!made.includes('team_spawn')) return call('team_spawn', { tasks: [{ prompt: 'BG-WORK keep working until you are released', label: 'rt-bg' }], background: true });
        return said('background worker started');
      }
      // a line's first stage: its output is the hop's job
      if (last.includes('LINE-START')) return said('HOP-PAYLOAD gathered for the writer');
      // the overseer's lead (test/helpers/overseer-provider.js's default path): brief, a working session, a background dispatch
      if (last.includes('WORKER_PROOF')) return said('WORKER_FINDINGS: two verified observations.');
      if (last.includes('OVERSEER-CELL') || last.includes('FOREGROUND-CELL')) {
        const lastUserIndex = messages.map(m => m && m.role).lastIndexOf('user');
        const calls = messages.slice(lastUserIndex + 1).filter(m => m && m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        const system = messages.filter(m => m && m.role === 'system').map(m => m.content).join('\n');
        const crew = system.match(/^  - ([A-Za-z0-9_-]+) \(/m);
        const workerId = crew ? crew[1] : 'mira_custom';
        if (!calls.includes('brief_proceed')) return call('brief_proceed', { objective: 'Delegate research and review the findings', deliverable: 'Research findings' });
        if (!calls.includes('session_create')) return call('session_create', { title: 'Research proof', agentId: workerId });
        if (!calls.includes('team_dispatch')) return call('team_dispatch', { workers: [{ agentId: workerId, session: 'Research proof', prompt: last.includes('FOREGROUND-CELL') ? 'FG-WORKER_PROOF: return two findings' : 'WORKER_PROOF: return two findings' }], background: !last.includes('FOREGROUND-CELL') });
        return said('Research started. You can keep talking here.');
      }
      return said('Done.');
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({
    server, seen,
    base: 'http://' + HOST + ':' + server.address().port + '/api/v1',
    hold(name, test, toolless) { holds.push({ name, test, toolless: !!toolless, res: null, waiters: [] }); },   // toolless: a reason-only run (the night shift's)
    held(name, ms) {
      const h = holds.find(x => x.name === name);
      return within(h.res ? Promise.resolve() : new Promise(r => h.waiters.push(r)), ms || 30000, 'the ' + name + ' run to reach the provider');
    },
    finish(name, content) {
      const h = holds.find(x => x.name === name);
      const res = h && h.res;
      if (!res || res.writableEnded || res.destroyed) return;
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content || 'Done.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (_) { /* its run already went (a stop closed the socket) */ }
    },
    closeAll() { for (const h of holds) { try { if (h.res && !h.res.writableEnded) h.res.destroy(); } catch (_) {} } }
  })));
}

(async () => {
  const model = await startModel();
  const [sidecarPort, lanPort] = await allocatePorts(2);
  let firstPort = sidecarPort;
  const fx = SidecarFixture.create({ prefix: 'sk-run-registry-', entry: path.join(__dirname, 'helpers', 'run-fault-host.cjs'),
    portAllocator: () => { const p = firstPort; firstPort = 0; return p ? Promise.resolve(p) : allocatePort(); },
    env: {
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-run-registry-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-run-registry-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      SKYNET_V1_MODEL: 'test/model', STARNET_V1_MODEL: 'test/model',
      SKYNET_API_KEY: V1KEY, STARNET_API_KEY: V1KEY,
      SKYNET_DEV: '1',                                     // the dev channel hub (POST /api/dev/inbound): the production makeChannelHub
      SKYNET_CRON_TICK_MS: '250', STARNET_CRON_TICK_MS: '250',
      SKYNET_LOOP_TICK_MS: '5000',                         // the loop tick's floor
      SKYNET_FULL_ACCESS: '1',                             // team.spawn / dispatch are consent-gated; the approval path has its own suites
      STARNET_REMOTE_PORT: String(lanPort), STARNET_REMOTE_LAN: '1', STARNET_REMOTE_RELAY: 'off'
    } });
  // the overseer's conversation is a desk session: seed the save the way e2e.overseer does, as a CURRENT save with its floor saved (a station
  // of the old save version, or one with no floor in it, is held until a page migrates it: nothing would route). Nothing is drawn on the
  // floor yet, so nothing routes until the line cell below publishes the two-stage line.
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8')).doc;
  seed.generalId = 'general'; seed.activeId = 'home';
  seed.workstreams = [{ id: 'general', agentId: 'agent', title: null, history: [], kind: 'chat', lane: 'active' },
    { id: 'home', agentId: 'agent', title: 'Launch planning', history: [], kind: 'chat', lane: 'active' }];
  seedSavedFloor(fx.workspace, emptyFloor(), { save: seed });

  let feed = null, phone = null;
  try {
    await fx.start();
    const B = fx.baseUrl;
    const ctl = m => fs.writeFileSync(path.join(fx.workspace, 'run-fault.json'), JSON.stringify(m || {}));
    const runTable = async () => {
      const d = await fx.json('GET', '/api/diagnostics');
      return { rt: d.body && d.body.report && d.body.report.runTable, text: (d.body && d.body.text) || '' };
    };
    const emptied = async label => {
      let last = null;
      try { await until(async () => { last = (await runTable()).rt; return last && last.live === 0; }, 10000, label); }
      catch (_) { /* reported below */ }
      A.eq(last && last.live, 0, label + ': once it ended, the run table is empty again (released on that exit)');
    };
    const desk = (streamId, text, agentId) => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'test/model', agentId: agentId || 'agent', streamId, isTask: true, messages: [{ role: 'user', content: text }] }) })
      .then(r => r.text()).catch(e => 'ERR ' + e.message);
    const v1 = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + V1KEY }, body: JSON.stringify(body) });

    // the station's live feed: a line deploy folds through the page, so this stands in for it (as cancel-host-run.e2e does);
    // it also keeps every event (the station floor, read by the E-STOP cell)
    const floor = [];
    const feedAc = new AbortController();
    const feedRes = await fetch(B + '/api/channels/events?' + sseQuery(fx.token), { signal: feedAc.signal });
    feed = { close: () => feedAc.abort() };
    (async () => {
      const rd = feedRes.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let ev = null; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) {}
            if (ev && ev.name) floor.push(ev);
            if (ev && ev.name === 'station.command') await fx.json('POST', '/api/station/ack', { id: ev.payload.id, ok: true, result: { folded: true } });
          }
        }
      } catch (_) { /* the feed closes at the end */ }
    })();

    A.eq((await fx.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You coordinate work.' },
      { agentId: 'mira_custom', name: 'Mira', role: 'Research', model: 'test/model', provider: 'openrouter', system: 'You are the research specialist.' },
      { agentId: 'forge', name: 'FORGE', model: 'test/model', provider: 'openrouter', system: 'You are FORGE, a builder.' },
      { agentId: 'gagent', name: 'Groupie', model: 'test/model', provider: 'openrouter', approvalMode: 'full', system: 'You answer in a group.' },
      // a line's stages: a hop runs as its target agent on that agent's own roster config
      { agentId: 'research-agent', name: 'Research', model: 'test/model', provider: 'openrouter', system: 'You research.' },
      { agentId: 'writer-agent', name: 'Writer', model: 'test/model', provider: 'openrouter', system: 'You write.' }
    ] })).status, 200, 'the crew roster is saved');

    // the phone (relay/app/phone-client.js over the LAN door), paired before the cells: each cell reads its status
    A.eq((await fx.json('POST', '/api/remote/enable', { on: true })).body.enabled, true, 'Remote switched on');
    const pr = await fx.json('POST', '/api/remote/pair', { name: 'RT phone' });
    const key = await Phone.makeDeviceKey();
    const paired = await Phone.pair({ base: 'http://' + HOST + ':' + lanPort, pairingId: pr.body.pairingId, code: pr.body.code, name: 'RT phone', key });
    phone = Phone.connect({ base: 'http://' + HOST + ':' + lanPort, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key });

    // the run each cell holds is named by the fault host's tag (the run whose own conversation carries the cell's mark)
    const tagged = mark => { try { return fs.readFileSync(path.join(fx.workspace, 'run-fault.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.mark === mark) || null; } catch (_) { return null; } };
    const snapshotRuns = async () => ((await fx.json('GET', '/api/state/snapshot')).body || {}).runs || [];
    const phoneRuns = async () => { const s = await phone.call('status'); return (s && s.data && s.data.runs) || []; };
    const cancelById = runId => fx.json('POST', '/api/cancel', { runId });
    /* THE S3 READERS, while a run is held: the snapshot lists it (stoppable unless a manager owns its stop), the phone lists it,
       the update drain counts it. -> its snapshot row */
    async function readers(name, runId, o) {
      const row = (await snapshotRuns()).find(r => r.runId === runId) || null;
      A.ok(row, name + ': GET /api/state/snapshot lists the live run (' + runId + ')');
      if (row && o.manager) A.ok(row.stoppable !== true, name + ': a run its manager stops is not offered a STOP by id');
      else if (row) A.eq(row.stoppable, true, name + ': and offers its STOP');
      if (row && o.source) A.eq(row.source, o.source, name + ': under its surface\'s source');
      A.ok((await phoneRuns()).some(r => r.runId === runId), name + ': the phone\'s status lists it');
      const drain = await fx.json('POST', '/api/update/prepare', { targetVersion: '9.9.9', force: false });
      A.eq([drain.status, drain.body && drain.body.code], [409, 'UPDATE_RUNS_ACTIVE'], name + ': the update drain counts it (INSTALL UPDATE waits)');
      return row;
    }

    /* one cell: hold its run at the provider, prove the superset and the readers, end it (STOP by its id, or the reply), prove
       the table empties and the snapshot lets it go */
    async function cell(name, test, start, opts) {
      const o = opts || {};
      if (o.mark) ctl({ mode: 'tag', mark: o.mark });
      model.hold(name, test, o.toolless);
      const done = start();
      await model.held(name, o.heldMs);
      const { rt, text } = await runTable();
      A.ok(rt && Number.isFinite(rt.live), name + ': GET /api/diagnostics reports the authoritative live count');
      if (rt) {
        A.eq(Object.keys(rt), ['live'], name + ': the retired registry comparison is absent');
        A.ok(rt.live >= (o.live || 1), name + ': the table holds the live run (live ' + rt.live + ')');
      }
      if (o.text) A.ok(/^Live runs: {5}\d+ in the run table$/m.test(text), name + ': the pasted report names the live count');
      const runId = o.mark ? ((tagged(o.mark) || {}).runId || '') : '';
      if (o.mark) {
        A.ok(runId, name + ': the fault host named the held run');
        await readers(name, runId, o);
      }
      if (o.whileHeld) await o.whileHeld(rt);
      if (o.stop && runId) {
        const stop = await cancelById(runId);
        A.eq([stop.status, stop.body], [200, { ok: true, stopped: true }], name + ': POST /api/cancel by its id stops it');
      } else {
        if (o.manager && runId) A.eq((await cancelById(runId)).body, { ok: true, stopped: false }, name + ': a STOP by its id never bypasses its manager');
        model.finish(name);
      }
      await within(Promise.resolve(done), 30000, name + ' to end');
      await emptied(name);
      if (runId) A.ok(!(await snapshotRuns()).some(r => r.runId === runId), name + ': once it ended, the snapshot no longer lists it');
      ctl({});
    }
    // the run's OWN turn names its cell: a finished run's after-run passes (reflection, study) quote its transcript, so a mark
    // anywhere in the conversation is not enough (the background lead's transcript names its worker's job)
    const userSaid = mark => last => last.includes(mark);
    const anyUserSaid = mark => (last, words) => words.some(w => w.includes(mark));   // a loop iteration composes its own turn around the objective

    // ---- COMMS ----
    await cell('comms', userSaid('HOLD-COMMS'), () => desk('rt-comms', 'HOLD-COMMS answer when released'), { text: true, mark: 'HOLD-COMMS', stop: true, source: 'interactive' });

    // ---- a run QUEUED behind its conversation: admitted before the queue, so it is in the table while it waits; then stopped there ----
    await cell('queue-head', userSaid('HOLD-QHEAD'), () => desk('rt-queue', 'HOLD-QHEAD the first turn'), { mark: 'HOLD-QHEAD', whileHeld: async () => {
      const second = desk('rt-queue', 'QUEUED-SECOND the turn that waits');
      const rows = (await until(async () => { const r = (await snapshotRuns()).filter(x => x.streamId === 'rt-queue'); return r.length >= 2 && r; }, 15000, 'the queued turn to be listed'))
        .sort((a, b) => a.startedAt - b.startedAt);
      const rt = (await runTable()).rt;
      A.eq(rt && Object.keys(rt), ['live'], 'queued: diagnostics uses only the authoritative table count');
      A.ok(rt && rt.live >= 2, 'queued: the table holds both turns, the waiting one included (live ' + (rt && rt.live) + ')');
      A.ok(!model.seen.some(s => s.includes('QUEUED-SECOND')), 'queued: the second turn is waiting in its conversation queue, not at the provider');
      A.eq(rows.length, 2, 'queued: the desk lists both turns of the conversation');
      A.eq(rows[1] && rows[1].stoppable, true, 'queued: the waiting turn offers its STOP');
      A.ok(rows.length === 2 && (await phoneRuns()).some(r => r.runId === rows[1].runId), 'queued: the phone lists the waiting turn');
      const stop = rows.length === 2 ? await cancelById(rows[1].runId) : null;
      A.eq(stop && [stop.status, stop.body], [200, { ok: true, stopped: true }], 'queued: the waiting turn is stopped by its id');
      model.finish('queue-head');
      const said = await within(second, 30000, 'the stopped queued turn to answer');
      A.ok(/"reason":"cancelled"/.test(said), 'queued: its stream ends it cancelled');
      A.ok(!model.seen.some(s => s.includes('QUEUED-SECOND')), 'queued: the stopped turn never reached the provider');
    } });

    // ---- Run Now ----
    const routine = await fx.json('POST', '/api/cron', { name: 'RT run now', prompt: 'HOLD-RUNNOW run me by hand', schedule: 'every 1h', agentId: 'scout', model: 'test/model', provider: 'openrouter' });
    A.ok(routine.body && routine.body.job, 'a routine to run by hand');
    await cell('run-now', userSaid('HOLD-RUNNOW'), () => fx.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: routine.body.job.id }) }).then(r => r.text()), { mark: 'HOLD-RUNNOW', stop: true, source: 'cron' });

    await fx.json('POST', '/api/cron/remove', { id: routine.body.job.id });   // arming the scheduler below fires only the job under test

    // ---- a scheduled fire (its agent is on the roster: a routine of an agent the roster lacks is removed, never fired) ----
    const sched = await fx.json('POST', '/api/cron', { name: 'RT scheduled', prompt: 'HOLD-SCHED fire on time', schedule: 'in 1s', agentId: 'forge', model: 'test/model', provider: 'openrouter' });
    A.ok(sched.body && sched.body.job, 'a one-shot routine due in a second');
    await cell('scheduled', userSaid('HOLD-SCHED'), () => fx.json('POST', '/api/cron/arm', { enabled: true }), { mark: 'HOLD-SCHED', stop: true, source: 'cron' });
    await fx.json('POST', '/api/cron/arm', { enabled: false });

    // ---- /v1: chat (sync and stream) and /v1/runs (in no older registry since the stop handles became the table's: legacy 0) ----
    await cell('v1-sync', userSaid('HOLD-V1SYNC'), () => v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: 'HOLD-V1SYNC answer' }] }).then(r => r.text()),
      { mark: 'HOLD-V1SYNC', stop: true, source: 'api' });
    await cell('v1-stream', userSaid('HOLD-V1STREAM'), () => v1('/v1/chat/completions', { model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: 'HOLD-V1STREAM answer' }] }).then(r => r.text()),
      { mark: 'HOLD-V1STREAM', stop: true, source: 'api' });
    let v1RunId = '';
    await cell('v1-runs', userSaid('HOLD-V1RUNS'), () => v1('/v1/runs', { model: 'starnet-agent', input: 'HOLD-V1RUNS answer' }).then(r => r.json()).then(j => { v1RunId = j.run_id; }),
      { mark: 'HOLD-V1RUNS', stop: true, source: 'api' });
    A.ok(v1RunId, 'the /v1/runs run had its id');

    // ---- the dev channel hub (the production makeChannelHub every Telegram/Discord/Slack/Matrix/Signal hub uses) ----
    await cell('dev-hub', userSaid('HOLD-DEV'), () => fx.json('POST', '/api/dev/inbound', { text: 'HOLD-DEV answer this', chatId: 'rtdev' }), { mark: 'HOLD-DEV', stop: true, source: 'dev' });

    // ---- a group session turn ----
    const groups = (b) => fx.json('POST', '/api/groups', b).then(r => r.body && r.body.result);
    const group = await groups({ op: 'create', members: ['gagent'], title: 'Run table group' });
    A.ok(group && group.id, 'a group session');
    await cell('group', userSaid('HOLD-GROUP'), () => groups({ op: 'send', id: group.id, key: 'rt-group-1', text: 'HOLD-GROUP answer the group' }), { mark: 'HOLD-GROUP', stop: true, source: 'group' });

    // ---- a line hop (a two-stage line run by hand: the hop is driven with its own run id) ----
    const lineJob = await fx.json('POST', '/api/cron', { name: 'RT line', prompt: 'LINE-START gather the news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter', runsLine: true });
    A.ok(lineJob.body && lineJob.body.job, 'a line routine');
    const belt = (x, y, dir) => ({ x, y, dir });
    await publishFloor(fx, floorOf({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
        { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' }, { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    }), { label: 'the two-stage line' });
    await cell('line-hop', userSaid('HOP-PAYLOAD'), () => fx.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lineJob.body.job.id }) }).then(r => r.text()), { mark: 'HOP-PAYLOAD', stop: true, source: 'cron' });   // a routine's hop: its host admission's word, as before

    // ---- a loop iteration (paused while held: the pause stops the iteration, another exit) ----
    let loopId = '';
    await cell('loop', anyUserSaid('HOLD-LOOP'), () => fx.json('POST', '/api/loops', { name: 'RT loop', objective: 'HOLD-LOOP keep iterating', model: 'test/model', provider: 'openrouter' })
      .then(r => { loopId = r.body && r.body.loop && r.body.loop.id; }), { heldMs: 30000, mark: 'HOLD-LOOP', source: 'loop', whileHeld: async () => {
      A.ok(loopId, 'the loop was created');
      A.eq((await fx.json('POST', '/api/loops/control', { id: loopId, action: 'pause' })).status, 200, 'loop: paused while its iteration is held');
    } });

    // ---- a phone task (relay/app/phone-client.js over the LAN door) ----
    let phoneRunId = '';
    await cell('phone', userSaid('HOLD-PHONE'), () => phone.call('send', { agentId: 'forge', text: 'HOLD-PHONE answer from the phone' }).then(s => { phoneRunId = s && s.data && s.data.runId; }),
      { mark: 'HOLD-PHONE', stop: true, source: 'remote' });
    A.ok(phoneRunId, 'the phone task had its run id');

    // ---- the overseer's review (driven without runOnce, admitted at its own site) ----
    await cell('overseer-review', (last, words, body) => /^Review the background work/.test(last), () => desk('home', 'OVERSEER-CELL Delegate research and review the findings'),
      { heldMs: 40000, mark: 'Review the background work', source: 'overseer' });

    // A foreground dispatch was the removed host-only registry's distinctive member. Hold the actual worker while its
    // lead awaits it: the table, snapshot and phone must still list the worker and keep manager-owned STOP semantics.
    await cell('foreground-worker', userSaid('FG-WORKER_PROOF'), () => desk('rt-fg', 'FOREGROUND-CELL Delegate research and wait for the findings'),
      { heldMs: 40000, mark: 'FG-WORKER_PROOF', manager: true, source: 'delegated', live: 2 });

    // ---- a background worker (team.spawn background:true; its manager owns its stop; after the review cell, so a review of its
    //      work, if one follows, is answered and never mistaken for the cell above) ----
    await cell('background-worker', userSaid('BG-WORK'), () => desk('rt-bg', 'SPAWN-BG start a background helper'), { mark: 'BG-WORK', manager: true, source: 'subagent' });

    // ---- a force-fired night-shift beat: its own id spans the reason-only (tool-less) runs it drives, admitted at its own site.
    //      A hot dossier clears the beat's readiness gate (as nightshift-beat-halt.e2e seeds it); the mark rides one belief ----
    const hot = t => [{ text: t, createdAt: Date.now(), updatedAt: Date.now() }];
    A.eq((await fx.json('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: { known: ['goals', 'pain', 'stack', 'ambition'],
      beliefs: { goals: hot('BEAT-MARK ship the beta to 100 users'), pain: hot('manual release notes eat my fridays'), stack: hot('node and a pixel-art canvas'), ambition: hot('a living agent station people watch') } } })).status, 200, 'the night shift has a hot dossier');
    await cell('nightshift-beat', userSaid('BEAT-MARK'), () => fx.request('/api/nightshift/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent' }) }).then(r => r.text()), { toolless: true, live: 2 });

    // ---- release on every exit: a throw inside the run, a throw in the conversation queue ----
    ctl({ mode: 'throw-after-start', mark: 'FAULT-CORE' });
    const thrown = await v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: 'FAULT-CORE answer' }] });
    A.ok(thrown.status >= 500, 'a run that throws after its start fails its /v1 caller (' + thrown.status + ')');
    await emptied('throw in the run');
    ctl({ mode: 'throw-in-queue', streamId: 'rt-fault-queue' });
    const queueThrow = await desk('rt-fault-queue', 'FAULT-QUEUE never runs');
    A.ok(/agent\.run\.end/.test(queueThrow), 'a run whose queue threw still ends on the desk stream');
    await emptied('throw in the queue');
    ctl({});
    A.ok(!model.seen.some(s => s.includes('FAULT-QUEUE')), 'the queue threw before the run reached the provider');

    // ---- ESTOP-STOPS-V1: COMMS, the dev hub, /v1 chat (sync and stream) and /v1/runs held at once, then one E-STOP ----
    {
      const marks = { comms: 'ESTOP-COMMS', hub: 'ESTOP-HUB', sync: 'ESTOP-V1SYNC', stream: 'ESTOP-V1STREAM', runs: 'ESTOP-V1RUNS' };
      ctl({ mode: 'tag', marks: Object.values(marks) });
      for (const k of Object.keys(marks)) model.hold('estop-' + k, userSaid(marks[k]));
      const comms = desk('rt-estop', marks.comms + ' answer when released');
      const hub = fx.json('POST', '/api/dev/inbound', { text: marks.hub + ' answer this', chatId: 'rtestop' }).catch(e => ({ error: e.message }));
      const sync = v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: marks.sync + ' answer' }] }).then(r => r.json()).catch(e => ({ error: e.message }));
      const stream = v1('/v1/chat/completions', { model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: marks.stream + ' answer' }] }).then(r => r.text()).catch(e => 'ERR ' + e.message);
      const job = await v1('/v1/runs', { model: 'starnet-agent', input: marks.runs + ' answer' }).then(r => r.json());
      for (const k of Object.keys(marks)) await model.held('estop-' + k);
      const ids = {};
      for (const k of Object.keys(marks)) ids[k] = (tagged(marks[k]) || {}).runId || '';
      A.ok(Object.values(ids).every(Boolean), 'estop: the fault host named each held run ' + JSON.stringify(ids));
      const listed = (await snapshotRuns()).map(r => r.runId);
      A.ok(Object.values(ids).every(id => listed.includes(id)), 'estop: the snapshot lists all five before the stop');
      const held = (await runTable()).rt;
      A.eq(held && held.live, 5, 'estop: the five held runs are the only live runs (the count below is theirs alone)');
      const halt = await fx.json('POST', '/api/halt', {});
      A.eq(halt.status, 200, 'estop: E-STOP answers');
      A.eq(halt.body && halt.body.halted, 5, 'estop: halted counts each live run exactly once: COMMS by its owned admission, the hub run by its record, the three /v1 runs (which no owner kill reaches) by the run table');
      const syncBody = await within(sync, 30000, 'the /v1 sync answer');
      A.eq(syncBody && syncBody.choices && syncBody.choices[0] && syncBody.choices[0].finish_reason, 'cancelled', 'estop: the /v1 chat sync ends cancelled (' + JSON.stringify(syncBody).slice(0, 200) + ')');
      A.ok(/"finish_reason":"cancelled"/.test(await within(stream, 30000, 'the /v1 stream')), 'estop: the /v1 chat stream ends cancelled');
      const st = await until(async () => { const s = await (await fetch(B + '/v1/runs/' + job.run_id, { headers: { Authorization: 'Bearer ' + V1KEY } })).json(); return !/^(queued|running|stopping)$/.test(String(s.status)) && s; }, 20000, 'the /v1/runs run to settle');
      A.eq(st.status, 'cancelled', 'estop: /v1/runs ends cancelled');
      const commsEvents = String(await within(comms, 30000, 'the COMMS stream')).split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(e => e && e.payload && e.payload.runId === ids.comms);
      A.eq([commsEvents.filter(e => e.name === 'agent.run.start').length, commsEvents.filter(e => e.name === 'agent.run.end').map(e => e.payload.reason)], [1, ['cancelled']], 'estop: the COMMS run starts once and ends cancelled once on its stream');
      await within(hub, 30000, 'the dev hub inbound');
      const replies = () => { try { return fs.readFileSync(path.join(fx.workspace, 'run-fault-replies.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.chatId === 'rtestop').map(r => r.text); } catch (_) { return []; } };
      let notice = null;
      try { notice = await until(() => replies().find(t => /E-STOP was pressed/.test(t)), 15000, 'the chat\'s stop notice'); } catch (_) {}
      A.ok(notice, 'estop: the hub chat is told E-STOP was pressed (' + JSON.stringify(replies()).slice(0, 300) + ')');
      for (const k of ['hub', 'sync', 'stream', 'runs']) {
        const of = name => floor.filter(e => e.name === name && e.payload && e.payload.runId === ids[k]);
        try { await until(() => of('agent.run.end').length >= 1, 10000, k + ' to end on the floor'); } catch (_) {}
        A.eq([of('agent.run.start').length, of('agent.run.end').length], [1, 1], 'estop: the ' + k + ' run starts once and ends once on the floor');
        A.ok(of('agent.run.end').every(e => e.payload.reason === 'cancelled'), 'estop: and ends cancelled');
      }
      await emptied('estop');
      const after = (await snapshotRuns()).map(r => r.runId);
      A.ok(!Object.values(ids).some(id => after.includes(id)), 'estop: none of them outlives the halt: the snapshot lists none');
      ctl({});
      A.eq((await fx.json('POST', '/api/halt/resume', { confirm: true })).status, 200, 'RESUME lifts the E-STOP');
    }
    // and through all of it the table's own bookkeeping never complained: no stray double release, no failed check
    const swallowed = (((await fx.json('GET', '/api/diagnostics')).body.report.swallowed || {}).tags || []).map(t => t.tag);
    A.eq(swallowed.filter(t => /^runtable\.|^diagnostics\.run-table$/.test(t)), [], 'no run-table bookkeeping fault was swallowed');
  } catch (e) {
    A.ok(false, 'run-registry-coverage threw: ' + (e && e.stack || e) + '\n--- sidecar output (tail) ---\n' + fx.output().slice(-4000));
  } finally {
    try { if (phone) phone.close(); } catch (_) {}
    try { if (feed) feed.close(); } catch (_) {}
    model.closeAll();
    await fx.dispose();
    await new Promise(r => model.server.close(r));
  }
  A.report('run-registry-coverage.http.test');
})().catch(e => { console.log('FAIL: run-registry-coverage.http.test threw - ' + (e && e.stack || e)); process.exit(1); });
