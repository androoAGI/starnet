/* node test/loop-truth.invariant.test.js — LOOP TRUTH (cost plan W1.11).

   The stop checks in sidecar/loop.js buy the model another paid turn, and what each one TELLS the model is a host
   statement: it must state only what the run's own ledger proves. Four seams broke that, and one was never counted:

     A. VERIFY-ON-STOP read "node hello.js" exiting 0 as nothing at all: the run wrote hello.js, ran it, saw [exit 0],
        and was still told it was "ending without running anything against it" (one extra request per write-and-run).
        A run of a changed file that the host saw exit 0 now clears THAT file; a run that failed or was KILLED is a
        check that did NOT pass; any other command that ran is named, never denied. Anti-fake-done is unchanged:
        a pipe, an inline -e, a background start, a run of some other file, or no exit receipt clears nothing.
     B. FAILURE RECOVERY told the model "The previous path failed (fs_write)" when the Task Brief gate HELD the call
        and nothing ran. A held call gets its own truthful note (once); a real failure keeps the two-chance ladder.
     C. NOBODY COUNTED the nudges: every turn-buying host note is counted by its tag on the loop's result (res.nudges),
        and every tag the loop can push is either counted or declared a note that rides a turn already being taken.
     D. ...and the run row keeps those counts (runstore: runs.jsonl, GET /api/runs), additive, so the history can price them.
     E. team.subagents could only be POLLED (one paid turn per look). wait:true blocks, bounded, until a listed worker
        changes status, the run is cancelled, or a note for the run arrives; a timeout is an answer, not an error.

   Hermetic: replay provider, stub registry, in-memory run store, a real subagent manager on a temp file, a fake
   runOnce. No network, no processes, no sidecar. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeRunStore } = require('../sidecar/runstore.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { TaskIntent } = require('../frontend/app/fork.js');

const ANY = { type: 'object', properties: {} };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));
const TOOLS = toolDefs('fs_write', 'fs_read', 'verify_run', 'shell_exec', 'brief_proceed');

// The exact result shapes the host produces (shell.js / registry.js / index.js briefHoldFor).
const shellOut = (body, code) => ({ content: body + '\n[exit ' + code + ']', summary: 'exit ' + code + ' (5ms)' });
function killed(body) {   // shell.js THROWS a killed command; the registry turns it into an isError result, summary 'timeout'
  const e = new Error('TIMEOUT: the command did not finish within its 1000ms timeout, so the host KILLED it (the whole process tree). It did not complete — anything it was doing may be only partly done. Output captured before the kill:\n' + body + '\n[exit -1 — KILLED (timed out after 1000ms)]');
  e.toolSummary = 'timeout';
  return e;
}
const bgStarted = () => ({ content: 'Started background process bg_1 in your workspace. It keeps running while you work — check it with shell.bg.status (id "bg_1").', summary: 'bg started bg_1' });
const HELD = { ok: false, isError: true, content: TaskIntent.GATE_HELD_LEAD + ' Settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work, then make this same call again.', summary: TaskIntent.GATE_HELD, quietRepair: true };

const call = (id, name, args) => [{ type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args) }, { type: 'done', finishReason: 'tool_calls' }];
const batch = (...cs) => {
  const out = [];
  cs.forEach(([id, name, args], i) => { out.push({ type: 'tool_start', index: i, id, name }, { type: 'tool_args', index: i, chunk: JSON.stringify(args) }); });
  out.push({ type: 'done', finishReason: 'tool_calls' });
  return out;
};
const write = (id, p) => call(id, 'fs_write', { path: p, content: 'console.log("hello world");\n' });
const exec = (id, command, extra) => call(id, 'shell_exec', Object.assign({ command }, extra || {}));
const say = (t) => [{ type: 'text', delta: t }, { type: 'done', finishReason: 'stop' }];
const DONE = 'Done — it works.';

// shell results are consumed in call order; an Error entry is THROWN (a killed command)
function registry(shellResults, readFails) {
  const r = makeRegistry();
  const s = (shellResults || []).slice();
  r.register({ impact: 'none', name: 'fs_write', schema: ANY, run: async (a) => 'wrote ' + a.path });
  r.register({ impact: 'none', name: 'fs_read', schema: ANY, run: async (a) => { if (readFails) throw new Error('ENOENT: no such file ' + a.path); return 'contents'; } });
  r.register({ impact: 'none', name: 'brief_proceed', schema: ANY, run: async () => 'Task Brief settled.' });
  r.register({ impact: 'none', name: 'verify_run', schema: ANY, run: async () => ({ content: '✓ PASSED — `npm test`\nok\n[exit 0]', summary: 'verify passed (5ms)' }) });
  r.register({ impact: 'none', name: 'shell_exec', schema: ANY, run: async () => { const next = s.shift(); if (next instanceof Error) throw next; return next || shellOut('ok', 0); } });
  return r;
}
async function run(turns, opts) {
  opts = opts || {};
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns });
  const messages = [{ role: 'user', content: opts.user || 'make it work' }];
  const reg = opts.registry || registry(opts.shell, opts.readFails);
  const held = new Set(opts.held || []);
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: opts.tools || TOOLS,
    limits: Object.assign({ maxIters: 12, grace: false }, opts.limits || {}),
    dispatch: (c, ctx) => held.has(c.id) ? Promise.resolve(Object.assign({}, HELD)) : reg.dispatch(c, ctx), capCtx: openCtx()
  });
  const tagged = (tag) => messages.filter(m => m.role === 'system' && String(m.content).indexOf('<' + tag + '>') === 0);
  return { res, messages, calls: provider.callCount(), vos: tagged('verify_before_done'), fr: tagged('failure_recovery'), tagged };
}
// the touched-file list the verify nudge names: "You changed code in this run (<list>) ..."
const touchedIn = (nudge) => { const m = /You changed code in this run \(([^)]*)\)/.exec(String(nudge && nudge.content)); return m ? m[1].split(', ') : []; };
const NOTHING_RAN = 'and are ending without running anything against it.';

(async () => {
  // ===== A. VERIFY-ON-STOP: the ledger, and a premise that is only ever a ledger fact =====
  {
    // A1. DONE MEANS: write hello.js, run `node hello.js`, see [exit 0], finish -> no nudge, three model calls.
    const r = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE)], { shell: [shellOut('hello world', 0)] });
    A.eq(r.vos.length, 0, 'A1 `node hello.js` exiting 0 is evidence for hello.js: no verify-on-stop nudge');
    A.eq(r.calls, 3, 'A1 write, run, answer: three model calls, no fourth bought by a false nudge');
    A.eq(r.res.reason, 'done', 'A1 the run ends done');

    // A1b. the same for every simple interpreter run of the file the run changed
    const runs = [
      ['hello.py', 'python hello.py'], ['hello.py', 'python3 -u hello.py'], ['hello.py', 'py -3 hello.py'],
      ['src/app.js', 'node src/app.js'], ['src/app.js', 'node .\\src\\app.js'], ['app.mjs', 'node --no-warnings ./app.mjs 2>&1'],
      ['run.sh', 'bash run.sh'], ['run.sh', 'sh ./run.sh'], ['main.go', 'go run main.go'], ['hello.ts', 'deno run hello.ts'],
      ['hello.ts', 'bun run hello.ts'], ['hello.rb', 'ruby hello.rb'], ['index.php', 'php index.php'], ['hello.js', 'NODE_ENV=test node hello.js > out.txt']
    ];
    for (const [file, command] of runs) {
      const x = await run([write('w1', file), exec('x1', command), say(DONE)], { shell: [shellOut('ok', 0)] });
      A.eq(x.vos.length, 0, 'A1b `' + command + '` exiting 0 clears the ' + file + ' it ran');
    }

    // A2. the run FAILED: that is a check that did not pass — never "you ran nothing"
    const failed = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say('It still throws; not verified.')], { shell: [shellOut('TypeError: x is not a function', 1)] });
    A.eq(failed.vos.length, 1, 'A2 a run of the changed file that exits 1 leaves the ledger armed');
    A.ok(failed.vos[0] && /did NOT pass/.test(failed.vos[0].content) && /node hello\.js/.test(failed.vos[0].content), 'A2 the nudge says that run did NOT pass, and names it: ' + (failed.vos[0] && failed.vos[0].content.slice(0, 220)));
    A.ok(failed.vos[0] && failed.vos[0].content.indexOf(NOTHING_RAN) < 0, 'A2 the nudge never claims nothing was run');

    // A3. the run was KILLED (shell.js throws, the registry makes it an isError result): it ran, and it did not pass.
    // A killed command is also a failed tool, so failure recovery spends its two turns first; verify-on-stop comes next.
    const kill = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say(DONE), say(DONE), say('It hangs; not verified.')], { shell: [killed('waiting…')] });
    A.eq(kill.fr.length, 2, 'A3 a killed run is a failed tool: failure recovery keeps its two turns');
    A.eq(kill.vos.length, 1, 'A3 a killed run of the changed file does not clear it');
    A.ok(kill.vos[0] && /did NOT pass/.test(kill.vos[0].content) && kill.vos[0].content.indexOf(NOTHING_RAN) < 0, 'A3 a KILLED run is a check that did not pass, never "nothing ran": ' + (kill.vos[0] && kill.vos[0].content.slice(0, 220)));

    // A4. a command that is not a check RAN: name it, never deny it
    const looked = await run([write('w1', 'src/app.js'), exec('x1', 'cat src/app.js'), say(DONE), say('Not run.')], { shell: [shellOut('module.exports = 1;', 0)] });
    A.eq(looked.vos.length, 1, 'A4 `cat` is not a check: the nudge still fires (anti-fake-done)');
    A.ok(looked.vos[0] && looked.vos[0].content.indexOf(NOTHING_RAN) < 0, 'A4 ...but it never says nothing ran: ' + (looked.vos[0] && looked.vos[0].content.slice(0, 260)));
    A.ok(looked.vos[0] && /cat src\/app\.js/.test(looked.vos[0].content), 'A4 ...it names the command that did run');

    // A5. NOTHING ran since the change: the original sentence is exactly true, and stays word for word
    const idle = await run([write('w1', 'src/app.js'), say(DONE), say('Not run.')]);
    A.eq(idle.vos.length, 1, 'A5 a change with nothing run against it still gets its one nudge');
    A.ok(idle.vos[0] && idle.vos[0].content.indexOf('You changed code in this run (src/app.js) ' + NOTHING_RAN + ' Code that compiles is not code that works') === 0 + '<verify_before_done>'.length, 'A5 the nothing-ran premise is unchanged: ' + (idle.vos[0] && idle.vos[0].content.slice(0, 200)));

    // A6. a run proves the FILE it ran: the other changed file stays owed
    const two = await run([batch(['w1', 'fs_write', { path: 'a.js', content: 'x' }], ['w2', 'fs_write', { path: 'b.js', content: 'y' }]), exec('x1', 'node a.js'), say(DONE), say('b.js not run.')], { shell: [shellOut('ok', 0)] });
    A.eq(two.vos.length, 1, 'A6 running a.js does not vouch for b.js');
    A.eq(touchedIn(two.vos[0]), ['b.js'], 'A6 the nudge names only the file still unproven');
    A.ok(two.vos[0] && two.vos[0].content.indexOf(NOTHING_RAN) < 0 && /node a\.js/.test(two.vos[0].content), 'A6 ...and names what did run instead of denying it');

    // A7. ANTI-FAKE-DONE: nothing below is a passing run of the changed file, so the nudge still fires
    const notEvidence = [
      ['a pipe hides the exit code', exec('x1', 'node hello.js | head -5'), shellOut('hello world', 0)],
      ['a chain hides the exit code', exec('x1', 'node hello.js || true'), shellOut('', 0)],
      ['a run of some OTHER file', exec('x1', 'node other.js'), shellOut('ok', 0)],
      ['inline code is not the file', exec('x1', 'node -e "require(\'./hello.js\')"'), shellOut('ok', 0)],
      ['a background start has no exit yet', exec('x1', 'node hello.js', { background: true }), bgStarted()],
      ['no host exit receipt at all', exec('x1', 'node hello.js'), 'ran node hello.js']
    ];
    for (const [why, turn, result] of notEvidence) {
      const x = await run([write('w1', 'hello.js'), turn, say(DONE), say('Not verified.')], { shell: [result] });
      A.eq(x.vos.length, 1, 'A7 ' + why + ': the nudge still fires');
      A.ok(x.vos[0] && x.vos[0].content.indexOf(NOTHING_RAN) < 0, 'A7 ' + why + ': ...and it does not deny that a command ran');
    }

    // A8. a check-shaped command that was KILLED ran and did not pass (it used to be skipped: "you ran nothing")
    const killedCheck = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say(DONE), say(DONE), say('Tests hang.')], { shell: [killed('RUNS test/app.test.js')] });
    A.eq(killedCheck.vos.length, 1, 'A8 a killed `npm test` leaves the ledger armed');
    A.ok(killedCheck.vos[0] && /did NOT pass/.test(killedCheck.vos[0].content) && /npm test/.test(killedCheck.vos[0].content), 'A8 ...and the nudge says the check did NOT pass: ' + (killedCheck.vos[0] && killedCheck.vos[0].content.slice(0, 220)));

    // A9. a check the Task Brief gate HELD never ran: "nothing ran" is the true premise there
    const heldCheck = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say(DONE), say('Not verified.')], { held: ['x1'] });
    A.eq(heldCheck.vos.length, 1, 'A9 a held check clears nothing');
    A.ok(heldCheck.vos[0] && heldCheck.vos[0].content.indexOf(NOTHING_RAN) > 0, 'A9 ...and "without running anything" is exactly true for a call that never ran');

    // A10. the one premise resolver, as a table over ledger states
    const P = _internals.nudgePremise;
    A.eq(typeof P, 'function', 'A10 one resolver words every stop-nudge premise (_internals.nudgePremise)');
    if (typeof P === 'function') {
      A.ok(P('verify_before_done', { failedCheck: '', ran: [] }).indexOf(NOTHING_RAN) === 0, 'A10 empty ledger -> the nothing-ran premise');
      const ranOne = P('verify_before_done', { failedCheck: '', ran: [{ cmd: 'git status', exit: '0' }] });
      A.ok(ranOne.indexOf(NOTHING_RAN) < 0 && /git status/.test(ranOne), 'A10 a command ran -> named, never denied: ' + ranOne.slice(0, 160));
      const failedOne = P('verify_before_done', { failedCheck: 'npm test', ran: [{ cmd: 'ls', exit: '0' }] });
      A.ok(/did NOT pass/.test(failedOne) && /npm test/.test(failedOne), 'A10 a failed check outranks the ran list');
    }
    // A11. which changed file a run ran: equal relative paths (`.`/`..` resolved), an extensionless node script, absolute vs
    // relative, an explicit cwd — and never a same-named file somewhere else
    const R = _internals.vosRunsPath;
    A.eq(typeof R === 'function' ? [R('hello.js', 'hello.js'), R('./src/../hello.js', 'hello.js'), R('src/app', 'src/app.js'), R('app.js', 'C:\\proj\\app.js'),
      R('C:/proj/src/app.js', 'src/app.js'), R('app.js', 'src/app.js', 'src'), R('other/hello.js', 'hello.js'), R('hello.js', 'src/hello.js'), R('hello.js', 'hello.json')] : null,
      [true, true, true, true, true, true, false, false, false], 'A11 vosRunsPath matches the file a run ran, never a namesake');
    const fromCwd = await run([write('w1', 'src/app.js'), exec('x1', 'node app.js', { cwd: 'src' }), say(DONE)], { shell: [shellOut('ok', 0)] });
    A.eq(fromCwd.vos.length, 0, 'A11 `node app.js` run with cwd src clears the src/app.js it ran');
    const namesake = await run([write('w1', 'hello.js'), exec('x1', 'node other/hello.js'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0)] });
    A.eq(namesake.vos.length, 1, 'A11 a run of a same-named file in another folder clears nothing (anti-fake-done)');
  }

  // ===== B. FAILURE RECOVERY: held is not failed =====
  {
    // B1. the gate HELD the write and the model tried to end: the note says held, never "failed"
    const h = await run([write('w1', 'note.txt'), say('Saved the note.'), say('Saved the note.'), say('Saved the note.')], { held: ['w1'] });
    A.eq(h.fr.length, 1, 'B1/B2 a held call buys exactly ONE recovery note (the held variant is max 1)');
    const t = String(h.fr[0] && h.fr[0].content);
    A.ok(!/The previous path failed/.test(t), 'B1 a held call is never called failed: ' + t.slice(0, 220));
    A.ok(/\bheld\b/.test(t) && /fs_write/.test(t) && /nothing ran/.test(t), 'B1 ...it says the call was held and nothing ran');
    A.ok(/make the same call again/.test(t), 'B1 ...and that the same call is still to be made (the hold\'s own instruction)');
    const two = typeof _internals.nudgePremise === 'function' ? _internals.nudgePremise('failure_recovery', { failed: [], held: ['fs_write', 'shell_exec'] }) : '';
    A.ok(/^The previous calls \(fs_write, shell_exec\) were held by the Task Brief gate, not failed: nothing ran\./.test(two) && /make the same calls again/.test(two) && /that they did not run/.test(two), 'B1 two held calls are named together: ' + two.slice(0, 160));

    // B3. a mixed batch: the failed call is named as failed, the held one is not
    const mixed = await run([batch(['r1', 'fs_read', { path: 'config.yaml' }], ['w1', 'fs_write', { path: 'note.txt', content: 'x' }]), say('Could not do it.'), say('Could not.'), say('Could not.')], { held: ['w1'], readFails: true });
    const mt = String(mixed.fr[0] && mixed.fr[0].content);
    A.ok(/The previous path failed \(fs_read\)/.test(mt), 'B3 the failed read is named as failed: ' + mt.slice(0, 160));
    A.ok(!/failed \([^)]*fs_write/.test(mt), 'B3 the held write is never listed among the failures');

    // B4. a real failure keeps the anti-lazy two-chance ladder and its wording
    const f = await run([call('r1', 'fs_read', { path: 'config.yaml' }), say('It is missing.'), say('It is missing.'), say('It is missing.')], { readFails: true });
    A.eq(f.fr.length, 2, 'B4 a real failure still gets two recovery turns');
    A.ok(/^<failure_recovery>The previous path failed \(fs_read\), but one failed tool is not proof/.test(String(f.fr[0] && f.fr[0].content)), 'B4 the failure wording is unchanged');
  }

  // ===== C. EVERY TURN-BUYING NUDGE IS COUNTED, BY ITS TAG =====
  {
    const NUDGE_TAGS = _internals.NUDGE_TAGS;
    A.ok(Array.isArray(NUDGE_TAGS) && NUDGE_TAGS.length >= 10, 'C1 the loop names the nudge tags it counts (_internals.NUDGE_TAGS)');
    const derived = (messages) => {
      const out = {};
      for (const m of messages) {
        if (m.role !== 'system') continue;
        const tag = (/^<([a-z_]+)>/.exec(String(m.content)) || [])[1];
        if (tag && (NUDGE_TAGS || []).indexOf(tag) >= 0) out[tag] = (out[tag] || 0) + 1;
      }
      return out;
    };
    const scenarios = {
      'write-only': await run([write('w1', 'src/app.js'), say(DONE), say('Not run.')]),
      'failed-run': await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say('Not verified.')], { shell: [shellOut('boom', 1)] }),
      'held': await run([write('w1', 'note.txt'), say('Saved.'), say('Saved.')], { held: ['w1'] }),
      'failure': await run([call('r1', 'fs_read', { path: 'x' }), say('Missing.'), say('Missing.'), say('Missing.')], { readFails: true }),
      'held-then-unverified': await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say(DONE), say('Not verified.')], { held: ['x1'] }),
      'announce': await run([say('Let me read the file now.'), call('r1', 'fs_read', { path: 'a' }), say('Read it.')])
    };
    for (const [name, r] of Object.entries(scenarios)) {
      const want = derived(r.messages);
      A.ok(Object.keys(want).length > 0, 'C2 scenario ' + name + ' really pushed a nudge');
      A.eq(r.res.nudges, want, 'C2 ' + name + ': res.nudges counts every pushed nudge by tag');
    }
    const quiet = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE)], { shell: [shellOut('hello world', 0)] });
    A.eq(quiet.res.nudges, undefined, 'C3 a run no nudge touched carries no nudges field (byte-identical result)');

    // C4. CLOSES THE FAMILY: every system note the loop pushes with a fenced tag is either a counted nudge (its push line
    // calls nudged('<tag>')) or a note that rides a turn the run is already taking. A new tag must pick one, here.
    const RIDES_ALONG = ['loop_guard', 'hook_context', 'mid_task_message'];
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'loop.js'), 'utf8');
    const lines = src.split('\n');
    const pushed = new Set();
    for (const l of lines) { const m = /messages\.push\(\{ role: 'system', content: '<([a-z_]+)>/.exec(l); if (m) pushed.add(m[1]); }
    A.ok(pushed.size >= 12, 'C4 the source scan sees the loop\'s pushes (' + pushed.size + ')');
    for (const tag of pushed) {
      const counted = (NUDGE_TAGS || []).indexOf(tag) >= 0;
      A.ok(counted || RIDES_ALONG.indexOf(tag) >= 0, 'C4 <' + tag + '> is either a counted nudge or declared to ride along');
      if (!counted) continue;
      const line = lines.find(l => l.indexOf("messages.push({ role: 'system', content: '<" + tag + ">") >= 0);
      A.ok(line && line.indexOf("nudged('" + tag + "')") >= 0, 'C4 the <' + tag + '> push counts itself (nudged(\'' + tag + '\') on its line)');
    }
    A.ok(src.indexOf("nudged('output_continuation')") >= 0, 'C4 the output-limit continuation (a prompt built elsewhere) counts itself too');
  }

  // ===== D. THE RUN ROW KEEPS THE COUNTS =====
  {
    const lines = [];
    const io = { readAll: () => lines.slice(), append: (e) => lines.push(e) };
    const clock = { now: () => 5000 };
    const s = makeRunStore({ io, clock });
    const row = s.record({ runId: 'n1', agentId: 'agent', reason: 'done', nudges: { verify_before_done: 1, failure_recovery: 2, 'Bad Key': 3, zero: 0, neg: -1, frac: 1.5, str: 'x' } });
    A.eq(row.nudges, { verify_before_done: 1, failure_recovery: 2 }, 'D1 the row keeps the counts (only well-formed tags with positive integer counts)');
    A.eq('nudges' in s.record({ runId: 'n2', agentId: 'agent', reason: 'done' }), false, 'D2 a run with no nudges keeps its exact pre-existing shape');
    A.eq('nudges' in s.record({ runId: 'n3', agentId: 'agent', reason: 'done', nudges: {} }), false, 'D2 an empty count object adds nothing');
    const reloaded = makeRunStore({ io, clock });
    A.eq((reloaded.latest('n1') || {}).nudges, { verify_before_done: 1, failure_recovery: 2 }, 'D3 the counts survive a reload from disk');
  }

  // ===== E. team.subagents: a bounded wait instead of a paid poll per look =====
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-truth-subagents-'));
    try {
      let n = 0;
      const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => Date.now() }, emit: () => {}, newId: () => 'sub_' + (++n) });
      const finishAfter = new Map();   // agentId -> ms the fake worker takes
      const ro = async (o) => {
        await new Promise(resolve => setTimeout(resolve, finishAfter.get(o.agentId) || 10));
        return { reason: 'done', messages: [{ role: 'assistant', content: 'finished:' + o.agentId }], usd: 0 };
      };
      let pendingNotes = 0;
      const roster = new Map([['researcher', { system: 'R' }], ['slow', { system: 'S' }]]);
      const tools = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: (() => { let i = 0; return () => 'run_' + (++i); })(), subagents, now: () => Date.now(), steerPending: () => pendingNotes });
      const tool = tools.subagentsTool;
      const props = (tool.schema && tool.schema.properties) || {};
      A.ok(props.wait && props.wait.type === 'boolean' && props.timeoutMs && props.timeoutMs.type === 'number', 'E0 the schema documents wait and timeoutMs (law 5)');
      A.ok(/wait:true/.test(tool.description) && /timeoutMs/.test(tool.description), 'E0 the description says how to wait instead of polling');
      A.ok(Number(tool.timeoutMs) >= 600000, 'E0 the registry backstop sits above the longest bounded wait');

      finishAfter.set('researcher', 300);
      const handle = JSON.parse((await tools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} })).content)[0];
      const plain = await tool.run({}, { agentId: 'lead' });
      A.eq(JSON.parse(plain.content)[0].status, 'running', 'E1 without wait the list answers at once (unchanged behavior)');
      const t0 = Date.now();
      const waited = await tool.run({ wait: true, timeoutMs: 5000 }, { agentId: 'lead' });
      const tookMs = Date.now() - t0;
      const rows = JSON.parse(String(waited.content).split('\n')[0]);
      A.eq(rows[0] && rows[0].status, 'done', 'E1 wait:true returns with the worker\'s new status');
      A.ok(tookMs < 3000, 'E1 ...as soon as it changed, not at the timeout (' + tookMs + 'ms)');
      A.ok(/changed/.test(String(waited.content)), 'E1 ...and says a worker changed: ' + String(waited.content).split('\n').slice(1).join(' '));

      const one = await tool.run({ id: handle.id, wait: true, timeoutMs: 2000 }, { agentId: 'lead' });
      A.ok(/nothing to wait for/.test(String(one.content)) && JSON.parse(String(one.content).split('\n')[0]).status === 'done', 'E2 waiting on a worker that already finished returns at once');

      finishAfter.set('slow', 60000);
      await tools.dispatchTool.run({ workers: [{ agentId: 'slow', prompt: 'y' }], background: true }, { agentId: 'lead', emit: () => {} });
      const t1 = Date.now();
      const timedOut = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 400 }, { agentId: 'lead' });
      const tookTimeout = Date.now() - t1;
      A.ok(tookTimeout >= 350 && tookTimeout < 3000, 'E3 an unchanged worker returns at the bounded timeout (' + tookTimeout + 'ms)');
      A.ok(!timedOut.isError && /still running/.test(String(timedOut.content)) && /not an error/.test(String(timedOut.content)), 'E3 a timeout is an answer, not an error');

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      const t2 = Date.now();
      const cut = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 20000 }, { agentId: 'lead', signal: ac.signal });
      A.ok(Date.now() - t2 < 3000 && /cancelled/.test(String(cut.content)), 'E4 a cancelled run stops the wait at once');

      pendingNotes = 1;
      const t3 = Date.now();
      const noted = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 20000 }, { agentId: 'lead' });
      A.ok(Date.now() - t3 < 3000 && /note/.test(String(noted.content)), 'E5 a note waiting for the run stops the wait (the loop folds it next)');
      pendingNotes = 0;
      subagents.interruptAll('lead');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('loop-truth.invariant');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
