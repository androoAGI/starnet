/* node test/loops-check.e2e.test.js — LIVE proof of the LOOP's host-run check (standing objectives, S2).

   The pure verdict logic is proven headlessly in test/loopjob-check.test.js. What can ONLY be proven live is
   the part that touches the machine:

     · the host really spawns the human-authored command at the real blessed project root
     · a real non-zero exit lands the iteration as 'red' — NOT as a review item, and NOT as an error
     · the real failure output reaches the NEXT iteration's prompt (the feedback loop)
     · a real edit to a real test file is detected as tampering and forced in front of a human
     · a real trusted green completes the loop as 'done'
     · an unblessed root is refused and the check is NOT run

   It builds a genuine throwaway git repo on disk with a genuine check script, and drives a real sidecar. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function gitSyncRetry(repo, args, attempts) {
  const max = attempts || 40;
  for (let i = 0; i < max; i++) {
    try { return execFileSync('git', ['-C', repo].concat(args), { stdio: 'pipe' }); }
    catch (e) {
      const detail = String((e && e.stderr) || '') + String((e && e.stdout) || '') + String((e && e.message) || '');
      if (!/index\.lock|another git process/i.test(detail) || i === max - 1) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function startMock(defaultReply) {
  const prompts = [], script = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          try {
            const p = JSON.parse(body);
            prompts.push((p.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n'));
          } catch (_) { prompts.push(''); }
          const reply = script.length ? script.shift() : defaultReply;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + '\n\n');
          res.write('data: [DONE]\n\n'); res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, prompts, script, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

async function until(B, headers, pred, label, ms) {
  const deadline = Date.now() + (ms || 60000);
  let last = null;
  while (Date.now() < deadline) {
    last = await (await fetch(B + '/api/loops', { headers })).json();
    if (pred(last)) return last;
    await sleep(250);
  }
  A.ok(false, 'timed out waiting for: ' + label + ' — last ' + JSON.stringify(last && last.loops && last.loops[0] && {
    state: last.loops[0].state, n: last.loops[0].iterationCount, recent: last.loops[0].recent
  }));
  return last;
}

/* a REAL throwaway git repo with a REAL check script. `check.js` exits non-zero until `fixed.txt` exists —
   so "make the check pass" is a genuine, machine-verifiable objective. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopproj-'));
  fs.writeFileSync(path.join(root, 'check.js'),
    "const fs=require('fs');\nif(fs.existsSync(__dirname+'/fixed.txt')){console.log('1 passing');process.exit(0);}\nconsole.log('1 failing — fixed.txt is missing');process.exit(1);\n");
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'thing.test.js'), '// a test file the loop must not touch\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
  const git = (args) => execFileSync('git', ['-C', root].concat(args), { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'loop@test.local']);
  git(['config', 'user.name', 'loop test']);
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  return root;
}

(async () => {
  const mock = await startMock('I looked at the failure and tried something.');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopchk-'));
  const repo = makeRepo();
  const env = {
    SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-check-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_LOOP_TICK_MS: '1000', SKYNET_FULL_ACCESS: '1'
  };
  let child, port;
  try {
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const mk = (body) => fetch(B + '/api/loops', { method: 'POST', headers, body: JSON.stringify(body) });

    /* ---- an UNBLESSED root: the loop must stand down BEFORE it spends -----------------------------------
       A dogfood run burned three passes and $0.33 against a folder whose grant did not match, because the
       loop fired first and only discovered the problem inside the model call. Nothing a model can do fixes a
       missing folder approval, so the refusal belongs in the precheck — where it is FREE and names the folder. */
    {
      const r = await mk({ name: 'unblessed', objective: 'make the check pass', workdir: repo, checkCmd: 'node check.js', exitOn: 'check-green' });
      A.eq(r.status, 200, 'the loop is created (the folder exists)');
      const id = (await r.json()).loop.id;
      const st = await until(B, headers, s => (s.loops.find(l => l.id === id) || {}).binding === 'precheck',
        'the loop to stand down on an unblessed root');
      const l = st.loops.find(x => x.id === id);
      A.eq(l.iterationCount, 0, 'NOT ONE pass was spent on a folder the station has not approved');
      A.eq(l.binding, 'precheck', 'and the gate names the reason');
      A.ok(/not approved/i.test(l.bindingDetail || ''), 'in words that say what is wrong: ' + l.bindingDetail);
      A.ok((l.bindingDetail || '').indexOf('dogfood') >= 0 || /re-approve/.test(l.bindingDetail || ''),
        'and what to do about it');
      A.ok(l.state !== 'done', 'so it cannot complete the objective');
      A.eq(l.lastCheck, null, 'and no check verdict is invented for a pass that never ran');
      await fetch(B + '/api/loops/remove', { method: 'POST', headers, body: JSON.stringify({ id }) });
    }

    // ---- bless the project, the way the real UI does -----------------------------------------------------
    const bless = await fetch(B + '/api/projects/bless', { method: 'POST', headers, body: JSON.stringify({ path: repo, surface: 'interactive' }) });
    A.eq(bless.status, 200, 'the project blessed');
    A.eq((await bless.json()).ok, true, 'and reports ok');

    // ---- a REAL red check: the host spawned the real command at the real root ----------------------------
    const created = await mk({
      name: 'make it pass', objective: 'make the project check pass', workdir: repo,
      checkCmd: 'node check.js', exitOn: 'check-green', queueCap: 3, redStopAfter: 20,
      model: 'test/model', provider: 'openrouter'
    });
    A.eq(created.status, 200, 'the build-test-verify loop was created');
    const loopId = (await created.json()).loop.id;
    const L = (s) => s.loops.find(x => x.id === loopId);

    let st = await until(B, headers, s => L(s) && L(s).iterationCount >= 1 && L(s).lastCheck, 'the first real check');
    let chk = L(st).lastCheck;
    A.eq(chk.passed, false, 'the REAL check ran and really failed');
    A.ok(/1 failing/.test(chk.summary), 'the real stdout came back: ' + chk.summary);
    A.eq(chk.gitProven, true, 'a real git repo means the changed-file list is provable');
    A.eq(chk.tampered, false, 'and nothing was tampered with');
    A.eq(L(st).recent[0].outcome, 'red', 'a red check lands the iteration RED');
    A.eq(L(st).pendingCount, 0, 'and it is NOT put in front of the Commander — you are never asked to approve broken work');
    A.ok(L(st).redStreak >= 1, 'the red streak is tracking');
    A.ok(L(st).state !== 'done', 'and the objective is not met');

    // ---- the REAL failure output reaches the NEXT prompt (the feedback loop) ------------------------------
    // read the LOOP's own prompts only — the sidecar makes internal model calls (session titling, quest
    // refresh) against the same mock, and one of those would otherwise be mistaken for the iteration.
    const OBJ = 'make the project check pass';
    const loopPrompts = () => mock.prompts.filter(p => p.indexOf(OBJ) >= 0);
    // Wait for a prompt that actually CARRIES the red-check block, not merely for a second iteration to
    // start. Pass 2 can be dispatched before pass 1's check verdict lands in the ledger, so the digest would
    // not have the failure in it yet — that race made this flaky. Wait on the thing being asserted.
    await until(B, headers, () => loopPrompts().some(p => /FAILED THE PROJECT'S OWN CHECK/.test(p)),
      'a prompt carrying the red-check feedback');
    const lastPrompt = loopPrompts().filter(p => /FAILED THE PROJECT'S OWN CHECK/.test(p)).pop() || '';
    A.ok(/FAILED THE PROJECT'S OWN CHECK/.test(lastPrompt), 'the next iteration is told its work failed the check');
    A.ok(/1 failing/.test(lastPrompt), 'and is handed the REAL failure output, not a generic retry');
    A.ok(/does NOT count as passing/.test(lastPrompt), 'and is told editing the tests will not work');

    // ---- TAMPERING, for real: edit a real test file on disk mid-loop --------------------------------------
    await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: loopId, action: 'pause' }) });
    fs.writeFileSync(path.join(repo, 'test', 'thing.test.js'), '// weakened\n');
    fs.writeFileSync(path.join(repo, 'fixed.txt'), 'ok\n');       // ALSO make the check genuinely green
    const nBefore = L(await (await fetch(B + '/api/loops', { headers })).json()).iterationCount;
    await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: loopId, action: 'resume' }) });

    st = await until(B, headers, s => L(s).iterationCount > nBefore && L(s).lastCheck && L(s).lastCheck.passed, 'a green check over a tampered test file');
    chk = L(st).lastCheck;
    A.eq(chk.passed, true, 'the check genuinely passes now');
    A.eq(chk.tampered, true, 'BUT the loop detected that a test file changed');
    A.ok((chk.tamperedPaths || []).some(p => /thing\.test\.js/.test(p)), 'and names the real file: ' + JSON.stringify(chk.tamperedPaths));
    A.eq(chk.trusted, false, 'so the green is NOT trusted');
    A.ok(L(st).state !== 'done', 'and a tampered green CANNOT complete the objective');
    A.eq(L(st).pendingCount >= 1, true, 'it is forced in front of a human instead');

    // ---- a clean, trusted green completes the loop as DONE -------------------------------------------------
    /* commit the tampering away so the working tree is clean again, leaving a genuinely-passing check.
       TOLERANT OF AN ALREADY-CLEAN TREE ON PURPOSE (S3): the loop now COMMITS each iteration itself, so if a
       pass was in flight when this test dirtied the repo, the harvest has already committed these files and
       `git commit` exits non-zero with "nothing to commit". The precondition this line exists to establish is
       "the tree is clean", and both paths establish it — only an unexpected git failure should fail the test. */
    gitSyncRetry(repo, ['add', '-A']);
    try { gitSyncRetry(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'accept']); }
    catch (e) { /* nothing to commit — the harvest got there first */ }
    A.eq(gitSyncRetry(repo, ['status', '--porcelain']).toString().trim(), '',
      'the working tree is clean before the trusted-green run, however it got there');
    const fresh = await mk({
      name: 'already green', objective: 'keep the project check passing', workdir: repo,
      checkCmd: 'node check.js', exitOn: 'check-green', model: 'test/model', provider: 'openrouter'
    });
    const freshId = (await fresh.json()).loop.id;
    const F = (s) => s.loops.find(x => x.id === freshId);
    st = await until(B, headers, s => F(s) && F(s).state === 'done', 'a trusted green to complete the objective');
    A.eq(F(st).state, 'done', 'a clean green ENDS the loop');
    A.eq(F(st).lastCheck.trusted, true, 'because the check was proven untampered');
    A.ok(/objective met/.test(F(st).stopReason || ''), 'and says the objective was met, not "nothing left to do"');
    A.eq(F(st).binding, 'done', 'the gate binds as done');

    const callsAtDone = mock.prompts.length;
    await sleep(3000);
    A.eq(mock.prompts.length, callsAtDone, 'a completed loop spends NOTHING further');

  } finally {
    try { child && child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('loops check e2e (LIVE host-run check + tamper guard)');
})().catch(e => { console.log('FAIL: unexpected throw — ' + (e && e.stack || e)); process.exit(1); });
