/* node test/station-builder.e2e.test.mjs — THE AGENT STATION BUILDER end to end, in real Chromium (2026-09-29).

   A MOCK lead model calls station_plan_line (a line from the fixed menu) → the REAL sidecar tool → the REAL station bridge →
   the REAL page (StationBuilder.plan on a copy of the live WorldModel) → the plan comes back; the model then calls
   station_build with that planId → StationBuilder.apply in ONE transact. It holds the build to its promises: the
   floor has exactly the planned room + line, the Workflow panel reads it the way the tool did, Build mode open refuses,
   and one UNDO removes all of it. Then the same for a furnished room kit (station_plan_room) and a restyle
   (station_plan_restyle): the room holds exactly the kit's furniture, the restyle changes only the floor, one UNDO each.
   Last, a whole-station swap (replace: true) is backed up to Build mode's own slot, and its RESTORE PREVIOUS brings the old station back.
   And the ask understood: the Commander's words pick the line, and "new" recruits a Tester through the page's own summon.
   Last, vibe design: "the left side cozy, the right side a line that builds and tests code" lands exactly so, in one undo. Isolated like station-layout.e2e (APPDATA / LOCALAPPDATA / USERPROFILE / HOME /
   HERMES_HOME to scratch, a fresh Chrome profile, OS-picked ports, a local mock model). Skips LOUDLY with no Chromium. */
import { spawn } from 'node:child_process';
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
const { hintFor } = require('./helpers/saved-floor.js');   // the compile the router routes by: the station's SAVED floor, compiled the way the page does

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('station-builder.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

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

// the mock model: a lead that finds the station builder the way a real one must (tool_search: the builder is deferred),
// (with mock.lookFirst) reads station_map, then PLANS (station_plan with mock.planArgs), then BUILDS the planId it was
// given, then answers.
// A refusal (no planId in the tool result) ends the run in words — the way a real model reads REFUSED.
function startMock() {
  // verdict: the VERDICT line a reviewer stage of the line under test ends its reply with (null: a reviewer that forgets it)
  const mock = { requests: [], results: [], planTool: 'station_plan', planArgs: {}, lookFirst: false, searched: [], verdict: 'approved' };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      mock.requests.push(p);
      const offered = (p.tools || []).some(t => t && t.function && t.function.name === 'tool_search');
      const answered = (p.messages || []).filter(m => m && m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const call = (name, args) => {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + name + '_' + mock.requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      };
      const say = text => {
        send({ choices: [{ delta: { content: text } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      };
      // a step of a line the lead is TESTING (station_test_line): the job, or the step before it, is in its user turn
      if ((p.messages || []).some(m => m && m.role === 'user' && /TEST JOB:|LINE STEP DONE/.test(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))) { mock.lineSteps = (mock.lineSteps || 0) + 1; say('LINE STEP DONE: hello' + (mock.verdict ? '\nVERDICT: ' + mock.verdict : '')); res.write('data: [DONE]\n\n'); return res.end(); }
      const pre = ['tool_search'].concat(mock.lookFirst ? ['station_map'] : []), seq = pre.length;   // tool calls before the plan
      if (offered && answered.length === 1) mock.searched.push({ result: answered[0], toolsAfter: null });
      if (offered && answered.length === 1 && mock.searched.length) mock.searched[mock.searched.length - 1].toolsAfter = (p.tools || []).map(t => t && t.function && t.function.name);
      if (offered && answered.length < seq) call(pre[answered.length], pre[answered.length] === 'tool_search' ? { query: 'station builder' } : (mock.mapArgs || {}));
      else if (offered && answered.length === seq) { if (mock.lookFirst) mock.results.push(answered[1]); call(mock.planTool, mock.planArgs); }
      else if (offered && answered.length === seq + 1) {
        mock.results.push(answered[seq]);
        let planId = null; try { planId = JSON.parse(answered[seq]).planId; } catch (_) { planId = null; }
        if (planId) call('station_build', { planId }); else say('I could not plan that.');
      } else { for (const t of answered.slice(seq + 1)) mock.results.push(t); say('Done.'); }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}
async function leadRun(base, token, prompt) {
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: prompt }] }) });
  const text = await res.text();
  return { status: res.status, events: text.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) };
}

