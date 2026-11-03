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
   The pasted report says it too: its text carries the "Live runs:" line. */
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
const Pipeline = require('../frontend/app/pipeline.js');

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
      if (last.includes('OVERSEER-CELL')) {
        const lastUserIndex = messages.map(m => m && m.role).lastIndexOf('user');
        const calls = messages.slice(lastUserIndex + 1).filter(m => m && m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        const system = messages.filter(m => m && m.role === 'system').map(m => m.content).join('\n');
        const crew = system.match(/^  - ([A-Za-z0-9_-]+) \(/m);
        const workerId = crew ? crew[1] : 'mira_custom';
        if (!calls.includes('brief_proceed')) return call('brief_proceed', { objective: 'Delegate research and review the findings', deliverable: 'Research findings' });
        if (!calls.includes('session_create')) return call('session_create', { title: 'Research proof', agentId: workerId });
        if (!calls.includes('team_dispatch')) return call('team_dispatch', { workers: [{ agentId: workerId, session: 'Research proof', prompt: 'WORKER_PROOF: return two findings' }], background: true });
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
  // the overseer's conversation is a desk session: seed the save the way e2e.overseer does
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
  seed.doc.generalId = 'general'; seed.doc.activeId = 'home';
  seed.doc.workstreams = [{ id: 'general', agentId: 'agent', title: null, history: [], kind: 'chat', lane: 'active' },
    { id: 'home', agentId: 'agent', title: 'Launch planning', history: [], kind: 'chat', lane: 'active' }];
  fs.writeFileSync(path.join(fx.workspace, 'agent.save.json'), JSON.stringify(seed));

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

    // the station's live feed: a line deploy folds through the page, so this stands in for it (as cancel-host-run.e2e does)
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

    /* one cell: hold its run at the provider, prove the superset, finish it, prove the table empties */
    async function cell(name, test, start, opts) {
      const o = opts || {};
      model.hold(name, test, o.toolless);
      const done = start();
      await model.held(name, o.heldMs);
      const { rt, text } = await runTable();
      A.ok(rt && Array.isArray(rt.missing), name + ': GET /api/diagnostics reports the run table');
      if (rt) {
        A.eq(rt.missing, [], name + ': held at the provider, every run the older registries hold is in the run table');
        A.ok(rt.legacy >= (o.legacy || 1), name + ': and the older registries really hold it (legacy ' + rt.legacy + ')');
        A.ok(rt.live >= (o.live || 1), name + ': the table holds the live run (live ' + rt.live + ')');
      }
      if (o.text) A.ok(/Live runs: {5}\d+ in the run table · \d+ in the older registries · none outside the table/.test(text), name + ': the pasted report says so');
      if (o.whileHeld) await o.whileHeld(rt);
      model.finish(name);
      await within(Promise.resolve(done), 30000, name + ' to end');
      await emptied(name);
    }
    // the run's OWN turn names its cell: a finished run's after-run passes (reflection, study) quote its transcript, so a mark
    // anywhere in the conversation is not enough (the background lead's transcript names its worker's job)
    const userSaid = mark => last => last.includes(mark);
    const anyUserSaid = mark => (last, words) => words.some(w => w.includes(mark));   // a loop iteration composes its own turn around the objective

    // ---- COMMS ----
    await cell('comms', userSaid('HOLD-COMMS'), () => desk('rt-comms', 'HOLD-COMMS answer when released'), { text: true });

    // ---- a run QUEUED behind its conversation: admitted before the queue, so it is in the table while it waits; then stopped there ----
    await cell('queue-head', userSaid('HOLD-QHEAD'), () => desk('rt-queue', 'HOLD-QHEAD the first turn'), { whileHeld: async () => {
      const second = desk('rt-queue', 'QUEUED-SECOND the turn that waits');
      const rt = await until(async () => { const r = (await runTable()).rt; return r && r.legacy >= 2 && r; }, 15000, 'the queued turn to reach the desk registries');
      A.eq(rt.missing, [], 'queued: the turn waiting behind its conversation is in the run table too');
      A.ok(rt.live >= 2, 'queued: the table holds both turns, the waiting one included (live ' + rt.live + ')');
      A.ok(!model.seen.some(s => s.includes('QUEUED-SECOND')), 'queued: the second turn is waiting in its conversation queue, not at the provider');
      const snap = await fx.json('GET', '/api/state/snapshot');
      const rows = ((snap.body && snap.body.runs) || []).filter(r => r.streamId === 'rt-queue').sort((a, b) => a.startedAt - b.startedAt);
      A.eq(rows.length, 2, 'queued: the desk lists both turns of the conversation');
      const stop = rows.length === 2 ? await fx.json('POST', '/api/cancel', { runId: rows[1].runId }) : null;
      A.eq(stop && stop.status, 200, 'queued: the waiting turn is stopped by its id');
      model.finish('queue-head');
      await within(second, 30000, 'the stopped queued turn to answer');
      A.ok(!model.seen.some(s => s.includes('QUEUED-SECOND')), 'queued: the stopped turn never reached the provider');
    } });

    // ---- Run Now ----
    const routine = await fx.json('POST', '/api/cron', { name: 'RT run now', prompt: 'HOLD-RUNNOW run me by hand', schedule: 'every 1h', agentId: 'scout', model: 'test/model', provider: 'openrouter' });
    A.ok(routine.body && routine.body.job, 'a routine to run by hand');
    await cell('run-now', userSaid('HOLD-RUNNOW'), () => fx.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: routine.body.job.id }) }).then(r => r.text()));

    await fx.json('POST', '/api/cron/remove', { id: routine.body.job.id });   // arming the scheduler below fires only the job under test

    // ---- a scheduled fire (its agent is on the roster: a routine of an agent the roster lacks is removed, never fired) ----
    const sched = await fx.json('POST', '/api/cron', { name: 'RT scheduled', prompt: 'HOLD-SCHED fire on time', schedule: 'in 1s', agentId: 'forge', model: 'test/model', provider: 'openrouter' });
    A.ok(sched.body && sched.body.job, 'a one-shot routine due in a second');
    await cell('scheduled', userSaid('HOLD-SCHED'), () => fx.json('POST', '/api/cron/arm', { enabled: true }));
    await fx.json('POST', '/api/cron/arm', { enabled: false });

    // ---- /v1: chat (sync and stream) and /v1/runs ----
    await cell('v1-sync', userSaid('HOLD-V1SYNC'), () => v1('/v1/chat/completions', { model: 'starnet-agent', messages: [{ role: 'user', content: 'HOLD-V1SYNC answer' }] }).then(r => r.text()));
    await cell('v1-stream', userSaid('HOLD-V1STREAM'), () => v1('/v1/chat/completions', { model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: 'HOLD-V1STREAM answer' }] }).then(r => r.text()));
    let v1RunId = '';
    await cell('v1-runs', userSaid('HOLD-V1RUNS'), () => v1('/v1/runs', { model: 'starnet-agent', input: 'HOLD-V1RUNS answer' }).then(r => r.json()).then(j => { v1RunId = j.run_id; }));
    A.ok(v1RunId, 'the /v1/runs run had its id');

    // ---- the dev channel hub (the production makeChannelHub every Telegram/Discord/Slack/Matrix/Signal hub uses) ----
    await cell('dev-hub', userSaid('HOLD-DEV'), () => fx.json('POST', '/api/dev/inbound', { text: 'HOLD-DEV answer this', chatId: 'rtdev' }));

    // ---- a group session turn ----
    const groups = (b) => fx.json('POST', '/api/groups', b).then(r => r.body && r.body.result);
    const group = await groups({ op: 'create', members: ['gagent'], title: 'Run table group' });
    A.ok(group && group.id, 'a group session');
    await cell('group', userSaid('HOLD-GROUP'), () => groups({ op: 'send', id: group.id, key: 'rt-group-1', text: 'HOLD-GROUP answer the group' }));

    // ---- a line hop (a two-stage line run by hand: the hop is driven with its own run id) ----
    const lineJob = await fx.json('POST', '/api/cron', { name: 'RT line', prompt: 'LINE-START gather the news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter', runsLine: true });
    A.ok(lineJob.body && lineJob.body.job, 'a line routine');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
        { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' }, { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
    A.eq((await fx.json('POST', '/api/routing', plan)).status, 200, 'the two-stage line deploys');
    await cell('line-hop', userSaid('HOP-PAYLOAD'), () => fx.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lineJob.body.job.id }) }).then(r => r.text()));

    // ---- a loop iteration (paused while held: the pause stops the iteration, another exit) ----
    let loopId = '';
    await cell('loop', anyUserSaid('HOLD-LOOP'), () => fx.json('POST', '/api/loops', { name: 'RT loop', objective: 'HOLD-LOOP keep iterating', model: 'test/model', provider: 'openrouter' })
      .then(r => { loopId = r.body && r.body.loop && r.body.loop.id; }), { heldMs: 30000, whileHeld: async () => {
      A.ok(loopId, 'the loop was created');
      A.eq((await fx.json('POST', '/api/loops/control', { id: loopId, action: 'pause' })).status, 200, 'loop: paused while its iteration is held');
    } });

    // ---- a phone task (relay/app/phone-client.js over the LAN door) ----
    A.eq((await fx.json('POST', '/api/remote/enable', { on: true })).body.enabled, true, 'Remote switched on');
    const pr = await fx.json('POST', '/api/remote/pair', { name: 'RT phone' });
    const key = await Phone.makeDeviceKey();
    const paired = await Phone.pair({ base: 'http://' + HOST + ':' + lanPort, pairingId: pr.body.pairingId, code: pr.body.code, name: 'RT phone', key });
    phone = Phone.connect({ base: 'http://' + HOST + ':' + lanPort, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key });
    let phoneRunId = '';
    await cell('phone', userSaid('HOLD-PHONE'), () => phone.call('send', { agentId: 'forge', text: 'HOLD-PHONE answer from the phone' }).then(s => { phoneRunId = s && s.data && s.data.runId; }));
    A.ok(phoneRunId, 'the phone task had its run id');

    // ---- the overseer's review (driven without runOnce, admitted at its own site) ----
    await cell('overseer-review', (last, words, body) => /^Review the background work/.test(last), () => desk('home', 'OVERSEER-CELL Delegate research and review the findings'), { heldMs: 40000 });

    // ---- a background worker (team.spawn background:true; its manager owns its stop; after the review cell, so a review of its
    //      work, if one follows, is answered and never mistaken for the cell above) ----
    await cell('background-worker', userSaid('BG-WORK'), () => desk('rt-bg', 'SPAWN-BG start a background helper'));

    // ---- a force-fired night-shift beat: its own id spans the reason-only (tool-less) runs it drives, admitted at its own site.
    //      A hot dossier clears the beat's readiness gate (as nightshift-beat-halt.e2e seeds it); the mark rides one belief ----
    const hot = t => [{ text: t, createdAt: Date.now(), updatedAt: Date.now() }];
    A.eq((await fx.json('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: { known: ['goals', 'pain', 'stack', 'ambition'],
      beliefs: { goals: hot('BEAT-MARK ship the beta to 100 users'), pain: hot('manual release notes eat my fridays'), stack: hot('node and a pixel-art canvas'), ambition: hot('a living agent station people watch') } } })).status, 200, 'the night shift has a hot dossier');
    await cell('nightshift-beat', userSaid('BEAT-MARK'), () => fx.request('/api/nightshift/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent' }) }).then(r => r.text()), { toolless: true, legacy: 2, live: 2 });

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
