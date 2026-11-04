'use strict';
/* node test/workflow-project-multibay.e2e.test.js — #25 trusted workflow projects × multi-bay agents.
   One agent ("writer") staffs a bay on TWO lines, each line's INBOX carrying its own trusted project. A routine
   that fires at writer's bay on line B must run BOTH of line B's stages in project B. The first cut of #25
   resolved the line with the one-argument lineOfAgent (writer's FIRST line) and checked membership against
   line.agents, which lists writer under line A only: the entry stage ran in project A and the hop refused with
   "The workflow changed". Real sidecar, real tools, real files; the model is a local simulated provider. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
(async () => {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const recent = body.messages.slice(body.messages.findLastIndex(m => m.role === 'user') + 1);
    const results = recent.filter(m => m.role === 'tool');
    const toolNames = (body.tools || []).map(t => t.function.name);
    const file = String(body.model).replace(/-model$/, '') + '.txt';
    const call = !toolNames.includes('fs_write') ? null : results.length === 0 ? { name: 'brief_proceed', args: { objective: 'write and read a file', deliverable: 'a saved file with a read receipt', assumptions: ['The selected folder is trusted'] } } : results.length === 1 ? { name: 'fs_write', args: { path: file, content: 'multibay project proof' } }
      : results.length === 2 ? { name: 'fs_read', args: { path: file } } : null;
    const delta = call ? { tool_calls: [{ index: 0, id: 'proof-' + results.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'The file was written and read back.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 30000, env: {
    STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_OPENROUTER_BASE: base + '/v1', SKYNET_OPENROUTER_BASE: base + '/v1',
    STARNET_FULL_ACCESS: '0', SKYNET_FULL_ACCESS: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-project-a-'));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-project-b-'));
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1,
      allow: ['path:' + fs.realpathSync(projA), 'path:' + fs.realpathSync(projB), 'cabinet:write'], meta: {} }));
    await fixture.start();
    const agents = ['writer', 'hop'].map(agentId => ({ agentId, name: agentId, provider: 'openrouter', model: agentId + '-model', executionProfile: 'trusted-project' }));
    await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() });
    // line A (y=0): INBOX(A) -> writer -> OUTBOX     line B (y=4): INBOX(B) -> writer -> hop -> OUTBOX
    const geometry = { props: [
      { id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1, projectRoot: projA },
      { id: 'a1', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer' },
      { id: 'oA', t: 'outbox', x: 6, y: 0, w: 1, h: 1 },
      { id: 'iB', t: 'intake', x: 0, y: 4, w: 1, h: 1, projectRoot: projB },
      { id: 'b1', t: 'bay', x: 3, y: 4, w: 1, h: 1, agentId: 'writer' },
      { id: 'b2', t: 'bay', x: 6, y: 4, w: 1, h: 1, agentId: 'hop' },
      { id: 'oB', t: 'outbox', x: 9, y: 4, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })).concat([1, 2, 4, 5, 7, 8].map(x => ({ x, y: 4, dir: 'E' }))) };
    const { plan } = await publishFloor(fixture, floorOf(geometry, { equip: ['computer', 'cabinet'] }), { label: 'the two-line floor' });   // saved, then published as the page does
    assert.equal((plan.errors || []).length, 0, JSON.stringify(plan.errors));
    const lineB = plan.lines.find(l => l.projectRoot === projB);
    assert.ok(lineB && plan.lines.some(l => l.projectRoot === projA), 'two lines, each with its own project');

    const routine = await fixture.json('POST', '/api/cron', { name: 'Line B', prompt: 'Write a file and read it back.', schedule: 'every 1h', agentId: 'writer', dockId: 'b1', model: 'writer-model', provider: 'openrouter', runsLine: true });
    assert.ok(routine.body.job?.id, routine.text);
    const run = await fixture.json('POST', '/api/cron/run', { id: routine.body.job.id });
    assert.ok(!run.text.includes('The workflow changed'), 'the hop is not refused as a foreign line: ' + run.text.slice(0, 400));
    assert.ok(!run.text.includes('agent.run.error'), run.text.slice(0, 400));
    // LINE WATCH: the entry run's OWN start (the loop's normal path, not an early exit) names the bay it fired at, so the
    // floor lights b1 — never writer's other bay, which is what pairing by 'oldest crate' does to a multi-bay agent.
    const starts = text => text.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(e => e && e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'writer');
    const bStarts = starts(run.text);
    assert.ok(bStarts.length >= 1 && bStarts.every(e => e.payload.dockId === 'b1'), 'the entry run.start names bay b1: ' + JSON.stringify(bStarts.map(e => e.payload)));
    const rows = (await fixture.json('GET', '/api/runs?agent=*')).body.runs.filter(r => r.surface === 'autonomous');
    const rootB = fs.realpathSync(projB), rootA = fs.realpathSync(projA);
    assert.ok(rows.some(r => r.agentId === 'writer' && r.projectRoot === rootB), 'the entry stage ran in line B\'s project');
    assert.ok(rows.some(r => r.agentId === 'hop' && r.projectRoot === rootB), 'the hop ran in line B\'s project');
    assert.ok(!rows.some(r => r.projectRoot === rootA), 'nothing ran in line A\'s project');
    for (const id of ['writer', 'hop']) assert.equal(fs.readFileSync(path.join(projB, id + '.txt'), 'utf8'), 'multibay project proof', id + ' wrote into project B');
    assert.equal(fs.readdirSync(projA).length, 0, 'project A is untouched');
    // Run Now of a routine with NO saved bay works at its crate's bay (the agent's entry bay), exactly like a scheduled
    // fire. A duplicate dockId key in the Run Now call used to override the crate's bay with undefined.
    const plain = await fixture.json('POST', '/api/cron', { name: 'No bay', prompt: 'Write a file and read it back.', schedule: 'every 1h', agentId: 'writer', model: 'writer-model', provider: 'openrouter' });
    assert.ok(plain.body.job?.id, plain.text);
    const plainRun = await fixture.json('POST', '/api/cron/run', { id: plain.body.job.id });
    assert.ok(!plainRun.text.includes('agent.run.error'), plainRun.text.slice(0, 400));
    const plainStarts = starts(plainRun.text);
    assert.ok(plainStarts.length === 1 && ['a1', 'b1'].includes(plainStarts[0].payload.dockId), 'a no-bay Run Now names its crate\'s bay: ' + JSON.stringify(plainStarts.map(e => e.payload)));
    const plainRow = (await fixture.json('GET', '/api/runs?agent=*')).body.runs.find(r => r.runId === plainStarts[0].payload.runId);
    assert.equal(plainRow && plainRow.dockId, plainStarts[0].payload.dockId, 'its run row records the same bay');
    console.log('workflow-project-multibay: OK — a multi-bay agent\'s routine runs its own line\'s project through every stage');
  } finally { await fixture.dispose();
    for (const p of [projA, projB]) {
      assert.equal(path.dirname(p), os.tmpdir());
      fs.rmSync(p, { recursive: true, force: true });
    }
    server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
