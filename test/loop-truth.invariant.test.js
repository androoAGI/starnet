/* node test/loop-truth.invariant.test.js — LOOP TRUTH (cost plan W1.11).

   The stop checks in sidecar/loop.js buy the model another paid turn, and what each one TELLS the model is a host
   statement: it must state only what the run's own ledger proves. Four seams broke that, and one was never counted:

     A. VERIFY-ON-STOP read "node hello.js" exiting 0 as nothing at all: the run wrote hello.js, ran it, saw [exit 0],
        and was still told it was "ending without running anything against it" (one extra request per write-and-run).
        A run of a changed file that the host saw exit 0 now clears THAT file; a run that failed or was KILLED is a
        check that did NOT pass; any other command that ran is named, never denied. Anti-fake-done is unchanged:
        a pipe, an inline -e, a background start, a run of some other file, or no exit receipt clears nothing.
        Review round 1 tightened what a run proves:
          · WHICH FILE RAN is a resolved path: the script against the folder the shell reports it ran in (ranIn), the
            changed file against the run's base. A namesake (an absolute/relative pair, a cwd argument or a `cd` kept
            from an earlier call) never matches (A11, A12); no ranIn or no base proves nothing.
          · EVIDENCE HAS A RANK: a clean run of one file never erases a failing project check (npm test, verify_run) or
            another file's failing run, and a check started in the background is no check (A13 to A16).
        Review round 2 closed the same two families in the other direction:
          · RANK WHATEVER THE ORDER: a failure that comes AFTER a clean run puts the file back — a failing project check
            every run-proven file, a failing run of the same unchanged file that file (A10, A17). Only a passing project
            check lets the ledger forget a run's proof.
          · A COMMAND THAT RAN IS NEVER DENIED: every command is kept, a clean run of a changed file too, and named for the
            files it proves nothing about (A6, A18); a file's own failed run is named as a failed check (A14); a background
            start the shell refused never ran (A15b); an interpreter flag that changes folder first proves nothing (A11b).
     B. FAILURE RECOVERY told the model "The previous path failed (fs_write)" when the Task Brief gate HELD the call
        and it never ran. A held call gets its own truthful note (once); a real failure keeps the two-chance ladder.
        The note speaks for the held calls only ("it did not run"): another call in the same batch may have run.
     C. NOBODY COUNTED the nudges: every stop-check note is counted by its tag on the loop's result (res.nudges), and
        every fenced tag in loop.js (a literal push, hostFenced(...), a note built by a helper) is either counted or
        declared a note that rides a turn already being taken.
     D. ...and the run row keeps those counts (runstore: runs.jsonl, GET /api/runs), additive, so the history can price them.
     E. team.subagents could only be POLLED (one paid turn per look). wait:true blocks, bounded, until a listed worker
        changes, the run is cancelled, or a note for the run arrives (the real steer buffer); a timeout is an answer,
        not an error; one wait never outlives the provider's 5-minute prompt cache; and only a wait outlasts the run's own
        30 s fast-tool cap (the registry backstop is per call).

   Hermetic: replay provider, a stub registry whose shell behaves like shell.js (it starts in the run's base, keeps a
   cwd argument and a bare `cd`, and reports where it ran), an in-memory run store, a real subagent manager on a temp
   file, the real steer buffers, a fake runOnce. No network, no processes, no sidecar. */
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
const { makeSteerBuffers } = require('../sidecar/steer-buffer.js');
const { TaskIntent } = require('../frontend/app/fork.js');

const ANY = { type: 'object', properties: {} };
const BASE = 'C:\\proj';   // the run's base (run-paths base(): the project root, else the private workspace)
// the run's capability context; `paths.base` is the one fact the ledger reads from it (absent = no base = runs prove nothing)
const openCtx = (base) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, base ? { paths: { base: () => base } } : {});
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
const VERIFY_PASSED = { content: '✓ PASSED — `npm test`\nok\n[exit 0]', summary: 'verify passed (5ms)' };

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

/* The stub registry. shell_exec results are consumed in call order (an Error entry is THROWN: a killed command), and the
   shell behaves like shell.js where it matters here: it starts in the run's base, a cwd argument moves it and is kept
   for later calls, a bare `cd X` is kept for the next call, and every result (a thrown kill too) names the folder the
   command ran in as `ranIn` beside the content. o.noRanIn = a sandbox backend (container paths name no host file).
   A plain-string result is a tool that is not shell.js: no receipt, no metadata. */
