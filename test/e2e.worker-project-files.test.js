/* node test/e2e.worker-project-files.test.js — issue #77 through the REAL sidecar (test:http; child-process boot).

   The reported setup: a Supervisor and a Creator ("designer"), both ASK, Away Work off; a trusted project folder
   ("YoutubeService"); a project conversation in which the Supervisor team_dispatches the Creator (whose kit carries a
   WORKBENCH). The mock provider plays both models and records exactly what each was SHOWN:

     Creator  1. tool_search "run a shell command"  -> must say shell_exec is WITHHELD for a delegated worker, and why
              2. shell_exec                          -> must say WITHHELD with the delegated cause + the route that works
              3. image_generate path:thumbnail-test-v1.png -> must land IN the project; the receipt names the location
     Supervisor  fs_read thumbnail-test-v1.png       -> must FIND it (the report: "no such file")

   Also asserted on the Creator's first request: its advertised tool list (no shell_exec; only shell_bg_* survive —
   by design in ASK mode) and its capability note (DELEGATED, not "UNATTENDED routine"). Zero spend, no network. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const DESIGNER_MARK = 'ISSUE77_DESIGNER_MARK';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sse(res, delta, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const call = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const systemOf = body => (body.messages || []).filter(m => m && m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');

function startProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(req.url.includes('/models')
          ? { data: [{ id: 'test/model', context_length: 100000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }
          : { data: {} }));
      }
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      requests.push({ body });
      if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
      }
      const offered = name => (body.tools || []).some(t => t && t.function && t.function.name === name);
      const results = (body.messages || []).filter(m => m && m.role === 'tool').length;
      const isDesigner = systemOf(body).includes(DESIGNER_MARK);
      if (isDesigner && offered('tool_search')) {
        if (results === 0) return sse(res, call('w_search', 'tool_search', { query: 'run a shell command' }), 'tool_calls');
        if (results === 1) return sse(res, call('w_shell', 'shell_exec', { cmd: 'echo hello' }), 'tool_calls');
        if (results === 2) return sse(res, call('w_img', 'image_generate', { prompt: 'a youtube thumbnail', path: 'thumbnail-test-v1.png' }), 'tool_calls');
        return sse(res, { content: 'Thumbnail saved. Commands are for the lead to run.' });
      }
      if (!isDesigner && offered('team_dispatch')) {
        if (results === 0) return sse(res, call('l_brief', 'brief_proceed', { objective: 'a project thumbnail made by the Creator', deliverable: 'thumbnail-test-v1.png in the project', assumptions: ['YoutubeService is the trusted project'] }), 'tool_calls');
        if (results === 1) return sse(res, call('l_dispatch', 'team_dispatch', { workers: [{ agentId: 'designer', prompt: 'Make the thumbnail and transfer the file into the project.' }] }), 'tool_calls');
        if (results === 2) return sse(res, call('l_read', 'fs_read', { path: 'thumbnail-test-v1.png' }), 'tool_calls');
      }
      return sse(res, { content: 'Finished.' });
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, requests, baseUrl: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

function toolResultFor(requests, callId) {
  for (const r of requests) {
    for (const m of (r.body.messages || [])) {
      if (m && m.role === 'tool' && m.tool_call_id === callId) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    }
  }
  return '';
}

(async () => {
  const provider = await startProvider();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'YoutubeService-'));
  const projectRoot = path.resolve(project);
  const fixture = SidecarFixture.create({ prefix: 'issue77-worker-files-', timeoutMs: 20000, env: {
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '', STARNET_CLOUD_URL: '',
    STARNET_IMAGE_MODEL: '', SKYNET_IMAGE_MODEL: '', SKYNET_FULL_ACCESS: '', SKYNET_AUX_BUDGET: '0',
    STARNET_OPENROUTER_BASE: provider.baseUrl, SKYNET_OPENROUTER_BASE: provider.baseUrl
  } });
  try {
    // the trusted project ("My Project Folders") + the Commander's standing ASK-mode grants for the two consent
    // classes this flow uses (delegate, generate). No Full Access anywhere; no command grant.
    const pathGrant = 'path:' + projectRoot;
    const allow = [pathGrant, 'orchestrator:execute', 'studio:write'];
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow, meta: {} }), 'utf8');
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: projectRoot, displayPath: project, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] }), 'utf8');
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: 100, agents: [
      { agentId: 'supervisor', name: 'Supervisor', system: 'You lead the crew.', provider: 'openrouter', model: 'test/model', approvalMode: 'ask' },
      { agentId: 'designer', name: 'Creator', system: DESIGNER_MARK + ' You make images.', provider: 'openrouter', model: 'test/model', approvalMode: 'ask' }
    ] });
    A.eq(roster.status, 200, 'the roster accepts a Supervisor and a Creator, both ASK');

    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'openrouter', model: 'test/model', key: 'fixture-openrouter-key', agentId: 'supervisor', isTask: true,
      streamId: 'youtube-project', projectRoot, placed: ['workbench', 'studio', 'cabinet'],
      messages: [{ role: 'user', content: 'Have the Creator make thumbnail-test-v1.png for this project.' }]
    }) });
    A.eq(r.status, 200, 'the project-scoped Supervisor run is accepted');
    const events = (await r.text()).split('\n').filter(Boolean).map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), 'the run finishes');

    const designerReqs = provider.requests.filter(q => systemOf(q.body).includes(DESIGNER_MARK) && Array.isArray(q.body.tools));
    A.ok(designerReqs.length >= 4, 'the Creator ran as a dispatched worker (' + designerReqs.length + ' turns)');
    const first = designerReqs[0] ? designerReqs[0].body : { tools: [] };
    const toolNames = (first.tools || []).map(t => t && t.function && t.function.name);

    // ---- the dispatched worker's resolved tool list: BY DESIGN no command execution in ASK mode ----
    A.ok(toolNames.indexOf('shell_exec') < 0 && toolNames.indexOf('verify_run') < 0, 'the delegated ASK-mode Creator is not handed shell_exec/verify_run: ' + toolNames.join(','));
    A.ok(toolNames.indexOf('shell_bg_status') >= 0, 'its WORKBENCH kit is present (shell_bg_status survives)');
    A.ok(toolNames.indexOf('image_generate') >= 0 && toolNames.indexOf('tool_search') >= 0, 'image_generate and tool_search are advertised');
    const sys = systemOf(first);
    A.ok(/DELEGATED worker run for supervisor/.test(sys), 'its capability note says DELEGATED for the Supervisor, not an unattended routine');
    A.ok(/Do NOT report that the station has no shell/.test(sys) && /result for supervisor/.test(sys), 'and names the route: hand the command back to the Supervisor');
    A.ok(!/per-routine grant/.test(sys), 'it is never sent to a per-routine grant');

    // ---- discovery + the withheld call: truthful and actionable ----
    const search = toolResultFor(provider.requests, 'w_search');
    A.ok(/WITHHELD on this run/.test(search) && /shell\.exec/.test(search) && /result for supervisor/.test(search), 'tool_search "run a shell command" names shell.exec as WITHHELD and what works: ' + search.slice(0, 500));
    const shell = toolResultFor(provider.requests, 'w_shell');
    A.ok(/WITHHELD: "shell\.exec" exists/.test(shell) && /delegated by supervisor/.test(shell) && /What works instead/.test(shell), 'calling shell_exec answers WITHHELD with the delegated cause and the route: ' + shell.slice(0, 500));

    // ---- image_generate lands in the project; the Supervisor reads it ----
    const saved = path.join(projectRoot, 'thumbnail-test-v1.png');
    A.ok(fs.existsSync(saved), 'the Creator\'s relative image path landed in the project folder');
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'designer', 'thumbnail-test-v1.png')), 'not in the Creator\'s private workspace');
    const img = toolResultFor(provider.requests, 'w_img');
    A.ok(img.indexOf('Saved at: ' + saved) >= 0 && /project folder/.test(img), 'the image receipt names the absolute project location: ' + img.slice(0, 500));
    const read = toolResultFor(provider.requests, 'l_read');
    A.ok(read.length > 0 && !/no such file/i.test(read) && !/^WITHHELD|denied|error/i.test(read), 'the Supervisor fs_read("thumbnail-test-v1.png") finds the file: ' + read.slice(0, 300));
    const view = (img.match(/View: (\S+)/) || [])[1];
    const opened = view ? await fixture.request(view) : null;
    A.eq(opened && opened.status, 200, 'the receipt\'s viewer URL opens the project copy: ' + view);
  } finally {
    await fixture.dispose();
    provider.server.closeAllConnections(); await new Promise(r => provider.server.close(r));
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.worker-project-files.test');
})().catch(e => { console.log('FAIL: e2e.worker-project-files.test threw — ' + (e && e.stack || e)); process.exit(1); });
