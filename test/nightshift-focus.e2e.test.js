/* node test/nightshift-focus.e2e.test.js — real sidecar proof for NS-5b (single-priority nights + project patch).

   Boots the ACTUAL sidecar with a mock OpenRouter, PRE-BLESSES a real git repo (with a planted TODO + a fixable
   bug) as a project root, seeds a HOT dossier + the away grant + reach 'sandbox', and drives the night shift the
   way it runs unattended (force-fired via POST /api/nightshift/beat). Proves the "Done means" bar:

     · FOCUS DECLARED — the first beat resolves ONE focus = the freshly-touched blessed project, and it cites the
       evidence that produced it (truthful telemetry). GET /api/nightshift/status carries the focus.
     · LEDGER — a 'focus' note records the declared priority (the beat's relation to it is in its outcome record).
     · PROJECT PATCH — the reach-gated build reads the repo (harness scan) and lands a .patch deliverable in /pending.
     · KEEP APPLIES TO A NEW BRANCH — decide keep git-applies the patch onto ns/<date>-<slug>, commits, NEVER main,
       NEVER push. Verified with git in the seeded repo (branch exists, HEAD is the night-shift commit, file changed).
     · DISCARD DENYLISTS — decide discard wipes + denylists so it isn't rebuilt.
     · STEER — POST /api/nightshift/focus sets a durable steer the status then reports as steer-sourced. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const ACT_MARK = '[NIGHTSHIFT_ACT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the file planted in the repo (committed) + the patch the night shift "authors" to fix its TODO.
const APP_JS = [
  'function total(items) {',
  '  // TODO: handle empty invoice list',
  '  return items.reduce((a, b) => a + b, 0);',
  '}',
  'module.exports = { total };',
  ''
].join('\n');
const PATCH = [
  'diff --git a/app.js b/app.js',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1,4 +1,4 @@',
  ' function total(items) {',
  '-  // TODO: handle empty invoice list',
  '+  if (!items || !items.length) return 0;',
  '   return items.reduce((a, b) => a + b, 0);',
  ' }',
  ''
].join('\n');

function git(repo, args) { return execFileSync('git', ['-C', repo].concat(args), { encoding: 'utf8' }).trim(); }

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ns5b-repo-')));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.local']); git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgsign', 'false']); git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'app.js'), APP_JS);
  git(repo, ['add', 'app.js']); git(repo, ['commit', '-q', '-m', 'seed app']);
  return repo;
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const prompt = String(((msgs.find(m => m && m.role === 'user')) || {}).content || '');
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };

          if (prompt.indexOf(ACT_MARK) === 0) {
            const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
            const dir = 'workshop/' + runId;
            // pull the exact targetRoot the DO directive embedded (proves the harness passed the blessed root through).
            const targetRoot = (prompt.match(/"targetRoot":"([^"]+)"/) || prompt.match(/repo root ([^\s\n]+)/) || [])[1] || '';
            if (toolResults === 0) tool('p', 'fs_write', { path: dir + '/change.patch', content: PATCH });
            else if (toolResults === 1) tool('m', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify({ v: 1, runId, agentId: 'agent', backlogId: '', title: 'fix empty invoice list', kind: 'patch', targetRoot: targetRoot, summary: 'Guard total() against an empty invoice list (the planted TODO).', files: [{ path: 'change.patch', bytes: PATCH.length }], howToUse: 'Apply to a new branch.', notVerified: ['not run'] }) });
            else text('Wrote the patch.');
          } else if (/JOB:/.test(prompt) && /GROUNDS:/.test(prompt)) {
            // the PROPOSE: a build job grounded in the REAL repo state (the planted TODO, surfaced by the harness scan).
            // PRIOR WORK (2026-10-05): once the fix was kept, the prompt lists it as ALREADY BUILT and a plain rebuild is
            // vetoed by the host — so the mock follows the no-rebuild rule and asks to CONTINUE it (an explicit
            // continuation of kept work is honored, and still exercises the honest-failure keep below).
            const already = /ALREADY BUILT ON EARLIER NIGHTS[\s\S]*"fix empty invoice list"/.test(prompt);
            text([already ? 'JOB: Continue: fix empty invoice list' : 'JOB: fix empty invoice list', 'KIND: advance-goal', 'GROUNDS: the TODO in app.js — handle empty invoice list', 'CONFIDENCE: high', 'SPEC: a git-apply-able patch that guards total() against an empty list'].join('\n'));
          } else { text('ok'); }
          res.write('data: [DONE]\n\n'); res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}
async function fireBeat(B, headers) {
  const res = await fetch(B + '/api/nightshift/beat', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent' }) });
  return ((await readNdjson(res)).find(e => e.name === 'nightshift.beat.result') || {}).payload || {};
}
function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the invoice tooling'), pain: b('empty-list crashes bite me'), stack: b('node'), ambition: b('a solid billing lib') } };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch (_) { clearTimeout(timer); resolve(); }
  });
}

(async () => {
  const mock = await startMock();
  const repo = makeRepo();
  const unblessed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ns5b-unblessed-')));
  const revoked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ns5b-revoked-')));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ns5b-ws-'));
  // PRE-BLESS the repo: seed the durable allowlist (path:<repo>) + the known-projects metadata (fresh lastTouchedAt).
  const now = Date.now();
  fs.writeFileSync(path.join(ws, 'permissions.allow.json'), JSON.stringify({ allow: ['path:' + repo], meta: { ['path:' + repo]: { grantedAt: now } } }));
  fs.writeFileSync(path.join(ws, 'projects.json'), JSON.stringify({ version: 1, projects: [
    { root: repo, displayPath: repo, grantedAt: now, lastTouchedAt: now, isGitRepo: true },
    { root: revoked, displayPath: revoked, grantedAt: now - 1000, lastTouchedAt: now - 1000, isGitRepo: false }
  ] }));
  fs.writeFileSync(path.join(ws, '_commander.goals.json'), JSON.stringify({ goal: { text: 'launch billing beta', done: 1, total: 3, next: 'finish export' } }));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-ns5b-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const started = await boot(8970 + (process.pid % 25), env, 20);
  let child = started.child;
  const port = started.port;
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', on: true }) });
    await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 12 }, beliefs: hotBeliefs(now) }) });

    // ===== 1. FIRST BEAT declares the focus + builds a patch deliverable =====
    const act = await fireBeat(B, headers);
    A.ok(act.delivered === true && act.reason === 'built', 'the reach-gated beat built a real deliverable (delivered, built) — got ' + JSON.stringify(act.reason));
    const runId = act.runId; A.ok(runId, 'the beat returned a runId');

    // FOCUS DECLARED + CITED (truthful telemetry) — visible on the status route the morning report leads with.
    const status = await (await fetch(B + '/api/nightshift/status', { headers })).json();
    A.ok(status.focus && status.focus.kind === 'project', 'a PROJECT focus was declared for the night');
    A.eq(status.focus.ref, repo, 'the focus is the blessed repo (single priority)');
    A.ok(Array.isArray(status.focus.why) && status.focus.why.length > 0, 'the declared focus carries cited evidence (never an unexplained pick)');

    // LEDGER: a 'focus' note recorded the declared priority.
    const led = await (await fetch(B + '/api/autonomy/ledger?source=nightshift&limit=200', { headers })).json();
    const focusNote = (led.entries || []).find(e => e && e.reason === 'focus' && e.detail && e.detail.ref === repo);
    A.ok(focusNote, 'the autonomy ledger recorded the FOCUS declaration (priority + why)');

    // AUTHORITY: malformed or stale references are rejected without mutating the current durable focus.
    const beforeInvalid = await (await fetch(B + '/api/nightshift/focus', { headers })).json();
    const beforeSerialized = JSON.stringify(beforeInvalid);
    const invalidCases = [
      [{ ref: path.join(ws, 'missing-project'), kind: 'project' }, 'a missing project path'],
      [{ ref: unblessed, kind: 'project' }, 'an existing but unblessed project'],
      [{ ref: revoked, kind: 'project' }, 'a revoked project'],
      [{ ref: 'th_missing', kind: 'thread' }, 'a missing thread'],
      [{ ref: 'goal', kind: 'bogus' }, 'an unknown kind'],
      [{ ref: 'stale-goal-name', kind: 'goal' }, 'a stale/noncanonical goal ref']
    ];
    for (const [body, label] of invalidCases) {
      const response = await fetch(B + '/api/nightshift/focus', { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json();
      A.ok(response.status >= 400 && response.status < 500 && payload.ok === false && payload.error, label + ' is rejected with an actionable 4xx');
      const after = await (await fetch(B + '/api/nightshift/focus', { headers })).json();
      A.eq(JSON.stringify(after), beforeSerialized, label + ' does not mutate focus or steer state');
    }
    await fetch(B + '/api/goals', { method: 'POST', headers, body: JSON.stringify({ goal: null }) });
    const missingGoalResponse = await fetch(B + '/api/nightshift/focus', { method: 'POST', headers, body: JSON.stringify({ ref: 'goal', kind: 'goal' }) });
    const missingGoalPayload = await missingGoalResponse.json();
    A.ok(missingGoalResponse.status === 404 && missingGoalPayload.ok === false, 'a cleared/stale goal is rejected against current goal truth');
    const afterMissingGoal = await (await fetch(B + '/api/nightshift/focus', { headers })).json();
    A.eq(JSON.stringify(afterMissingGoal), beforeSerialized, 'a cleared/stale goal rejection does not mutate focus or steer state');
    await fetch(B + '/api/goals', { method: 'POST', headers, body: JSON.stringify({ goal: { text: 'launch billing beta', done: 1, total: 3, next: 'finish export' } }) });

    // PROJECT PATCH landed in /pending as a patch-kind deliverable.
    const pend = await (await fetch(B + '/api/workshop/pending?agent=agent', { headers })).json();
    const man = (pend.pending || []).find(m => m.runId === runId);
    A.ok(man && man.kind === 'patch', 'the deliverable in /pending is a PATCH (project work, not a greenfield file)');
    A.ok(fs.existsSync(path.join(ws, 'agent', 'workshop', runId, 'change.patch')), 'the .patch file is really on disk in the jail');

    // ===== 2. KEEP APPLIES THE PATCH TO A NEW BRANCH (never main, never push) =====
    const beforeBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const keep = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', runId, decision: 'keep' }) })).json();
    A.ok(keep.ok === true && keep.applied === true, 'KEEP applied the patch (applied:true) — got ' + JSON.stringify(keep));
    A.ok(/^ns\//.test(String(keep.branch || '')), 'the patch landed on an ns/ branch: ' + keep.branch);
    // verify with GIT itself (not the app's word): the branch exists, HEAD is the night-shift commit, the file changed.
    const branches = git(repo, ['branch', '--list', 'ns/*']);
    A.ok(branches.indexOf(keep.branch.replace('ns/', '')) >= 0 || branches.length > 0, 'git shows the new ns/ branch exists');
    A.eq(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), keep.branch, 'HEAD is now on the ns/ branch (never committed onto ' + beforeBranch + ')');
    A.ok(/^autonomy:/.test(git(repo, ['log', '-1', '--pretty=%s'])), 'the branch tip is the autonomy patch commit (one word: autonomy)');
    A.ok(fs.readFileSync(path.join(repo, 'app.js'), 'utf8').indexOf('if (!items || !items.length) return 0;') >= 0, 'the planted bug is actually fixed in the working tree');
    // the original branch was NOT mutated: it still has the seed commit only.
    A.eq(git(repo, ['log', beforeBranch, '--pretty=%s']).split('\n').length, 1, 'the original branch (' + beforeBranch + ') was never touched — still one commit');

    // ===== 3. HONEST FAILURE — a patch that does not apply is reported as NOT applied (never a false "applied") =====
    // (the working tree is now dirty-free on ns/ but the seed file already changed; a second identical patch won't
    //  apply cleanly. Build a fresh beat, then keep — the apply must fail HONESTLY, not lie.)
    const act2 = await fireBeat(B, headers);
    A.ok(act2.reason === 'built' && act2.runId, 'the second beat built (an explicit continuation of the kept fix, not a vetoed rebuild): ' + act2.reason);
    A.eq(act2.continuesRunId, runId, 'the continuation names the kept build it continues');
    A.ok(fs.existsSync(path.join(ws, 'agent', 'workshop', String(act2.runId), 'change.patch')), 'the continuation started from the earlier build\'s files');
    if (act2.reason === 'built' && act2.runId) {
      const keep2 = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', runId: act2.runId, decision: 'keep' }) })).json();
      A.ok(keep2.applied !== true, 'a non-applying / dirty-tree keep reports applied:false (honest failure, never a false apply)');
      A.ok(String(keep2.error || '').length > 0, 'and it names the honest reason: ' + (keep2.error || '').split('\n')[0]);
      // ===== 4. DISCARD denylists =====
      const disc = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', runId: act2.runId, decision: 'discard' }) })).json();
      A.ok(disc.ok === true && disc.decision === 'discard', 'DISCARD accepted (denylists the backlog item)');
      A.ok(!fs.existsSync(path.join(ws, 'agent', 'workshop', act2.runId)), 'DISCARD wiped the run dir');
    }

    // ===== 5. STEER — a durable "focus on Y" outranks derived evidence and is reported as steer-sourced =====
    const steerRes = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers, body: JSON.stringify({ ref: repo, kind: 'project' }) })).json();
    A.ok(steerRes.ok === true && steerRes.focus && steerRes.focus.source === 'steer', 'POST /api/nightshift/focus sets a durable steer the focus reports as steer-sourced');
    const goalSteer = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers, body: JSON.stringify({ ref: 'goal', kind: 'goal' }) })).json();
    A.ok(goalSteer.ok === true && goalSteer.focus && goalSteer.focus.kind === 'goal', 'the current real goal is accepted as a steer');
    const clr = await (await fetch(B + '/api/nightshift/focus', { method: 'DELETE', headers })).json();
    A.ok(clr.ok === true && clr.cleared === true, 'DELETE clears the steer');
    A.ok(!clr.focus || clr.focus.source !== 'steer', 'DELETE never returns the cleared steer-derived cached focus');
    A.ok(!clr.focus || JSON.stringify(clr.focus.why || []).indexOf('you asked me to focus on') < 0, 'DELETE hides the old steer reason immediately');

    // ===== 6. FOCUS PERSISTS ACROSS A RESTART (single-focus-per-night is durable) =====
    A.ok(fs.existsSync(path.join(ws, 'nightfocus.state.json')), 'the focus state persisted to disk (survives a restart mid-night)');
    const savedFocus = JSON.parse(fs.readFileSync(path.join(ws, 'nightfocus.state.json'), 'utf8'));
    A.eq(savedFocus.focus && savedFocus.focus.ref, repo, 'the persisted focus is the repo (a restart resumes the same night, not a re-scatter)');
    await stop(child);
    fs.writeFileSync(path.join(ws, 'threads.json'), JSON.stringify({ v: 1, threads: [
      { id: 'th_open', title: 'ship the invoice export', spec: 'finish the real export', state: 'open', createdAt: now - 2000, updatedAt: now - 2000 },
      { id: 'th_picked', title: 'polish the billing report', spec: 'continue picked work', state: 'picked', createdAt: now - 3000, updatedAt: now - 1000 }
    ], declined: [] }));
    const restarted = await boot(port, env, 0);
    child = restarted.child;
    const token2 = await bootToken(B, B);
    const headers2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token2, Origin: B };
    const afterRestart = await (await fetch(B + '/api/nightshift/focus', { headers: headers2 })).json();
    A.eq(afterRestart.steer, null, 'the cleared steer remains cleared after a real sidecar restart');
    A.eq(afterRestart.focus && afterRestart.focus.ref, repo, 'restart preserves only the valid post-clear derived focus');
    A.ok(afterRestart.focus && afterRestart.focus.source === 'evidence', 'restart cannot resurrect a steer-derived focus');

    const pickedSteer = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers: headers2, body: JSON.stringify({ ref: 'th_picked', kind: 'thread' }) })).json();
    A.ok(pickedSteer.ok === true && pickedSteer.focus && pickedSteer.focus.ref === 'th_picked', 'a real picked thread is accepted as a steer');
    const openSteer = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers: headers2, body: JSON.stringify({ ref: 'th_open', kind: 'thread' }) })).json();
    A.ok(openSteer.ok === true && openSteer.focus && openSteer.focus.ref === 'th_open', 'a real open thread is accepted as a steer');
    const clearThread = await (await fetch(B + '/api/nightshift/focus', { method: 'DELETE', headers: headers2 })).json();
    A.ok(clearThread.ok === true && (!clearThread.focus || clearThread.focus.source !== 'steer'), 'clearing a thread steer immediately returns derived evidence or null');
    await stop(child);
    const restartedAgain = await boot(port, env, 0);
    child = restartedAgain.child;
    const token3 = await bootToken(B, B);
    const headers3 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token3, Origin: B };
    const afterThreadRestart = await (await fetch(B + '/api/nightshift/focus', { headers: headers3 })).json();
    A.eq(afterThreadRestart.steer, null, 'a cleared thread steer stays cleared through restart');
    A.ok(!afterThreadRestart.focus || afterThreadRestart.focus.source !== 'steer', 'restart preserves only fresh derived focus/null after thread clear');

    // Durable user directives fail closed: neither clearing focus nor adding an off-limits boundary may become
    // a session-only success when the atomic rename target is unwritable.
    const durableGoal = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers: headers3, body: JSON.stringify({ ref: 'goal', kind: 'goal' }) })).json();
    A.ok(durableGoal.ok === true && durableGoal.focus && durableGoal.focus.ref === 'goal', 'precondition: a goal steer is durably selected');
    const focusFile = path.join(ws, 'nightfocus.state.json');
    const focusBytes = fs.readFileSync(focusFile);
    fs.rmSync(focusFile);
    fs.mkdirSync(focusFile);
    const failedClearResponse = await fetch(B + '/api/nightshift/focus', { method: 'DELETE', headers: headers3 });
    const failedClear = await failedClearResponse.json();
    A.eq(failedClearResponse.status, 507, 'an unwritable focus store refuses to acknowledge clearing a steer');
    A.eq(failedClear.ok, false, 'the failed clear is explicitly reported as unsuccessful');
    const failedAvoidResponse = await fetch(B + '/api/nightshift/avoid', { method: 'POST', headers: headers3, body: JSON.stringify({ ref: 'goal', kind: 'goal' }) });
    const failedAvoid = await failedAvoidResponse.json();
    A.eq(failedAvoidResponse.status, 507, 'an unwritable focus store refuses to acknowledge an off-limits directive');
    A.eq(failedAvoid.ok, false, 'the failed off-limits mutation is explicitly reported as unsuccessful');
    const stillInRam = await (await fetch(B + '/api/nightshift/focus', { headers: headers3 })).json();
    A.eq(stillInRam.steer && stillInRam.steer.ref, 'goal', 'failed mutations leave the last proven steer in process memory');
    A.ok(!(stillInRam.avoid || []).some(e => e && e.ref === 'goal'), 'failed off-limits mutation is not exposed from process memory');
    fs.rmSync(focusFile, { recursive: true });
    fs.writeFileSync(focusFile, focusBytes);
    await stop(child);
    const restartedAfterWriteFailure = await boot(port, env, 0);
    child = restartedAfterWriteFailure.child;
    const token4 = await bootToken(B, B);
    const headers4 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token4, Origin: B };
    const afterWriteFailureRestart = await (await fetch(B + '/api/nightshift/focus', { headers: headers4 })).json();
    A.eq(afterWriteFailureRestart.steer && afterWriteFailureRestart.steer.ref, 'goal', 'restart preserves the last proven steer after failed writes');
    A.ok(!(afterWriteFailureRestart.avoid || []).some(e => e && e.ref === 'goal'), 'restart confirms the failed off-limits directive never became durable');

    const projectAgain = await (await fetch(B + '/api/nightshift/focus', { method: 'POST', headers: headers4, body: JSON.stringify({ ref: repo, kind: 'project' }) })).json();
    A.ok(projectAgain.ok === true && projectAgain.focus && projectAgain.focus.ref === repo, 'precondition: the blessed project can be selected before revocation');
    const revoke = await (await fetch(B + '/api/permissions/revoke', { method: 'POST', headers: headers4, body: JSON.stringify({ key: 'path:' + repo }) })).json();
    A.ok(revoke.ok === true, 'the project standing grant is revoked through the real authority route');
    const afterRevoke = await (await fetch(B + '/api/nightshift/focus', { headers: headers4 })).json();
    A.eq(afterRevoke.steer, null, 'revoking a selected project retires its durable steer');
    A.ok(!afterRevoke.focus || afterRevoke.focus.ref !== repo, 'focus read never advertises the now-unavailable project');
    const statusAfterRevoke = await (await fetch(B + '/api/nightshift/status', { headers: headers4 })).json();
    A.ok(!statusAfterRevoke.focus || statusAfterRevoke.focus.ref !== repo, 'night-shift status never advertises the now-unavailable project');
  } finally {
    await stop(child);
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(unblessed, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(revoked, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-focus.e2e.test');
})().catch(e => { console.log('FAIL: nightshift-focus.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
