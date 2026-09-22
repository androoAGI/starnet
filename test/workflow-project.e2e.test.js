'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
(async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw); calls.push(body);
    const recent = body.messages.slice(body.messages.findLastIndex(m => m.role === 'user') + 1);
    const results = recent.filter(m => m.role === 'tool');
    const toolNames = (body.tools || []).map(t => t.function.name);
    const file = body.model === 'entry-model' ? 'entry.txt' : 'hop.txt';
    const call = !toolNames.includes('fs_write') ? null : results.length === 0 ? { name: 'brief_proceed', args: { objective: 'write and read a file', deliverable: 'a saved file with a read receipt', assumptions: ['The selected folder is trusted'] } } : results.length === 1 ? { name: 'fs_write', args: { path: file, content: 'workflow project proof' } }
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
    STARNET_CRON_TICK_MS: '5000', SKYNET_CRON_TICK_MS: '5000',
    STARNET_FULL_ACCESS: '0', SKYNET_FULL_ACCESS: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-project-'));
  try {
    const grant = 'path:' + fs.realpathSync(project);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [grant, 'cabinet:write'], meta: {} }));
    await fixture.start();
    const agents = ['entry', 'hop'].map(agentId => ({ agentId, name: agentId, provider: 'openrouter', model: agentId + '-model', executionProfile: 'trusted-project' }));
    await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() });
    const geometry = { props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1, projectRoot: project },
      { id: 'a', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'entry' },
      { id: 'b', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'hop' },
      { id: 'o', t: 'outbox', x: 9, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5, 7, 8].map(x => ({ x, y: 0, dir: 'E' })) };
    const plan = Pipeline.compileRoutingPlan(geometry);
    assert.equal(plan.lines[0].projectRoot, project);
    const noProject = Pipeline.compileRoutingPlan({ ...geometry, props: geometry.props.map(p => ({ ...p, projectRoot: undefined })) });
    assert.equal(noProject.hash, plan.hash, 'project edits preserve routing topology');
    for (const bay of plan.bays.concat(plan.dockBays)) bay.objects = ['computer', 'cabinet'];
    assert.equal((await fixture.json('POST', '/api/routing', plan)).body.ok, true);
    const sample = await fixture.json('POST', '/api/routing/sample', { text: 'Write a file and read it back.' });
    assert.equal(sample.body.delivered?.agentId, 'hop', JSON.stringify(sample.body));
    for (const id of ['entry', 'hop']) assert.equal(fs.readFileSync(path.join(project, id + '.txt'), 'utf8'), 'workflow project proof');
    await fixture.restart();
    const routine = await fixture.json('POST', '/api/cron', { name: 'Project workflow', prompt: 'Write a file and read it back.', schedule: 'every 1h', agentId: 'entry', model: 'entry-model', provider: 'openrouter', runsLine: true });
    assert.ok(routine.body.job?.id, routine.text);
    const run = await fixture.json('POST', '/api/cron/run', { id: routine.body.job.id });
    assert.ok(!run.text.includes('agent.run.error'), run.text);
    const rows = (await fixture.json('GET', '/api/runs?agent=*')).body.runs;
    assert.ok(rows.filter(r => r.surface === 'autonomous' && r.projectRoot === fs.realpathSync(project)).length >= 4, 'sample and routine stages all record the project');
    const scheduled = await fixture.json('POST', '/api/cron', { name: 'Scheduled project', prompt: 'Write a file and read it back.', schedule: 'in 1s', agentId: 'entry', model: 'entry-model', provider: 'openrouter', runsLine: true });
    assert.ok(scheduled.body.job?.id, scheduled.text);
    await fixture.json('POST', '/api/cron/arm', { enabled: true });
    let scheduledRows = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      scheduledRows = (await fixture.json('GET', '/api/runs?agent=*')).body.runs.filter(r => r.surface === 'autonomous' && r.projectRoot === fs.realpathSync(project));
      if (scheduledRows.length >= 6) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(scheduledRows.length >= 6, 'timer-triggered workflow carries the project through both stages');
    const direct = await fixture.json('POST', '/api/run', { agentId: 'entry', provider: 'openrouter', model: 'entry-model', isTask: true, messages: [{ role: 'user', content: 'Write a file and read it back.' }] });
    assert.ok(!direct.text.includes('agent.run.error'), direct.text);
    assert.ok(fs.existsSync(path.join(fixture.workspace, 'entry/entry.txt')), 'direct chat keeps the agent workspace');
    // Trust is host authority, not permission implied by the saved Inbox.
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: ['cabinet:write'], meta: {} }));
    await fixture.restart(); calls.length = 0;
    const blocked = await fixture.json('POST', '/api/routing/sample', { text: 'Write a file.' });
    assert.equal(blocked.body.ok, false, blocked.text);
    assert.equal(calls.length, 0, 'revoked workflow project fails before upstream work');
    console.log('workflow-project: OK — two stages, files/readback, routine, restart, direct isolation and revocation');
  } finally { await fixture.dispose();
    assert.equal(path.dirname(project), os.tmpdir());
    assert.ok(path.basename(project).startsWith('workflow-project-'));
    fs.rmSync(project, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
