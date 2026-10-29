/* #104: seeded real sidecar + owned background page + real headless Chromium + mock provider.
   The final proof is a FileList/change event on the local page, not a remote website upload. */
'use strict';
const A = require('./_assert.js'), fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');
const { defaultStagingRoot } = require('../sidecar/egress-files.js');
const MODEL = 'test/browser-upload';
function reply(res, call) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Local file selection verified. Remote upload was not tested.' };
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
(async () => {
  if (!T.findChrome()) { console.log('browser-upload.run.e2e: SKIPPED — no Chromium installed'); return; }
  const requests = [], faults = [];
  let statusReads = 0;
  const provider = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 100000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
      }
      try {
        const body = JSON.parse(raw); requests.push(body);
        const messages = (body.messages || []).filter(m => m.role === 'tool');
        const result = id => messages.find(m => m.tool_call_id === id);
        const call = (id, name, args) => reply(res, { id, name, args });
        if (!result('brief')) return call('brief', 'brief_proceed', { objective: 'select a local fixture photo', deliverable: 'a readback receipt', assumptions: ['The selected project is trusted'] });
        if (!result('start')) return call('start', 'shell_exec', { cmd: 'node upload-page.cjs', background: true });
        const started = /Started background process (\S+)/.exec(result('start').content);
        if (!started) throw new Error('background start failed: ' + result('start').content);
        const id = started[1], statuses = messages.filter(m => /^status/.test(m.tool_call_id));
        const address = statuses.length && /http:\/\/127\.0\.0\.1:\d+/.exec(statuses.at(-1).content);
        if (!address) {
          if (++statusReads > 10) throw new Error('fixture server did not report its bound URL');
          await new Promise(resolve => setTimeout(resolve, 150));
          return call('status' + statusReads, 'shell_bg_status', { id });
        }
        if (!result('navigate')) return call('navigate', 'browser_test_navigate', { url: address[0], serverId: id });
        if (!result('snapshot')) return call('snapshot', 'browser_test_snapshot', {});
        const target = /\[([^\]]+)\][^\n]*CHOOSE PHOTO/.exec(result('snapshot').content);
        if (!target) throw new Error('fixture ref absent: ' + result('snapshot').content + '; nav=' + result('navigate').content);
        if (!result('upload')) return call('upload', 'browser_upload', { ref: target[1], paths: ['photo.txt'] });
        if (!result('readback')) return call('readback', 'browser_test_state', { selector: '#events' });
        if (!result('stop')) return call('stop', 'shell_bg_kill', { id });
        return reply(res, null);
      } catch (e) { faults.push(e.message); return reply(res, null); }
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + provider.address().port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'starnet-upload-run-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-upload-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-upload-fixture',
    SKYNET_DEFAULT_MODEL: MODEL, STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEV: '1',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
  } });
  const project = path.join(fixture.profile, 'project');
  try {
    // Same committed onboarding seed as dev/seed.js, in a hermetic profile with no real credentials.
    fs.cpSync(path.join(__dirname, '../dev/fixtures/seed-workspace'), fixture.workspace, { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'photo.txt'), 'PROJECT PHOTO BYTES');
    fs.mkdirSync(path.join(fixture.workspace, 'upload-agent'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'upload-agent', 'photo.txt'), 'DECOY');
    const html = '<!doctype html><label for="photo" style="display:block;width:200px;height:40px">CHOOSE PHOTO</label><input id="photo" type="file" hidden><pre id="events"></pre><script>document.getElementById("photo").addEventListener("change",e=>{document.getElementById("events").textContent=JSON.stringify(Array.from(e.target.files,f=>({name:f.name,size:f.size})));});</script>';
    fs.writeFileSync(path.join(project, 'upload-page.cjs'), 'const http=require("node:http");const s=http.createServer((q,r)=>{r.setHeader("Content-Type","text/html");r.end(' + JSON.stringify(html) + ')});s.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+s.address().port));');
    const grant = 'path:' + path.resolve(project);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [grant], meta: { [grant]: { grantedAt: 1 } } }));
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: path.resolve(project), displayPath: project, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] }));
    await fixture.start();
    A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{
      agentId: 'upload-agent', name: 'Upload fixture', system: 'Use the requested native tools and report only their receipts.',
      provider: 'openrouter', model: MODEL, approvalMode: 'full', executionProfile: 'trusted-project'
    }] })).status, 200, 'seeded sidecar accepts the local fixture agent');
    const response = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify({
      key: 'sk-or-v1-upload-fixture', provider: 'openrouter', model: MODEL, agentId: 'upload-agent', streamId: 'upload-proof', isTask: true, projectRoot: project,
      messages: [{ role: 'user', content: 'Start upload-page.cjs, open its owned local page, select photo.txt, and read back the file selection. Stop the server when finished.' }]
    }) });
    A.eq(response.status, 200, 'real run starts');
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.eq(faults, [], 'mock provider completed the intended native tool sequence');
    A.ok(events.some(e => e.name === 'agent.run.end' && e.payload?.reason === 'done'), 'real run emits done');
    const results = requests.flatMap(b => (b.messages || []).filter(m => m.role === 'tool'));
    const result = id => results.find(m => m.tool_call_id === id)?.content || '';
    A.ok(/File selection verified/.test(result('upload')) && /"size":19/.test(result('upload')), 'production browser deps resolve and select project bytes, not the private decoy');
    A.ok(/Remote upload\/server acceptance is not verified/.test(result('upload')), 'model receives an honest selection-only receipt');
    // review round 4 minor-1 / round 5: the page was handed a staged copy in the STATION staging root OUTSIDE the jail,
    // and the copy never outlives the run (index.js runOnceCore releases this run's uploads when it ends)
    const staging = path.join(defaultStagingRoot(path, require('node:path').resolve(fixture.workspace)), 'upload-agent');
    let leftover = null;
    for (let i = 0; i < 50; i++) {
      leftover = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
      if (!leftover.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    A.ok(fs.existsSync(staging) && leftover.length === 0, 'the staged upload copy is gone once the run ends (' + JSON.stringify(leftover) + ')');
    A.ok(/photo.txt/.test(result('readback')) && /size\\?":19/.test(result('readback')), 'local website change handler independently reads project FileList size');
    A.ok(/Killed background process|already exited/i.test(result('stop')), 'owned fixture server is stopped with a receipt');
    const errors = fixture.output().split('\n').filter(s => /uncaught|unhandled|ReferenceError|TypeError:/.test(s));
    A.eq(errors, [], 'seeded sidecar emits no runtime exception');
    console.log('UPLOAD_RUN_RECEIPT ' + JSON.stringify({ upload: result('upload'), readback: result('readback'), stop: result('stop'), done: events.find(e => e.name === 'agent.run.end') }));
  } finally {
    await fixture.dispose();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  }
  A.report('browser-upload.run.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
