/* node test/loops-endurance.e2e.test.js — process-level endurance proof for standing autonomy.

   Safe local fixture only: a localhost OpenRouter double performs a two-turn read-only run
   (station.inspect -> final synthesis) and deliberately leaves the synthesis stream hung. The test kills and
   restarts the real sidecar around that durable boundary, then proves:
     - restart never auto-replays the provider call or leaves a false RUNNING row;
     - the run journal preserves provider-valid context and exposes no false completed run;
     - explicit RESUME starts exactly one replacement pass;
     - targeted PAUSE is immediate/idempotent even when the provider ignores cancellation;
     - PAUSED survives another restart with no duplicate work.

   No real provider, connector, external message, project, credential, or user workspace is touched. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function startProvider() {
  const state = { mode: 'hang-after-read', calls: [], hanging: new Set() };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'test/endurance', context_length: 16000,
        pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools']
      }] }));
      return;
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      state.calls.push({ mode: state.mode, messages });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

      if (state.mode === 'complete') {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'DIGEST: 1 findings — recovered exactly once' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const hasToolResult = messages.some(message => message && message.role === 'tool');
      if (!hasToolResult) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'inspect-1', type: 'function', function: { name: 'station_inspect', arguments: '{}' }
        }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // A byte proves the second provider turn is live, but no finish marker ever arrives. Keeping the response
      // open reproduces a provider/tool that does not settle before process restart or targeted cancellation.
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'continuing after inspection…' } }] }) + '\n\n');
      state.hanging.add(res);
      res.once('close', () => state.hanging.delete(res));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    state,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1',
    close() {
      for (const response of state.hanging) { try { response.destroy(); } catch (_) {} }
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      try { server.close(); } catch (_) {}
    }
  })));
}

async function until(fixture, predicate, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last = null;
  while (Date.now() < deadline) {
    const response = await fixture.json('GET', '/api/loops');
    last = response.body;
    if (response.status === 200 && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error('timed out waiting for ' + label + '; last=' + JSON.stringify(last));
}

(async () => {
  const provider = await startProvider();
  const fixture = SidecarFixture.create({
    prefix: 'starnet-loop-endurance-',
    timeoutMs: 12000,
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-endurance-fake',
      SKYNET_DEFAULT_MODEL: 'test/endurance',
      SKYNET_LOOP_TICK_MS: '1000',
      SKYNET_FULL_ACCESS: '1',
      SKYNET_AUX_BUDGET: '0'
    }
  });

  try {
    await fixture.start();
    const restartObjective = 'inspect local station state in multiple steps and report once';
    const cancelObjective = 'inspect then wait for cancellation';
    const loopCalls = objective => provider.state.calls.filter(call => {
      const users = call.messages.filter(message => message && message.role === 'user');
      return users.length > 0 && userWords(users[0]).indexOf(objective) === 0;
    }).length;
    const created = await fixture.json('POST', '/api/loops', {
      name: 'endurance restart fixture',
      objective: restartObjective,
      model: 'test/endurance', provider: 'openrouter', queueCap: 1
    });
    A.eq(created.status, 200, 'the local endurance loop was created');
    const loopId = created.body.loop.id;

    await until(fixture, body => body.inFlight === 1 && loopCalls(restartObjective) >= 2,
      'the two-turn pass to hang after its read-only tool result', 20000);
    const callsBeforeCrash = loopCalls(restartObjective);
    const preCrash = (await fixture.json('GET', '/api/loops')).body;
    A.eq(preCrash.loops[0].recent[0].outcome, 'running', 'precondition: the durable ledger says the pass is running');

    await fixture.crash();
    await fixture.start();
    A.eq(loopCalls(restartObjective), callsBeforeCrash, 'sidecar restart itself does not replay a provider call');

    const recovered = await until(fixture,
      body => body.loops[0] && body.loops[0].state === 'paused' && body.loops[0].recent[0].outcome === 'cancelled',
      'boot reconciliation to pause the interrupted pass', 12000);
    A.eq(recovered.inFlight, 0, 'restart clears false live-run telemetry');
    A.ok(/restart|interrupted/i.test(recovered.loops[0].stopReason || ''), 'the recovery pause names why it stopped');
    A.eq(loopCalls(restartObjective), callsBeforeCrash, 'reconciliation duplicates no provider/tool side effect');

    const journal = await fixture.json('GET', '/api/run-recoveries');
    A.eq(journal.status, 200, 'the interrupted run journal is readable after restart');
    A.eq(journal.body.recoveries.length, 1, 'exactly one interrupted run is retained');
    A.eq(journal.body.recoveries[0].status, 'resumable', 'paired read-only tool intent/result is classified resumable');
    const roles = journal.body.recoveries[0].checkpoint.messages.map(message => message.role);
    A.ok(roles.includes('user') && roles.includes('assistant') && roles.includes('tool'),
      'the recovery checkpoint preserves the multi-step provider context');
    A.eq(journal.body.recoveries[0].uncertain.length, 0, 'no side effect is falsely labelled uncertain');

    const runsAfterCrash = await fixture.json('GET', '/api/runs?agent=agent&limit=20');
    // Run history now lists a run the process died inside as reason 'interrupted' (Step 2 journal lane) — honest, and
    // never a completion. The invariant is that nothing claims the pass finished.
    A.eq(runsAfterCrash.body.runs.filter(run => run.reason !== 'interrupted').length, 0, 'the interrupted pass is not falsely recorded as completed');

    provider.state.mode = 'complete';
    const resume = await fixture.json('POST', '/api/loops/control', { id: loopId, action: 'resume' });
    A.eq(resume.status, 200, 'explicit RESUME is accepted');
    const callsAtResume = loopCalls(restartObjective);
    const resumed = await until(fixture, body => body.loops[0] && body.loops[0].pendingCount === 1,
      'one replacement pass to complete', 12000);
    A.eq(loopCalls(restartObjective), callsAtResume + 1, 'RESUME launches exactly one replacement provider pass');
    const replacementPrompt = provider.state.calls.filter(call => {
      const users = call.messages.filter(message => message && message.role === 'user');
      return users.length && userWords(users[0]).indexOf(restartObjective) === 0;
    }).slice(-1)[0];
    // The transcript is written per turn now (Step 2), so the interrupted pass's own directive + paired tool turn are
    // real history the replacement is seeded with. The fence belongs to the replacement's OWN directive: the last
    // user turn of that call.
    const replacementUsers = replacementPrompt ? replacementPrompt.messages.filter(message => message && message.role === 'user') : [];
    const replacementText = String((replacementUsers[replacementUsers.length - 1] || {}).content || '');
    A.ok(/INTERRUPTED PASSES/.test(replacementText) && /inspect and verify current state/i.test(replacementText),
      'the replacement prompt carries the durable lost-context/duplicate-effect fence');
    A.eq(resumed.loops[0].recent.filter(row => row.outcome === 'running').length, 0, 'no abandoned RUNNING row survives');
    A.eq(resumed.loops[0].recent.filter(row => row.outcome === 'cancelled').length, 1, 'the interruption stays explicit in history');
    A.eq(resumed.loops[0].recent.filter(row => row.outcome === 'candidate').length, 1, 'only the replacement becomes reviewable');
    await fixture.json('POST', '/api/loops/control', { id: loopId, action: 'stop' });

    // Targeted cancellation: a second two-turn pass hangs, then PAUSE must become terminal immediately. Repeating
    // PAUSE is an idempotent no-op, and the quiet state must survive another real sidecar restart.
    provider.state.mode = 'hang-after-read';
    const second = await fixture.json('POST', '/api/loops', {
      name: 'endurance cancellation fixture', objective: cancelObjective,
      model: 'test/endurance', provider: 'openrouter', queueCap: 1
    });
    const secondId = second.body.loop.id;
    const secondStartCalls = loopCalls(cancelObjective);
    await until(fixture, body => body.inFlight === 1 && loopCalls(cancelObjective) >= secondStartCalls + 2,
      'the cancellation fixture to hang', 20000);

    const pause = await fixture.json('POST', '/api/loops/control', { id: secondId, action: 'pause' });
    A.eq(pause.status, 200, 'targeted PAUSE is accepted while the provider is hung');
    A.eq(pause.body.loop.state, 'paused', 'PAUSE is immediately authoritative');
    A.eq(pause.body.loop.recent[0].outcome, 'cancelled', 'the hung pass is immediately terminal, not RUNNING');
    const pausedCalls = loopCalls(cancelObjective);
    const pauseAgain = await fixture.json('POST', '/api/loops/control', { id: secondId, action: 'pause' });
    A.eq(pauseAgain.status, 200, 'repeating PAUSE is idempotent');
    A.eq(pauseAgain.body.loop.recent.length, 1, 'idempotent PAUSE creates no duplicate ledger row');
    await sleep(500);
    A.eq(loopCalls(cancelObjective), pausedCalls, 'a cancelled hung pass never restarts itself');

    await fixture.restart();
    const afterPauseRestart = (await fixture.json('GET', '/api/loops')).body;
    const pausedLoop = afterPauseRestart.loops.find(loop => loop.id === secondId);
    A.eq(pausedLoop.state, 'paused', 'PAUSED survives a second real sidecar restart');
    A.eq(pausedLoop.recent[0].outcome, 'cancelled', 'its terminal cancellation checkpoint survives restart');
    A.eq(loopCalls(cancelObjective), pausedCalls, 'the paused restart produces no duplicate provider calls');

    A.report('loops endurance e2e (restart/cancel/resume/idempotency)');
  } finally {
    await fixture.dispose();
    provider.close();
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
