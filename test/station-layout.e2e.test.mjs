/* node test/station-layout.e2e.test.mjs — station.layout END TO END, in real Chromium (2026-09-28).

   The unit suites prove the page verb and the sidecar tool in a vm. Only this proves the whole chain the lead
   actually uses: a MOCK model asks for station_layout → the REAL sidecar tool → the REAL station bridge (SSE) →
   the REAL page (stationcommands.js over the live WorldModel, WorkflowLine, World.planStatus) → the ack → the
   sidecar completes it against the REAL router → the tool result the model receives. And it holds that answer to
   the one promise the tool makes: it says what the Workflow panel shows — the panel is opened in the same page and
   its pill + sentence must match the tool's, character for character.

   Isolated: a fresh seeded workspace, APPDATA / LOCALAPPDATA / USERPROFILE / HOME / HERMES_HOME pointed at scratch
   (a test sidecar must never touch a real station), a fresh Chrome profile, OS-picked ports, and the model is a
   local mock (a mock that is never hit fails the test — traffic that reached a real provider is not a pass).
   Skips LOUDLY when no Chromium is installed. In test:http (a child-process boot + browser is not a fast step). */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { bootToken } = require('./_httpToken.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('station-layout.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

const failures = [];
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!ok) failures.push(name); };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(e => e ? reject(e) : resolve(a.port)); });
});
const stopChild = (child, graceful = false) => new Promise(resolve => {
  if (!child || child.exitCode != null) { resolve(); return; }
  let killTimer;
  const timer = setTimeout(resolve, 6000);
  child.once('exit', () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
  const kill = () => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
      } else child.kill('SIGKILL');
    } catch (_) { clearTimeout(timer); resolve(); }
  };
  if (graceful) killTimer = setTimeout(kill, 3000); else kill();
});

// Match the actual foreground turn, never a quotation in auxiliary context or a desired tool.
function hasExactUserTurn(request, run) {
  const users = (request.messages || []).filter(m => m && m.role === 'user');
  return request.model === run.model && users.length === 1 && userWords(users[0]) === run.prompt;
}
function leadRequest(mock, run) {
  const matches = mock.requests.filter(r => hasExactUserTurn(r, run)
    && !(r.messages || []).some(m => m && (m.role === 'tool' || m.role === 'assistant')));
  if (matches.length !== 1) throw new Error('expected one initial foreground request, found ' + matches.length);
  return matches[0];
}
function layoutResult(mock, run, initial) {
  const starts = run.events.filter(e => e.name === 'agent.run.start');
  const ends = run.events.filter(e => e.name === 'agent.run.end');
  const runId = starts.length === 1 && starts[0].payload && starts[0].payload.runId;
  if (!runId || starts[0].payload.agentId !== 'agent' || ends.length !== 1
    || ends[0].payload.runId !== runId || ends[0].payload.reason !== 'done') throw new Error('foreground run did not finish once');
  const calls = run.events.filter(e => e.name === 'agent.tool_call' && e.payload.runId === runId && e.payload.name === 'station_layout');
  if (calls.length !== 1) throw new Error('expected one foreground station_layout call, found ' + calls.length);
  const callId = calls[0].payload.callId;
  if (mock.issued.get(callId) !== initial) throw new Error('layout call did not originate in the selected foreground request');
  const completed = run.events.filter(e => e.name === 'agent.tool_result' && e.payload.runId === runId && e.payload.callId === callId);
  if (completed.length !== 1 || completed[0].payload.ok !== true || completed[0].payload.isError !== false) throw new Error('foreground layout tool did not succeed once');
  const results = mock.results.filter(r => r.callId === callId && hasExactUserTurn(r.request, run));
  if (results.length !== 1) throw new Error('expected one model-visible foreground layout result, found ' + results.length);
  return results[0].content;
}

