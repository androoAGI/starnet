/* node test/project-parked-output.e2e.test.js — over-cap tool output in a PROJECT-scoped /api/run must be readable
   back through the EXACT path string the model was handed (harness gauntlet G1, 2026-10-08). The host parks the
   whole output in the agent's private workspace (.output/…), but in a project session a relative fs path resolves
   against the project, so the old `.output/…` pointer dangled and the model spent ~12 minutes hunting for it.
   Boots the real sidecar, drives the real registry through a mock provider, and replays the pointer verbatim. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const SAVED = /SAVED to (.+?\.txt) — /;

function startProvider() {
  return new Promise(resolve => {
    const requests = [];
    const seen = { parked: null };
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/parked-output', context_length: 100000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const results = (body.messages || []).filter(message => message && message.role === 'tool');
        const big = results.find(message => message.tool_call_id === 'big');
        const m = big && SAVED.exec(String(big.content));
        if (m) seen.parked = m[1];
        let call = null;
        if (results.length === 0) call = { id: 'brief', name: 'brief_proceed', args: { objective: 'page a large output back', deliverable: 'the middle marker', assumptions: ['The project root is already blessed'] } };
        // THE REACH FENCE (2026-11-08): this TRUSTED PROJECT agent is fenced even on Full Power, so its command meets the
        // workspace text floor, which reads a quoted '\n' escape as a drive-root path; the newline is built instead.
        // The output is byte-identical (the page offsets below still land on the marker).
        else if (results.length === 1) call = { id: 'big', name: 'shell_exec', args: { cmd: 'node -e "const n=String.fromCharCode(10);process.stdout.write(\'PARK_HEAD\'+n+(\'x\'.repeat(99)+n).repeat(750)+\'PARK_MIDDLE_MARKER\'+n+(\'y\'.repeat(99)+n).repeat(750)+\'PARK_TAIL\'+n)"' } };
        // Replay the pointer EXACTLY as handed over — no normalizing, no guessing — first whole, then paged.
        else if (results.length === 2 && seen.parked) call = { id: 'readback', name: 'fs_read', args: { path: seen.parked } };
        else if (results.length === 3 && seen.parked) call = { id: 'page', name: 'fs_read', args: { path: seen.parked, offset: 74990, limit: 100 } };   // fs.read pages by CHARACTER: the marker sits at 75010
        else if (results.length === 4 && seen.parked) call = { id: 'search', name: 'fs_search', args: { query: 'PARK_MIDDLE_MARKER', path: seen.parked } };
        // An explicit project file must not silently widen to nested files with the same basename.
        else if (results.length === 5) call = { id: 'exact-content', name: 'fs_search', args: { query: 'SCOPE_MARK', path: 'exact.txt' } };
        else if (results.length === 6) call = { id: 'exact-files', name: 'fs_search', args: { query: 'exact.txt', path: 'exact.txt', target: 'files' } };
        else if (results.length === 7) call = { id: 'exact-budget', name: 'fs_search', args: { query: 'SCOPE_MARK', path: 'exact.txt', max_files: 1 } };

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (call) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Paged the saved output.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, seen, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const provider = await startProvider();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-parked-project-'));
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'a project with no .output folder of its own\n', 'utf8');
  fs.mkdirSync(path.join(projectRoot, 'a-first'));
  fs.writeFileSync(path.join(projectRoot, 'exact.txt'), 'SCOPE_MARK requested\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'a-first', 'exact.txt'), 'SCOPE_MARK unrelated\n', 'utf8');
  const fixture = SidecarFixture.create({
    prefix: 'starnet-parked-output-sidecar-', timeoutMs: 15000,
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-parked-output-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-parked-output-fake',
      SKYNET_DEFAULT_MODEL: 'test/parked-output', STARNET_DEFAULT_MODEL: 'test/parked-output'
    }
  });
  try {
    const grant = 'path:' + path.resolve(projectRoot);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [grant], meta: { [grant]: { grantedAt: 1 } } }), 'utf8');
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: path.resolve(projectRoot), displayPath: projectRoot, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] }), 'utf8');
    await fixture.start();
    // Full Access is asked for by name (raise) and confirmed at the desk with the code this station printed (GHSA-2hpj #1),
    // as the page does; a push that names no raise is held ask-first, and the run's shell_exec would wait on a card nobody answers
    const roster = await fixture.deskJson('POST', '/api/roster', {
      updatedAt: 100,
      agents: [{ agentId: 'park-agent', name: 'park-agent', system: 'Use the requested native tools and report only their receipts.', provider: 'openrouter', model: 'test/parked-output', approvalMode: 'full', executionProfile: 'trusted-project' }],
      raise: ['park-agent']
    });
    A.eq([roster.status, roster.body && roster.body.clamped], [200, undefined], 'the real sidecar accepts the project test agent, on Full Access');

    const response = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'sk-or-v1-parked-output-fake', provider: 'openrouter', model: 'test/parked-output',
        agentId: 'park-agent', streamId: 'parked-output', isTask: true, projectRoot: path.resolve(projectRoot),
        messages: [{ role: 'user', content: 'Print a large log, then page the saved copy back.' }]
      })
    });
    A.eq(response.status, 200, 'the project-scoped run is accepted');
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(event => event.name === 'agent.run.end' && event.payload && event.payload.reason === 'done'), 'the run finishes normally');

    const results = provider.requests.flatMap(request => (request.messages || []).filter(message => message && message.role === 'tool'));
    const big = results.find(message => message.tool_call_id === 'big');
    A.ok(big && /PARK_HEAD/.test(big.content) && !/PARK_MIDDLE_MARKER/.test(big.content), 'the large output was clamped, its middle elided');
    A.ok(!!provider.seen.parked, 'the clamp note names where the full output was saved: ' + provider.seen.parked);
    const parked = String(provider.seen.parked || '');
    A.ok(path.isAbsolute(parked), 'in a project session the pointer is absolute, so it cannot resolve against the project: ' + parked);
    A.ok(!fs.existsSync(path.join(projectRoot, '.output')), 'nothing was parked into the user\'s project');
    A.ok(fs.existsSync(parked) && /PARK_MIDDLE_MARKER/.test(fs.readFileSync(parked, 'utf8')), 'the pointer names the real saved file, which holds the whole output');

    const readback = results.find(message => message.tool_call_id === 'readback');
    A.ok(readback && /PARK_HEAD/.test(readback.content) && !/^(error|\[error)/i.test(readback.content), 'fs.read of the exact pointer string succeeds: ' + (readback && String(readback.content).slice(0, 200)));
    const page = results.find(message => message.tool_call_id === 'page');
    A.ok(page && /PARK_MIDDLE_MARKER/.test(page.content), 'paging the pointer with offset/limit reaches the elided middle: ' + (page && String(page.content).slice(0, 200)));
    const search = results.find(message => message.tool_call_id === 'search');
    A.ok(search && /PARK_MIDDLE_MARKER/.test(search.content) && !/ERROR|ENOTDIR|no match/i.test(search.content),'fs.search on the pointer finds the elided middle: ' + (search && String(search.content).slice(0, 200)));
    const exactContent = results.find(message => message.tool_call_id === 'exact-content');
    A.ok(exactContent && /SCOPE_MARK requested/.test(exactContent.content), 'the real run searches the requested project file');
    A.ok(exactContent && !/unrelated|a-first/.test(exactContent.content), 'content results exclude its nested namesake');
    const exactFiles = results.find(message => message.tool_call_id === 'exact-files');
    A.ok(exactFiles && /exact\.txt/.test(exactFiles.content) && !/a-first/.test(exactFiles.content), 'file-name results stay within the explicit file: ' + (exactFiles && String(exactFiles.content).slice(0, 350)));
    const exactBudget = results.find(message => message.tool_call_id === 'exact-budget');
    A.ok(exactBudget && /SCOPE_MARK requested/.test(exactBudget.content) && !/unrelated|a-first/.test(exactBudget.content), 'max_files one still finds the requested file rather than a traversed sibling');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('project-parked-output.e2e.test');
})().catch(error => { console.log('FAIL: project-parked-output.e2e.test threw — ' + (error && error.stack || error)); process.exit(1); });
