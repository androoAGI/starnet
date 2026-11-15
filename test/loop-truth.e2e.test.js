/* node test/loop-truth.e2e.test.js — LOOP TRUTH through the REAL sidecar (cost plan W1.11).

   The unit invariant (loop-truth.invariant.test.js) pins the ledger, the premises and the counts on a stub registry. This
   drives the whole station path: a hermetic SidecarFixture, the 'custom' provider pointed at a recording
   OpenAI-compatible mock on loopback (no inference), the real shell.exec running the real `node` (and reporting the
   folder it ran in), the real Task Brief gate, and the run row read back from GET /api/runs.

     wjrun      settle the brief + write hello.js, run `node hello.js`, answer   -> 3 model calls, no verify nudge, no counts
     writeonly  settle the brief + write src/app.js, answer (nothing run)       -> the one verify nudge, counted on the row
     heldend    write note.txt before the brief (the gate holds it), answer     -> ONE recovery note that says held, counted
     cdrun      write sub/hello.js, `cd sub`, `node hello.js`, answer           -> the kept `cd` is where it ran: no nudge
     absname    write hello.js and <workspace>\src\hello.js by its absolute path, `node hello.js` at the root, answer
                                                                                 -> the root namesake ran, src\hello.js is owed,
                                                                                    and the premise names that root run
     failproj   write src/app.js, `node tests/missing.js` (a check, fails), `node src/app.js` (passes), answer
                                                                                 -> the failed check stands: one nudge naming it
     runthentest  write src/app.js, `node src/app.js` (passes), `node tests/missing.js` (a check, fails), answer
                                                                                 -> the later failure re-arms the file: one nudge
     runtwice   write a.js, `node a.js` (passes), `node a.js x` (the same unchanged file, fails), answer
                                                                                 -> the later run speaks: one nudge naming it

   Each scenario's main-call count is the cost the lane is about: wjrun was 4 calls on e316231d7 (a false
   "ending without running anything" bought the 4th). absname and failproj are review round 1's blockers 2 and 1 on the
   real station: 867313704 ended both with no nudge (a fake done). runthentest and runtwice are review round 2's blocker
   1 (the same evidence in the other order): 3cc0fcce4 ended both with no nudge; e316231d7 nudged in both. Every main
   call's prompt size (request bytes / 4) is printed as a `measure:` line, so the same rig on another commit prices the
   difference. */
'use strict';
const http = require('node:http');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'LOOP_TRUTH_E2E_LEAD';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const BRIEF = { name: 'brief_proceed', args: { objective: 'do the task as asked', deliverable: 'the file', assumptions: ['use the workspace root'] } };
const shell = cmd => ({ name: 'shell_exec', args: { cmd } });
// the folder this scenario's `node -e "console.log(process.cwd())"` printed: the workspace root the shell starts in
function printedCwd(after) {
  for (const m of after) {
    if (m.role !== 'tool') continue;
    const line = text(m.content).split(/\r?\n/).map(l => l.trim()).find(l => l && path.isAbsolute(l));
    if (line) return line;
  }
  return '';
}
const PLANS = {
  SCEN_WJRUN: [[BRIEF, { name: 'fs_write', args: { path: 'hello.js', content: 'console.log("hello world");\n' } }], [shell('node hello.js')]],
  SCEN_WRITEONLY: [[BRIEF, { name: 'fs_write', args: { path: 'src/app.js', content: 'module.exports = 1;\n' } }]],
  SCEN_HELDEND: [[{ name: 'fs_write', args: { path: 'note.txt', content: 'note\n' } }]],
  SCEN_CDRUN: [[BRIEF, { name: 'fs_write', args: { path: 'sub/hello.js', content: 'console.log("hello from sub");\n' } }], [shell('cd sub')], [shell('node hello.js')]],
  SCEN_ABSNAME: [[BRIEF, shell('node -e "console.log(process.cwd())"')],
    after => {
      const dir = printedCwd(after);
      return dir ? [{ name: 'fs_write', args: { path: 'hello.js', content: 'console.log("root namesake");\n' } },
        { name: 'fs_write', args: { path: path.join(dir, 'src', 'hello.js'), content: 'console.log("the changed file");\n' } }] : null;
    },
    [shell('node hello.js')]],
  SCEN_FAILPROJ: [[BRIEF, { name: 'fs_write', args: { path: 'src/app.js', content: 'module.exports = 1;\n' } }], [shell('node tests/missing.js')], [shell('node src/app.js')]],
  SCEN_RUNTHENTEST: [[BRIEF, { name: 'fs_write', args: { path: 'src/app.js', content: 'module.exports = 1;\nconsole.log("app ok");\n' } }], [shell('node src/app.js')], [shell('node tests/missing.js')]],
  SCEN_RUNTWICE: [[BRIEF, { name: 'fs_write', args: { path: 'a.js', content: 'if (process.argv[2]) throw new Error("bad input " + process.argv[2]);\nconsole.log("ok");\n' } }], [shell('node a.js')], [shell('node a.js x')]]
};