// The mock calls station_layout for each registered foreground case, then answers.
function startMock() {
  const mock = { requests: [], results: [], issued: new Map(), cases: new Map() };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      mock.requests.push(p);
      const offered = (p.tools || []).some(t => t && t.function && t.function.name === 'station_layout');
      const answered = (p.messages || []).filter(m => m && m.role === 'tool');
      const ownCase = Array.from(mock.cases.values()).find(c => hasExactUserTurn(p, c));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (ownCase && offered && !answered.length) {
        const callId = 'call_layout_' + mock.requests.length;
        mock.issued.set(callId, p);
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'station_layout', arguments: JSON.stringify(ownCase.args) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      } else {
        for (const m of answered) mock.results.push({ request: p, callId: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        send({ choices: [{ delta: { content: 'I read the floor.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}
async function leadRun(base, token, prompt, args = {}) {
  prompt += '\n[layout-e2e:' + randomUUID() + ']';
  const model = 'test/model';
  mock.cases.set(prompt, { prompt, model, args });
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model, agentId: 'agent', isTask: true, messages: [{ role: 'user', content: prompt }] }) });
  const text = await res.text();
  return { status: res.status, prompt, model, events: text.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) };
}

const root = mkdtempSync(join(tmpdir(), 'starnet-layout-e2e-'));
const iso = {};
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes']]) { iso[k] = join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
const workspace = join(root, 'workspace'), profile = join(root, 'profile');
const mock = await startMock();
const appPort = await freePort(), cdpPort = await freePort();
const base = 'http://127.0.0.1:' + appPort;
materializeSeedWorkspace(workspace, 'test/model');
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, iso) });
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let cdp = null;
try {
  check('isolated seeded sidecar starts', await waitUp(base + '/'));
  const token = await bootToken(base, base);
  cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 45000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  // Resolve the real artwork request only after an edit is held by Build. Slow image readiness
  // used to call World.rebake(), publish that unfinished floor and silently clear pending edits.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original = window.fetch;
    const held = new Promise(resolve => { window.__releaseLayoutArt = resolve; });
    window.__layoutArtHeld = false;
    window.__layoutRoutingPosts = 0;
    window.fetch = function(input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/routing' && init && init.method === 'POST') window.__layoutRoutingPosts++;
      const response = original.apply(this, arguments);
      if (url.pathname !== '/assets/industrial/projection-correction/manifest.json') return response;
      window.__layoutArtHeld = true;
      return response.then(async value => { await held; return value; });
    };
  })();` });
  // a throttled frame pump: the world still recompiles + posts, without a software canvas starving every evaluate
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live floor', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));

  // a REAL line through the live WorldModel mutation API: INBOX -> RESEARCHER -> WRITER -> OUTBOX, the hero on BOTH Bays
  const setup = await evalJS(cdp, `(() => {
    const st = App.station(), hero = App.heroId(), z = st.rooms()[0].rects[0];
    st.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
    let ok = null;
    for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = st.stampBlueprint('research_line', x, y); if (r && r.ok) ok = r; }
    if (!ok) return null;
    const bays = st.props().filter(p => p.t === 'bay').map(p => p.id);
    for (const b of bays) st.assignPropAgent(b, hero);
    const intake = st.props().find(p => p.t === 'intake');
    st.setPropLabel(intake.id, 'RESEARCH DESK');
    return { hero, bays, intake: intake.id };
  })()`);
  check('laid a research line with the hero on both Bays', !!setup && setup.bays.length === 2, JSON.stringify(setup));
  let sync = null;
  for (let i = 0; i < 40; i++) { sync = await evalJS(cdp, 'World.planStatus()'); if (sync && !sync.pending && sync.lastHash && !sync.inflight && !sync.stale) break; await sleep(500); }
  check('the world posted the floor and the router answered', !!sync && !sync.pending && !!sync.lastHash && !sync.stale, JSON.stringify(sync && { pending: sync.pending, stale: sync.stale }));

  // 1. the lead reads the floor over the real bridge
  const run1 = await leadRun(base, token, 'what does my research line do?');
  const end1 = run1.events.filter(e => e.name === 'agent.run.end').pop();
  check('the lead run completes', run1.status === 200 && !!end1 && end1.payload.reason === 'done', JSON.stringify(end1 && end1.payload && end1.payload.reason));
  const leadReq = leadRequest(mock, run1);
  check('the lead is offered station_layout', JSON.stringify(leadReq.tools || []).indexOf('station_layout') >= 0);
  const result1 = layoutResult(mock, run1, leadReq);
  let R = null; try { R = JSON.parse(result1); } catch (_) { R = null; }
  check('the model received the layout (not a refusal)', !!R, result1.slice(0, 160));
  const L = R && (R.lines || []).find(l => l.name === 'RESEARCH DESK');
  check('routing is live AND confirmed against the real router', !!R && R.routing.state === 'live' && R.routing.confirmed === true, JSON.stringify(R && R.routing));
  check('two steps, the hero on both, in compiled order', !!L && L.steps.length === 2 && L.steps.every(s => s.propId && setup.bays.indexOf(s.propId) >= 0), JSON.stringify(L && L.steps));
  check('the line carries the runner\'s effective budget', !!L && !!L.budget && typeof L.budget.maxHops === 'number', JSON.stringify(L && L.budget));

  // 2. the same line in full: per-Bay hand-offs off the compiled dock layer
  const run2 = await leadRun(base, token, 'show me that line in full', { line: 'research desk' });
  const result2 = layoutResult(mock, run2, leadRequest(mock, run2));
  let D = null; try { D = JSON.parse(result2).line; } catch (_) { D = null; }
  const [a, b] = (D && D.steps) || [];
  check('`line` returns that one line in full', !!D && D.name === 'RESEARCH DESK' && !!a && typeof a.brief === 'string' && Array.isArray(a.tools));
  check('step 1 is fed by the Inbox and hands to step 2; step 2 ships to the OUTBOX', !!a && !!b && a.fedByInbox === true && b.fedByInbox === false
    && a.sendsTo.length === 1 && a.sendsTo[0].step === 2 && b.sendsTo.length === 1 && b.sendsTo[0] === 'OUTBOX', JSON.stringify(a && [a.sendsTo, b.sendsTo]));

  // 3. PARITY: the REAL Workflow panel on the same line shows the same pill and the same sentence
  await evalJS(cdp, `(() => { Build.openAssign(${JSON.stringify(setup.intake)}); return true; })()`);
  let panel = null;
  for (let i = 0; i < 20; i++) {
    panel = await evalJS(cdp, `(() => { try { WorkflowPanel.refresh && WorkflowPanel.refresh(); } catch (e) {}
      const p = document.getElementById('wf-pill'), s = document.getElementById('wf-sentence');
      return { open: WorkflowPanel.isOpen(), pill: p && p.textContent, sentence: s && s.textContent }; })()`);
    if (panel && panel.open && panel.pill === (L && L.status) && panel.sentence === (L && L.howItRuns)) break;
    await sleep(500);
  }
  check('panel pill == tool status', !!panel && !!L && panel.pill === L.status, JSON.stringify([panel && panel.pill, L && L.status]));
  check('panel sentence == tool sentence', !!panel && !!L && panel.sentence === L.howItRuns, '\n  panel: ' + (panel && panel.sentence) + '\n  tool : ' + (L && L.howItRuns));

  // 4. Build mode holds the world: an unsent edit reads as pending, and the answer never says the router runs it
  await evalJS(cdp, `(() => { App.station().assignPropAgent(${JSON.stringify(setup.bays[1])}, ''); return true; })()`);
  const heldBefore = await evalJS(cdp, '({ build: Build.isOpen(), held: window.__layoutArtHeld, posts: window.__layoutRoutingPosts, sync: World.planStatus() })');
  check('Build holds the edit before artwork finishes', heldBefore.build && heldBefore.held && heldBefore.sync.pending, JSON.stringify(heldBefore));
  const heldAfter = await evalJS(cdp, `(async () => {
    window.__releaseLayoutArt(); await PropRemaster.ready;
    World.rebake(); // lighting/user-art refresh shares the public invalidation path
    const full = World.renderStill(320);
    const cropped = World.renderStillOfTiles(App.station().rooms()[0].rects[0], 320);
    return { build: Build.isOpen(), revision: PropRemaster.revision(), full: full === null, cropped: cropped === null,
      posts: window.__layoutRoutingPosts, sync: World.planStatus() };
  })()`);
  check('late artwork and still reads preserve the unpublished Build floor', heldAfter.build && heldAfter.revision > 0
    && heldAfter.full && heldAfter.cropped && heldAfter.sync.pending
    && heldAfter.sync.hash === heldBefore.sync.hash && heldAfter.sync.lastHash === heldBefore.sync.lastHash
    && !heldAfter.sync.inflight && heldAfter.posts === heldBefore.posts, JSON.stringify(heldAfter));
  const run3 = await leadRun(base, token, 'why is step 2 not running?');
  const result3 = layoutResult(mock, run3, leadRequest(mock, run3));
  let P = null; try { P = JSON.parse(result3); } catch (_) { P = null; }
  /* The router routes by the floor the station SAVED, and the page saves the edit at once while Build mode holds back only its compile and its send.
     So the router already differs from the floor the page last sent, and the answer says so, with the page's account of the edits it holds back —
     never "the router runs the floor as last sent", and never "another open page". (test/station-layout.test.js holds the whole merge.) */
  check('an edit held by Build mode reads as pending', !!P && P.routing.pendingEdits === true && P.routing.state === 'unconfirmed' && P.routing.confirmed === false
    && /different version of the floor than the page last sent/.test(P.routing.note) && /newer edits/.test(P.routing.note) && !/running the floor as last sent|another open page/.test(P.routing.note), JSON.stringify(P && P.routing));
  const PL = P && (P.lines || []).find(l => l.name === 'RESEARCH DESK');
  check('and the drawn floor says what is missing', !!PL && /NEEDS AN AGENT/.test(PL.status), PL && PL.status);
  // The explicit run boundary can still publish while Build stays open; closing Build publishes the next edit.
  const published = await evalJS(cdp, '(async () => { await World.syncPlan(); World.rebake(); return {build:Build.isOpen(),sync:World.planStatus()}; })()');
  check('explicit plan sync still publishes a held edit', published.build && !published.sync.pending && !published.sync.inflight
    && !published.sync.stale && published.sync.hash !== heldBefore.sync.hash, JSON.stringify(published));
  await evalJS(cdp, `(() => { App.station().assignPropAgent(${JSON.stringify(setup.bays[1])}, ${JSON.stringify(setup.hero)}); Build.close(); return true; })()`);
  let closed = null;
  for (let i = 0; i < 40; i++) {
    closed = await evalJS(cdp, '({build:Build.isOpen(),sync:World.planStatus()})');
    if (!closed.build && !closed.sync.pending && !closed.sync.inflight && !closed.sync.stale && closed.sync.hash === heldBefore.sync.hash) break;
    await sleep(250);
  }
  check('closing Build publishes the next floor', closed && !closed.build && !closed.sync.pending && !closed.sync.inflight
    && !closed.sync.stale && closed.sync.hash === heldBefore.sync.hash, JSON.stringify(closed));
  const run4 = await leadRun(base, token, 'read the line after I close Build');
  const finalLayout = JSON.parse(layoutResult(mock, run4, leadRequest(mock, run4)));
  check('the real router confirms the floor published on close', finalLayout.routing.state === 'live' && finalLayout.routing.confirmed === true
    && !finalLayout.routing.pendingEdits && finalLayout.lines.some(l => l.name === 'RESEARCH DESK' && l.ready), JSON.stringify(finalLayout.routing));
  check('the mock carried every model call (no real provider)', mock.requests.length >= 6, String(mock.requests.length));
  check('no page exceptions', diagnostics.exceptions.length === 0, JSON.stringify(diagnostics.exceptions.slice(0, 3)));
} catch (error) {
  console.log('FAIL harness :: ' + (error && error.stack || error));
  failures.push('harness');
} finally {
  try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch {}
  try { cdp?.ws.close(); } catch {}
  await Promise.all([stopChild(chrome, true), stopChild(sidecar)]);
  try { mock.server.close(); } catch {}
  const resolvedRoot = root.replace(/\\/g, '/');
  if (resolvedRoot.startsWith(tmpdir().replace(/\\/g, '/') + '/') && /starnet-layout-e2e-/.test(resolvedRoot)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) console.log('(could not remove ' + root + ': ' + error.message + ')'); await sleep(300); }
    }
  }
}

console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'station-layout.e2e: ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