function registry(o) {
  o = o || {};
  const r = makeRegistry();
  const shellQ = (o.shell || []).slice(), verifyQ = (o.verify || []).slice();
  let cwd = o.start || BASE;
  const P = /^[a-z]:/i.test(cwd) ? path.win32 : path.posix;
  r.register({ impact: 'none', name: 'fs_write', schema: ANY, run: async (a) => 'wrote ' + a.path });
  r.register({ impact: 'none', name: 'fs_read', schema: ANY, run: async (a) => { if (o.readFails) throw new Error('ENOENT: no such file ' + a.path); return 'contents'; } });
  r.register({ impact: 'none', name: 'brief_proceed', schema: ANY, run: async () => 'Task Brief settled.' });
  r.register({ impact: 'none', name: 'verify_run', schema: ANY, run: async () => verifyQ.shift() || VERIFY_PASSED });
  r.register({ impact: 'none', name: 'shell_exec', schema: ANY, run: async (a) => {
    a = a || {};
    if (a.cwd != null) cwd = P.resolve(cwd, String(a.cwd));
    const ranIn = o.noRanIn ? '' : cwd;
    const cd = /^\s*cd\s+("?)([^"&|;<>]+?)\1\s*$/i.exec(String(a.command || a.cmd || ''));
    if (cd) cwd = P.resolve(cwd, cd[2]);
    const next = shellQ.shift();
    if (next instanceof Error) { if (ranIn) next.ranIn = ranIn; throw next; }
    if (typeof next === 'string') return next;
    const out = Object.assign({}, next || shellOut('ok', 0));
    if (ranIn) out.ranIn = ranIn;
    return out;
  } });
  return r;
}
async function run(turns, opts) {
  opts = opts || {};
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns });
  const messages = [{ role: 'user', content: opts.user || 'make it work' }];
  const reg = registry(opts);
  const held = new Set(opts.held || []);
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: opts.tools || TOOLS,
    limits: Object.assign({ maxIters: 12, grace: false }, opts.limits || {}),
    dispatch: (c, ctx) => held.has(c.id) ? Promise.resolve(Object.assign({}, HELD)) : reg.dispatch(c, ctx),
    capCtx: openCtx(opts.base === undefined ? BASE : opts.base)
  });
  const tagged = (tag) => messages.filter(m => m.role === 'system' && String(m.content).indexOf('<' + tag + '>') === 0);
  return { res, messages, calls: provider.callCount(), vos: tagged('verify_before_done'), fr: tagged('failure_recovery'), tagged };
}
// the touched-file list the verify nudge names: "You changed code in this run (<list>) ..."
const touchedIn = (nudge) => { const m = /You changed code in this run \(([^)]*)\)/.exec(String(nudge && nudge.content)); return m ? m[1].split(', ') : []; };
const textOf = (nudge) => String(nudge && nudge.content);
const NOTHING_RAN = 'and are ending without running anything against it.';
const NOT_A_CHECK = 'commands the host does not count as a check';

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
      ['hello.ts', 'bun run hello.ts'], ['hello.rb', 'ruby hello.rb'], ['index.php', 'php index.php'], ['hello.js', 'NODE_ENV=test node hello.js > out.txt'],
      ['C:\\proj\\hello.js', 'node hello.js'], ['hello.js', 'node C:\\proj\\hello.js']
    ];
    for (const [file, command] of runs) {
      const x = await run([write('w1', file), exec('x1', command), say(DONE)], { shell: [shellOut('ok', 0)] });
      A.eq(x.vos.length, 0, 'A1b `' + command + '` exiting 0 clears the ' + file + ' it ran');
    }

    // A2. the run FAILED: that is a check that did not pass — never "you ran nothing"
    const failed = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say('It still throws; not verified.')], { shell: [shellOut('TypeError: x is not a function', 1)] });
    A.eq(failed.vos.length, 1, 'A2 a run of the changed file that exits 1 leaves the ledger armed');
    A.ok(/\(node hello\.js\) did NOT pass, and no passing check has run since\./.test(textOf(failed.vos[0])), 'A2 the nudge says that run did NOT pass, and names it: ' + textOf(failed.vos[0]).slice(0, 220));
    A.ok(textOf(failed.vos[0]).indexOf(NOTHING_RAN) < 0, 'A2 the nudge never claims nothing was run');

    // A3. the run was KILLED (shell.js throws, the registry makes it an isError result): it ran, and it did not pass.
    // A killed command is also a failed tool, so failure recovery spends its two turns first; verify-on-stop comes next.
    const kill = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say(DONE), say(DONE), say('It hangs; not verified.')], { shell: [killed('waiting…')] });
    A.eq(kill.fr.length, 2, 'A3 a killed run is a failed tool: failure recovery keeps its two turns');
    A.eq(kill.vos.length, 1, 'A3 a killed run of the changed file does not clear it');
    A.ok(/did NOT pass/.test(textOf(kill.vos[0])) && textOf(kill.vos[0]).indexOf(NOTHING_RAN) < 0, 'A3 a KILLED run is a check that did not pass, never "nothing ran": ' + textOf(kill.vos[0]).slice(0, 220));

    // A4. a command that is not a check RAN: name it, never deny it
    const looked = await run([write('w1', 'src/app.js'), exec('x1', 'cat src/app.js'), say(DONE), say('Not run.')], { shell: [shellOut('module.exports = 1;', 0)] });
    A.eq(looked.vos.length, 1, 'A4 `cat` is not a check: the nudge still fires (anti-fake-done)');
    A.ok(textOf(looked.vos[0]).indexOf(NOTHING_RAN) < 0, 'A4 ...but it never says nothing ran: ' + textOf(looked.vos[0]).slice(0, 260));
    A.ok(/cat src\/app\.js \(exit 0\)/.test(textOf(looked.vos[0])), 'A4 ...it names the command that did run');

    // A5. NOTHING ran since the change: the original sentence is exactly true, and stays word for word
    const idle = await run([write('w1', 'src/app.js'), say(DONE), say('Not run.')]);
    A.eq(idle.vos.length, 1, 'A5 a change with nothing run against it still gets its one nudge');
    A.ok(textOf(idle.vos[0]).indexOf('You changed code in this run (src/app.js) ' + NOTHING_RAN + ' Code that compiles is not code that works') === '<verify_before_done>'.length, 'A5 the nothing-ran premise is unchanged: ' + textOf(idle.vos[0]).slice(0, 200));

    // A6. a run proves the FILE it ran: the other changed file stays owed. The run still RAN, so it is named as a command
    // that is no check of b.js (review round 2: "ending without running anything against it" was false — node a.js ran)
    const two = await run([batch(['w1', 'fs_write', { path: 'a.js', content: 'x' }], ['w2', 'fs_write', { path: 'b.js', content: 'y' }]), exec('x1', 'node a.js'), say(DONE), say('b.js not run.')], { shell: [shellOut('ok', 0)] });
    A.eq(two.vos.length, 1, 'A6 running a.js does not vouch for b.js');
    A.eq(touchedIn(two.vos[0]), ['b.js'], 'A6 the nudge names only the file still unproven');
    A.ok(textOf(two.vos[0]).indexOf(NOT_A_CHECK + ' of it: node a.js (exit 0).') > 0 && textOf(two.vos[0]).indexOf(NOTHING_RAN) < 0, 'A6 node a.js ran: it is named as a command that is no check of b.js, never "without running anything": ' + textOf(two.vos[0]).slice(0, 220));

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
      A.ok(textOf(x.vos[0]).indexOf(NOTHING_RAN) < 0, 'A7 ' + why + ': ...and it does not deny that a command ran');
    }

    // A8. a check-shaped command that was KILLED ran and did not pass (it used to be skipped: "you ran nothing")
    const killedCheck = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say(DONE), say(DONE), say('Tests hang.')], { shell: [killed('RUNS test/app.test.js')] });
    A.eq(killedCheck.vos.length, 1, 'A8 a killed `npm test` leaves the ledger armed');
    A.ok(/did NOT pass/.test(textOf(killedCheck.vos[0])) && /npm test/.test(textOf(killedCheck.vos[0])), 'A8 ...and the nudge says the check did NOT pass: ' + textOf(killedCheck.vos[0]).slice(0, 220));

    // A9. a check the Task Brief gate HELD never ran: "nothing ran" is the true premise there
    // ops-1115 T3 (#187): with recovery on, the held `npm test` buys its one held note and the next "Done" ends the run
    // incomplete_work (held work never ran) before verify-on-stop is reached; the verify premise is read with recovery off.
    const heldEnd = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say(DONE), say('Not verified.')], { held: ['x1'] });
    A.eq([heldEnd.fr.length, heldEnd.res.reason], [1, 'error'], 'A9 (T3) a held check that never ran ends the run as an error after its one held note');
    const heldCheck = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), say(DONE), say('Not verified.')], { held: ['x1'], limits: { failureRecovery: false } });
    A.eq(heldCheck.vos.length, 1, 'A9 a held check clears nothing');
    A.ok(textOf(heldCheck.vos[0]).indexOf(NOTHING_RAN) > 0, 'A9 ...and "without running anything" is exactly true for a call that never ran');

    // A10. the one premise resolver, and the one ledger, as tables
    const P = _internals.nudgePremise;
    A.eq(typeof P, 'function', 'A10 one resolver words every stop-nudge premise (_internals.nudgePremise)');
    if (typeof P === 'function') {
      A.ok(P('verify_before_done', { failedCheck: '', ran: [] }).indexOf(NOTHING_RAN) === 0, 'A10 empty ledger -> the nothing-ran premise');
      const ranOne = P('verify_before_done', { failedCheck: '', ran: [{ cmd: 'git status', exit: '0' }] });
      A.ok(ranOne.indexOf(NOTHING_RAN) < 0 && /git status \(exit 0\)/.test(ranOne), 'A10 a command ran -> named, never denied: ' + ranOne.slice(0, 160));
      const failedOne = P('verify_before_done', { failedCheck: 'npm test', passedSince: false, ran: [{ cmd: 'ls', exit: '0' }] });
      A.ok(/^and are ending although the last check you ran against it \(npm test\) did NOT pass, and no passing check has run since\. A failing check is evidence/.test(failedOne), 'A10 a failed check outranks the ran list (original sentence while nothing passed since): ' + failedOne.slice(0, 160));
      const failedSince = P('verify_before_done', { failedCheck: 'npm test', passedSince: true, ran: [] });
      A.ok(/^and are ending although a check you ran against it \(npm test\) did NOT pass and has not passed since\. A failing check is evidence/.test(failedSince) && failedSince.indexOf('no passing check has run since') < 0, 'A10 a pass of something else since -> never "no passing check has run since": ' + failedSince.slice(0, 160));
      const many = P('verify_before_done', { failedCheck: '', ran: [1, 2, 3, 4, 5].map(i => ({ cmd: 'ls ' + i, exit: '0' })), ranEarlier: 4 });
      A.ok(/: ls 3 \(exit 0\), ls 4 \(exit 0\), ls 5 \(exit 0\) and 6 earlier\./.test(many), 'A10 the ran list names the last 3 and counts the rest: ' + many.slice(0, 200));
    }
    const L = _internals.makeVosLedger;
    A.eq(typeof L, 'function', 'A10 one ledger holds the evidence rules (_internals.makeVosLedger)');
    if (typeof L === 'function') {
      const l1 = L(); l1.change('src/app.js'); l1.check('all', false, 'npm test'); l1.run(['src/app.js'], true, 'node src/app.js');
      A.eq([l1.paths(), l1.facts().failedCheck, l1.facts().passedSince], [['src/app.js'], 'npm test', true], 'A10 ledger: a failing whole-change check outranks a clean run of one file');
      const l2 = L(); l2.change('a.js'); l2.change('b.js'); l2.run(['a.js'], false, 'node a.js'); l2.run(['b.js'], false, 'node b.js'); l2.run(['b.js'], true, 'node b.js');
      A.eq([l2.paths(), l2.facts().failedCheck], [['a.js'], 'node a.js'], 'A10 ledger: one failure slot per file — a later file\'s failure never overwrites an earlier one');
      const l3 = L(); l3.change('a.js'); l3.check('all', false, 'npm test'); l3.check('all', true, 'npm test');
      A.eq([l3.size, l3.facts()], [0, { failedCheck: '', passedSince: false, ran: [], ranEarlier: 0 }], 'A10 ledger: a passing whole-change check clears the set and forgets the failure');
      const l4 = L(); l4.change('a.js'); for (let i = 0; i < 6; i++) l4.ran({ cmd: 'ls ' + i, exit: '0' });
      A.eq([l4.facts().ran.map(x => x.cmd), l4.facts().ranEarlier], [['ls 3', 'ls 4', 'ls 5'], 3], 'A10 ledger: the ran list is bounded (the last 3 and a count)');
      const l5 = L(); l5.change('a.js'); l5.run(['a.js'], false, 'node a.js'); l5.run(['a.js'], true, 'node a.js');
      A.eq([l5.size, l5.facts().failedCheck], [0, ''], 'A10 ledger: a file\'s own clean run settles its own failed run');
      // review round 2 (blocker 1): the rank holds whatever order the evidence came in
      const l6 = L(); l6.change('a.js'); l6.run(['a.js'], true, 'node a.js'); l6.check('all', false, 'npm test');
      A.eq([l6.paths(), l6.facts().failedCheck, l6.facts().passedSince], [['a.js'], 'npm test', false], 'A10 ledger: a failing whole-change check AFTER a clean run puts the file back (nothing passed after it: the original sentence)');
      const l7 = L(); l7.change('a.js'); l7.run(['a.js'], true, 'node a.js'); l7.run(['a.js'], false, 'node a.js x');
      A.eq([l7.paths(), l7.facts().failedCheck], [['a.js'], 'node a.js x'], 'A10 ledger: the same unchanged file failing after its clean run is owed again');
      const l8 = L(); l8.change('a.js'); l8.change('b.js'); l8.run(['a.js'], true, 'node a.js'); l8.run(['b.js'], true, 'node b.js'); l8.change('b.js'); l8.check('all', false, 'npm test');
      A.eq(l8.paths().slice().sort(), ['a.js', 'b.js'], 'A10 ledger: a failing whole-change check re-arms every file only a run proved');
      const l9 = L(); l9.change('a.js'); l9.run(['a.js'], true, 'node a.js'); l9.check('all', false, 'npm test'); l9.check('all', true, 'npm test'); l9.run(['a.js'], false, 'node a.js');
      A.eq(l9.size, 0, 'A10 ledger: only a passing whole-change check forgets a run proof (a later failing run does not outrank it, as on e316231d7)');
      const l10 = L(); l10.change('a.js'); l10.check('all', true, 'npm test'); l10.check('all', false, 'npm run lint');
      A.eq(l10.size, 0, 'A10 ledger: a failing check with nothing owed records nothing (as on e316231d7)');
      const l11 = L(); l11.change('fix.patch'); l11.check('patch', true, 'git apply --check fix.patch'); l11.check('all', false, 'npm test');
      A.eq(l11.size, 0, 'A10 ledger: a failing project check does not re-arm a patch file its patch check proved (it does not run an unapplied patch)');
    }

    // A11. which changed file a run ran: RESOLVED paths only — the script against the folder the shell ran in, the changed
    // file against the run's base. Never a namesake; no ranIn, no base, or a path the shell expands = proves nothing.
    const R = _internals.vosRunsPath;
    const B = BASE;
    const table = [
      [['hello.js', 'hello.js', B, B, 'node'], true, 'the same relative file'],
      [['./src/../hello.js', 'hello.js', B, B, 'node'], true, '`.` and `..` resolved'],
      [['src/app', 'src/app.js', B, B, 'node'], true, 'node finds app.js for `node src/app`'],
      [['src/app', 'src/app.js', B, B, 'python'], false, 'only node adds an extension'],
      [['app.js', 'C:\\proj\\app.js', B, B, 'node'], true, 'a relative run of an absolutely named change'],
      [['C:/proj/src/app.js', 'src/app.js', B, B, 'node'], true, 'an absolute run of a relatively named change'],
      [['app.js', 'src/app.js', 'C:\\proj\\src', B, 'node'], true, 'run in src (a cwd argument or a `cd`)'],
      [['..\\hello.js', 'hello.js', 'C:\\proj\\sub', B, 'node'], true, 'run from a subfolder by `..`'],
      [['HELLO.JS', 'hello.js', 'C:\\Proj', 'c:\\proj', 'node'], true, 'a drive path compares without case (Windows)'],
      [['/srv/app/hello.js', 'hello.js', '/srv/app', '/srv/app', 'node'], true, 'POSIX absolute'],
      [['other/hello.js', 'hello.js', B, B, 'node'], false, 'a namesake in another folder'],
      [['hello.js', 'src/hello.js', B, B, 'node'], false, 'a root namesake of src/hello.js'],
      [['index.js', 'C:\\proj\\src\\index.js', B, B, 'node'], false, 'review round 1: a relative namesake of an absolute change'],
      [['C:\\other\\hello.js', 'hello.js', B, B, 'node'], false, 'review round 1: an absolute namesake of a relative change'],
      [['app.js', 'app.js', 'C:\\proj\\src', B, 'node'], false, 'review round 1: run in src (a kept cwd / cd), changed at the root'],
      [['hello.js', 'hello.json', B, B, 'node'], false, 'another extension'],
      [['Hello.js', 'hello.js', '/home/u/p', '/home/u/p', 'node'], false, 'POSIX keeps case'],
      [['hello.js', 'hello.js', '', B, 'node'], false, 'no ranIn (a sandbox backend, a stub)'],
      [['hello.js', 'hello.js', B, '', 'node'], false, 'no base'],
      [['$HOME/hello.js', 'hello.js', B, B, 'node'], false, 'a variable the shell expands'],
      [['%CD%\\hello.js', 'hello.js', B, B, 'node'], false, 'a cmd variable'],
      [['~/hello.js', 'hello.js', B, B, 'node'], false, 'home'],
      [['*.js', 'hello.js', B, B, 'node'], false, 'a glob'],
      [['hello.js', '\\\\server\\share\\hello.js', B, B, 'node'], false, 'a network path'],
      [['C:hello.js', 'hello.js', B, B, 'node'], false, 'a drive-relative path']
    ];
    for (const [args, want, why] of table) A.eq(typeof R === 'function' ? R(...args) : null, want, 'A11 vosRunsPath ' + JSON.stringify(args) + ': ' + why);
    const fromCwd = await run([write('w1', 'src/app.js'), exec('x1', 'node app.js', { cwd: 'src' }), say(DONE)], { shell: [shellOut('ok', 0)] });
    A.eq(fromCwd.vos.length, 0, 'A11 `node app.js` run with cwd src clears the src/app.js it ran');
    const namesake = await run([write('w1', 'hello.js'), exec('x1', 'node other/hello.js'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0)] });
    A.eq(namesake.vos.length, 1, 'A11 a run of a same-named file in another folder clears nothing (anti-fake-done)');

    // A11b. an interpreter flag that moves to another folder BEFORE it opens the script: the script no longer resolves
    // against the folder the shell ran in, so which file ran is unknown — no target, it proves nothing (review round 2)
    const T = _internals.vosInterpreterTarget;
    for (const command of ['ruby -Csrc hello.rb', 'ruby -C src hello.rb', 'ruby -xsrc hello.rb', 'bun --cwd=src index.ts', 'bun --cwd src run index.ts', 'bun run --cwd src index.ts', 'go run -C src main.go'])
      A.eq(typeof T === 'function' ? T({ command }) : 'no vosInterpreterTarget', null, 'A11b `' + command + '` changes folder before it opens the script: no target');
    A.eq(typeof T === 'function' ? T({ command: 'ruby -w hello.rb' }) : null, { exe: 'ruby', script: 'hello.rb' }, 'A11b control: a flag that does not change folder still targets the script');
    const movedRun = await run([write('w1', 'hello.rb'), exec('x1', 'ruby -Csub hello.rb'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0)] });
    A.eq(movedRun.vos.length, 1, 'A11b `ruby -Csub hello.rb` ran sub/hello.rb, not the changed hello.rb at the root: the nudge fires (3cc0fcce4 cleared it)');

    // A12. THE FOUR NAMESAKES (review round 1, blocker 2), through the loop with a shell that says where it ran: each ran
    // a DIFFERENT same-named file, so the changed one stays owed (867313704 cleared all four by suffix or by name)
    const four = [
      ['an absolute change, its relative namesake run at the root', [write('w1', 'C:\\proj\\src\\index.js'), exec('x1', 'node index.js')], 'C:\\proj\\src\\index.js'],
      ['a relative change, an absolute namesake elsewhere', [write('w1', 'hello.js'), exec('x1', 'node C:\\other\\hello.js')], 'hello.js'],
      ['a cwd argument kept from an earlier call', [write('w1', 'app.js'), exec('x0', 'dir', { cwd: 'src' }), exec('x1', 'node app.js')], 'app.js'],
      ['a `cd` kept from an earlier call', [write('w1', 'hello.js'), exec('x0', 'cd sub'), exec('x1', 'node hello.js')], 'hello.js']
    ];
    for (const [why, steps, owed] of four) {
      const x = await run(steps.concat([say(DONE), say('Not verified.')]), { shell: steps.slice(1).map(() => shellOut('ok', 0)) });
      A.eq(x.vos.length, 1, 'A12 ' + why + ': the changed file is not cleared, the nudge fires');
      A.eq(touchedIn(x.vos[0]), [owed], 'A12 ' + why + ': ...and still names it');
      A.ok(/node [^(]*\(exit 0\)/.test(textOf(x.vos[0])), 'A12 ' + why + ': ...the namesake run is named as a command that is no check of it: ' + textOf(x.vos[0]).slice(0, 220));
    }
    // ...and the same rules clear the file a run really ran
    const cdThere = await run([write('w1', 'src/index.js'), exec('x0', 'cd src'), exec('x1', 'node index.js'), say(DONE)], { shell: [shellOut('', 0), shellOut('ok', 0)] });
    A.eq(cdThere.vos.length, 0, 'A12 `cd src` then `node index.js` ran the changed src/index.js: cleared');
    const sandbox = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0)], noRanIn: true });
    A.eq(sandbox.vos.length, 1, 'A12 a shell that does not say where it ran (a sandbox backend) proves nothing');
    const noBase = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0)], base: '' });
    A.eq(noBase.vos.length, 1, 'A12 a run with no base (an aux loop, a rig) proves nothing');

    // A13. EVIDENCE HAS A RANK (review round 1, blocker 1): a clean run of the changed file never erases a FAILED project
    // check — `npm test` or verify_run. 867313704 nudged 0 times here; e316231d7 nudged once.
    const projFail = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), exec('x2', 'node src/app.js'), say(DONE), say('Tests fail; not verified.')], { shell: [shellOut('1 failing', 1), shellOut('ok', 0)] });
    A.eq(projFail.vos.length, 1, 'A13 a passing `node src/app.js` does not erase the failed `npm test`: the nudge fires');
    A.eq(touchedIn(projFail.vos[0]), ['src/app.js'], 'A13 ...the change stays owed');
    A.ok(/\(npm test\) did NOT pass and has not passed since\./.test(textOf(projFail.vos[0])) && textOf(projFail.vos[0]).indexOf('no passing check has run since') < 0, 'A13 ...naming the failed check, and never "no passing check has run since" (a run passed since): ' + textOf(projFail.vos[0]).slice(0, 240));
    const verifyFail = await run([write('w1', 'src/app.js'), call('v1', 'verify_run', { cmd: 'npm test' }), exec('x2', 'node src/app.js'), say(DONE), say('Not verified.')], { verify: [{ content: '✗ FAILED — `npm test`\n1 failing\n[exit 1]', summary: 'verify FAILED (5ms)' }], shell: [shellOut('ok', 0)] });
    A.eq(verifyFail.vos.length, 1, 'A13 a passing run does not erase a FAILED verify_run either');
    A.ok(/\(npm test\) did NOT pass and has not passed since\./.test(textOf(verifyFail.vos[0])), 'A13 ...the nudge names the failed verify_run: ' + textOf(verifyFail.vos[0]).slice(0, 220));
    const fixed = await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), exec('x2', 'npm test'), say(DONE)], { shell: [shellOut('1 failing', 1), shellOut('ok', 0)] });
    A.eq(fixed.vos.length, 0, 'A13 control: the failed check passing again clears it');

    // A14. one failure slot PER FILE (review round 1, blocker 3a): a.js failed, b.js failed then passed. 867313704 kept
    // one slot (b.js overwrote a.js), dropped it at b.js's pass, and listed `node a.js (exit 1)` as a command that is no check.
    const p5 = await run([batch(['w1', 'fs_write', { path: 'a.js', content: 'x' }], ['w2', 'fs_write', { path: 'b.js', content: 'y' }]), exec('x1', 'node a.js'), exec('x2', 'node b.js'), exec('x3', 'node b.js'), say(DONE), say('a.js still fails.')], { shell: [shellOut('boom', 1), shellOut('boom', 1), shellOut('ok', 0)] });
    A.eq(p5.vos.length, 1, 'A14 a.js never passed: the nudge fires');
    A.eq(touchedIn(p5.vos[0]), ['a.js'], 'A14 b.js ran clean; only a.js is owed');
    A.ok(/\(node a\.js\) did NOT pass and has not passed since\./.test(textOf(p5.vos[0])), 'A14 the failed run of a.js stands and is named as failed: ' + textOf(p5.vos[0]).slice(0, 220));
    A.ok(textOf(p5.vos[0]).indexOf(NOT_A_CHECK) < 0, 'A14 a run of a changed file is never listed among the commands that are no check');

    // A15. a check STARTED in the background has no exit yet: it is no check (e316231d7 and 867313704 read the start as a pass)
    const bgCheck = await run([write('w1', 'src/app.js'), exec('x1', 'npm test', { background: true }), say(DONE), say('Tests still running.')], { shell: [bgStarted()] });
    A.eq(bgCheck.vos.length, 1, 'A15 `npm test` in the background proves nothing yet: the nudge fires');
    A.ok(/npm test \(started in the background\)/.test(textOf(bgCheck.vos[0])) && textOf(bgCheck.vos[0]).indexOf(NOTHING_RAN) < 0, 'A15 ...and names it as started, never "nothing ran": ' + textOf(bgCheck.vos[0]).slice(0, 220));
    // A15b. a background start the shell REFUSED (too many background processes) or could not make never ran: it is never
    // called started (3cc0fcce4 said "started in the background"; e316231d7 read the refusal as a passing check)
    const notStarted = [
      ['refused', { content: 'Could not start a background process: too many background processes (max 4) — kill one with shell.bg.kill first', summary: 'bg refused' }],
      ['unavailable', { content: 'Background processes are not available in this build.', summary: 'unavailable' }]
    ];
    for (const [why, result] of notStarted) {
      const x = await run([write('w1', 'src/app.js'), exec('x1', 'npm test', { background: true }), say(DONE), say('Not verified.')], { shell: [result] });
      A.eq(x.vos.length, 1, 'A15b a background start the shell ' + why + ' proves nothing: the nudge fires');
      A.ok(textOf(x.vos[0]).indexOf('started in the background') < 0 && textOf(x.vos[0]).indexOf(NOTHING_RAN) > 0, 'A15b ...and it is never called started: nothing ran (' + why + '): ' + textOf(x.vos[0]).slice(0, 200));
    }

    // A16. a passing PATCH check speaks for patch files only: it never erases a failed project check
    const patch = await run([batch(['w1', 'fs_write', { path: 'src/app.js', content: 'x' }], ['w2', 'fs_write', { path: 'fix.patch', content: 'y' }]), exec('x1', 'npm test'), exec('x2', 'git apply --check fix.patch'), say(DONE), say('Not verified.')], { shell: [shellOut('1 failing', 1), shellOut('', 0)] });
    A.eq(patch.vos.length, 1, 'A16 the code is still owed after the patch check');
    A.eq(touchedIn(patch.vos[0]), ['src/app.js'], 'A16 ...the patch check cleared the patch file only');
    A.ok(/\(npm test\) did NOT pass and has not passed since\./.test(textOf(patch.vos[0])), 'A16 ...and the failed `npm test` still stands (e316231d7 said nothing ran): ' + textOf(patch.vos[0]).slice(0, 220));

    // A17. RANK WHATEVER THE ORDER (review round 2, blocker 1): a clean run of the changed file that came FIRST never hides a
    // failing project check, or a failing run of the same unchanged file, that came AFTER it. e316231d7 nudged in every
    // one of these (it never cleared a file on a run); 3cc0fcce4 ended every one 'done' with no nudge.
    const ORIG = 'did NOT pass, and no passing check has run since.', SINCE = 'did NOT pass and has not passed since.';
    const VERIFY_FAILED = { content: '✗ FAILED — `npm test`\n1 failing\n[exit 1]', summary: 'verify FAILED (5ms)' };
    const later = [
      ['R1 a clean run, then `npm test` fails', [write('w1', 'src/app.js'), exec('x1', 'node src/app.js'), exec('x2', 'npm test')], { shell: [shellOut('ok', 0), shellOut('1 failing', 1)] }, ['src/app.js'], 'npm test', ORIG],
      ['R2 a clean run, then verify_run FAILS', [write('w1', 'src/app.js'), exec('x1', 'node src/app.js'), call('v1', 'verify_run', { cmd: 'npm test' })], { shell: [shellOut('ok', 0)], verify: [VERIFY_FAILED] }, ['src/app.js'], 'npm test', ORIG],
      ['R3 a clean run, then the same unchanged file fails', [write('w1', 'a.js'), exec('x1', 'node a.js'), exec('x2', 'node a.js x')], { shell: [shellOut('ok', 0), shellOut('Error: bad input x', 1)] }, ['a.js'], 'node a.js x', ORIG],
      ['R4 the clean run and the failing test in ONE batch', [write('w1', 'src/app.js'), batch(['x1', 'shell_exec', { command: 'node src/app.js' }], ['x2', 'shell_exec', { command: 'npm test' }])], { shell: [shellOut('ok', 0), shellOut('1 failing', 1)] }, ['src/app.js'], 'npm test', ORIG],
      ['R4b the same batch with the failing test first', [write('w1', 'src/app.js'), batch(['x2', 'shell_exec', { command: 'npm test' }], ['x1', 'shell_exec', { command: 'node src/app.js' }])], { shell: [shellOut('1 failing', 1), shellOut('ok', 0)] }, ['src/app.js'], 'npm test', SINCE],
      ['R5 a.js ran clean, b.js never ran, then `npm test` fails', [batch(['w1', 'fs_write', { path: 'a.js', content: 'x' }], ['w2', 'fs_write', { path: 'b.js', content: 'y' }]), exec('x1', 'node a.js'), exec('x2', 'npm test')], { shell: [shellOut('ok', 0), shellOut('1 failing', 1)] }, ['a.js', 'b.js'], 'npm test', ORIG]
    ];
    for (const [why, steps, opts, owed, failedCmd, sentence] of later) {
      const x = await run(steps.concat([say(DONE), say('Not verified.')]), opts);
      A.eq([x.vos.length, x.res.reason], [1, 'done'], 'A17 ' + why + ': the nudge fires before the run ends (3cc0fcce4: none)');
      A.eq(touchedIn(x.vos[0]).slice().sort(), owed, 'A17 ' + why + ': ...the earlier clean run no longer proves ' + owed.join(', '));
      A.ok(textOf(x.vos[0]).indexOf('(' + failedCmd + ') ' + sentence) > 0, 'A17 ' + why + ': ...naming the failure that came last: ' + textOf(x.vos[0]).slice(0, 240));
    }
    // controls: a later PASSING check after the clean run, and a failing run after a passing project check (the project
    // check outranks a run, as on e316231d7), end with no nudge
    const laterPass = await run([write('w1', 'src/app.js'), exec('x1', 'node src/app.js'), exec('x2', 'npm test'), say(DONE)], { shell: [shellOut('ok', 0), shellOut('3 passing', 0)] });
    A.eq(laterPass.vos.length, 0, 'A17 control: a clean run, then a passing `npm test`: no nudge');
    const projFirst = await run([write('w1', 'a.js'), exec('x1', 'npm test'), exec('x2', 'node a.js x'), say(DONE)], { shell: [shellOut('3 passing', 0), shellOut('usage: a.js', 1)] });
    A.eq(projFirst.vos.length, 0, 'A17 control: a passing `npm test`, then a failing run of a.js: the project check outranks it, no nudge (as on e316231d7)');

    // A18. A COMMAND THAT RAN IS NEVER DENIED (review round 2, blocker 3): a clean run proves the file it ran and is still a
    // command that ran, named for the OTHER changed files it proves nothing about; so is a passing patch check for the
    // code. e316231d7 and 3cc0fcce4 told the model it was "ending without running anything against it".
    const named = [
      ['M1 lib.js and main.js written, main.js ran clean', [batch(['w1', 'fs_write', { path: 'lib.js', content: 'x' }], ['w2', 'fs_write', { path: 'main.js', content: 'y' }]), exec('x1', 'node main.js')], 'lib.js', 'node main.js (exit 0)'],
      ['M2 app.py and test_app.py written, the test file ran clean', [batch(['w1', 'fs_write', { path: 'app.py', content: 'x' }], ['w2', 'fs_write', { path: 'test_app.py', content: 'y' }]), exec('x1', 'python test_app.py')], 'app.py', 'python test_app.py (exit 0)'],
      ['M3 a patch check proved the patch file, not the code', [batch(['w1', 'fs_write', { path: 'src/app.js', content: 'x' }], ['w2', 'fs_write', { path: 'fix.patch', content: 'y' }]), exec('x1', 'git apply --check fix.patch')], 'src/app.js', 'git apply --check fix.patch (exit 0)']
    ];
    for (const [why, steps, owed, cmd] of named) {
      const x = await run(steps.concat([say(DONE), say('Not verified.')]), { shell: [shellOut('', 0)] });
      A.eq(x.vos.length, 1, 'A18 ' + why + ': the nudge still fires for the file the command proved nothing about');
      A.eq(touchedIn(x.vos[0]), [owed], 'A18 ' + why + ': ...naming only ' + owed);
      A.ok(textOf(x.vos[0]).indexOf(NOT_A_CHECK + ' of it: ' + cmd + '.') > 0 && textOf(x.vos[0]).indexOf(NOTHING_RAN) < 0, 'A18 ' + why + ': ...and names the command that ran, never "without running anything": ' + textOf(x.vos[0]).slice(0, 240));
    }
  }

  // ===== B. FAILURE RECOVERY: held is not failed =====
  {
    // B1. the gate HELD the write and the model tried to end: the note says held, never "failed"
    const h = await run([write('w1', 'note.txt'), say('Saved the note.'), say('Saved the note.'), say('Saved the note.')], { held: ['w1'] });
    A.eq(h.fr.length, 1, 'B1/B2 a held call buys exactly ONE recovery note (the held variant is max 1)');
    const t = String(h.fr[0] && h.fr[0].content);
    A.ok(!/The previous path failed/.test(t), 'B1 a held call is never called failed: ' + t.slice(0, 220));
    A.ok(/The previous call \(fs_write\) was held by the Task Brief gate, not failed: it did not run\./.test(t) && !/nothing ran/.test(t), 'B1 ...it says the call was held and that IT did not run');
    A.ok(/make the same call again/.test(t), 'B1 ...and that the same call is still to be made (the hold\'s own instruction)');
    const two = typeof _internals.nudgePremise === 'function' ? _internals.nudgePremise('failure_recovery', { failed: [], held: ['fs_write', 'shell_exec'] }) : '';
    A.ok(/^The previous calls \(fs_write, shell_exec\) were held by the Task Brief gate, not failed: they did not run\./.test(two) && /make the same calls again/.test(two) && /that they did not run/.test(two), 'B1 two held calls are named together: ' + two.slice(0, 160));

    // B3. a mixed batch: the failed call is named as failed, the held one is not
    const mixed = await run([batch(['r1', 'fs_read', { path: 'config.yaml' }], ['w1', 'fs_write', { path: 'note.txt', content: 'x' }]), say('Could not do it.'), say('Could not.'), say('Could not.')], { held: ['w1'], readFails: true });
    const mt = String(mixed.fr[0] && mixed.fr[0].content);
    A.ok(/The previous path failed \(fs_read\)/.test(mt), 'B3 the failed read is named as failed: ' + mt.slice(0, 160));
    A.ok(!/failed \([^)]*fs_write/.test(mt), 'B3 the held write is never listed among the failures');

    // B4. a real failure keeps the anti-lazy two-chance ladder and its wording
    const f = await run([call('r1', 'fs_read', { path: 'config.yaml' }), say('It is missing.'), say('It is missing.'), say('It is missing.')], { readFails: true });
    A.eq(f.fr.length, 2, 'B4 a real failure still gets two recovery turns');
    A.ok(/^<failure_recovery>The previous path failed \(fs_read\), but one failed tool is not proof/.test(String(f.fr[0] && f.fr[0].content)), 'B4 the failure wording is unchanged');

    // B5. review round 1 (blocker 3b): another call in the batch RAN, so the held note speaks for the held call only
    const ranHeld = await run([batch(['r1', 'fs_read', { path: 'config.yaml' }], ['w1', 'fs_write', { path: 'note.txt', content: 'x' }]), say('Saved.'), say('Saved.'), say('Saved.')], { held: ['w1'] });
    const rh = String(ranHeld.fr[0] && ranHeld.fr[0].content);
    A.eq(ranHeld.fr.length, 1, 'B5 the held write buys its one note');
    A.ok(/\(fs_write\) was held by the Task Brief gate, not failed: it did not run\./.test(rh) && !/nothing ran/.test(rh), 'B5 the read ran: the note never says nothing ran: ' + rh.slice(0, 200));
  }

  // ===== C. EVERY STOP-CHECK NOTE IS COUNTED, BY ITS TAG =====
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
      'failed-project-check': await run([write('w1', 'src/app.js'), exec('x1', 'npm test'), exec('x2', 'node src/app.js'), say(DONE), say('Not verified.')], { shell: [shellOut('1 failing', 1), shellOut('ok', 0)] }),
      'run-then-failed-check': await run([write('w1', 'src/app.js'), exec('x1', 'node src/app.js'), exec('x2', 'npm test'), say(DONE), say('Not verified.')], { shell: [shellOut('ok', 0), shellOut('1 failing', 1)] }),
      'announce': await run([say('Let me read the file now.'), call('r1', 'fs_read', { path: 'a' }), say('Read it.')])
    };
    for (const [name, r] of Object.entries(scenarios)) {
      const want = derived(r.messages);
      A.ok(Object.keys(want).length > 0, 'C2 scenario ' + name + ' really pushed a nudge');
      A.eq(r.res.nudges, want, 'C2 ' + name + ': res.nudges counts every pushed nudge by tag');
    }
    const quiet = await run([write('w1', 'hello.js'), exec('x1', 'node hello.js'), say(DONE)], { shell: [shellOut('hello world', 0)] });
    A.eq(quiet.res.nudges, undefined, 'C3 a run no nudge touched carries no nudges field (byte-identical result)');

    // C4. CLOSES THE FAMILY: every fenced note tag in loop.js — a literal '<tag>…', a hostFenced(…, 'tag') — is either a
    // counted nudge or a note that rides a turn the run is already taking. A new tag must pick one, here.
    const RIDES_ALONG = ['loop_guard', 'hook_context', 'mid_task_message', 'steering_note', 'failed_check_repair', 'terminal_evidence', 'conversation_summary', 'task_list'];
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'loop.js'), 'utf8');
    const lines = src.split('\n');
    const fenced = new Set();
    for (const m of src.matchAll(/'<([a-z_]+)>/g)) fenced.add(m[1]);
    for (const m of src.matchAll(/hostFenced\([^()]*(?:\([^()]*\)[^()]*)*,\s*'([a-z_]+)'\s*\)/g)) fenced.add(m[1]);
    A.ok(fenced.size >= 15, 'C4 the source scan sees the loop\'s fenced notes (' + fenced.size + ')');
    A.ok(['terminal_evidence', 'task_list', 'steering_note', 'failed_check_repair', 'conversation_summary'].every(t => fenced.has(t)), 'C4 ...including notes built by hostFenced() and by helpers, not only literal pushes');
    for (const tag of fenced) {
      const counted = (NUDGE_TAGS || []).indexOf(tag) >= 0;
      A.ok(counted || RIDES_ALONG.indexOf(tag) >= 0, 'C4 <' + tag + '> is either a counted nudge or declared to ride along');
      if (!counted) continue;
      const line = lines.find(l => l.indexOf("messages.push({ role: 'system', content: '<" + tag + ">") >= 0);
      A.ok(!line || line.indexOf("nudged('" + tag + "')") >= 0, 'C4 the <' + tag + '> push counts itself (nudged(\'' + tag + '\') on its line)');
    }
    for (const tag of (NUDGE_TAGS || [])) A.ok(src.indexOf("nudged('" + tag + "')") >= 0, 'C4 every counted tag is counted somewhere: nudged(\'' + tag + '\')');
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
      // the station's own steer buffers (POST /api/run/steer), read the way index.js wires them: pending(<this run>)
      const steer = makeSteerBuffers();
      const LEAD_RUN = 'lead-run-1';
      const roster = new Map([['researcher', { system: 'R' }], ['slow', { system: 'S' }]]);
      const tools = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: (() => { let i = 0; return () => 'run_' + (++i); })(), subagents, now: () => Date.now(), steerPending: () => steer.pending(LEAD_RUN) });
      const tool = tools.subagentsTool;
      const props = (tool.schema && tool.schema.properties) || {};
      A.ok(props.wait && props.wait.type === 'boolean' && props.timeoutMs && props.timeoutMs.type === 'number', 'E0 the schema documents wait and timeoutMs (law 5)');
      A.ok(/wait:true/.test(tool.description) && /timeoutMs \(max 3 min\)/.test(tool.description), 'E0 the description says how to wait instead of polling, and the real cap');
      const orchSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'orchestration.js'), 'utf8');
      const cap = Number((/const SUBAGENT_WAIT_MAX_MS = (\d+);/.exec(orchSrc) || [])[1]);
      A.ok(cap > 0 && cap <= 240000, 'E0 one wait never outlives the 5-minute prompt cache (cap ' + cap + 'ms, a minute left for the turn that asked)');
      // the registry backstop is per call (review round 2): above the bounded wait for wait:true only; a list, an id or a
      // runId lookup keeps the run's 30 s fast-tool cap (0 = ctx.timeoutMs), as before the wait existed
      const backstop = (args) => (typeof tool.timeoutMs === 'function' ? Number(tool.timeoutMs(args)) : Number(tool.timeoutMs));
      A.ok(backstop({ wait: true }) >= cap && backstop({ wait: true }) < 300000, 'E0 a wait:true call\'s registry backstop sits above the bounded wait (' + backstop({ wait: true }) + 'ms)');
      A.eq([backstop({}), backstop({ id: 'sub_1' }), backstop({ runId: 'run_1' })], [0, 0, 0], 'E0 ...and every other call keeps the run\'s fast-tool cap (0 = ctx.timeoutMs)');
      // ...and the registry reads that per-call form: (args) => ms, 0 = the run's own cap
      const napReg = makeRegistry();
      napReg.register({ impact: 'none', name: 'nap', schema: ANY, timeoutMs: (a) => (a && a.long ? 20000 : 0), run: () => new Promise(resolve => setTimeout(() => resolve('woke'), 400)) });
      const napCtx = Object.assign(openCtx(BASE), { timeoutMs: 100 });
      const napShort = await napReg.dispatch({ id: 'n1', name: 'nap', args: {} }, napCtx);
      const napLong = await napReg.dispatch({ id: 'n2', name: 'nap', args: { long: true } }, napCtx);
      A.ok(napShort.isError && !napLong.isError && /woke/.test(String(napLong.content)), 'E0 the registry applies a per-call backstop: 0 falls back to the run\'s cap (timed out), a longer one lets the call finish');

      finishAfter.set('researcher', 1500);   // long enough that the plain list below still sees it running on a loaded CPU
      const handle = JSON.parse((await tools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} })).content)[0];
      const plain = await tool.run({}, { agentId: 'lead' });
      A.eq(JSON.parse(plain.content)[0].status, 'running', 'E1 without wait the list answers at once (unchanged behavior)');
      // wall-clock bounds sit far from the timeouts (shared-CPU gates run late): the wait NOTE is the proof, the clock a backstop
      const t0 = Date.now();
      const waited = await tool.run({ wait: true, timeoutMs: 60000 }, { agentId: 'lead' });
      const tookMs = Date.now() - t0;
      const rows = JSON.parse(String(waited.content).split('\n')[0]);
      A.eq(rows[0] && rows[0].status, 'done', 'E1 wait:true returns with the worker\'s new status');
      A.ok(tookMs < 30000, 'E1 ...as soon as it changed, not at the 60 s timeout (' + tookMs + 'ms)');
      A.ok(/\[wait: the worker list changed/.test(String(waited.content)), 'E1 ...and says the list changed (a status, a generation or a filtered row: never more than it saw): ' + String(waited.content).split('\n').slice(1).join(' '));

      const one = await tool.run({ id: handle.id, wait: true, timeoutMs: 2000 }, { agentId: 'lead' });
      A.ok(/nothing to wait for/.test(String(one.content)) && JSON.parse(String(one.content).split('\n')[0]).status === 'done', 'E2 waiting on a worker that already finished returns at once');

      finishAfter.set('slow', 60000);
      await tools.dispatchTool.run({ workers: [{ agentId: 'slow', prompt: 'y' }], background: true }, { agentId: 'lead', emit: () => {} });
      const t1 = Date.now();
      const timedOut = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 400 }, { agentId: 'lead' });
      const tookTimeout = Date.now() - t1;
      A.ok(tookTimeout >= 350 && tookTimeout < 30000, 'E3 an unchanged worker returns at the bounded timeout, never at its 60 s finish (' + tookTimeout + 'ms)');
      A.ok(!timedOut.isError && /still running/.test(String(timedOut.content)) && /not an error/.test(String(timedOut.content)), 'E3 a timeout is an answer, not an error');

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      const t2 = Date.now();
      const cut = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 50000 }, { agentId: 'lead', signal: ac.signal });
      A.ok(Date.now() - t2 < 30000 && /cancelled/.test(String(cut.content)), 'E4 a cancelled run stops the wait at once, not at its 50 s timeout');

      // E5. a Commander's note posted to the REAL steer buffer mid-wait stops the wait, and stays for the loop to fold
      let posted = null;
      setTimeout(() => { posted = steer.post(LEAD_RUN, 'wrap up with what you have', true); }, 150);
      const t3 = Date.now();
      const noted = await tool.run({ agentId: 'slow', wait: true, timeoutMs: 50000 }, { agentId: 'lead' });
      A.ok(posted && posted.status === 200, 'E5 the steer buffer accepted the note for the live run');
      A.ok(Date.now() - t3 < 30000 && /a note for this run is waiting to be read/.test(String(noted.content)), 'E5 a note posted mid-wait stops the wait (the loop folds it next): ' + String(noted.content).split('\n').slice(1).join(' '));
      A.eq(steer.drain(LEAD_RUN), ['wrap up with what you have'], 'E5 ...the wait only looked: the note is still there for the loop to read');
      // E6. ...and the station wires THIS run's buffer into the tool (index.js; a worker's own generation-bound steer is not it).
      // Read through the source helper (source-helper.test H5: no test reads index.js as text directly); the wiring line is
      // unique, so the joined sidecar source finds it wherever runOnceCore lives.
      const sidecarSrc = require('./helpers/source.js').readSidecarSource();
      A.ok(sidecarSrc.indexOf("steerPending: () => (typeof o.steer === 'function' ? 0 : steerBufs.pending(runId)),") >= 0, 'E6 the station hands team.subagents the run\'s own steer buffer (steerBufs.pending(runId))');
      subagents.interruptAll('lead');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('loop-truth.invariant');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