function startUpstream() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (req.method === 'GET' || !raw) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 200000 }] }));
    }
    let body; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = body.messages || [];
    const sys = msgs.filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
    const tools = (body.tools || []).map(t => (t.function && t.function.name) || t.name);
    let dirIdx = -1, scen = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = text(msgs[i].content).match(/\b(SCEN_[A-Z]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    const main = sys.indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0;
    const after = dirIdx >= 0 ? msgs.slice(dirIdx + 1) : [];
    // every host note the loop added since the directive (system-role, or riding user-side on this wire)
    const hostNotes = after.filter(m => m.role === 'system' || m.role === 'user').map(m => text(m.content));
    const promptTok = Math.ceil(raw.length / 4);
    const rec = { scen, main, hostNotes, promptTok, toolResults: after.filter(m => m.role === 'tool').map(m => text(m.content)) };
    calls.push(rec);
    let out = null, reply = main ? 'Done: ' + scen + ' complete.' : (/title/i.test(sys) ? 'Loop Truth Probe' : 'NONE');
    if (main) {
      const steps = after.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
      const plan = PLANS[scen] || [];
      if (steps < plan.length) out = typeof plan[steps] === 'function' ? plan[steps](after) : plan[steps];
      if (out) out = out.filter(c => tools.indexOf(c.name) >= 0);
      if (out && !out.length) out = null;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (out) {
      const tcs = out.map((c, k) => ({ index: k, id: 'call_' + calls.length + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: tcs } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTok, completion_tokens: 30, total_tokens: promptTok + 30 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: 8, total_tokens: promptTok + 8 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, calls, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.0-loop-truth' });
}
// the touched list a verify nudge names: "You changed code in this run (<list>) ..."
const touchedOf = t => { const m = /You changed code in this run \(([^)]*)\)/.exec(String(t || '')); return m ? m[1].split(', ') : []; };

(async () => {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'loop-truth-e2e-', timeoutMs: 60000, env: hermeticEnv() });
  try {
    await fixture.start();
    async function scenario(name, words) {
      const from = up.calls.length;
      const streamId = 'loop-truth-' + name.toLowerCase();
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true, placed: FLOOR, stationPlaced: FLOOR,
        system: MARK + ': you are the lead.', streamId, messages: [{ role: 'user', content: words + ' (' + name + ')' }] }) });
      A.eq(r.status, 200, name + ': run accepted');
      const events = (await r.text()).split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
      const main = up.calls.slice(from).filter(c => c.main && c.scen === name);
      const runs = await fixture.json('GET', '/api/runs?agent=agent&limit=20');
      const row = ((runs.body && runs.body.runs) || []).find(x => x.streamId === streamId) || null;
      const notes = main.length ? main[main.length - 1].hostNotes : [];
      // the hermetic price of the scenario: main calls and each one's prompt size (request bytes / 4)
      console.log('measure: ' + name + ' main calls ' + main.length + ', prompt tokens [' + main.map(c => c.promptTok).join(', ') + '] = ' + main.reduce((s, c) => s + c.promptTok, 0));
      return { end, main, row, notes, tagged: tag => notes.filter(t => t.indexOf('<' + tag + '>') >= 0) };
    }

    // ---- DONE MEANS: `node hello.js` ends without a nudge ----
    const wj = await scenario('SCEN_WJRUN', 'Create hello.js that prints hello world and run it');
    const ran = wj.main.length >= 3 ? wj.main[2].toolResults.join('\n') : '';
    A.ok(/hello world/.test(ran) && /\[exit 0\]\s*$/.test(ran.trim()), 'wjrun: the real shell ran the real `node hello.js` and the host stamped [exit 0]: ' + JSON.stringify(ran.slice(-120)));
    A.eq(wj.main.length, 3, 'wjrun: write, run, answer = 3 model calls (e316231d7 made 4: a false verify nudge bought one)');
    A.eq(wj.tagged('verify_before_done').length, 0, 'wjrun: no verify-on-stop nudge after a run that exited 0');
    A.eq(wj.end.reason, 'done', 'wjrun: the run ends done');
    A.ok(wj.row && wj.row.reason === 'done', 'wjrun: the run row is recorded');
    A.eq(wj.row && Object.prototype.hasOwnProperty.call(wj.row, 'nudges'), false, 'wjrun: a run no nudge touched keeps the row shape (no nudges field)');

    // ---- anti-fake-done still fires, and the row now counts it ----
    const wo = await scenario('SCEN_WRITEONLY', 'Create src/app.js that exports 1');
    A.eq(wo.tagged('verify_before_done').length, 1, 'writeonly: a code write with nothing run still gets its verify nudge');
    A.ok(wo.tagged('verify_before_done').every(t => t.indexOf('without running anything against it') >= 0), 'writeonly: ...with the premise that is true here (nothing ran)');
    A.eq(wo.main.length, 3, 'writeonly: write, answer, nudged answer = 3 model calls');
    A.eq(wo.row && wo.row.nudges, { verify_before_done: 1 }, 'writeonly: GET /api/runs shows the nudge count on the run row');

    // ---- a held call is reported as held, once, and counted ----
    const he = await scenario('SCEN_HELDEND', 'Save a note to note.txt');
    const fr = he.tagged('failure_recovery');
    A.eq(fr.length, 1, 'heldend: a call the Task Brief held buys one recovery note');
    A.ok(fr.length === 1 && !/The previous path failed/.test(fr[0]) && /\(fs_write\) was held by the Task Brief gate, not failed: it did not run\./.test(fr[0]) && !/nothing ran/.test(fr[0]), 'heldend: the note says held and that IT did not run, never failed: ' + JSON.stringify(String(fr[0] || '').slice(0, 200)));
    A.eq(he.main.length, 3, 'heldend: held write, answer, noted answer = 3 model calls (e316231d7 made 4: two "failed" notes)');
    A.eq(he.row && he.row.nudges, { failure_recovery: 1 }, 'heldend: the run row counts the recovery note');
    // ops-1115 T3 (#187): the noted answer ends again with the held write never made: the run is incomplete, never done
    A.eq([he.end.reason, he.row && he.row.reason, he.row && he.row.failureCode], ['error', 'error', 'incomplete_work'], 'heldend: held work that never ran ends the run error / incomplete_work on the record');

    // ---- a `cd` kept from an earlier call is where the next command runs: the shell says so, and it counts ----
    const cd = await scenario('SCEN_CDRUN', 'Create sub/hello.js, cd into sub and run it');
    const cdLast = cd.main.length >= 4 ? String(cd.main[3].toolResults.slice(-1)[0] || '') : '';
    A.ok(/hello from sub/.test(cdLast) && /\[exit 0\]\s*$/.test(cdLast.trim()), 'cdrun: after `cd sub` the real shell ran sub/hello.js: ' + JSON.stringify(cdLast.slice(-120)));
    A.eq(cd.tagged('verify_before_done').length, 0, 'cdrun: `node hello.js` after `cd sub` ran the changed sub/hello.js: no nudge (867313704 nudged here)');
    A.eq(cd.main.length, 4, 'cdrun: write, cd, run, answer = 4 model calls');
    A.eq(cd.row && Object.prototype.hasOwnProperty.call(cd.row, 'nudges'), false, 'cdrun: no nudges on the row');

    // ---- blocker 2: a same-named file somewhere else never clears the changed one ----
    const an = await scenario('SCEN_ABSNAME', 'Create src/hello.js by its absolute path and a root hello.js, then run hello.js');
    const anRan = an.main.length >= 4 ? String(an.main[3].toolResults.slice(-1)[0] || '') : '';
    A.ok(/root namesake/.test(anRan) && /\[exit 0\]\s*$/.test(anRan.trim()), 'absname: the real shell ran the ROOT hello.js, exit 0: ' + JSON.stringify(anRan.slice(-120)) + ' (the workspace printed: ' + JSON.stringify(an.main.length >= 2 ? an.main[1].toolResults : null).slice(0, 400) + ')');
    const anVos = an.tagged('verify_before_done');
    A.eq(anVos.length, 1, 'absname: the changed absolute src\\hello.js never ran, so the nudge fires (867313704 cleared it: the suffix matched)');
    const anOwed = touchedOf(anVos[0]);
    A.ok(anOwed.length === 1 && path.isAbsolute(anOwed[0]) && /[\\/]src[\\/]hello\.js$/.test(anOwed[0]), 'absname: ...naming only the absolute src\\hello.js still owed: ' + JSON.stringify(anOwed));
    // review round 2, blocker 3: the root run RAN — it is named as a command that is no check of src\hello.js, never denied
    A.ok(anVos.length === 1 && /and are ending after running only commands the host does not count as a check of it: node hello\.js \(exit 0\)\./.test(anVos[0]) && anVos[0].indexOf('without running anything') < 0, 'absname: ...and names the root `node hello.js` that ran, never "without running anything" (3cc0fcce4 and e316231d7 denied it): ' + JSON.stringify(String(anVos[0] || '').slice(0, 300)));
    A.eq(an.row && an.row.nudges, { verify_before_done: 1 }, 'absname: the run row counts it');

    // ---- blocker 1: a failed check stands after a clean run of the changed file ----
    const fp = await scenario('SCEN_FAILPROJ', 'Create src/app.js, run its tests, then run it');
    const fpTests = fp.main.length >= 3 ? String(fp.main[2].toolResults.slice(-1)[0] || '') : '';
    A.ok(/\[exit 1\]\s*$/.test(fpTests.trim()), 'failproj: the real `node tests/missing.js` failed with exit 1: ' + JSON.stringify(fpTests.slice(-120)));
    const fpVos = fp.tagged('verify_before_done');
    A.eq(fpVos.length, 1, 'failproj: a passing `node src/app.js` never erases the failed check: the nudge fires (867313704: none)');
    A.ok(fpVos.length === 1 && /\(node tests\/missing\.js\) did NOT pass and has not passed since\./.test(fpVos[0]), 'failproj: ...naming the failed check: ' + JSON.stringify(String(fpVos[0] || '').slice(0, 260)));
    A.eq(fp.row && fp.row.nudges, { verify_before_done: 1 }, 'failproj: the run row counts it');

    // ---- review round 2, blocker 1: the same evidence in the other order — a failure AFTER a clean run re-arms the file ----
    const rt = await scenario('SCEN_RUNTHENTEST', 'Create src/app.js, run it, then run its tests');
    const rtTail = rt.main.length >= 4 ? rt.main[3].toolResults.slice(-2).map(t => t.trim()) : [];
    A.ok(rtTail.length === 2 && /app ok/.test(rtTail[0]) && /\[exit 0\]$/.test(rtTail[0]) && /\[exit 1\]$/.test(rtTail[1]), 'runthentest: the real `node src/app.js` exited 0, then the real `node tests/missing.js` exited 1: ' + JSON.stringify(rtTail.map(t => t.slice(-80))));
    const rtVos = rt.tagged('verify_before_done');
    A.eq(rtVos.length, 1, 'runthentest: the failing check after the clean run puts src/app.js back: the nudge fires (3cc0fcce4: none)');
    A.ok(rtVos.length === 1 && /\(src\/app\.js\) and are ending although the last check you ran against it \(node tests\/missing\.js\) did NOT pass, and no passing check has run since\./.test(rtVos[0]), 'runthentest: ...naming the later failed check, with the original sentence: ' + JSON.stringify(String(rtVos[0] || '').slice(0, 260)));
    A.eq([rt.main.length, rt.end.reason], [5, 'done'], 'runthentest: write, run, check, answer, nudged answer = 5 model calls (e316231d7 made 5 too)');
    A.eq(rt.row && rt.row.nudges, { verify_before_done: 1 }, 'runthentest: the run row counts it');

    const tw = await scenario('SCEN_RUNTWICE', 'Create a.js, run it, then run it with an argument');
    const twTail = tw.main.length >= 4 ? tw.main[3].toolResults.slice(-2).map(t => t.trim()) : [];
    A.ok(twTail.length === 2 && /\[exit 0\]$/.test(twTail[0]) && /bad input x/.test(twTail[1]) && /\[exit 1\]$/.test(twTail[1]), 'runtwice: the real `node a.js` exited 0, then `node a.js x` threw and exited 1: ' + JSON.stringify(twTail.map(t => t.slice(-80))));
    const twVos = tw.tagged('verify_before_done');
    A.eq(twVos.length, 1, 'runtwice: the same unchanged file failing after its clean run is owed again: the nudge fires (3cc0fcce4: none)');
    A.ok(twVos.length === 1 && /\(a\.js\) and are ending although the last check you ran against it \(node a\.js x\) did NOT pass, and no passing check has run since\./.test(twVos[0]), 'runtwice: ...naming the later run: ' + JSON.stringify(String(twVos[0] || '').slice(0, 260)));
    A.eq(tw.row && tw.row.nudges, { verify_before_done: 1 }, 'runtwice: the run row counts it');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('loop-truth.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
