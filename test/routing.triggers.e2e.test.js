/* node test/routing.triggers.e2e.test.js — LINE TRIGGERS over real sockets against the REAL host.

   Boot pattern + content-driven mock provider per routing.sample.e2e.test.js (zero real spend, no keys). HOME /
   USERPROFILE point at a scratch folder so the folder jail ("inside your home folder") is exercised on every OS.
   Locks:
     1. CRUD sits behind the launch-token gate; email is refused honestly; a folder outside home is refused;
     2. FOLDER: a file that was already there never fires; a new file fires ONE work item that rides the line —
        two real runs (entry dock + chain hop) recorded under the fire's own streamId, a kind:'trigger' crate at
        the routed dock stamped with the line, delivered to the OUTBOX; the trigger records fires/lastOutcome;
     3. WEBHOOK: the secret is answered once and never listed; no key / a wrong key / an unknown id -> 401; the
        right key (header or ?key) -> 202 and a real two-stage run; any OTHER /api/hooks path still meets the
        token gate; a regenerated secret retires the old key; a disabled trigger refuses 409;
     4. RESTART: triggers persist, the fired file does not refire, a newly dropped file still fires;
     5. DELETE removes the trigger. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const Events = require('../shared/events.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    return script.find(r => text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          const answer = () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          };
          if (turn.delayMs) setTimeout(answer, turn.delayMs); else answer();   // a SLOW stage: the run is observably live
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, log: () => out }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 20000);
  });
}
function stop(child) { return new Promise(r => { if (!child || child.exitCode != null) return r(); child.once('exit', () => r()); try { child.kill(); } catch (_) { r(); } }); }

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line.indexOf('data:') !== 0) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      }
    } catch (_) {}
  })();
  return { events, close() { try { ac.abort(); } catch (_) {} } };
}

function twoStagePlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent', brief: 'Dig in.' },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent', brief: 'Write it up.' },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    { when: 'slow-lane-probe', text: 'stage one findings', delayMs: 2500 },   // (sweep) a slow entry run, to watch it live
    { when: 'stage one findings', text: 'final trigger answer' },   // the chain hop (its handoff carries stage one's output)
    { when: 'line trigger', text: 'stage one findings' }           // the entry dock's own turn (the work item header)
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-trg-e2e-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws'), drops = path.join(home, 'drops'), outside = path.join(root, 'outside');
  for (const d of [home, ws, drops, outside, path.join(root, 'hermes')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(drops, 'old.txt'), 'was here before the trigger existed');
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, STARNET_DEV: '', SKYNET_DEV: '',
    HOME: home, USERPROFILE: home, HERMES_HOME: path.join(root, 'hermes'),
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-triggers-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_TRIGGER_POLL_MS: '300', STARNET_TRIGGER_SETTLE_MS: '200'
  };
  let { child, port } = await boot(await allocatePort(), env, 20);
  let B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const api = (p, method, body) => fetch(B + p, { method: method || 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));
    const list = async () => ((await api('/api/routing/triggers')).j || {}).triggers || [];
    const waitFor = async (pred, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(200); } A.ok(false, 'timed out waiting for ' + what); return null; };

    /* ---- 1. auth + refusals ---- */
    const bare = await fetch(B + '/api/routing/triggers', { headers: { Origin: B } });
    A.eq(bare.status, 403, 'GET triggers without the launch token -> 403');
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(twoStagePlan()) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');
    const lineId = Pipeline.lineOf(twoStagePlan(), 'research-agent');
    A.ok(!!lineId, 'the compiled floor names the line: ' + lineId);
    const email = await api('/api/routing/triggers', 'POST', { kind: 'email', lineId });
    A.ok(email.status === 400 && /no mail connector/.test(email.j.error), 'an email trigger is refused honestly: ' + JSON.stringify(email.j));
    const out = await api('/api/routing/triggers', 'POST', { kind: 'folder', lineId, config: { path: outside } });
    A.ok(out.status === 400 && out.j.code === 'outside', 'a folder outside home + projects is refused: ' + JSON.stringify(out.j));
    const wsFolder = await api('/api/routing/triggers', 'POST', { kind: 'folder', lineId, config: { path: ws } });
    A.ok(wsFolder.status === 400, 'the station data folder is refused: ' + JSON.stringify(wsFolder.j));
    const g0 = await api('/api/routing/triggers');
    A.ok(g0.j.ok && g0.j.email && g0.j.email.available === false && g0.j.kinds.indexOf('email') < 0, 'the listing says email is not available (and offers folder + webhook only)');

    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    /* ---- 2. FOLDER ---- */
    const cf = await api('/api/routing/triggers', 'POST', { kind: 'folder', lineId, name: 'Invoices', config: { path: drops, task: 'Summarize the invoice.' } });
    A.eq(cf.status, 200, 'the folder trigger is created: ' + JSON.stringify(cf.j));
    const fid = cf.j.trigger.id;
    A.ok(cf.j.trigger.config.path && cf.j.trigger.blockedBy === null, 'it is armed (nothing blocks it): ' + cf.j.trigger.blockedBy);
    await sleep(1200);   // several polls: the pre-existing file must NOT fire
    A.eq((await list()).find(t => t.id === fid).fires, 0, 'the file already in the folder never fires');
    fs.writeFileSync(path.join(drops, 'invoice-42.txt'), 'INVOICE 42 — 3 widgets, $120');
    const fdone = await waitFor(async () => { const t = (await list()).find(x => x.id === fid); return t && t.lastOutcome ? t : null; }, 30000, 'the folder fire to finish');
    A.eq(fdone && fdone.fires, 1, 'one new file -> one fire');
    A.ok(fdone && fdone.lastOutcome.ok === true && fdone.lastOutcome.runs === 2, 'the fire ran BOTH docks to the OUTBOX: ' + JSON.stringify(fdone && fdone.lastOutcome) + ' err=' + (fdone && fdone.lastError));
    A.ok(fdone && /invoice-42\.txt/.test(fdone.lastOutcome.source || ''), 'the outcome names the file');
    const runsApi = await api('/api/runs?agent=*&limit=50');
    const rows = ((runsApi.j || {}).runs || []).filter(r => r && r.streamId === (fdone && fdone.lastOutcome.streamId));
    A.eq(rows.map(r => r.agentId).sort(), ['research-agent', 'writer-agent'], 'runs.jsonl holds both docks\' runs under the fire\'s own streamId');
    const entryReq = mock.requests.find(rq => JSON.stringify(rq).indexOf('invoice-42.txt') >= 0);
    A.ok(entryReq && JSON.stringify(entryReq).indexOf('INVOICE 42') >= 0, 'the entry dock\'s prompt carried the file\'s name and content');
    await sleep(500);
    const placed = sse.events.filter(e => e.name === 'workitem.placed').map(e => e.payload || {});
    const crate = placed.find(p => p.kind === 'trigger' && p.triggerId === fid);
    A.ok(crate && crate.agentId === 'research-agent' && crate.lineId === lineId, 'a kind:trigger crate rode the bus to the routed dock, stamped with the line: ' + JSON.stringify(crate));
    A.ok(crate && Events.validate('workitem.placed', crate).ok, 'the trigger crate validates against the frozen event contract');
    A.ok(sse.events.some(e => e.name === 'workitem.delivered' && e.payload && e.payload.workitemId === (crate && crate.workitemId) && e.payload.finalQueueId === 'outbox'), 'the crate was delivered to the OUTBOX');

    /* ---- 3. WEBHOOK ---- */
    const cw = await api('/api/routing/triggers', 'POST', { kind: 'webhook', lineId, name: 'Orders' });
    A.eq(cw.status, 200, 'the webhook trigger is created');
    const wid = cw.j.trigger.id, key = cw.j.secret;
    A.ok(/^whk_/.test(key || '') && cw.j.secretShownOnce === true, 'the secret is answered once at create');
    A.eq(cw.j.trigger.url, B + '/api/hooks/' + wid, 'the URL names this machine (127.0.0.1:<port>)');
    const g1 = await api('/api/routing/triggers');
    A.ok(JSON.stringify(g1.j).indexOf(key) < 0 && !/secretHash|[a-f0-9]{64}/.test(JSON.stringify(g1.j)), 'the listing never echoes the secret or its hash');
    const hook = (id, h, qs, body) => fetch(B + '/api/hooks/' + id + (qs || ''), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: body || JSON.stringify({ order: 7, item: 'blue widget' }) }).then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));
    A.eq((await hook(wid)).status, 401, 'no key -> 401');
    A.eq((await hook(wid, { 'X-StarNet-Hook-Key': key + 'x' })).status, 401, 'a wrong key -> 401');
    A.eq((await hook('trg_000000000000', { 'X-StarNet-Hook-Key': key })).status, 401, 'an unknown trigger id -> 401 (existence never revealed)');
    A.eq((await fetch(B + '/api/hooks/' + wid, { headers: { 'X-StarNet-Hook-Key': key } })).status, 403, 'a GET on the hook path still meets the launch-token gate');
    A.eq((await fetch(B + '/api/hooks/allow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Hook-Key': key }, body: '{}' })).status, 403, 'the neighbouring /api/hooks/allow route is NOT opened by the hook seam');
    A.eq((await api('/api/routing/triggers')).j.triggers.find(t => t.id === wid).fires, 0, 'refused calls never fired');
    const okHook = await hook(wid, { 'X-StarNet-Hook-Key': key });
    A.eq(okHook.status, 202, 'the right key -> 202 accepted: ' + JSON.stringify(okHook.j));
    A.ok(okHook.j && okHook.j.accepted === true && okHook.j.durable === false, 'the 202 says honestly that the waiting item is not on disk yet (a restart before it runs drops it)');
    const wdone = await waitFor(async () => { const t = (await list()).find(x => x.id === wid); return t && t.lastOutcome ? t : null; }, 30000, 'the webhook fire to finish');
    A.ok(wdone && wdone.lastOutcome.ok === true && wdone.lastOutcome.runs === 2, 'the webhook ran BOTH docks to the OUTBOX: ' + JSON.stringify(wdone && wdone.lastOutcome) + ' err=' + (wdone && wdone.lastError));
    A.ok(mock.requests.some(rq => JSON.stringify(rq).indexOf('blue widget') >= 0), 'the webhook body reached the entry dock');
    const viaQuery = await hook(wid, null, '?key=' + encodeURIComponent(key), 'plain text ping slow-lane-probe');
    A.eq(viaQuery.status, 202, '?key= works for senders that can only set a URL');
    // (sweep 2026-09-25) a trigger's run is LIVE state: the reconnect snapshot lists it while it runs, or the floor's
    // 30 s reconcile stood its bay lamp down to IDLE mid-run and then ignored the run's real end
    const liveSnap = await waitFor(async () => { const r = await api('/api/state/snapshot'); const hit = ((r.j || {}).runs || []).find(x => x && x.agentId === 'research-agent' && x.source === 'host'); return hit || null; }, 2400, 'the trigger run in /api/state/snapshot');
    A.ok(liveSnap && /^[0-9a-f-]{20,}$/.test(liveSnap.runId || ''), 'the running trigger stage is listed live in /api/state/snapshot: ' + JSON.stringify(liveSnap));
    await waitFor(async () => { const t = (await list()).find(x => x.id === wid); return t && t.fires === 2 && !t.running && !t.queued ? t : null; }, 30000, 'the second webhook fire');
    const regen = await api('/api/routing/triggers/' + wid + '/secret', 'POST', {});
    A.ok(regen.status === 200 && /^whk_/.test(regen.j.secret) && regen.j.secret !== key, 'regenerate answers a NEW secret once');
    A.eq((await hook(wid, { 'X-StarNet-Hook-Key': key })).status, 401, 'the old key is retired');
    const dis = await api('/api/routing/triggers/' + wid, 'PATCH', { enabled: false });
    A.ok(dis.status === 200 && dis.j.trigger.enabled === false, 'PATCH disables the webhook');
    A.eq((await hook(wid, { 'X-StarNet-Hook-Key': regen.j.secret })).status, 409, 'a disabled trigger refuses the right key with 409');

    /* ---- 4. RESTART ---- */
    sse.close(); sse = null;
    await stop(child);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const after = await list();
    const f2 = after.find(t => t.id === fid), w2 = after.find(t => t.id === wid);
    A.ok(f2 && w2, 'both triggers survived the restart');
    A.ok(f2 && f2.fires === 1 && f2.lastOutcome && f2.lastOutcome.ok, 'the folder trigger kept its fire count + last outcome');
    A.ok(w2 && w2.enabled === false && w2.fires === 2, 'the webhook kept its disabled state + fire count');
    await sleep(1500);
    A.eq((await list()).find(t => t.id === fid).fires, 1, 'after the restart the already-fired file does NOT refire');
    fs.writeFileSync(path.join(drops, 'invoice-43.txt'), 'INVOICE 43');
    const f3 = await waitFor(async () => { const t = (await list()).find(x => x.id === fid); return t && t.fires === 2 && t.lastOutcome && /invoice-43/.test(t.lastOutcome.source || '') ? t : null; }, 30000, 'a new file after the restart');
    A.ok(f3 && f3.lastOutcome.ok, 'a file dropped after the restart fires and runs the line');

    /* ---- 5. DELETE ---- */
    const del = await api('/api/routing/triggers/' + wid, 'DELETE');
    A.ok(del.status === 200 && del.j.ok, 'DELETE removes the webhook trigger');
    A.ok(!(await list()).some(t => t.id === wid), 'and it is gone from the listing');
    A.eq((await api('/api/routing/triggers/' + wid, 'PATCH', { enabled: true })).status, 404, 'a deleted trigger is a 404');
  } finally {
    if (sse) sse.close();
    await stop(child);
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.triggers.e2e.test');
})().catch(e => { console.log('FAIL: routing.triggers.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
