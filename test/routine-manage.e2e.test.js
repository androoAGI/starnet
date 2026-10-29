/* node test/routine-manage.e2e.test.js — real-sidecar proof for the routine.manage tool.

   test/routine-tools.test.js proves the TOOL's policy against injected fakes (reference resolution, the patch
   allowlist, the queued-not-run wording). That is not enough: the four store verbs live in index.js's injection
   bag, and a typo there is invisible to a unit test — the tool would still "succeed" and the routine would never
   change. So this boots the REAL sidecar, makes a real routine, and drives a real model turn that calls
   routine.manage, then reads the store back over HTTP to prove the edit landed.

   What it locks:
     1. the tool is actually PROJECTED into a browser-commanded (lead) run — a missing CAP_REGISTRY row would
        make it dark, and the model would be told the tool does not exist;
     2. consent is asked before standing autonomous work is mutated, and DENIAL changes nothing;
     3. an approved update reaches the cron store and is visible in GET /api/cron (read-back, not a claim);
     4. remove actually deletes;
     5. run_now RE-ANCHORS the next fire instead of running the routine inline.

   The provider is a mock that returns one tool_call and then a plain reply, which is how the other tool e2es
   drive a specific tool without a real model. */
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* A mock OpenRouter that decides from the REQUEST, not from a queue.

   A queue-driven mock desyncs here: a real run makes provider calls this test never asked for — reflection
   (runOnce sets reflect:true on every real-work host) fires its own aux completion after the run ends, and it
   would silently eat the next scripted turn, so run 3 would get run 2's script. Keying on the conversation
   instead makes each answer a pure function of what was actually asked:
     · a request that already carries a tool result  -> a plain final answer (the run must terminate);
     · otherwise the first `script` rule whose keyword appears in the last user message -> that tool call;
     · anything else (reflection, retitles, self-talk) -> a plain answer. */
function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    const hit = script.find(r => text.indexOf(r.when) >= 0);
    return hit || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (turn.tool) {
            res.write('data: ' + JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }]
            }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
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
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

/* Drive one browser-shaped run and collect its NDJSON. handleRun is the LEAD surface, so the orchestrator
   object (and therefore routine.manage) is conferred exactly as it is for the real COMMS window.

   Consent rides the SAME stream: an ungranted mutation emits permission.prompt and the run await-pauses until
   POST /api/consent answers it. `decide` is called with the prompt payload and returns the decision string. */
async function runWithConsent(B, headers, messages, decide) {
  const res = await fetch(B + '/api/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'test/model', provider: 'openrouter', agentId: 'agent', messages, system: 'you manage routines' })
  });
  A.eq(res.status, 200, 'the run stream opens');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [], runId = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'runId') runId = ev.payload && ev.payload.runId;
      if (ev.name === 'agent.run.start') runId = ev.payload && ev.payload.runId;
      if (ev.name === 'permission.prompt') {
        const decision = decide(ev.payload);
        // handleConsent looks the pending finisher up by runId FIRST (pendingByRun), so the answer must carry
        // both ids — a promptId alone silently matches nothing and the run stalls to its fail-closed deny.
        // fire-and-forget: the run is blocked on this answer, so awaiting it here would deadlock the reader.
        fetch(B + '/api/consent', {
          method: 'POST', headers,
          body: JSON.stringify({ runId: runId, promptId: ev.payload.promptId, decision: decision })
        }).catch(() => {});
      }
    }
  }
  return events;
}

const jobsOf = async (B, headers) => (await (await fetch(B + '/api/cron', { headers })).json()).jobs || [];

/* agent.tool_result carries the callId, NOT the tool name (shared/events.js) — so a result is correlated back
   to its agent.tool_call by callId, never by name. With no callId given, take the last result in the stream. */
function resultFor(events, callId) {
  const results = events.filter(e => e.name === 'agent.tool_result');
  if (callId) return results.find(e => e.payload && e.payload.callId === callId) || null;
  return results.length ? results[results.length - 1] : null;
}

