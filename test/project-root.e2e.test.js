/* node test/project-root.e2e.test.js — a blessed /api/run session must make native relative fs/shell
   operations project-native. This boots the real sidecar, preloads a durable path grant, drives the real tool
   registry through a mock provider, and inspects the exact tool results returned to that provider. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function startProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/project-root', context_length: 100000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const results = (body.messages || []).filter(message => message && message.role === 'tool');
        const worker = (body.messages || []).some(message => message.role === 'system' && String(message.content).includes('PROJECT_WORKER_PROOF'));
        let call = null;
        const routine = (body.messages || []).some(message => message.role === 'user' && String(message.content).includes('ROUTINE_WRITE_PROOF'));
        const lapsed = (body.messages || []).some(message => message.role === 'user' && String(message.content).includes('LAPSED_WRITE_PROOF'));
        if (lapsed) call = results.length === 0 ? { id: 'lbrief', name: 'brief_proceed', args: { objective: 'write the proof file', deliverable: 'one write receipt', assumptions: ['The anchored folder may not be trusted'] } } : results.length === 1 ? { id: 'lwrite', name: 'fs_write', args: { path: 'Working/lapsed-proof.txt', content: 'LAPSED_PRIVATE' } } : null;
        else if (routine) call = results.length === 0 ? { id: 'rwrite', name: 'fs_write', args: { path: 'Working/routine-proof.txt', content: 'ROUTINE_IN_PROJECT' } } : null;
        else if (results.length === 0) call = { id: 'brief', name: 'brief_proceed', args: { objective: 'prove project-relative native tools', deliverable: 'two authoritative read receipts', assumptions: ['The project root is already blessed'] } };
        else if (results.length === 1) call = { id: 'read', name: 'fs_read', args: { path: 'incident.log' } };
        else if (results.length === 2) call = { id: 'shell', name: 'shell_exec', args: { cmd: 'node -e "console.log(require(\'fs\').readFileSync(\'incident.log\',\'utf8\'))"' } };
        else if (results.length === 3) call = { id: 'verify', name: 'verify_run', args: {} };
        else if (results.length === 4 && !worker) call = { id: 'dispatch', name: 'team_dispatch', args: { workers: [{ agentId: 'project-worker', prompt: 'Read incident.log and verify the active project.' }] } };

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (call) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Both project-relative reads are proven.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const provider = await startProvider();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-project-root-'));
  fs.writeFileSync(path.join(projectRoot, 'incident.log'), 'PROJECT_RELATIVE_OK\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'PROJECT_VERIFY_OK\')"' } }));
  const fixture = SidecarFixture.create({
    prefix: 'starnet-project-root-sidecar-', timeoutMs: 15000,
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-project-root-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-project-root-fake',
      SKYNET_DEFAULT_MODEL: 'test/project-root', STARNET_DEFAULT_MODEL: 'test/project-root'
    }
  });
  try {
    const grant = 'path:' + path.resolve(projectRoot);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [grant], meta: { [grant]: { grantedAt: 1 } } }), 'utf8');
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: path.resolve(projectRoot), displayPath: projectRoot, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] }), 'utf8');
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', {
      updatedAt: 100,
      agents: ['project-agent', 'project-worker'].map(agentId => ({ agentId, name: agentId, system: agentId === 'project-worker' ? 'PROJECT_WORKER_PROOF' : 'Use the requested native tools and report only their receipts.', provider: 'openrouter', model: 'test/project-root', approvalMode: 'full', executionProfile: 'trusted-project' }))
    });
    A.eq(roster.status, 200, 'the real sidecar accepts the project test agent');

    const response = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'sk-or-v1-project-root-fake', provider: 'openrouter', model: 'test/project-root',
        agentId: 'project-agent', streamId: 'project-root', isTask: true, projectRoot: path.resolve(projectRoot),
        messages: [{ role: 'user', content: 'Read incident.log with fs.read, then read the same relative file from shell.exec.' }]
      })
    });
    A.eq(response.status, 200, 'the production /api/run path accepts a blessed project-scoped session');
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(event => event.name === 'agent.run.end' && event.payload && event.payload.reason === 'done'), 'the project-scoped run finishes normally');

    const parentRequests = provider.requests.filter(request => !(request.messages || []).some(message => message.role === 'system' && String(message.content).includes('PROJECT_WORKER_PROOF')));
    const results = parentRequests.flatMap(request => (request.messages || []).filter(message => message && message.role === 'tool'));
    const fsRead = results.find(message => message.tool_call_id === 'read');
    const shellRead = results.find(message => message.tool_call_id === 'shell');
    A.ok(fsRead && /PROJECT_RELATIVE_OK/.test(fsRead.content), 'relative fs.read returned the seeded file from projectRoot');
    A.ok(shellRead && /PROJECT_RELATIVE_OK/.test(shellRead.content) && /exit 0/.test(shellRead.content), 'relative shell.exec ran at projectRoot and returned an exit-zero receipt');
    const allResults = provider.requests.flatMap(request => (request.messages || []).filter(message => message.role === 'tool'));
    A.ok(allResults.some(message => message.tool_call_id === 'verify' && /PROJECT_VERIFY_OK/.test(message.content)), 'verify.run discovers and executes the selected project package test');
    const workerRequests = provider.requests.filter(request => (request.messages || []).some(message => message.role === 'system' && String(message.content).includes('PROJECT_WORKER_PROOF')));
    const workerResults = workerRequests.flatMap(request => (request.messages || []).filter(message => message.role === 'tool'));
    A.ok(workerResults.some(message => message.tool_call_id === 'read' && /PROJECT_RELATIVE_OK/.test(message.content)), 'delegated worker reads the same active project');
    A.ok(workerResults.some(message => message.tool_call_id === 'verify' && /PROJECT_VERIFY_OK/.test(message.content)), 'delegated worker verifies the same active project');
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'project-agent', 'incident.log')), 'neither relative read silently fell back to the private agent workspace');
    const sysOf = request => (request.messages || []).filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
    A.ok(parentRequests.length && /PROJECT FOLDER: this session is anchored/.test(sysOf(parentRequests[0])) && !/PROJECT FOLDER NOT TRUSTED/.test(sysOf(parentRequests[0])), 'a blessed anchor gets the folder line, never the lapsed one');

    /* ISSUE #60 — an INTERACTIVE session anchored to a folder that is NOT a standing grant (trust removed, or a path
       that never matched it). The run used to drop the anchor silently: a relative fs.write "verified" into the
       private workspace while the shell looked in the folder and found it MISSING. Now the run is told plainly. */
    const lapsedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lapsed-root-'));
    const before = provider.requests.length;
    const lapsedRun = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'sk-or-v1-project-root-fake', provider: 'openrouter', model: 'test/project-root',
        agentId: 'project-agent', streamId: 'lapsed-root', isTask: true, projectRoot: lapsedRoot,
        messages: [{ role: 'user', content: 'LAPSED_WRITE_PROOF write the proof file' }]
      })
    });
    A.eq(lapsedRun.status, 200, 'a session anchored to an untrusted folder still runs');
    await lapsedRun.text();
    const lapsedRequests = provider.requests.slice(before).filter(request => (request.messages || []).some(message => message.role === 'user' && String(message.content).includes('LAPSED_WRITE_PROOF')));
    A.ok(lapsedRequests.length && /PROJECT FOLDER NOT TRUSTED: this session is anchored to /.test(sysOf(lapsedRequests[0])) && sysOf(lapsedRequests[0]).indexOf(lapsedRoot) >= 0, 'the run is told its anchored folder is not trusted, by name');
    A.ok(!/PROJECT FOLDER: this session is anchored/.test(sysOf(lapsedRequests[0])), 'and is never told it works in that folder');
    const lapsedWrite = lapsedRequests.flatMap(request => (request.messages || []).filter(message => message.role === 'tool')).find(message => message.tool_call_id === 'lwrite');
    A.ok(lapsedWrite && /\(your private workspace, not a project folder;.*absolute path inside it/.test(lapsedWrite.content), 'the write receipt says private workspace and names the way into a project: ' + (lapsedWrite && lapsedWrite.content));
    A.ok(!fs.existsSync(path.join(lapsedRoot, 'Working', 'lapsed-proof.txt')), 'nothing was written into the untrusted folder');
    try { fs.rmSync(lapsedRoot, { recursive: true, force: true }); } catch (_) {}

    /* ISSUE #60 — a ROUTINE with a project workdir: its prompt says file work happens in the project and its
       shell defaults there, so a relative fs.write must land there too (it used to land in the agent's private
       workspace, where the shell — and Windows — reported it MISSING). */
    const created = await fixture.json('POST', '/api/cron', { name: 'project write', prompt: 'ROUTINE_WRITE_PROOF write the proof file', schedule: 'every 1h', agentId: 'project-agent', model: 'test/project-root', provider: 'openrouter', workdir: path.resolve(projectRoot) });
    A.eq(created.status, 200, 'a routine anchored to the blessed project is created');
    const jobId = created.body && created.body.job && created.body.job.id;
    const fired = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
    A.eq(fired.status, 200, 'Run Now fires the project routine');
    await fired.text();
    const writeResult = provider.requests.flatMap(request => (request.messages || []).filter(message => message.role === 'tool')).find(message => message.tool_call_id === 'rwrite');
    A.ok(writeResult && /\[location: /.test(writeResult.content), 'the routine fs.write receipt names where the file went');
    A.eq(fs.existsSync(path.join(projectRoot, 'Working', 'routine-proof.txt')) && fs.readFileSync(path.join(projectRoot, 'Working', 'routine-proof.txt'), 'utf8'), 'ROUTINE_IN_PROJECT', 'a routine relative fs.write lands in its project folder, where the shell looks');
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'project-agent', 'Working', 'routine-proof.txt')), 'the routine write did not silently land in the private agent workspace');

    /* (sweep 2026-10-02) DELIVERABLES › OPEN on that file opens THE PROJECT'S copy — it resolved the relative path in the
       agent's private workspace and served an older same-named file (a decoy proves which one is served). */
    fs.mkdirSync(path.join(fixture.workspace, 'project-agent', 'Working'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'project-agent', 'Working', 'routine-proof.txt'), 'DECOY_PRIVATE_COPY', 'utf8');
    const dl = await fixture.json('GET', '/api/deliverables');
    const items = (dl.body && (dl.body.items || dl.body.deliverables || dl.body.rows)) || [];
    const file = items.flatMap(it => it.files || []).find(f => f && f.path && /routine-proof\.txt$/.test(String(f.path).replace(/\\/g, '/')));
    A.ok(file && /[?&]project=/.test(String(file.openUrl)), 'the deliverable link names its project: ' + (file && file.openUrl));
    const opened = file ? await fixture.request(file.openUrl) : null;
    A.eq(opened && opened.status === 200 ? await opened.text() : 'HTTP ' + (opened && opened.status), 'ROUTINE_IN_PROJECT', 'OPEN serves the project file, not the same-named one in the private workspace');
    const enc = encodeURIComponent(path.resolve(projectRoot));
    A.eq((await fixture.request('/api/file?agent=project-agent&path=..%2Fx&project=' + enc)).status, 403, 'a ".." path under a project is refused');
    const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-not-blessed-')); fs.writeFileSync(path.join(stranger, 'secret.txt'), 'S');
    A.eq((await fixture.request('/api/file?agent=project-agent&path=secret.txt&project=' + encodeURIComponent(stranger))).status, 403, 'a folder that is not a blessed project serves nothing');
    try { fs.rmSync(stranger, { recursive: true, force: true }); } catch (_) {}
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('project-root.e2e.test');
})().catch(error => { console.log('FAIL: project-root.e2e.test threw — ' + (error && error.stack || error)); process.exit(1); });
