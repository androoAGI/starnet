/* node test/nightshift-floor-visibility.e2e.test.js — real sidecar proof that a SELF-INITIATED night-shift
   beat is VISIBLE on the station floor while it runs (2026-07-18 fix).

   The escape this pins: the beat's broadcast opt-in (added 2026-07-14) reached only the ACT path —
   the reason-only runs (propose/do/critique, the DEFAULT-leash path) went through nightshiftChat with a
   local sink and no SSE tee, so the station showed an idle wandering agent while the harness provably
   worked, then a surprise "drafted while you were away" toast. The crate was just as wrong: placed AFTER
   the draft landed, keyed to a runId no run.end ever settles (queue depth leaked +1 per draft forever).

   Proven here over the REAL SSE bridge (/api/channels/events), mock provider, forced beat:
     · agent.run.start with trigger 'nightshift' reaches SSE (the world.js work-pose binding consumes this).
     · a night-shift work-item crate rides BEFORE the beat finishes (placed while runs are still live).
     · the crate settles: workitem.delivered fires and the queue depth returns to 0 (no leak). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter for the REASON-ONLY beat: three text-only calls (propose → do → critique), matched on the
// distinctive template line each directive carries (autopilot.js builders).
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = String((userMsg && userMsg.content) || '');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          if (/SELF-REVIEW/.test(prompt)) {
            text('VERDICT: ship\nNOTE: solid');
          } else if (/Do this ONE job now/.test(prompt)) {
            text('TITLE: Beta launch checklist\nA real draft body the Commander can read.');
          } else if (/Propose up to/.test(prompt)) {
            text(['JOB: Beta launch checklist', 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a checklist draft toward the beta'].join('\n'));
          } else {
            text('ok');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}

// attach the REAL SSE bridge (the exact stream the station HUD consumes) and accumulate parsed events.
function attachSse(B, token) {
  const ac = new AbortController();
  const events = [];
  const done = fetch(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token), { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        while (true) {
          const { value, done: d } = await reader.read(); if (d) break;
          buf += dec.decode(value, { stream: true });
          let nl; while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (line.indexOf('data: ') === 0) { try { const e = JSON.parse(line.slice(6)); if (e && e.name) events.push(e); } catch (_) {} }
          }
        }
      } catch (_) { /* aborted at teardown */ }
    }).catch(() => {});
  return { events, close: () => { try { ac.abort(); } catch (_) {} return done; } };
}

function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return {
    known: ['goals', 'pain', 'stack', 'ambition'],
    beliefs: {
      goals: b('ship the StarNet beta to 100 users'),
      pain: b('manual release notes eat my fridays'),
      stack: b('node and a pixel-art canvas'),
      ambition: b('a living agent station people watch')
    }
  };
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsvis-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nsvis-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    sse = attachSse(B, token);
    await sleep(300);   // let the SSE stream open before the beat fires

    // reach 'observe' → the REASON-ONLY draft path (the default-leash lane this fix is about).
    const post = await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) }) });
    A.ok(post.status === 200, 'posture set (leash / observe) with a hot dossier');

    const res = await fetch(B + '/api/nightshift/beat', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent' }) });
    const stream = await readNdjson(res);
    const result = ((stream.find(e => e.name === 'nightshift.beat.result') || {}).payload || {});
    A.ok(result.delivered === true && result.reason === 'delivered', 'the reason-only beat delivered a draft (mock propose→do→critique): ' + JSON.stringify(result));

    await sleep(500);   // let the SSE tail (settle events) flush
    const ev = sse.events.slice();

    // ── 1. the run lifecycle reached the floor: agent.run.start with trigger 'nightshift' over REAL SSE.
    //      (world.js binds the work pose to any non-'directive' trigger — this event is what sends the body
    //      to its workstation; before the fix ZERO nightshift run.start events reached SSE on this path.)
    const starts = ev.filter(e => e.name === 'agent.run.start' && e.payload && e.payload.trigger === 'nightshift');
    A.ok(starts.length >= 1, "agent.run.start{trigger:'nightshift'} teed to SSE (" + starts.length + ' seen) — the floor can pose the body');

    // ── 2. the crate rode WHILE the work ran: workitem.placed (night-shift preview) arrives BEFORE the last
    //      nightshift run.end (the DO/critique runs execute after placement — pending work is visible live).
    const placedIdx = ev.findIndex(e => e.name === 'workitem.placed' && e.payload && /^✦ autonomy: /.test(String(e.payload.preview || '')));
    A.ok(placedIdx >= 0, 'an autonomy work-item crate was placed on the conveyor');
    A.ok(ev[placedIdx].payload.kind === 'cron' && ev[placedIdx].payload.agentId === 'agent', 'the crate is agent-bound autonomous work (kind cron, agentId agent)');
    let lastEndIdx = -1;
    for (let i = 0; i < ev.length; i++) if (ev[i].name === 'agent.run.end') lastEndIdx = i;
    A.ok(lastEndIdx > placedIdx, 'the crate was placed BEFORE the beat\'s last run ended (pending work visible while working, not after)');

    // ── 3. the crate SETTLES: delivered fires and the queue drains to 0 (the old path leaked +1 per draft).
    A.ok(ev.some(e => e.name === 'workitem.delivered' && e.payload && e.payload.agentId === 'agent'), 'the crate settled as delivered (the draft genuinely landed)');
    const depths = ev.filter(e => e.name === 'queue.status' && e.payload && e.payload.queueId === 'agent').map(e => e.payload.depth | 0);
    A.ok(depths.some(d => d >= 1), 'the queue depth rose while the beat worked (real backpressure, not a hardcoded 0)');
    A.eq(depths[depths.length - 1], 0, 'the queue depth returned to 0 after the beat (no leaked slot)');

  } finally {
    if (sse) await sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-floor-visibility.e2e.test');   // prints the tally and exits 1 on any FAIL above
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