(async () => {
  // one rule per phase, keyed on a distinctive word in that phase's user message
  const mock = await startMockOpenRouter([
    { when: 'rename the morning brief', tool: { name: 'routine.manage', args: { action: 'update', id: 'Morning brief', name: 'Renamed brief', prompt: 'summarize overnight markets' } } },
    { when: 'rename it again', tool: { name: 'routine.manage', args: { action: 'update', id: 'Renamed brief', name: 'Should not apply' } } },
    { when: 'fire it now', tool: { name: 'routine.manage', args: { action: 'run_now', id: 'Renamed brief' } } },
    { when: 'delete it', tool: { name: 'routine.manage', args: { action: 'remove', id: 'Renamed brief' } } }
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routine-manage-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-routine-manage-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // ---- a real routine to manage -----------------------------------------------------------------
    const create = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Morning brief', prompt: 'gather overnight news', schedule: '0 9 * * *', agentId: 'agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'a routine exists to manage');
    const job = (await create.json()).job;
    const firstNextRun = job.nextRunAt;

    // ---- 1. the tool is REACHABLE in a lead run, asks consent, and the edit lands -----------------
    {
      let asked = null;
      const events = await runWithConsent(B, headers, [{ role: 'user', content: 'rename the morning brief' }], (p) => { asked = p; return 'once'; });
      const names = events.map(e => e.name);

      A.ok(names.indexOf('agent.tool_call') >= 0, 'the model actually reached a tool (routine.manage was projected, not dark)');
      const started = events.find(e => e.name === 'agent.tool_call');
      A.eq(started.payload.name, 'routine.manage', 'the tool that ran is routine.manage');
      A.ok(asked, 'mutating standing autonomous work asked the Commander first');
      A.eq(asked.tool, 'routine.manage', 'the consent card names routine.manage');

      const ended = resultFor(events, started.payload.callId);
      A.ok(ended && !ended.payload.isError, 'the approved call succeeded: ' + JSON.stringify(ended && ended.payload).slice(0, 300));

      // READ-BACK, not a claim: the store itself must report the new name and prompt.
      const jobs = await jobsOf(B, headers);
      const now = jobs.find(j => j.id === job.id);
      A.ok(now, 'the routine still exists after an update');
      A.eq(now.name, 'Renamed brief', 'the host update verb reached the cron store (read back over HTTP)');
      A.eq(now.prompt, 'summarize overnight markets', 'the prompt patch persisted too');
    }

    // ---- 2. consent DENIAL must change nothing ----------------------------------------------------
    {
      const events = await runWithConsent(B, headers, [{ role: 'user', content: 'rename it again' }], () => 'no');
      const ended = resultFor(events);
      A.ok(ended && ended.payload.isError, 'a denied routine.manage returns an error to the model');
      const jobs = await jobsOf(B, headers);
      A.eq(jobs.find(j => j.id === job.id).name, 'Renamed brief', 'a DENIED edit left the routine untouched');
    }

    // ---- 3. run_now re-anchors the next fire; it does NOT run the routine -------------------------
    {
      const before = (await jobsOf(B, headers)).find(j => j.id === job.id);
      const events = await runWithConsent(B, headers, [{ role: 'user', content: 'fire it now' }], () => 'once');
      const ended = resultFor(events);
      A.ok(ended && !ended.payload.isError, 'run_now succeeded: ' + JSON.stringify(ended && ended.payload).slice(0, 300));
      const after = (await jobsOf(B, headers)).find(j => j.id === job.id);
      /* THE REGRESSION THIS PINS. The first cut used cronStore.resumeJob, which re-anchors the SCHEDULE: for
         `0 9 * * *` that recomputes 09:00 tomorrow — byte-identical to the old value — so run_now reported
         "queued to fire within a tick" about something a day away. The proof is not "it changed", it is that
         the stamped fire time is NOW-ish and no longer the schedule's own next occurrence. */
      A.ok(after.nextRunAt !== before.nextRunAt,
        'run_now changed the next fire time (' + before.nextRunAt + ' -> ' + after.nextRunAt + ')');
      const stamped = Date.parse(after.nextRunAt);
      A.ok(Math.abs(Date.now() - stamped) < 60000,
        'run_now stamped the next fire at NOW (within a minute), not at the schedule\'s next occurrence: ' + after.nextRunAt);
      A.ok(stamped < Date.parse(firstNextRun), 'the stamped fire is earlier than the routine\'s natural next run');
      // and it did NOT run inline: the scheduler is disarmed in this env, so nothing has fired yet either.
      A.eq(after.lastRunAt, null, 'run_now did NOT run the routine inline — lastRunAt is still unset, exactly as the tool reports');
    }

    // ---- 4. remove actually deletes ---------------------------------------------------------------
    {
      const events = await runWithConsent(B, headers, [{ role: 'user', content: 'delete it' }], () => 'once');
      const ended = resultFor(events);
      A.ok(ended && !ended.payload.isError, 'remove succeeded: ' + JSON.stringify(ended && ended.payload).slice(0, 300));
      const jobs = await jobsOf(B, headers);
      A.ok(!jobs.some(j => j.id === job.id), 'the routine is gone from the store');
    }
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routine-manage.e2e.test');
})().catch(e => { console.log('FAIL: routine-manage.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
