/* The Etsy report (2026-11-06), end to end: seeded real sidecar + mock provider + real headless Chromium.
   Agent ONE signs in to a local shop in the station browser and stays on it. Agent TWO runs at the same time, so it loses the
   durable profile and gets a private browser: the shop must see it signed in, which used to be the "my agent keeps on asking
   me to sign in" of the report. The sidecar then restarts and a later agent is still signed in, the "keeps on signing me out".
   What the shop saw comes back through a real browser_get_text tool result. */
'use strict';
const A = require('./_assert.js'), fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');
const Orphans = require('../sidecar/tools/builtin/browser-orphans.js');
const MODEL = 'test/browser-signin';
const SIGNED_IN = 'lasting=1; session=1';

function reply(res, call) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Finished.' };
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

(async () => {
  if (!T.findChrome()) { console.log('browser-signin-survives.run.e2e: SKIPPED — no Chromium installed'); return; }
  const faults = [], saw = {};
  let releaseOne, twoSawAProfile = null;
  const twoFinished = new Promise(r => { releaseOne = r; });
  let signedIn; const oneSignedIn = new Promise(r => { signedIn = r; });
  let fixtureRef = null;
  const provider = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 100000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
      }
      try {
        const body = JSON.parse(raw);
        const tagged = /AGENT-(ONE|TWO|LATER)/.exec(JSON.stringify((body.messages || []).filter(m => m.role === 'user')));
        if (!tagged) return reply(res, null);   // the station's own background model calls are no part of this
        const who = tagged[1];
        const messages = (body.messages || []).filter(m => m.role === 'tool');
        const result = id => messages.find(m => m.tool_call_id === id);
        const call = (id, name, args) => reply(res, { id, name, args });
        if (!result('brief')) return call('brief', 'brief_proceed', { objective: 'open the local shop', deliverable: 'what the shop saw', assumptions: ['local fixture'], successCriteria: ['the shop answers'] });
        if (!result('start')) return call('start', 'shell_exec', { cmd: 'node shop.cjs', background: true });
        const started = /Started background process (\S+)/.exec(result('start').content);
        if (!started) throw new Error('background start failed: ' + result('start').content);
        const id = started[1], statuses = messages.filter(m => /^status/.test(m.tool_call_id));
        const address = statuses.length && /http:\/\/127\.0\.0\.1:\d+/.exec(statuses.at(-1).content);
        if (!address) {
          if (statuses.length > 20) throw new Error('the shop did not report its address');
          await new Promise(resolve => setTimeout(resolve, 150));
          return call('status' + statuses.length, 'shell_bg_status', { id });
        }
        if (who === 'TWO') await oneSignedIn;
        if (!result('navigate')) return call('navigate', 'browser_test_navigate', { url: address[0] + (who === 'ONE' ? '/login' : '/me'), serverId: id });
        if (!result('read')) return call('read', 'browser_get_text', {});
        saw[who] = result('read').content;
        if (who === 'ONE') { signedIn(); await twoFinished; }   // agent one stays on the station browser while agent two runs
        if (who === 'TWO') {
          // which browser is it? a Chrome of its own on a temporary profile, with the station's still on the durable one
          const rows = await Orphans.makeProcessLister({})();
          twoSawAProfile = {
            durable: Orphans.profileProcesses(rows, path.join(fixtureRef.workspace, '.browser-profile')).some(p => p.browser),
            temporary: rows.some(r => /--user-data-dir=[^"]*starnet-browser-\d+-/.test(String(r.cmd)) && !/--type=/.test(String(r.cmd)))
          };
          releaseOne();
        }
        if (!result('stop')) return call('stop', 'shell_bg_kill', { id });
        return reply(res, null);
      } catch (e) { faults.push(e.message); signedIn(); releaseOne(); return reply(res, null); }
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + provider.address().port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'starnet-signin-run-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-signin-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-signin-fixture',
    SKYNET_DEFAULT_MODEL: MODEL, STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEV: '1',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '', STARNET_BROWSER_HEADLESS: '1'
  } });
  fixtureRef = fixture;
  const project = path.join(fixture.profile, 'project');
  // stream: a fresh conversation per run. The cost stack replays a stream's earlier tool results into its next run, so a
  // second run on one stream would hand this scripted model the first run's finished steps (and a dead background id).
  const run = async (agentId, tag, stream) => {
    const response = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000), body: JSON.stringify({
      key: 'sk-or-v1-signin-fixture', provider: 'openrouter', model: MODEL, agentId, streamId: 'signin-' + (stream || tag), isTask: true, projectRoot: project,
      messages: [{ role: 'user', content: 'AGENT-' + tag + ': open the local shop and read what it saw.' }]
    }) });
    A.eq(response.status, 200, tag + ': the run starts');
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), tag + ': the run ends done');
  };
  try {
    fs.cpSync(path.join(__dirname, '../dev/fixtures/seed-workspace'), fixture.workspace, { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'shop.cjs'), 'const http=require("node:http");const s=http.createServer((q,r)=>{if(q.url==="/login")r.setHeader("Set-Cookie",["session=1; Path=/; HttpOnly","lasting=1; Path=/; Max-Age=31536000; HttpOnly"]);r.setHeader("Content-Type","text/html");r.end("<p>shop saw "+String(q.headers.cookie||"nothing").split("; ").sort().join("; ")+"</p>")});s.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+s.address().port));');
    const grant = 'path:' + path.resolve(project);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [grant], meta: { [grant]: { grantedAt: 1 } } }));
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: path.resolve(project), displayPath: project, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] }));
    await fixture.start();
    const agent = id => ({ agentId: id, name: id, system: 'Use the requested native tools and report only their receipts.', provider: 'openrouter', model: MODEL, approvalMode: 'full', executionProfile: 'trusted-project' });
    // the cost stack's desk: a roster push names the Full Access and reach it asks for, and the desk confirms them
    // (a plain push is clamped to ask-first and the run waits on a card nobody answers)
    const ids = ['agent-one', 'agent-two', 'agent-later'];
    const saved = await fixture.deskJson('POST', '/api/roster', { updatedAt: Date.now(), raise: ids, raiseProfile: ids, agents: ids.map(agent) });
    A.eq(saved.status, 200, 'the sidecar accepts the fixture agents');
    A.ok(!(saved.body && (saved.body.clamped || saved.body.profileClamped)), 'the desk confirmed their Full Access and reach (nothing clamped): ' + JSON.stringify(saved.body));

    await Promise.all([run('agent-one', 'ONE'), run('agent-two', 'TWO')]);
    A.eq(faults, [], 'the mock provider completed the intended tool sequence');
    A.ok(/shop saw nothing/.test(saw.ONE || ''), 'agent one reached the sign-in page: ' + saw.ONE);
    A.ok((saw.TWO || '').includes('shop saw ' + SIGNED_IN), 'agent two, in its own browser while agent one holds the station browser, is signed in: ' + saw.TWO);
    A.eq(twoSawAProfile, { durable: true, temporary: true }, 'and it really was a second browser on a temporary profile');

    // the desktop's Quit, seconds after the sign-in: the sidecar closes its browser, which writes the cookies out
    const quitting = fixture.child;
    const gone = new Promise(resolve => { if (quitting.exitCode !== null) resolve(); else quitting.once('exit', resolve); });
    A.eq((await fixture.deskJson('POST', '/api/lifecycle/quit')).status, 202, 'the sidecar accepts a Quit');   // a Quit is a desk action on the cost stack
    await gone;
    await fixture.stop();
    await fixture.start();
    await run('agent-later', 'LATER');
    A.eq(faults, [], 'the mock provider completed the tool sequence after the Quit');
    A.ok((saw.LATER || '').includes('shop saw ' + SIGNED_IN), 'after a Quit and a fresh start an agent is still signed in: ' + saw.LATER);

    // a crash: the sidecar is killed, Chrome dies with it, and the session cookie already on disk must outlive that too
    delete saw.LATER;
    await fixture.restart();
    await run('agent-later', 'LATER', 'LATER-after-crash');
    A.eq(faults, [], 'the mock provider completed the tool sequence after the crash');
    A.ok((saw.LATER || '').includes('shop saw ' + SIGNED_IN), 'after a hard kill an agent is still signed in: ' + saw.LATER);
  } finally {
    try { await fixture.request('/api/browser/view/close', { method: 'POST' }); } catch (_) {}
    await fixture.dispose().catch(() => {});
    provider.closeAllConnections(); provider.close();
  }
  A.report('browser-signin-survives.run.e2e');
  process.exit(process.exitCode || 0);
})().catch(e => { console.log('FAIL: browser-signin-survives.run.e2e threw - ' + (e && e.stack || e)); process.exit(1); });
