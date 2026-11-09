/* node test/cli-station.e2e.test.js — `starnet ls / approve / deny / watch / flow`, end to end, against a REAL sidecar.

   test/cli-dashboard.test.js locks the pure model and formatters. This spawns bin/starnet.js exactly as a shell does
   (no TTY) beside a run another client started the way the page does (POST /api/run on its own conversation), with a
   content-driven mock OpenRouter (zero spend) and a hermetic profile, and proves:
     1. `ls --json` sees that run's open ask as needs-you, naming what it wants to write;
     2. `approve` answers it: exit 0, the write LANDS, and the run's own stream (the page) was told the terminal
        answered; a second `approve` / `deny` with nothing waiting exits 6;
     3. `watch --json` streams the run's events (start with its prompt, the tool call, the end);
     4. `-p` marks a task (the model is offered tools) and talk as talk (none) — without isTask no tool was ever offered;
     5. `flow` on a station with no lines says so, exit 0; a bare `starnet` in a pipe prints usage, never a screen;
     6. `-p` started inside a project works in it once the station trusts it (the agent is told the folder and a
        relative write lands there), and before that says the folder is not trusted and works in its own workspace;
     7. the station's own slash commands answer the terminal (POST /api/slash/dispatch, client 'terminal'): /tools reads
        the agent's SAVED floor (the floor a terminal run gets), /usage answers, a page-only command says it is one;
     8. a terminal task run (the dashboard's body) is told it has no station on screen: the [TERMINAL] note, the terminal
        manual pointer and the capability note's "place it in the desktop app" (the run's viewer reaches
        summarizeCapabilities); a page run gets none of it.
   Part of test:http. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const BIN = path.resolve(__dirname, '..', 'bin', 'starnet.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMock(seen) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch (_) {}
        const msgs = p.messages || [];
        const last = [...msgs].reverse().find(m => m && m.role === 'user');
        const text = String((last && last.content) || '');
        const sys = msgs.filter(m => m && m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');
        seen.push({ text: text.slice(-120), tools: (p.tools || []).length, sys });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const tool = (name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        };
        const say = (t) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        };
        if (msgs.some(m => m && m.role === 'tool')) return say('done');
        if (/write the station notes/i.test(text)) return tool('fs.write', { path: 'station-notes.md', content: 'approved from starnet approve' });
        if (/write the project note/i.test(text)) return tool('fs.write', { path: 'project-note.md', content: 'written from the folder starnet was started in' });
        return say('Hello from the station.');
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function cli(args, env, ms, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN].concat(args), { cwd: cwd || process.cwd(), env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, ms || 60000);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function post(fixture, p, body) {
  return new Promise(resolve => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: HOST, port: fixture.port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', e => resolve({ status: 0, json: null, error: e.message })); req.end(payload);
  });
}
function hermetic(profile) {
  const h = { APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile, STARNET_PORT: '', SKYNET_PORT: '', STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '', STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: '' };
  if (process.platform !== 'win32') h.HOME = profile;
  return h;
}

(async () => {
  const seen = [];
  const mock = await startMock(seen);
  const providerEnv = {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-station-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-station-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const fixture = SidecarFixture.create({ prefix: 'sk-cli-station-', env: providerEnv });
  await fixture.start();
  const port = String(fixture.port);
  const env = Object.assign(hermetic(fixture.profile), providerEnv);
  let watcher = null;
  try {
    // a watcher first, so it sees the whole run
    const watched = { out: '', err: '' };
    watcher = spawn(process.execPath, [BIN, 'watch', '--json', '--port', port], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    watcher.stdout.setEncoding('utf8'); watcher.stdout.on('data', d => { watched.out += d; });
    watcher.stderr.setEncoding('utf8'); watcher.stderr.on('data', d => { watched.err += d; });
    // the run starts only once the watcher says its feed is live (a fixed wait let a slow start miss the run's first events)
    const live = Date.now() + 30000;
    while (Date.now() < live && !/watching .* live/.test(watched.err)) await sleep(100);
    A.ok(/^· watching http:\/\/127\.0\.0\.1:\d+ live · ctrl\+c stops$/m.test(watched.err) && watched.out === '', 'watch says once, on stderr, that its feed is live (stdout stays the events): ' + watched.err.trim());

    // the page starts work on its own conversation (the bare agent asks before every write; no task brief, so the
    // write goes straight to the approval gate)
    const pageEvents = [];
    const payload = Buffer.from(JSON.stringify({ model: 'test/model', provider: 'openrouter', agentId: 'agent', streamId: 'desk-e2e', placed: [{ objectType: 'computer' }, { objectType: 'cabinet' }], messages: [{ role: 'user', content: 'write the station notes' }] }));
    const pageDone = new Promise(resolve => {
      const req = http.request({ host: HOST, port: fixture.port, path: '/api/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl } }, res => {
        res.setEncoding('utf8'); let buf = '';
        res.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { pageEvents.push(JSON.parse(l)); } catch (_) {} } } });
        res.on('end', resolve);
      });
      req.on('error', resolve); req.end(payload);
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !pageEvents.some(e => e.name === 'permission.prompt')) await sleep(100);
    A.ok(pageEvents.some(e => e.name === 'permission.prompt'), 'the page run is waiting on an approval');

    /* ---- 1. ls --json -------------------------------------------------------------------------- */
    const ls = await cli(['ls', '--json', '--port', port], env);
    A.eq(ls.code, 0, 'ls exits 0: ' + ls.err.slice(0, 200));
    let j = null; try { j = JSON.parse(ls.out); } catch (_) {}
    const hero = j && j.agents.find(a => a.agentId === 'agent');
    A.ok(hero && hero.status === 'needs-you', 'ls sees the open ask: ' + ls.out.slice(0, 300));
    A.ok(hero && /station-notes\.md/.test(hero.now), 'and names what it wants to write: ' + (hero && hero.now));
    const lsText = await cli(['ls', '--port', port], env);
    A.ok(/needs-you/.test(lsText.out) && /1 need you/.test(lsText.out), 'ls prints a table + summary');

    /* ---- 2. approve ---------------------------------------------------------------------------- */
    const ap = await cli(['approve', '--port', port], env);
    A.eq(ap.code, 0, 'approve exits 0: ' + ap.err);
    A.ok(/^allowed once · .* · fs\.write .*station-notes\.md/.test(ap.out), 'approve says what it allowed: ' + ap.out);
    await pageDone;
    const told = pageEvents.find(e => e.name === 'permission.response');
    A.ok(told && told.payload.via === 'terminal' && told.payload.decision === 'once', "the page's stream was told the terminal answered: " + JSON.stringify(told && told.payload));
    A.ok(fs.existsSync(path.join(fixture.workspace, 'agent', 'station-notes.md')), 'the approved write really landed');
    const again = await cli(['approve', '--port', port], env);
    A.eq(again.code, 6, 'nothing left to approve → exit 6');
    A.eq((await cli(['deny', 'agent', '--port', port], env)).code, 6, 'nothing to deny → exit 6');
    A.eq((await cli(['approve', 'ghost', '--port', port], env)).code, 3, 'an unknown agent → exit 3');

    /* ---- 3. watch --json ---------------------------------------------------------------------- */
    await sleep(800);
    const lines = watched.out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const runId = (pageEvents.find(e => e.name === 'agent.run.start') || { payload: {} }).payload.runId;
    const mine = lines.filter(e => e.payload && e.payload.runId === runId).map(e => e.name);
    A.ok(mine.indexOf('agent.run.start') >= 0 && mine.indexOf('agent.tool_call') >= 0 && mine.indexOf('permission.prompt') >= 0 && mine.indexOf('agent.run.end') >= 0, 'watch --json streamed the run: ' + mine.join(','));
    const start = lines.find(e => e.name === 'agent.run.start' && e.payload.runId === runId);
    A.ok(start && /write the station notes/.test(start.payload.prompt || ''), 'with the asking prompt');

    /* ---- 4. -p marks a task ------------------------------------------------------------------- */
    seen.length = 0;
    await cli(['-p', 'write a haiku file', '--port', port], env);
    A.ok(seen.some(s => /write a haiku file/.test(s.text) && s.tools > 0), '-p on an instruction: the model was offered tools: ' + JSON.stringify(seen.map(s => s.tools)));
    seen.length = 0;
    await cli(['-p', 'thanks!', '--port', port], env);
    A.ok(seen.some(s => /thanks!/.test(s.text)) && !seen.some(s => /thanks!/.test(s.text) && s.tools > 0), '-p on a pleasantry: talk, no tools');

    /* ---- 5. flow + a bare starnet in a pipe ----------------------------------------------------- */
    const fl = await cli(['flow', '--port', port], env);
    A.eq(fl.code, 0, 'flow exits 0');
    A.ok(/no workflows on this station yet/.test(fl.out), 'and says there are none: ' + fl.out);
    const fj = JSON.parse((await cli(['flow', '--json', '--port', port], env)).out);
    A.eq(fj.flows, [], 'flow --json: an empty list');
    const bare = await cli([], env);
    A.ok(bare.code === 0 && /starnet — run StarNet agents/.test(bare.out), 'a bare starnet without a terminal prints the usage');

    /* ---- 6. the folder it was started in --------------------------------------------------------- */
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cli-proj-'));
    fs.mkdirSync(path.join(proj, '.git')); fs.mkdirSync(path.join(proj, 'src'));
    const projReal = fs.realpathSync.native(proj);
    try {
      seen.length = 0;
      const before = await cli(['-p', 'write the project note', '--port', port, '--yes'], env, 60000, path.join(proj, 'src'));
      A.ok(before.err.indexOf('· ' + projReal + ' is not a trusted project, so ') >= 0 && /works in its own workspace/.test(before.err), 'started in a project the station does not trust: -p says so, naming the project: ' + before.err.slice(0, 400));
      A.ok(seen.length > 0 && !seen.some(s => /PROJECT FOLDER/.test(s.sys)), 'and the agent is told of no project folder');
      A.ok(!fs.existsSync(path.join(proj, 'project-note.md')) && fs.existsSync(path.join(fixture.workspace, 'agent', 'project-note.md')), 'its write landed in its own workspace, not the folder');
      // trusted the way the dashboard's y (and the app's PROJECTS rail) does it: confirmed at the desk (GHSA-2hpj #1) with the
      // code this station printed on its console, as the person at it types it
      const b = await fixture.deskJson('POST', '/api/projects/bless', { path: projReal });
      A.ok(b.status === 200 && b.body && b.body.ok && b.body.root, 'the station trusts the project: ' + JSON.stringify(b.body));
      const root = b.body && b.body.root;
      seen.length = 0;
      const after = await cli(['-p', 'write the project note', '--port', port, '--yes'], env, 60000, path.join(proj, 'src'));
      A.eq(after.code, 0, 'the run in the trusted project exits 0: ' + after.err.slice(-300));
      A.ok(after.err.indexOf(' · in ' + root) >= 0 && !/is not a trusted project/.test(after.err), '-p says the folder it works in: ' + after.err.slice(0, 300));
      A.ok(seen.some(s => s.sys.indexOf('anchored to the trusted project folder ' + root) >= 0), 'the agent is told it works in that project');
      A.ok(fs.existsSync(path.join(proj, 'project-note.md')) && /started in/.test(fs.readFileSync(path.join(proj, 'project-note.md'), 'utf8')), 'and its write (a relative path) landed in the project');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }

    /* ---- 7. the station's slash commands, from the terminal ----------------------------------------- */
    // a floor with a files cabinet on it, saved the way the app saves it: an agent with no room of its own uses it
    const WM = require('../frontend/app/worldmodel.js');   // loaded here: the page's world model, only this section needs it
    const station = WM.create();
    A.ok(station.addProp({ t: 'war_intelcab', x: 2, y: 2, w: 1, h: 2 }).ok, 'a cabinet on the floor');
    const rev = ((await fixture.json('GET', '/api/save?agent=agent')).body.save || {})._saveRevision || 0;
    const saved = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: 5, _saveRevision: rev, updatedAt: Date.now(), agent: { id: 'agent' }, station: station.serialize() });
    A.ok(saved.body && saved.body.ok, 'the floor is saved: ' + saved.text);
    const dispatch = async (input, extra) => (await post(fixture, '/api/slash/dispatch', Object.assign({ input, agentId: 'agent' }, extra || {}))).json || {};
    const said = d => (d.directive ? [d.directive.title].concat(d.directive.lines || [], [d.directive.text]) : []).filter(Boolean).join(' | ');
    const termTools = await dispatch('/tools', { client: 'terminal' });
    A.ok(termTools.ok && termTools.directive.type === 'say' && /✓ [^|]*fs[._]/.test(said(termTools)), '/tools from the terminal lists the files tools its saved floor grants: ' + said(termTools).slice(0, 300));
    const floorless = await dispatch('/tools');
    A.ok(floorless.ok && !/✓ [^|]*fs[._]/.test(said(floorless)), 'a caller sending no floor and not the terminal keeps the old reading (none): ' + said(floorless).slice(0, 200));
    const page = await dispatch('/tools', { client: 'terminal', placed: [] });
    A.ok(page.ok && !/✓ [^|]*fs[._]/.test(said(page)), 'a floor the caller sends (even an empty one) is never replaced by the saved one');
    const usage = await dispatch('/usage', { client: 'terminal' });
    A.ok(usage.ok && usage.directive.type === 'say' && said(usage).length > 0, '/usage answers the terminal: ' + said(usage).slice(0, 200));
    const yolo = await dispatch('/yolo', { client: 'terminal' });
    A.ok(yolo.ok && yolo.directive.type === 'client', 'a page-only command comes back as one (the terminal says it only works in the app)');
    const cat = (await fixture.json('GET', '/api/slash/catalog?agent=agent&client=terminal')).body;
    A.ok(cat && Array.isArray(cat.commands) && cat.commands.some(c => c.name === 'usage'), 'the catalog answers the terminal');

    /* ---- 8. a terminal task run is told it has no station on screen --------------------------------- */
    // the dashboard's own body (bin/lib/dashboard.js send): roster persona, client 'terminal', a task, no floor sent (the
    // saved floor above: a cabinet only, so the run lacks gear and the capability note says where gear is placed)
    const termRun = async (extra) => {
      seen.length = 0;
      const r = await post(fixture, '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'look around the station' }] }, extra));
      A.eq(r.status, 200, 'the run answered: ' + r.status);
      return seen.map(s => s.sys).join('\n');
    };
    const termSys = await termRun({ streamId: 'cli-agent', rosterSystem: true, client: 'terminal' });
    A.ok(termSys.indexOf('[TERMINAL] The Commander is talking to you from the StarNet terminal CLI') >= 0, 'the terminal run carries the [TERMINAL] note');
    A.ok(termSys.indexOf('using StarNet from its TERMINAL CLI') >= 0, 'and the terminal manual pointer, not the desktop manual');
    A.ok(termSys.indexOf('name the object to place in the StarNet desktop app to grant it') >= 0, 'and the capability note sends missing gear to the desktop app (the run\'s viewer reached summarizeCapabilities): ' + (termSys.match(/You do NOT have[^\n]*\n[^\n]*/) || [''])[0].slice(0, 300));
    const deskSys = await termRun({ streamId: 'desk-e2e-8', placed: [{ objectType: 'cabinet' }] });
    A.ok(deskSys.indexOf('[TERMINAL]') < 0 && deskSys.indexOf('in the StarNet desktop app to grant it') < 0 && deskSys.indexOf('TERMINAL CLI') < 0, 'a page run on the same station gets none of it');
  } catch (e) {
    A.ok(false, 'cli-station e2e threw: ' + ((e && e.stack) || e));
  } finally {
    try { if (watcher) watcher.kill(); } catch (_) {}
    await fixture.dispose();
    mock.server.close();
  }
  A.report('cli-station.e2e.test');
})();
