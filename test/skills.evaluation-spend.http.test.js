/* Real sidecar accounting regression. A finished response without usage is unknown
   spend, so the next paid evaluation must be refused before another provider call. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const guard = require('../sidecar/skills/guard.js');
const { digestOf } = require('../sidecar/skills/gate.js');
const { digestSkill } = require('../sidecar/skillevaluation.js');

const MODEL = 'evaluation-spend/local-script';
const NAME = 'Evaluation Spend Procedure';
const BASELINE = 'BASELINE_POLICY: Report the old result as JSON.';
const CANDIDATE = 'CANDIDATE_POLICY: Report the requested result as JSON.';
const SUITE = 'owner:evaluation-spend';
const requests = [], phases = [], faults = [];
let includeUsage = false;
function seed(workspace) {
  const rows = [];
  const store = makeSkillStore({ io: { readAll: () => [], append: row => rows.push(JSON.stringify(row)) },
    clock: { now: () => 1000 + rows.length }, guard, digest: digestOf, digestCandidate: digestSkill });
  const active = store.write({ agentId: 'agent', name: NAME, summary: 'Return the requested JSON value', body: BASELINE, createdBy: 'user' });
  assert.equal(active.ok, true);
  const proposed = store.write({ agentId: 'agent', name: NAME, summary: active.skill.summary, body: CANDIDATE, createdBy: 'background-review' });
  assert.equal(proposed.pending, true);
  fs.writeFileSync(path.join(workspace, 'skills.jsonl'), rows.join('\n') + '\n');
  return { skillId: active.skill.id, candidate: proposed.candidate };
}
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', part => { raw += part; });
  req.on('end', () => {
    try {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
      }
      const input = JSON.parse(raw), messages = input.messages || [];
      const system = String(messages.find(m => m.role === 'system')?.content || '');
      const prompt = String(messages.filter(m => m.role === 'user').at(-1)?.content || '');
      assert.equal(input.model, MODEL, 'provider dispatch uses only the isolated fixture model');
      assert.match(prompt, /^EVALUATION_SPEND:/, 'no unrelated background model work is admitted by the fixture');
      requests.push({ model: input.model, prompt, includeUsage });
      const value = Number(prompt.match(/value=(\d+)/)?.[1]);
      assert.ok([7, 19].includes(value), 'provider receives the declared task prompt');
      const result = { value: value + (system.includes('CANDIDATE_POLICY') ? 0 : 1) };
      const chunk = { choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }] };
      if (includeUsage) chunk.usage = { prompt_tokens: 30, completion_tokens: 10, cost: 0.01 };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      // An assertion thrown here never reaches the test's own try: record it so the run fails below.
      faults.push(error.message);
      console.error('scripted spend provider failed: ' + error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  const fixture = SidecarFixture.create({ prefix: 'skill-evaluation-spend-', timeoutMs: 30000, env: {
    STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEFAULT_MODEL: MODEL,
    STARNET_OPENROUTER_BASE: endpoint, SKYNET_OPENROUTER_BASE: endpoint,
    STARNET_OPENROUTER_KEY: 'local-fixture-only', SKYNET_OPENROUTER_KEY: 'local-fixture-only',
    STARNET_BUDGET_PER_DAY: '1', SKYNET_BUDGET_PER_DAY: '1',
    // no PER RUN cap: the shipped default is none, and that is what most stations evaluate with
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1',
    SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_REFLECT: '0', SKYNET_SCOUT: '0',
    SKYNET_QUEST_REFRESH: '0', SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0'
  } });
  const api = async (method, route, body, status = 200) => {
    const response = await fixture.json(method, route, body, { signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, status, route + ': ' + response.text.slice(0, 1200));
    return response.body;
  };
  try {
    const seeded = seed(fixture.workspace);
    await fixture.start();
    const sidecarPid = fixture.child.pid;
    const evaluate = () => api('POST', '/api/agent-skills/evaluate-candidate', {
      agentId: 'agent', candidateId: seeded.candidate.candidateId,
      candidateDigest: seeded.candidate.candidateDigest, suiteId: SUITE
    });
    await api('POST', '/api/agent-skills/evaluation-suite', { agentId: 'agent', skillId: seeded.skillId, suite: {
      id: SUITE, version: 1, description: 'Two exact JSON results, including an independent held-out case.',
      cases: [7, 19].map((value, i) => ({ id: 'result-' + i, heldOut: i === 1,
        prompt: 'EVALUATION_SPEND: Return only the JSON object with value=' + value + '.',
        checks: [{ id: 'exact-value', kind: 'json_equal', expected: { value } }]
      }))
    } });
    const initial = await api('GET', '/api/budget/status');
    assert.equal(initial.caps.perDay, 1, 'the fixture explicitly configures a strict one-dollar daily rail');
    assert.equal(initial.accounting.complete, true);
    assert.equal(initial.spentToday, 0);

    const incomplete = await evaluate();
    assert.equal(incomplete.receipt.status, 'insufficient_evidence', 'missing billing cannot create a passing evaluation receipt');
    assert.equal(requests.length, 1, 'the first uncertain charge prevents all remaining case dispatches');
    const unknown = await api('GET', '/api/budget/status');
    assert.equal(unknown.accounting.complete, false, 'unknown usage becomes station accounting authority immediately');
    assert.equal(unknown.accounting.readError, 'UNSETTLED_SPEND');
    assert.equal(unknown.accounting.durable, true, 'the durable dispatch receipt survives missing provider usage');
    assert.equal(unknown.spentToday, null, 'unknown spend is never presented as zero');
    // The pool counts the receipt's per-run ceiling; the actual charge stays unknown until attested.
    assert.deepEqual([unknown.day.usd, unknown.day.countedUsd, unknown.unknown], [null, 2, { items: 1, unbounded: 0, countedUsd: 2 }], 'the charge stays unknown while the day pool conservatively counts its $2 limit: ' + JSON.stringify(unknown.day));
    assert.equal(unknown.unsettled.length, 1);
    const unsettled = unknown.unsettled[0];
    assert.match(unsettled.runId, /^skill-eval-/);
    assert.doesNotMatch(unsettled.runId, /^skill-eval-skill-eval-/, 'the receipt id carries one skill-eval- namespace');
    assert.equal(unsettled.agentId, 'agent');
    assert.equal(unsettled.provider, 'openrouter');
    assert.equal(unsettled.model, MODEL);
    // skills-eval-06: with no PER RUN cap set (the shipped default), an evaluation run gets the station's ceiling for
    // a run nobody capped ($2, issue #53), never a fixed $0.08 that a premium model passes on its first call
    assert.equal(unsettled.runCapUsd, 2, 'an uncapped station gives each evaluation run the uncapped-run ceiling');
    // security-storage-07: the row says what it is (an evaluation, not an interrupted run) and the billing source the
    // host knew (the Commander's own key here, so not StarNet credits)
    assert.equal(unsettled.kind, 'evaluation');
    assert.equal(unsettled.title, 'skill evaluation (agent)');
    assert.equal(unsettled.managed, false, 'the billing source is known');
    phases.push('finished text without usage creates an immediately visible unsettled charge');

    const beforeBlocked = requests.length;
    const blocked = await evaluate();
    assert.equal(blocked.receipt.status, 'insufficient_evidence');
    assert.equal(requests.length, beforeBlocked, 'a separate evaluation request dispatches zero new provider calls: the run counted at its $2 limit passes the $1 day cap');
    assert.ok(blocked.receipt.cases.every(c => !c.before.completed && !c.after.completed));
    const stillUnknown = await api('GET', '/api/budget/status');
    assert.deepEqual(stillUnknown.unsettled.map(r => r.runId), [unsettled.runId], 'refused dispatches do not create phantom unsettled charges');
    // A conservative ceiling is not charge settlement: RESUME cannot clear unknown accounting.
    const refusedResume = await api('POST', '/api/budget/resume', { scope: 'day' }, 409);
    assert.equal(refusedResume.code, 'spend_history_unavailable');
    assert.equal(requests.length, beforeBlocked, 'refused RESUME dispatches no provider work');
    assert.equal(fixture.child.pid, sidecarPid, 'both refusal and accounting visibility are proved without restarting the sidecar');
    phases.push('strict daily rail blocks a fresh evaluation request before dispatch, before restart');

    // This explicit owner attestation is the fixture's stand-in for checking the
    // provider dashboard. It does not guess a charge from missing token usage.
    const reconciled = await api('POST', '/api/budget/settle', { runId: unsettled.runId, usd: 0.02 });
    assert.equal(reconciled.accounting.complete, true);
    assert.equal(reconciled.accounting.durable, true);
    assert.deepEqual(reconciled.unsettled, []);
    assert.equal(reconciled.spentToday, 0.02);
    assert.equal((await api('POST', '/api/budget/resume', { scope: 'day' })).cap, 2, 'explicit settlement restores ordinary pool resume');
    includeUsage = true;
    const recovered = await evaluate();
    assert.equal(recovered.receipt.status, 'passed', JSON.stringify(recovered.receipt));
    assert.equal(requests.length - beforeBlocked, 4, 'complete billing admits exactly two baseline and two candidate cases');
    const final = await api('GET', '/api/budget/status');
    assert.equal(final.accounting.complete, true);
    assert.equal(final.accounting.durable, true);
    assert.deepEqual(final.unsettled, []);
    assert.ok(Math.abs(final.spentToday - 0.06) < 1e-9, 'the attested charge and four observed charges are each booked exactly once');
    assert.equal(fixture.child.pid, sidecarPid, 'explicit settlement restores evaluation without restarting');
    phases.push('explicit settlement restores known spend and complete-usage evaluation in the same process');

    // skills-eval-06: a PER RUN cap the Commander saves in SPENDING LIMITS replaces that ceiling for the next evaluation
    await api('POST', '/api/budget/caps', { perRun: 0.25 });
    includeUsage = false;
    const beforeCapped = requests.length;
    const capped = await evaluate();
    assert.equal(capped.receipt.status, 'insufficient_evidence');
    assert.equal(requests.length - beforeCapped, 1, 'the uncertain charge stops the evaluation after one call');
    const cappedStatus = await api('GET', '/api/budget/status');
    assert.equal(cappedStatus.unsettled.length, 1);
    assert.equal(cappedStatus.unsettled[0].runCapUsd, 0.25, 'the evaluation run recorded the Commander\'s per-run cap');
    phases.push('a saved PER RUN cap bounds each evaluation run');
    assert.deepEqual(faults, [], 'the scripted provider served only the declared evaluation cases (no unrelated or background model work)');
    console.log(JSON.stringify({ status: 'PASS', test: 'skills.evaluation-spend.http', phases, modelCalls: requests.length }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', phases, error: error.stack, requests, faults, sidecarTail: fixture.output().slice(-5000) }, null, 2));
    process.exitCode = 1;
  } finally {
    await fixture.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.closeAllConnections(); server.close(); });
