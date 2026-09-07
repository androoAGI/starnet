/* node test/loops.e2e.test.js — LIVE proof of the LOOP subsystem (standing objectives, S1).

   Boots the REAL sidecar against a mock OpenRouter and walks the whole product claim end to end:

     · a created loop ARMS ITSELF (no arm ceremony) and fires a real iteration through runOnce
     · the iteration's prompt carries the standing objective
     · it stacks candidates up to queueCap, then PARKS — and no amount of waiting fires it
     · the Commander's VERDICT is what starts the next iteration (the whole thesis)
     · a REJECTION cascades to everything stacked on top of it, and its reason is fed into the
       NEXT iteration's prompt (the loop's memory — without this it re-finds the same bug forever)
     · an honest NOTHING-TO-DO parks the loop DORMANT instead of burning money forever
     · the whole record survives a process restart
     · POST /api/halt durably stands loops down, and the halt SURVIVES a restart

   The mock's reply is scripted per-request so a test can make an iteration converge on demand. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* the mock provider. `script` is a queue of reply strings; when it runs dry the default is reused. Every
   received prompt is captured so the test can assert what the loop actually sent the model. */
function startMockOpenRouter(defaultReply) {
  const prompts = [];
  const script = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const user = (parsed.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
            prompts.push(user);
          } catch (_) { prompts.push(''); }
          const reply = script.length ? script.shift() : defaultReply;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, prompts, script, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
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
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

// poll GET /api/loops until `pred` holds or we give up — the driver ticks on its own schedule, so the test
// waits on OBSERVED state rather than guessing a sleep long enough to be flaky.
async function until(B, headers, pred, label, ms) {
  const deadline = Date.now() + (ms || 12000);
  let last = null;
  while (Date.now() < deadline) {
    const r = await fetch(B + '/api/loops', { headers });
    last = await r.json();
    if (pred(last)) return last;
    await sleep(200);
  }
  A.ok(false, 'timed out waiting for: ' + label + ' — last state ' + JSON.stringify(last && last.loops && last.loops[0]));
  return last;
}

(async () => {
  const mock = await startMockOpenRouter('Fixed the null dereference in auth.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loops-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-loops-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_LOOP_TICK_MS: '1000',        // a brisk tick so the walk finishes in seconds
    SKYNET_FULL_ACCESS: '1'
  };
  let child, port;
  try {
    /* Count only the LOOP's own model calls. The sidecar makes its own internal calls against the same mock
       (the post-run aux passes: background skill review, scout interests extraction), and those prompts EMBED
       the run's transcript / recent-activity titles — which contain the objective. So a substring match counted
       them as loop spend, and that was this test's one flake: the skill-review pass launched at the end of the
       FINAL pre-dormancy iteration is fire-and-forget, so ~8% of runs (worse under gate load) its mock hit
       landed only AFTER the driver's settle had written 'dormant' and this test had snapshotted — reading as
       "a dormant loop spent money" when the loop subsystem had provably stopped (instrumented timeline proof,
       2026-07-30: the trailing prompt began "You are StarNet background skill review", never with the
       objective or a <loop_ledger>). An iteration prompt is the ONLY prompt that BEGINS with the objective
       (loopjob-driver buildMessages puts the objective first; every aux prompt opens with its own scaffolding),
       so the counter anchors at position 0 — it still counts every real iteration, including any that would
       illegally fire after dormancy/halt, which keeps the money guards below fully armed. */
    const OBJ = 'find and fix bugs in the portfolio site';
    const loopCalls = () => mock.prompts.filter(p => p.indexOf(OBJ) === 0).length;

    ({ child, port } = await boot(8990 + (process.pid % 25), env, 20));
    let B = 'http://' + HOST + ':' + port;
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // ---- a station with no loops pays no timer ----------------------------------------------------------
    const empty = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(empty.loops.length, 0, 'a fresh station has no loops');
    A.eq(empty.armed, false, 'and arms no timer — a loopless station costs nothing');

    // ---- create: no arm ceremony, it just goes ----------------------------------------------------------
    const created = await fetch(B + '/api/loops', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'bug sweep', objective: 'find and fix bugs in the portfolio site', queueCap: 2, model: 'test/model', provider: 'openrouter' })
    });
    A.eq(created.status, 200, 'the loop was created');
    const loopId = (await created.json()).loop.id;
    A.ok(loopId, 'and returned an id');

    // ---- it fires on its own, and stacks up to queueCap --------------------------------------------------
    let st = await until(B, headers, s => s.loops[0] && s.loops[0].pendingCount >= 1, 'the first candidate');
    A.eq(st.armed, true, 'creating a loop IS the arming action — no second switch');
    A.ok(loopCalls() >= 1, 'a real model call was made through runOnce');
    A.ok(loopCalls() >= 1 && mock.prompts.some(x => x.indexOf(OBJ) >= 0), 'the standing objective is the directive');
    A.eq(st.loops[0].pending[0].title, 'Fixed the null dereference in auth.js', 'the candidate carries what the agent actually did');

    st = await until(B, headers, s => s.loops[0].state === 'waiting', 'the loop to park on a full queue');
    A.eq(st.loops[0].pendingCount, 2, 'it stacked exactly queueCap candidates');
    A.eq(st.loops[0].binding, 'queue-full', 'and names the queue as the reason it went quiet');
    A.ok(/waiting on your review/.test(st.loops[0].stopReason || ''), 'in words a beginner can read');

    // ---- INVARIANT: no clock advances a parked loop ------------------------------------------------------
    const callsAtPark = loopCalls();
    await sleep(3500);   // several tick periods
    const stillParked = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(stillParked.loops[0].pendingCount, 2, 'waiting through several ticks changes nothing');
    A.eq(loopCalls(), callsAtPark, 'and costs ZERO further model calls — a parked loop does not spend');

    // ---- INVARIANT: the VERDICT is the trigger -----------------------------------------------------------
    mock.script.push('Removed the dead retry branch');
    const approve = await fetch(B + '/api/loops/verdict', {
      method: 'POST', headers, body: JSON.stringify({ id: loopId, n: 1, verdict: 'approved' })
    });
    A.eq(approve.status, 200, 'the verdict was accepted');
    A.eq((await approve.json()).cascaded.length, 0, 'an approval cascades to nothing');
    // Wait on the OBSERVABLE consequence — a new loop model-call — rather than on an iteration counter a
    // pre-park iteration could already have satisfied. That proxy made this assertion flaky under load.
    st = await until(B, headers, () => loopCalls() > callsAtPark, 'the verdict to start the next iteration');
    A.ok(loopCalls() > callsAtPark, 'the Commander\'s click is what spent the next dollar');

    // ---- a double verdict on the same iteration is refused -----------------------------------------------
    const again = await fetch(B + '/api/loops/verdict', {
      method: 'POST', headers, body: JSON.stringify({ id: loopId, n: 1, verdict: 'rejected' })
    });
    A.eq(again.status, 409, 'an already-ruled iteration cannot be silently re-ruled');

    // ---- INVARIANT: rejection cascades, and TEACHES the next iteration -----------------------------------
    st = await until(B, headers, s => s.loops[0].state === 'waiting', 'the queue to fill again');
    const oldest = st.loops[0].pending[0].n;
    const stacked = st.loops[0].pendingCount - 1;
    const reject = await fetch(B + '/api/loops/verdict', {
      method: 'POST', headers,
      body: JSON.stringify({ id: loopId, n: oldest, verdict: 'rejected', note: 'never touch the build config' })
    });
    A.eq(reject.status, 200, 'the rejection was accepted');
    A.eq((await reject.json()).cascaded.length, stacked, 'and reports exactly what it discarded (' + stacked + ' stacked above)');

    const promptsBefore = loopCalls();
    await until(B, headers, () => loopCalls() > promptsBefore, 'the next iteration after a rejection');
    const taught = mock.prompts.filter(x => x.indexOf(OBJ) >= 0).pop();
    A.ok(/never touch the build config/.test(taught), 'THE REJECTION REASON IS IN THE NEXT PROMPT — the loop has memory');
    A.ok(/NOTHING-TO-DO/.test(taught), 'and the convergence escape hatch is offered every iteration');

    // ---- INVARIANT: convergence is real -------------------------------------------------------------------
    // Flip the loop to gate:'auto' — the Commander's "you have full access to merge" mode. It applies its own
    // work, so it never builds a review queue and can therefore run freely to convergence. Proving the mode
    // live AND clearing the queue in one step; a review-gated loop would just park on the queue forever here.
    const flipped = await fetch(B + '/api/loops/update', {
      method: 'POST', headers, body: JSON.stringify({ id: loopId, patch: { gate: 'auto' } })
    });
    A.eq(flipped.status, 200, 'the loop was switched to full-access (auto-merge) mode');
    A.eq((await flipped.json()).loop.gate, 'auto', 'and reports the new mode');
    // every remaining pass honestly declares it found nothing left to do
    for (let i = 0; i < 12; i++) mock.script.push('I swept the whole project. NOTHING-TO-DO');
    st = await until(B, headers, s => s.loops[0].state === 'dormant', 'the loop to converge to DORMANT', 20000);
    A.eq(st.loops[0].state, 'dormant', 'consecutive honest NOTHING-TO-DO passes park the loop');
    A.eq(st.loops[0].binding, 'dormant', 'and the binding says so');
    A.ok(/nothing left to do/.test(st.loops[0].stopReason || ''), 'in plain words');
    /* THE 24/7 MONEY GUARD. Once STATUS reads 'dormant', no further loop iteration may spend. This is
       deterministic, not a race: decide() gates state==='dormant' before anything else, the per-loop lease
       means no pass can still be in flight when dormant is visible (dormant is written by the settle of the
       last pass, and that pass's model call necessarily landed BEFORE its settle), and loopCalls() counts
       ITERATION prompts only (see its comment) — so one extra count here would be a real product regression,
       never test noise. Do NOT relax this assertion. */
    const callsAtDormant = loopCalls();
    const itersAtDormant = st.loops[0].iterationCount;
    await sleep(3000);
    A.eq(loopCalls(), callsAtDormant, 'a dormant loop spends NOTHING — this is the 24/7 money guard');
    const stillDormant = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(stillDormant.loops[0].state, 'dormant', 'and it STAYED dormant through the wait');
    A.eq(stillDormant.loops[0].iterationCount, itersAtDormant, 'with not one new iteration started');

    // ---- the record survives a restart --------------------------------------------------------------------
    const beforeRestart = (await (await fetch(B + '/api/loops', { headers })).json()).loops[0];
    try { child.kill(); } catch (_) {}
    await sleep(600);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B); headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const revived = (await (await fetch(B + '/api/loops', { headers })).json()).loops[0];
    A.eq(revived.id, beforeRestart.id, 'the loop survived the restart');
    A.eq(revived.state, 'dormant', 'still dormant — a converged loop does not quietly resume itself');
    A.eq(revived.iterationCount, beforeRestart.iterationCount, 'with its full iteration count');
    A.eq(revived.approvedCount, beforeRestart.approvedCount, 'and its verdict history');

    // ---- RESUME clears the streak but KEEPS the memory ----------------------------------------------------
    mock.script.length = 0;
    const resumed = await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: loopId, action: 'resume' }) });
    A.eq(resumed.status, 200, 'resume accepted');
    const rl = (await resumed.json()).loop;
    A.eq(rl.state, 'idle', 'resume lifts DORMANT');
    A.eq(rl.dryStreak, 0, 'and clears the streak so it does not instantly re-park');
    A.eq(rl.iterationCount, beforeRestart.iterationCount, 'but the loop KEEPS its memory');

    // ---- E-STOP: durable, and it survives a restart --------------------------------------------------------
    await until(B, headers, s => s.loops[0].iterationCount > beforeRestart.iterationCount, 'the resumed loop to work again');
    const halt = await fetch(B + '/api/halt', { method: 'POST', headers, body: '{}' });
    A.eq(halt.status, 200, 'E-STOP accepted');
    A.ok('loopAborted' in (await halt.json()), 'and reports how many loop iterations it aborted');
    let halted = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(halted.halted, true, 'loops are durably halted');
    A.eq(halted.armed, false, 'the timer came down');
    A.eq(halted.loops[0].binding, 'halted', 'and every loop names the E-STOP as its binding');

    const callsAtHalt = loopCalls();
    try { child.kill(); } catch (_) {}
    await sleep(600);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B); headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    await sleep(2500);
    halted = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(halted.halted, true, 'the E-STOP SURVIVED the restart — no self-resuming autonomy');
    A.eq(halted.armed, false, 'no timer armed at boot');
    A.eq(loopCalls(), callsAtHalt, 'and not one loop iteration happened after the halt');

    // ---- and it lifts only on an explicit unhalt -----------------------------------------------------------
    const un = await fetch(B + '/api/halt/resume', { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
    A.eq(un.status, 200, 'unhalt accepted');
    A.eq((await un.json()).halted, false, 'the durable halt is lifted');
    await until(B, headers, () => loopCalls() > callsAtHalt, 'work to resume after an explicit unhalt');

    // ---- stop + remove --------------------------------------------------------------------------------------
    const stopped = await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: loopId, action: 'stop' }) });
    A.eq((await stopped.json()).loop.state, 'stopped', 'a stopped loop reports stopped');
    const gone = await fetch(B + '/api/loops/remove', { method: 'POST', headers, body: JSON.stringify({ id: loopId }) });
    A.eq(gone.status, 200, 'the loop was removed');
    const after = await (await fetch(B + '/api/loops', { headers })).json();
    A.eq(after.loops.length, 0, 'and is gone from the list');
    A.eq(after.armed, false, 'with the timer stood back down');

    // ---- 404s on a loop that does not exist ------------------------------------------------------------------
    A.eq((await fetch(B + '/api/loops/verdict', { method: 'POST', headers, body: JSON.stringify({ id: 'nope', n: 1, verdict: 'approved' }) })).status, 404, 'a verdict on a missing loop 404s');
    A.eq((await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: 'nope', action: 'pause' }) })).status, 404, 'control on a missing loop 404s');

  } finally {
    try { child && child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }

  A.report('loops e2e (LIVE standing objectives)');
})().catch(e => { console.log('FAIL: unexpected throw — ' + (e && e.stack || e)); process.exit(1); });