const root = mkdtempSync(join(tmpdir(), 'starnet-builder-e2e-'));
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
  // a throttled frame pump: the world still recompiles + posts, without a software canvas starving every evaluate
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live floor', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));


  const before = await evalJS(cdp, `(() => { const st = App.station(); return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), hero: App.heroId() }; })()`);
  // the page must be LISTENING on the bridge before a tool asks it anything (the SSE opens after the floor paints)
  let link = null;
  for (let i = 0; i < 60; i++) { link = await evalJS(cdp, "World._dbgLinkState()"); if (link && link.readyState === 1 && link.lastEventMsAgo != null) break; await sleep(500); }
  check("the page is listening on the station bridge", !!link && link.readyState === 1 && link.lastEventMsAgo != null, JSON.stringify(link));
  let sync = null;
  for (let i = 0; i < 40; i++) { sync = await evalJS(cdp, 'World.planStatus()'); if (sync && !sync.pending && !sync.inflight && !sync.stale) break; await sleep(500); }

  // Hold the frame pump before the mutation: a build must publish itself, even if no animation frame runs.
  // Previously the document changed but /api/routing kept the empty plan, while the receipt said ready.
  await evalJS(cdp, 'World.stop(); true');

  // 1. the lead plans a line from the fixed menu, then builds exactly that plan (full access: no approval card here)
  mock.planTool = 'station_plan'; mock.planArgs = { line: 'Build + test', name: 'SHIP IT', steps: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'lead' }], dailyCap: 5 };
  const req0 = mock.requests.length;   // only THIS run's requests are its own
  const run1 = await leadRun(base, token, 'make me a new room with a line that builds features and tests them');
  const end1 = run1.events.filter(e => e.name === 'agent.run.end').pop();
  check('the lead run completes', run1.status === 200 && !!end1 && end1.payload.reason === 'done', JSON.stringify(end1 && end1.payload && end1.payload.reason));
  /* the LEAD's first turn: it is offered tool_search (every loop turn is). A background model call carrying the same words and no
     tools could finish uploading first under gate load and be read as the lead's (3 of 17 gates failed here, never solo). */
  const offered = r => (r.tools || []).some(t => t && t.function && t.function.name === 'tool_search');
  const leadReq = mock.requests.slice(req0).find(r => offered(r) && JSON.stringify(r.messages || []).indexOf('builds features and tests them') >= 0) || {};
  const offeredNames = JSON.stringify(leadReq.tools || []);
  check('the builder is deferred: not on the wire at first, but named in the prompt as there to find', ['station_map', 'station_plan', 'station_build'].every(n => offeredNames.indexOf('"' + n + '"') < 0) && ['station_map', 'station_plan', 'station_build'].every(n => JSON.stringify(leadReq.messages || []).indexOf(n) >= 0), offeredNames.slice(0, 120));
  const found = mock.searched[0] || {};
  check('tool_search "station builder" reveals all three, callable on the next turn', /station\.map/.test(found.result || '') && /station\.plan/.test(found.result || '') && /station\.build/.test(found.result || '') && ['station_map', 'station_plan', 'station_build'].every(n => (found.toolsAfter || []).indexOf(n) >= 0), (found.result || '').slice(0, 200) + ' | ' + JSON.stringify(found.toolsAfter || []).slice(0, 200));
  let PL = null; try { PL = JSON.parse(mock.results[0] || ''); } catch (_) { PL = null; }
  check('the plan came back from a copy of the station: nothing built yet', !!PL && /^plan-/.test(PL.planId) && /Nothing has been built yet/.test(PL.next), (mock.results[0] || '').slice(0, 200));
  check('the plan speaks plainly and says it will be ready', !!PL && /^Build \+ test \("SHIP IT"\) in a new room (north|south|east|west) of HOME, through a hallway: Engineer \(.+\) → Tester \(.+\) → Outbox · daily cap \$5 · up to 3 review tries\. It will be ready to run\.$/.test(PL.summary) && PL.ready === true, PL && PL.summary);
  let BL = null; try { BL = JSON.parse(mock.results[1] || ''); } catch (_) { BL = null; }
  check('the build answered: built, ready to run, and how to undo it', !!BL && BL.built === true && BL.ready === true && /one UNDO/.test(BL.undo), (mock.results[1] || '').slice(0, 200));

  // 2. the floor really has it — named, capped, staffed by the lead — and nothing else moved
  const floor = await evalJS(cdp, `(() => { const st = App.station(), hero = App.heroId();
    const ip = st.props().find(p => p.t === 'intake' && p.label === 'SHIP IT');
    const bays = st.props().filter(p => p.t === 'bay');
    return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), intake: ip && ip.id, lineId: ip && ip.lineId, cap: ip && ip.limits && ip.limits.maxUsdPerDay,
      bays: bays.map(b => [b.role, b.agentId === hero, (b.brief || '').slice(0, 20)]), loop: (st.props().find(p => p.t === 'loop') || {}).maxIter }; })()`);
  check('a new room named for the line, beside the station', floor.rooms.length === before.rooms.length + 1 && floor.rooms.includes('SHIP IT'), JSON.stringify(floor.rooms));
  check('the Inbox is named and carries the $5 daily cap', !!floor.intake && floor.cap === 5, JSON.stringify(floor));
  check('both steps are staffed by the lead with their standard instructions', floor.bays.length === 2 && floor.bays.every(b => b[1] && b[2].length > 5) && floor.loop === 3, JSON.stringify(floor.bays));

  // Nothing a page posts is installed or kept: the router routes by the floor the station SAVED. So the plan to hold the receipt against is that floor's, compiled
  // the way the router compiles it (the old read of routing.plan.json, the last plan a page posted, is a file the station no longer writes).
  const savedNow = await fetch(base + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': token, Origin: base } }).then(r => r.json()).catch(() => null);
  const posted = savedNow && savedNow.save && savedNow.save.station ? hintFor(savedNow.save.station).plan : {};
  const builtSync = await evalJS(cdp, 'World.planStatus()');
  check('the build receipt follows publication even with the frame pump held',
    !!BL && !!BL.routing && BL.routing.published === true && typeof floor.lineId === 'string' && !!floor.lineId
      && (posted.lines || []).some(l => l.lineId === floor.lineId && (l.intakes || []).includes(floor.intake) && l.name === 'SHIP IT')
      && !builtSync.pending && !builtSync.inflight && !builtSync.stale && !builtSync.refusedHash && BL.routing.hash === posted.hash,
    JSON.stringify({ routing: BL && BL.routing, hash: posted.hash, lines: (posted.lines || []).map(l => l.lineId), world: builtSync }));

  // 3. parity: the Workflow panel on that line says what the tool said
  await evalJS(cdp, `(() => { Build.openAssign(${JSON.stringify(floor.intake)}); return true; })()`);
  let panel = null;
  for (let i = 0; i < 30; i++) {
    panel = await evalJS(cdp, `(() => { try { WorkflowPanel.refresh && WorkflowPanel.refresh(); } catch (e) {}
      const p = document.getElementById('wf-pill'); return { open: WorkflowPanel.isOpen(), pill: p && p.textContent }; })()`);
    if (panel && panel.open && panel.pill === 'READY TO RUN') break;   // the first paint lands before Build mode has compiled the line
    await sleep(500);
  }
  check('the Workflow panel agrees: READY TO RUN', !!panel && panel.pill === 'READY TO RUN', JSON.stringify(panel));

  // 4. Build mode open: the Commander owns the floor, so the builder refuses (and the model is told why)
  const run2 = await leadRun(base, token, 'add another build and test line');
  check('a second run completes', run2.status === 200);
  check('with Build mode open, planning is refused in plain words', /^REFUSED: Build mode is open, so the Commander is editing the floor/.test(mock.results[2] || ''), (mock.results[2] || '').slice(0, 160));

  // 4b. TEST A LINE (10-01): the lead sends one real job down the line it built (SEND A JOB's own route) and reads each step back
  mock.planTool = 'station_test_line'; mock.planArgs = { line: 'SHIP IT', job: 'TEST JOB: write the word hello' };
  const nRes = mock.results.length, steps0 = mock.lineSteps || 0;
  const runT = await leadRun(base, token, 'test the SHIP IT line');
  const tl = mock.results[nRes] || '';
  let TJ = null; try { TJ = JSON.parse(tl.split('\n')[0]); } catch (_) { TJ = null; }
  check('station_test_line sends a real job down the line and reads every step back', runT.status === 200 && !!TJ && TJ.line === 'SHIP IT' && TJ.status === 'delivered' && TJ.steps.length >= 2 && TJ.steps.every(s => s.ended === 'done') && (mock.lineSteps || 0) - steps0 >= 2, tl.slice(0, 300));
  check('what the line delivered comes back fenced as data, not instructions', /\[BEGIN EXTERNAL WEB CONTENT — what the line SHIP IT delivered/.test(tl) && /LINE STEP DONE: hello/.test(tl), tl.slice(-240));
  const jobs = await fetch(base + '/api/line-jobs', { headers: { 'X-StarNet-Token': token, Origin: base } }).then(r => r.json()).catch(() => null);
  check('and the job is on record like any SEND A JOB', !!jobs && (jobs.jobs || []).some(j => j.name === 'SHIP IT' && j.status === 'delivered'), JSON.stringify(jobs || {}).slice(0, 240));

  // 4b2. THE SAME LINE, A REVIEWER THAT FORGETS ITS VERDICT (line-hold lane): a verdict gate that gets no usable VERDICT line holds the work
  // for a person at once, with nothing more bought, instead of looping its review tries and shipping the work unapproved. The lead's tool says
  // so in words, the job is on record as HELD (not delivered, no end time), and a STOP is the person's answer.
  mock.verdict = null;
  const nRes2 = mock.results.length, steps1 = mock.lineSteps || 0;
  const runH = await leadRun(base, token, 'test the SHIP IT line once more');
  const th = mock.results[nRes2] || '';
  let HJ = null; try { HJ = JSON.parse(th.split('\n')[0]); } catch (_) { HJ = null; }
  check('a reviewer with no VERDICT line holds the work: station_test_line says it is held for a person, never delivered', runH.status === 200 && !!HJ && HJ.status !== 'delivered' && HJ.outcome === 'blocked' && /no usable VERDICT line/.test((HJ.stop && HJ.stop.why) || '') && /saved for a person to decide/.test(th), th.slice(0, 300));
  check('and nothing was bought after the gate: the two stages ran once each, no review pass was repeated', (mock.lineSteps || 0) - steps1 === 2, String((mock.lineSteps || 0) - steps1));
  const heldList = await fetch(base + '/api/line-jobs', { headers: { 'X-StarNet-Token': token, Origin: base } }).then(r => r.json()).catch(() => null);
  const heldJob = ((heldList && heldList.jobs) || []).find(j => j.name === 'SHIP IT' && j.status === 'held');
  check('and the job is on record as HELD: no end time, saved for a person to decide', !!heldJob && heldJob.endedAt == null, JSON.stringify(heldJob || heldList || {}).slice(0, 240));
  const stopHeld = heldJob ? await fetch(base + '/api/line-jobs/' + heldJob.id, { method: 'DELETE', headers: { 'X-StarNet-Token': token, Origin: base } }).then(r => r.json()).catch(() => null) : null;
  let afterStop = null;
  for (let i = 0; heldJob && i < 30; i++) {
    afterStop = await fetch(base + '/api/line-jobs/' + heldJob.id, { headers: { 'X-StarNet-Token': token, Origin: base } }).then(r => r.json()).catch(() => null);
    if (afterStop && afterStop.job && afterStop.job.status === 'stopped') break;
    await sleep(100);
  }
  check('a STOP is the person\'s answer: the held job ends stopped, and still nothing more was bought', !!stopHeld && stopHeld.stopRequested === true && !!afterStop && !!afterStop.job && afterStop.job.status === 'stopped' && (mock.lineSteps || 0) - steps1 === 2, JSON.stringify([stopHeld, afterStop && afterStop.job && afterStop.job.status]).slice(0, 300));
  mock.verdict = 'approved';

  // 4c. WHAT STARTS A LINE (10-01): a schedule and a webhook through the panel's own cores, and a trigger turned off
  const api = (p, o) => fetch(base + p, Object.assign({ headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base } }, o || {})).then(r => r.json()).catch(() => null);
  mock.planTool = 'station_start_line'; mock.planArgs = { line: 'SHIP IT', schedule: 'weekdays at 8:30am', job: 'TEST JOB: the morning check' };
  let nS = mock.results.length;
  await leadRun(base, token, 'run the SHIP IT line every weekday morning');
  let SJ = null; try { SJ = JSON.parse(mock.results[nS] || ''); } catch (_) { SJ = null; }
  const cronNow = await api('/api/cron');
  const routine = SJ && cronNow && (cronNow.jobs || []).find(j => j.id === SJ.id);
  check('station_start_line { schedule } makes a routine that runs the whole line from its first step', !!routine && routine.runsLine === true && !!routine.dockId && routine.prompt === 'TEST JOB: the morning check' && /^SHIP IT — /.test(routine.name) && /^The line SHIP IT now runs /.test(SJ.said), (mock.results[nS] || '').slice(0, 240));
  mock.planArgs = { line: 'SHIP IT', webhook: true, job: 'TEST JOB: a deploy finished' };
  nS = mock.results.length;
  await leadRun(base, token, 'start the SHIP IT line from a webhook');
  let WJ = null; try { WJ = JSON.parse(mock.results[nS] || ''); } catch (_) { WJ = null; }
  const trg = await api('/api/routing/triggers');
  const hook = WJ && trg && (trg.triggers || []).find(t => t.id === WJ.id);
  check('station_start_line { webhook } makes the line\'s webhook trigger, and the lead never sees a key', !!hook && hook.kind === 'webhook' && hook.config.task === 'TEST JOB: a deploy finished' && /press NEW KEY/.test(WJ.said) && !/"secret"|whsec|trg_[A-Za-z0-9]+\.[A-Za-z0-9]{16,}/.test(mock.results[nS] || ''), (mock.results[nS] || '').slice(0, 240));
  mock.planArgs = { line: 'SHIP IT', off: WJ ? WJ.id : 'none' };
  nS = mock.results.length;
  await leadRun(base, token, 'turn that webhook off');
  const trg2 = await api('/api/routing/triggers');
  check('and turns a trigger off', !!WJ && (trg2.triggers || []).some(t => t.id === WJ.id && t.enabled === false), (mock.results[nS] || '').slice(0, 200));
  if (routine) await api('/api/cron/remove', { method: 'POST', body: JSON.stringify({ id: routine.id }) });
  mock.planTool = 'station_plan';

  // 5. one UNDO removes the room, the line and every setting
  const undone = await evalJS(cdp, `(() => { const st = App.station(); const r = st.undo(); return { ok: r && r.ok, rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), line: !!st.props().find(p => p.t === 'intake' && p.label === 'SHIP IT') }; })()`);
  check('one UNDO removes all of it', undone.ok && JSON.stringify(undone.rooms) === JSON.stringify(before.rooms) && !undone.line, JSON.stringify(undone));
  await evalJS(cdp, `(() => { if (WorkflowPanel.isOpen()) WorkflowPanel.close(); Build.close(); return true; })()`);

  // 6. a furnished room kit: the lead picks LOUNGE from the menu, StarNet places every piece
  const kit = await evalJS(cdp, `(() => { const k = StationTemplates.kits().find(x => x.id === 'cozyLounge'); return { name: k.name, n: k.props.length, types: k.props.map(p => p[0]).sort() }; })()`);
  mock.planTool = 'station_plan'; mock.planArgs = { kit: kit.name };
  let at = mock.results.length;
  const run3 = await leadRun(base, token, 'add a lounge');
  check('the room run completes', run3.status === 200);
  let RP = null, RB = null; try { RP = JSON.parse(mock.results[at] || ''); RB = JSON.parse(mock.results[at + 1] || ''); } catch (_) {}
  check('the room plan speaks plainly', !!RP && RP.summary.indexOf(kit.name + ' (') === 0 && / in a new room (north|south|east|west) of HOME, through a hallway/.test(RP.summary) && /Nothing has been built yet/.test(RP.next), (mock.results[at] || '').slice(0, 240));
  check('the room build answered with the room and how to undo it', !!RB && RB.ok !== false && (RB.rooms || []).some(r => r.name === kit.name) && /one UNDO/.test(RB.undo || ''), (mock.results[at + 1] || '').slice(0, 240));
  const lib = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === ${JSON.stringify(kit.name)}); if (!r) return null;
    return { types: st.props().filter(p => st.roomAt(p.x, p.y) === r.id).map(p => p.t).sort(), style: r.floorStyle }; })()`);
  check('the new room holds exactly the kit\'s furniture', !!lib && JSON.stringify(lib.types) === JSON.stringify(kit.types), JSON.stringify(lib));

  // 7. a restyle: only the floor changes
  mock.planTool = 'station_plan'; mock.planArgs = { restyle: { room: kit.name, floorStyle: 'teal', floorMat: 'tile' } };
  at = mock.results.length;
  const propsBefore = await evalJS(cdp, 'JSON.stringify(App.station().serialize().props)');
  const run4 = await leadRun(base, token, 'make the lounge floor teal tile');
  check('the restyle run completes', run4.status === 200);
  let SP = null; try { SP = JSON.parse(mock.results[at] || ''); } catch (_) {}
  check('the restyle plan says nothing is added, moved or removed', !!SP && /Nothing is added, moved or removed\.$/.test(SP.summary), (mock.results[at] || '').slice(0, 200));
  const styled = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === ${JSON.stringify(kit.name)}); return { style: r && r.floorStyle, mat: r && r.floorMat, same: JSON.stringify(st.serialize().props) === ${JSON.stringify(propsBefore)} }; })()`);
  check('the room is restyled and no prop changed', styled.style === 'teal' && styled.mat === 'tile' && styled.same, JSON.stringify(styled));

  // 7b. EDIT WHAT STANDS through the real page: refurnish the lounge as a library, then remove it
  mock.planTool = 'station_plan'; mock.planArgs = { refurnish: { room: kit.name, style: 'library', name: 'Reading Room' } };
  at = mock.results.length;
  const run4b = await leadRun(base, token, 'turn the lounge into a library called reading room');
  check('the refurnish run completes', run4b.status === 200);
  let EP = null; try { EP = JSON.parse(mock.results[at] || ''); } catch (_) {}
  check('the refurnish plan says what goes and what comes', !!EP && new RegExp('^Refurnish ' + kit.name + ' as a library: its \\d+ pieces of furniture are cleared').test(EP.summary) && /; renamed READING ROOM\./.test(EP.summary), (mock.results[at] || '').slice(0, 300));
  const refurnished = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === 'READING ROOM'); if (!r) return null; const t = st.props().filter(p => st.roomAt(p.x, p.y) === r.id).map(p => p.t); return { books: t.filter(x => /bookshelf/.test(x)).length, kitLeft: t.filter(x => ${JSON.stringify(kit.types)}.indexOf(x) >= 0 && !/plant|rug|lamp/.test(x)).length }; })()`);
  check('the room is a READING ROOM of bookshelves, the kit furniture gone', !!refurnished && refurnished.books >= 2, JSON.stringify(refurnished));
  mock.planTool = 'station_plan'; mock.planArgs = { remove: 'Reading Room' };
  at = mock.results.length;
  const run4c = await leadRun(base, token, 'actually remove the reading room');
  check('the remove run completes', run4c.status === 200);
  let XP = null; try { XP = JSON.parse(mock.results[at] || ''); } catch (_) {}
  check('the remove plan names what goes', !!XP && /^Remove READING ROOM \(\d+ × \d+\), with the hallway that joined it\. Its furniture goes with it/.test(XP.summary), (mock.results[at] || '').slice(0, 300));
  const removed = await evalJS(cdp, `(() => { const st = App.station(); return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), halls: st.rooms().filter(r => r.kind === 'corridor').length }; })()`);
  check('the room and its hallway are gone; the station is as it began', JSON.stringify(removed.rooms) === JSON.stringify(before.rooms) && removed.halls === 0, JSON.stringify(removed));

  // 8. one UNDO each: the removal, the refurnish, the restyle, then the whole room
  const undone2 = await evalJS(cdp, `(() => { const st = App.station(); const u = [st.undo(), st.undo()], back = st.rooms().some(r => r.name === ${JSON.stringify(kit.name)}); const v = [st.undo(), st.undo()]; return { ok: u.concat(v).every(x => x && x.ok), back, rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name) }; })()`);
  check('one UNDO each takes back the removal, the refurnish, the restyle and the furnished room', undone2.ok && undone2.back && JSON.stringify(undone2.rooms) === JSON.stringify(before.rooms), JSON.stringify(undone2));

  // 9. the whole-station swap: backed up to Build mode's own slot, so its RESTORE PREVIOUS brings the old station back
  const preSwap = await evalJS(cdp, `(() => { const st = App.station(); return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), props: st.props().length, key: 'starnet.layoutBackup.' + st.doc().meta.createdAt }; })()`);
  await evalJS(cdp, `(() => { try { localStorage.removeItem(${JSON.stringify(preSwap.key)}); } catch (e) {} return true; })()`);
  mock.planTool = 'station_plan'; mock.planArgs = { preset: 'Research Station', replace: true };
  at = mock.results.length;
  const run5 = await leadRun(base, token, 'replace my station with the research station');
  check('the swap run completes', run5.status === 200);
  let WP = null, WB = null; try { WP = JSON.parse(mock.results[at] || ''); WB = JSON.parse(mock.results[at + 1] || ''); } catch (_) {}
  check('the swap plan says what is replaced and how to get it back', !!WP && /^Swap your whole station for RESEARCH STATION \(/.test(WP.summary) && /RESTORE PREVIOUS in Build → Presets brings it back/.test(WP.summary), (mock.results[at] || '').slice(0, 300));
  check('the swap answered built', !!WB && WB.built === true, (mock.results[at + 1] || '').slice(0, 200));
  const swapped = await evalJS(cdp, `(() => { const st = App.station(); let saved = null; try { saved = JSON.parse(localStorage.getItem(${JSON.stringify(preSwap.key)}) || 'null'); } catch (e) {}
    return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), backupProps: saved && saved.props ? saved.props.length : -1 }; })()`);
  check('the station is now the preset', JSON.stringify(swapped.rooms) === JSON.stringify(['HOME', 'ANALYSIS', 'ARCHIVE']), JSON.stringify(swapped.rooms));
  check('the old layout is backed up in Build mode\'s slot', swapped.backupProps === preSwap.props, JSON.stringify(swapped) + ' vs ' + preSwap.props);
  // the Commander restores it the way Build mode offers: Build → Presets → RESTORE PREVIOUS
  const restored = await evalJS(cdp, `(async () => { Build.open(); await new Promise(r => setTimeout(r, 700)); document.querySelector('#refit-stations').click(); await new Promise(r => setTimeout(r, 500));
    const b = document.querySelector('[data-restore-build]'); const enabled = !!b && !b.disabled; if (enabled) b.click(); await new Promise(r => setTimeout(r, 500)); Build.close();
    const st = App.station(); return { enabled, rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), props: st.props().length }; })()`);
  check('RESTORE PREVIOUS brings the old station back', restored.enabled && JSON.stringify(restored.rooms) === JSON.stringify(preSwap.rooms) && restored.props === preSwap.props, JSON.stringify(restored) + ' vs ' + JSON.stringify(preSwap));

  // 10. understanding the ask: the Commander's words pick the line, and "new" recruits the Tester through the page's own summon
  const crew0 = await evalJS(cdp, `App.agents().map(a => a.id)`);
  mock.planTool = 'station_plan'; mock.planArgs = { purpose: 'fix bugs in my repo and test them', steps: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'new' }] };
  at = mock.results.length;
  const run6 = await leadRun(base, token, 'fix bugs in my repo and test them, and hire someone to test');
  check('the purpose run completes', run6.status === 200);
  let IP = null, IB = null; try { IP = JSON.parse(mock.results[at] || ''); IB = JSON.parse(mock.results[at + 1] || ''); } catch (_) {}
  check('the purpose picked Build + test and the card lists the recruit', !!IP && IP.line && IP.line.id === 'build_test' && /Picked for "fix bugs in my repo and test them"/.test(IP.summary) && /It adds 1 crew member: TESTER/.test(IP.summary), (mock.results[at] || '').slice(0, 400));
  const rec = IB && IB.recruited && IB.recruited[0];
  check('the build recruited a Tester and the line is ready', !!rec && rec.role === 'TESTER' && IB.ready === true, (mock.results[at + 1] || '').slice(0, 300));
  const seated = await evalJS(cdp, `(() => { const st = App.station(), id = ${JSON.stringify(rec ? rec.id : '')}; const bay = st.props().find(p => p.t === 'bay' && p.role === 'TESTER' && p.agentId === id);
    return { onCrew: App.agents().some(a => a.id === id), seated: !!bay, desk: st.props().some(p => p.agentId === id && p.t !== 'bay'), brief: bay ? bay.brief : '' }; })()`);
  check('the recruit is on the crew, seated at its step, with a desk', seated.onCrew && seated.seated && seated.desk, JSON.stringify(seated));
  check('the step carries the Commander\'s words', /This line is for: "fix bugs in my repo and test them"\.$/.test(seated.brief), seated.brief.slice(-120));
  const after6 = await evalJS(cdp, `(() => { const st = App.station(), id = ${JSON.stringify(rec ? rec.id : '')}; const u = st.undo();
    return { ok: u && u.ok, line: st.props().some(p => p.t === 'bay' && p.role === 'TESTER'), onCrew: App.agents().some(a => a.id === id), crew: App.agents().length }; })()`);
  check('one UNDO takes back the line and the seat; the recruit stays on the crew, as the card said', after6.ok && !after6.line && after6.onCrew && after6.crew === crew0.length + 1, JSON.stringify(after6));

  // 11. vibe design: "a new room, the left side cozy, the right side a line that builds and tests code"
  mock.planTool = 'station_plan';
  mock.planArgs = { name: 'Den', zones: [{ area: 'left side', style: 'cozy' }, { area: 'right side', line: 'build_test', staff: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'lead' }] }] };
  at = mock.results.length;
  const pre7 = await evalJS(cdp, `App.station().rooms().filter(r => r.kind !== 'corridor').map(r => r.name)`);
  const run7 = await leadRun(base, token, 'make me a new room called den: the left side cozy, the right side a line that builds and tests code');
  check('the vibe run completes', run7.status === 200);
  let VP = null, VB = null; try { VP = JSON.parse(mock.results[at] || ''); VB = JSON.parse(mock.results[at + 1] || ''); } catch (_) {}
  check('the plan says what goes in each part of the room', !!VP && /^DEN, a new \d+ × \d+ room (north|south|east|west) of HOME, through a hallway: the left half, a cozy corner \(.+\); the right half, Build \+ test \("BUILD \+ TEST"\): Engineer \(.+\) → Tester \(.+\) → Outbox/.test(VP.summary) && /It will be ready to run\./.test(VP.summary), (mock.results[at] || '').slice(0, 400));
  check('the build answered built, one undo', !!VB && VB.built === true && /one UNDO/.test(VB.undo || ''), (mock.results[at + 1] || '').slice(0, 200));
  // the zones split where their contents need (not at the middle): every piece of the cozy corner stands left of every machine
  const den = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === 'DEN'); if (!r) return null; const hero = App.heroId();
    const inRoom = st.props().filter(p => st.roomAt(p.x, p.y) === r.id), M = /^(intake|bay|outbox|loop|filter|merger|splitter|joiner)$/;
    const machines = inRoom.filter(p => M.test(p.t)), furniture = inRoom.filter(p => !M.test(p.t));
    return { furniture: furniture.length, machines: machines.length, rightmostFurniture: Math.max(...furniture.map(p => p.x + p.w - 1)), leftmostMachine: Math.min(...machines.map(p => p.x)),
      lamp: furniture.some(p => p.t === 'lavalamp'), staffed: inRoom.filter(p => p.t === 'bay').every(b => b.agentId === hero) }; })()`);
  check('the cozy corner stands on the left and the line on the right', !!den && den.furniture >= 7 && den.machines >= 4 && den.rightmostFurniture < den.leftmostMachine && den.staffed, JSON.stringify(den));
  check('the page\'s own rules hold: the lava lamp stands on its side table', !!den && den.lamp, JSON.stringify(den));
  const undone7 = await evalJS(cdp, `(() => { const st = App.station(); const u = st.undo(); return { ok: u && u.ok, rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name) }; })()`);
  check('one UNDO removes the designed room', undone7.ok && JSON.stringify(undone7.rooms) === JSON.stringify(pre7), JSON.stringify(undone7));


  // 12. a line the Commander DESCRIBED: "research it, then a writer and an analyst at once, then a reviewer"
  mock.planTool = 'station_plan';
  mock.planArgs = { name: 'Weekly digest', shape: ['RESEARCHER', { together: ['WRITER', 'ANALYST'] }, 'REVIEWER'], steps: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'lead' }, { step: 3, agent: 'lead' }, { step: 4, agent: 'lead' }] };
  at = mock.results.length;
  const pre8 = await evalJS(cdp, `App.station().rooms().filter(r => r.kind !== 'corridor').map(r => r.name)`);
  const run8 = await leadRun(base, token, 'build me a line: research it, then a writer and an analyst at the same time, then a reviewer');
  check('the described-line run completes', run8.status === 200);
  let DP = null, DB = null; try { DP = JSON.parse(mock.results[at] || ''); DB = JSON.parse(mock.results[at + 1] || ''); } catch (_) {}
  check('the plan lays the described line out, staffed and ready', !!DP && DP.line && DP.line.label === 'Weekly digest' && DP.ready === true && /Researcher \(.+\) → Writer \(.+\) \+ Analyst \(.+\) \(at once\) → Reviewer/.test(DP.summary), (mock.results[at] || '').slice(0, 300));
  const dig = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === 'WEEKLY DIGEST'); if (!r) return null; const inRoom = st.props().filter(p => st.roomAt(p.x, p.y) === r.id);
    return { bays: inRoom.filter(p => p.t === 'bay').map(p => p.role).sort(), splitter: inRoom.some(p => p.t === 'splitter'), joiner: inRoom.some(p => p.t === 'joiner') }; })()`);
  check('the room holds the line as described: four steps, a split and a join', !!DB && DB.built === true && !!dig && JSON.stringify(dig.bays) === JSON.stringify(['ANALYST', 'RESEARCHER', 'REVIEWER', 'WRITER']) && dig.splitter && dig.joiner, JSON.stringify(dig));
  const undone8 = await evalJS(cdp, `(() => { const st = App.station(); const u = st.undo(); return { ok: u && u.ok, rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name) }; })()`);
  check('one UNDO removes the described line and its room', undone8.ok && JSON.stringify(undone8.rooms) === JSON.stringify(pre8), JSON.stringify(undone8));

  /* 13. THE ASK THAT FAILED LIVE (2026-09-30): "build new rooms connected to the bridge room, and a giant conveyor system
     room where we will fill it with workflows". The lead looks (station_map), plans three rooms in ONE plan, builds. */
  mock.lookFirst = true; mock.planTool = 'station_plan';
  mock.planArgs = { rooms: [
    { name: 'Ops Room', beside: 'bridge', side: 'north' },
    { name: 'Rec Room', beside: 'the bridge room', side: 'west', zones: [{ area: 'left', style: 'games' }, { area: 'right', style: 'cafe' }] },
    { name: 'Conveyor Hall', size: 'giant', beside: 'bridge', side: 'east', type: 'FOUNDRY' }] };
  at = mock.results.length;
  const snap9 = `(() => { const st = App.station(); return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), halls: st.rooms().filter(r => r.kind === 'corridor').length, props: st.props().length }; })()`;
  const pre9 = await evalJS(cdp, snap9);
  const run9 = await leadRun(base, token, 'I want you to build new rooms connected to the bridge room, I want you to also add a giant conveyor system room where we will fill it with workflows we will run');
  check('the build run completes', run9.status === 200);
  let MP = null, BP = null, BB = null; try { MP = JSON.parse(mock.results[at] || ''); BP = JSON.parse(mock.results[at + 1] || ''); BB = JSON.parse(mock.results[at + 2] || ''); } catch (_) {}
  check('the lead read the map first: the rooms, the main one, what fits where, the floor drawn', !!MP && MP.main === 'HOME' && Array.isArray(MP.drawing) && MP.drawing.length > 5 && MP.rooms.some(r => r.main && r.roomForANewRoom && r.roomForANewRoom.east.indexOf('giant') >= 0), (mock.results[at] || '').slice(0, 300));
  check('one plan holds all three rooms, each where it was asked, joined to the bridge by a hallway', !!BP && /^OPS ROOM, a new 18 × 11 room north of HOME, through a hallway: empty floor, ready for lines and furniture\. REC ROOM, a new \d+ × \d+ room west of HOME, through a hallway: the left half, a games corner \(.+\); the right half, a café corner \(.+\)(; [a-z ]+ in the corners)?\. CONVEYOR HALL, a new 36 × 20 room east of HOME, through a hallway: empty floor, ready for lines and furniture\./.test(BP.summary), (mock.results[at + 1] || '').slice(0, 500));
  check('the build answered built, with the three rooms and how to undo it', !!BB && BB.built === true && (BB.rooms || []).length === 3 && /one UNDO/.test(BB.undo || ''), (mock.results[at + 2] || '').slice(0, 300));
  const built9 = await evalJS(cdp, `(() => { const st = App.station(), g = st.projectGeometry(), ox = g.origin.tx, oy = g.origin.ty, by = n => st.rooms().find(r => r.name === n);
    const free = r => { const R = r.rects[0]; for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) if (g.walkable(x - ox, y - oy)) return [x - ox, y - oy]; return null; };
    const home = by('HOME'), h = home.rects[0], out = { halls: st.rooms().filter(r => r.kind === 'corridor').length, rooms: {} };
    for (const n of ['OPS ROOM', 'REC ROOM', 'CONVEYOR HALL']) { const r = by(n); if (!r) { out.rooms[n] = null; continue; } const R = r.rects[0], a = free(home), b = free(r);
      out.rooms[n] = { w: R.x2 - R.x1 + 1, h: R.y2 - R.y1 + 1, kind: r.kind, side: R.y2 < h.y1 ? 'north' : R.x2 < h.x1 ? 'west' : R.x1 > h.x2 ? 'east' : 'south', walk: !!(a && b && g.path(a[0], a[1], b[0], b[1])), props: st.props().filter(p => st.roomAt(p.x, p.y) === r.id).length }; }
    return out; })()`);
  const R9 = built9.rooms;
  check('the floor has them: north, west and east of the bridge, each through its own hallway', built9.halls === pre9.halls + 3 && !!R9['OPS ROOM'] && R9['OPS ROOM'].side === 'north' && !!R9['REC ROOM'] && R9['REC ROOM'].side === 'west' && !!R9['CONVEYOR HALL'] && R9['CONVEYOR HALL'].side === 'east', JSON.stringify(built9));
  check('the conveyor hall is giant, a foundry, and empty; the rec room is furnished', !!R9['CONVEYOR HALL'] && R9['CONVEYOR HALL'].w === 36 && R9['CONVEYOR HALL'].h === 20 && R9['CONVEYOR HALL'].kind === 'factory' && R9['CONVEYOR HALL'].props === 0 && R9['REC ROOM'].props > 8, JSON.stringify(R9));
  check('the crew can walk from the bridge into every one', Object.values(R9).every(r => r && r.walk), JSON.stringify(R9));

  // 14. "…fill it with workflows": two lines into the hall that now exists, in one plan
  mock.planArgs = { rooms: [{ into: 'Conveyor Hall', lines: [{ line: 'build_test', staff: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'lead' }] }, { shape: ['RESEARCHER', { together: ['WRITER', 'ANALYST'] }, 'REVIEWER'], name: 'Digest' }] }] };
  at = mock.results.length;
  const run10 = await leadRun(base, token, 'now put a build and test line and a digest line in the conveyor hall');
  check('the fill run completes', run10.status === 200);
  let FP = null, FB = null; try { FP = JSON.parse(mock.results[at + 1] || ''); FB = JSON.parse(mock.results[at + 2] || ''); } catch (_) {}
  check('the plan lays both lines in the hall that stands there', !!FP && /^CONVEYOR HALL \(36 × 20\): Build \+ test \("BUILD \+ TEST"\): .+; a custom line \("Digest"\): /.test(FP.summary) && (FP.lines || []).length === 2, (mock.results[at + 1] || '').slice(0, 400));
  const lines10 = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === 'CONVEYOR HALL'), inRoom = st.props().filter(p => st.roomAt(p.x, p.y) === r.id);
    const comps = Pipeline.lineComponents(st.projectGeometry()), ids = new Set(inRoom.map(p => p.id));
    return { intakes: inRoom.filter(p => p.t === 'intake').map(p => p.label).sort(), bays: inRoom.filter(p => p.t === 'bay').length, rooms: st.rooms().filter(x => x.kind !== 'corridor').length }; })()`);
  check('both lines stand in the hall, as two lines, and no room was added', !!FB && FB.built === true && (FB.lines || []).length === 2 && new Set(FB.lines.map(l => l.lineId)).size === 2 && JSON.stringify(lines10.intakes) === JSON.stringify(['BUILD + TEST', 'Digest']) && lines10.bays === 6 && lines10.rooms === pre9.rooms.length + 3, JSON.stringify(lines10) + ' ' + (mock.results[at + 2] || '').slice(0, 300));
  if (process.env.SB_SHOT) { try { await sleep(2500); const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(process.env.SB_SHOT, Buffer.from(shot.data, 'base64')); } catch (e) { console.log('(no screenshot: ' + e.message + ')'); } }
  const undone9 = await evalJS(cdp, `(() => { const st = App.station(); const a = st.undo(), b = st.undo(); return { ok: a && a.ok && b && b.ok, now: ${snap9} }; })()`);
  check('two UNDOs take back the lines, then every room and hallway', undone9.ok && JSON.stringify(undone9.now) === JSON.stringify(pre9), JSON.stringify(undone9));
  mock.lookFirst = false;

  /* 15. "redo my station as a gorgeous layout with hallways": the lead lays the whole station out again as a DIAMOND round
     the bridge — every room furnished in its style, the corridors planted and lit — and the old layout is backed up. */
  mock.lookFirst = true;
  mock.planArgs = { layout: { pattern: 'ring', rooms: [{ style: 'lounge' }, { style: 'arcade' }, { style: 'library' }, { style: 'quarters' }, { style: 'garden' }, { name: 'Conveyor Hall', style: 'works', lines: [{ line: 'build_test', staff: [{ step: 1, agent: 'lead' }, { step: 2, agent: 'lead' }] }] }] }, replace: true };
  at = mock.results.length;
  const pre11 = await evalJS(cdp, `(() => { const st = App.station(); return { rooms: st.rooms().filter(r => r.kind !== 'corridor').map(r => r.name), props: st.props().length, json: JSON.stringify(st.serialize()) }; })()`);
  const run11 = await leadRun(base, token, 'our station looks like one long thin strip; redo the whole station as a gorgeous layout with hallways: a lounge, an arcade, a library, quarters, a garden and a giant conveyor hall');
  check('the layout run completes', run11.status === 200);
  let LP = null, LB = null; try { LP = JSON.parse(mock.results[at + 1] || ''); LB = JSON.parse(mock.results[at + 2] || ''); } catch (_) {}
  check('the plan is a diamond round the bridge with every room, and says the old station is backed up', !!LP && /^A DIAMOND around HOME: a corridor loop round it with a hallway in from each side, and 6 rooms on an even grid round the loop, each on its own planted, lit hallway\. Every room is 18 × 11 unless it says\. LOUNGE north: a lounge\. ARCADE south: an arcade\./.test(LP.summary) && /RESTORE PREVIOUS in Build → Presets brings it back\./.test(LP.summary), (mock.results[at + 1] || '').slice(0, 400));
  check('the build answered built, with how to get the old station back', !!LB && LB.built === true && /RESTORE PREVIOUS/.test(LB.undo || ''), (mock.results[at + 2] || '').slice(0, 300));
  const lay = await evalJS(cdp, `(() => { const st = App.station(), g = st.projectGeometry(), ox = g.origin.tx, oy = g.origin.ty, rooms = st.rooms().filter(r => r.kind !== 'corridor'), home = rooms.find(r => r.name === 'HOME');
    const free = r => { const R = r.rects[0]; for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) if (g.walkable(x - ox, y - oy)) return [x - ox, y - oy]; return null; };
    const a = free(home), inRoom = r => st.props().filter(p => st.roomAt(p.x, p.y) === r.id).length;
    const key = 'starnet.layoutBackup.' + st.doc().meta.createdAt;
    return { rooms: rooms.map(r => r.name).sort(), furnished: rooms.filter(r => r.name !== 'HOME' && r.name !== 'CONVEYOR HALL').map(inRoom), walk: rooms.every(r => { const b = free(r); return !!(a && b && g.path(a[0], a[1], b[0], b[1])); }),
      halls: st.rooms().filter(r => r.kind === 'corridor').length, backup: (() => { try { return localStorage.getItem(key); } catch (_) { return null; } })(), line: st.props().some(p => p.t === 'intake' && p.label === 'BUILD + TEST') }; })()`);
  check('the station is now the bridge and the six rooms, joined by corridors', JSON.stringify(lay.rooms) === JSON.stringify(['ARCADE', 'CONVEYOR HALL', 'GARDEN', 'HOME', 'LIBRARY', 'LOUNGE', 'QUARTERS']) && lay.halls >= 14, JSON.stringify(lay.rooms) + ' halls ' + lay.halls);
  check('every room is furnished wall to wall and walkable from the bridge; the hall holds its line', lay.furnished.every(n => n >= 12) && lay.walk && lay.line, JSON.stringify(lay.furnished) + ' walk ' + lay.walk);
  check('the old layout is in Build mode\'s backup slot', lay.backup === pre11.json, 'backup ' + (lay.backup ? lay.backup.length : 'none') + ' vs ' + pre11.json.length);
  if (process.env.SB_SHOT) { try { await evalJS(cdp, `(() => { try { World.frameReviewRoom(''); } catch (_) {} return true; })()`); await sleep(3500); const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(process.env.SB_SHOT.replace(/\.png$/, '-layout.png'), Buffer.from(shot.data, 'base64')); } catch (e) { console.log('(no screenshot: ' + e.message + ')'); } }
  const undone11 = await evalJS(cdp, `(() => { const st = App.station(); const u = st.undo(); return { ok: u && u.ok, json: JSON.stringify(st.serialize()) }; })()`);
  check('one UNDO brings the old station back exactly', undone11.ok && undone11.json === pre11.json, String(undone11.ok));
  mock.lookFirst = false;

  // LOOK (Andrew 10-01: the model designs freely): through the real loop, station_map { look: a room } hands the model that
  // room as it really renders (the next model request carries the picture), then the lead refits what it saw
  const homeName = await evalJS(cdp, `(() => { const st = App.station(); const r = st.rooms().find(x => x.kind !== 'corridor' && st.props().some(p => p.agentId === App.heroId() && st.roomAt(p.x, p.y) === x.id)) || st.rooms().find(x => x.kind !== 'corridor'); return r.name; })()`);
  mock.lookFirst = true; mock.mapArgs = { look: homeName };
  mock.planTool = 'station_plan'; mock.planArgs = { refit: [{ op: 'rename', room: homeName, name: 'LOOKED AT' }] };
  const nReq = mock.requests.length;
  const run12 = await leadRun(base, token, 'take a look at the bridge, then rename it');
  const pics = mock.requests.slice(nReq).flatMap(p => (p.messages || []).filter(m => m && m.role === 'user' && Array.isArray(m.content)).flatMap(m => m.content.filter(c => c && c.type === 'image_url').map(c => String((c.image_url && c.image_url.url) || ''))));
  const pic = pics[0] || '', b64 = pic.replace(/^data:image\/(webp|jpeg);base64,/, '');
  check('station_map { look } puts the room as it renders in front of the model', run12.status === 200 && /^data:image\/(webp|jpeg);base64,(UklGR|\/9j\/)/.test(pic) && b64.length > 3000 && b64.length <= 180000, pics.length + ' picture(s), ' + b64.length + ' base64 chars');
  check('with a note saying what it shows', /^A picture of [A-Z ]+ as it renders now \(\d+ x \d+ px; it shows tiles x -?\d+--?\d+, y -?\d+--?\d+ with the wall faces above, about \d+ px a tile\)/.test(mock.results[mock.results.length - 3] || ''), String(mock.results[mock.results.length - 3] || '').slice(0, 160));
  const seen = await evalJS(cdp, `(async () => { const img = new Image(); img.src = ${JSON.stringify(pic)}; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, colours = new Set(); let lit = 0; for (let i = 0; i < d.length; i += 16) { colours.add((d[i] >> 4) + '.' + (d[i + 1] >> 4) + '.' + (d[i + 2] >> 4)); if (d[i] + d[i + 1] + d[i + 2] > 90) lit++; }
    return { w: img.width, h: img.height, colours: colours.size, lit: lit / (d.length / 16) }; })()`);
  check('and the picture is the real room, drawn (not a blank frame)', seen && seen.w >= 300 && seen.colours > 60 && seen.lit > 0.25, JSON.stringify(seen));
  const renamed = await evalJS(cdp, `(() => App.station().rooms().some(r => r.name === 'LOOKED AT'))()`);
  check('then the lead refits what it saw', renamed === true);
  const undone12 = await evalJS(cdp, `(() => { const u = App.station().undo(); return !!(u && u.ok) && App.station().rooms().some(r => r.name === ${JSON.stringify(homeName)}); })()`);
  check('one UNDO takes the refit back', undone12 === true);
  mock.lookFirst = false; mock.mapArgs = {};

  /* A STATION DESIGNED WHOLE, through the real tools: a palette in the Commander's words, from a prebuild, a design review on the plan and the receipt. */
  mock.lookFirst = false; mock.planTool = 'station_plan';
  mock.planArgs = { layout: { theme: 'a moody cyberpunk club', from: 'software', rooms: [{ name: 'AFTER HOURS', style: 'games', size: { w: 26, h: 16 } }] }, replace: true };
  at = mock.results.length;
  const runDesigned = await leadRun(base, token, 'design me a gorgeous cyberpunk club of a software studio');
  const designRows = mock.results.slice(at).map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
  const designPlan = designRows.find(x => x.planId), designBuilt = designRows.find(x => x.built === true);
  check('the designed station run completes', runDesigned.status === 200);
  check('its plan carries a design review', !!designPlan && !!designPlan.design && typeof designPlan.design.score === 'number' && !!designPlan.design.grade, JSON.stringify(designPlan || null).slice(0, 300));
  check('its receipt carries the review of what was built', !!designBuilt && designBuilt.built === true && !!designBuilt.design && typeof designBuilt.design.score === 'number', (mock.results[at + 2] || '').slice(0, 300));
  const designed = await evalJS(cdp, `(() => { const st = App.station(), r = st.rooms().find(x => x.name === 'AFTER HOURS'), b = r && r.rects[0]; return { floor: r && r.floorStyle, w: b && b.x2 - b.x1 + 1, lines: st.props().filter(p => p.t === 'intake').length, loaded: typeof StationDesign !== 'undefined' }; })()`);
  check('the palette, the heart size and the line from the prebuild all landed', designed.loaded && designed.floor === 'magenta' && designed.w === 26 && designed.lines >= 1, JSON.stringify(designed));
  check('the mock carried every model call (no real provider)', mock.requests.length >= 30, String(mock.requests.length));
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
  if (resolvedRoot.startsWith(tmpdir().replace(/\\/g, '/') + '/') && /starnet-builder-e2e-/.test(resolvedRoot)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) console.log('(could not remove ' + root + ': ' + error.message + ')'); await sleep(300); }
    }
  }
}

console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'station-builder.e2e: ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
