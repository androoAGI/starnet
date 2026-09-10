/* node test/loops-git.e2e.test.js — LIVE proof that APPROVE and REJECT are real (standing objectives, S3).

   THE HOLE THIS PROVES CLOSED. Until S3 the review gate was bookkeeping: loopjob-driver's defaultHarvest
   reported `commit: null`, nothing injected a harvest, and POST /api/loops/verdict ran no git at all. So an
   iteration's edits piled up UNCOMMITTED in the Commander's project — approve promoted nothing, and REJECT
   left the rejected code exactly where the agent wrote it. The row said one thing, the working tree said
   another, which is the one failure this product does not tolerate.

   Only a live run can prove the git is real, so this drives a REAL sidecar against a REAL throwaway repo and
   asserts on the repo itself, never on the API's own account of it:

     · every iteration lands as a REAL COMMIT on the loop's OWN branch — never on main
     · the Commander's pre-existing uncommitted work is NOT swept into that commit
     · REJECT actually reverts the code, and cascades to the iterations stacked on top of it
     · the undo is a REVERT, not a reset — every original commit is still recoverable afterwards
     · a reject that cannot be performed safely is REFUSED, and the row is NOT marked rejected
     · files from an APPROVED iteration stay exactly where they are

   The mock provider writes a file into the repo as it answers, which is how an agent's edit is simulated
   deterministically: the write happens strictly inside the pass, so the harvest sees it as that pass's own. */
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* the mock provider. `onPrompt` runs BEFORE the reply is streamed, and this test uses it to write the
   "agent's" file into the project — the deterministic stand-in for a tool-using model editing real code.
   It reads through a mutable box so a later phase can swap in a different "agent". */
function startMock(box) {
  const onPrompt = (nth) => box.write(nth);
  let nth = 0;
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
          nth += 1;
          let reply = 'pass ' + nth;
          try { reply = onPrompt(nth) || reply; } catch (e) { reply = 'mock threw: ' + e.message; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

async function until(B, headers, pred, label, ms) {
  const deadline = Date.now() + (ms || 25000);
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

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopgit-')));
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), '// base\n');
  const git = (args) => execFileSync('git', ['-C', root].concat(args), { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'loop@test.local']);
  git(['config', 'user.name', 'loop test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return root;
}

(async () => {
  const repo = makeRepo();
  const git = (args) => execFileSync('git', ['-C', repo].concat(args), { stdio: 'pipe' }).toString();
  const baseHead = git(['rev-parse', 'HEAD']).trim();
  const baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  /* THE COMMANDER'S OWN UNCOMMITTED WORK, sitting in the tree before the loop ever runs. Nothing the loop
     does may fold this into a commit — it would then be reverted by a rejection the Commander thought
     applied only to the agent's work. */
  fs.writeFileSync(path.join(repo, 'MY-NOTES.txt'), 'my own unsaved work\n');

  // each pass writes one file, exactly as an agent editing the project would.
  const box = {
    write: (nth) => {
      fs.writeFileSync(path.join(repo, 'src', 'feature' + nth + '.js'), 'module.exports = ' + nth + ';\n');
      return 'I added feature ' + nth + '.';
    }
  };
  const mock = await startMock(box);

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopgitws-'));
  const env = {
    SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-git-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_LOOP_TICK_MS: '1000', SKYNET_FULL_ACCESS: '1'
  };
  let child, port;
  try {
    ({ child, port } = await boot(8980 + (process.pid % 15), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    const bless = await fetch(B + '/api/projects/bless', { method: 'POST', headers, body: JSON.stringify({ path: repo, surface: 'interactive' }) });
    A.eq(bless.status, 200, 'the project blessed');

    const created = await fetch(B + '/api/loops', {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'add features', objective: 'add one feature per pass', workdir: repo,
        queueCap: 3, exitOn: 'never', model: 'test/model', provider: 'openrouter'
      })
    });
    A.eq(created.status, 200, 'the loop is created');
    const id = (await created.json()).loop.id;

    // ---- 1. every pass is a REAL COMMIT on the loop's OWN branch ----------------------------------------
    const st = await until(B, headers, s => {
      const l = s.loops.find(x => x.id === id);
      return l && (l.recent || []).filter(i => i.outcome === 'candidate').length >= 2;
    }, 'two committed candidates');
    const loop = st.loops.find(x => x.id === id);
    const cands = (loop.recent || []).filter(i => i.outcome === 'candidate').sort((a, b) => a.n - b.n);
    A.ok(cands.length >= 2, 'the loop stacked at least two candidates');
    A.ok(/^[0-9a-f]{7,40}$/.test(String(cands[0].commit || '')), 'iteration #1 reports a real commit id, not null: ' + cands[0].commit);
    A.ok(/^[0-9a-f]{7,40}$/.test(String(cands[1].commit || '')), 'iteration #2 reports a real commit id: ' + cands[1].commit);
    A.ok(cands[0].commit !== cands[1].commit, 'each iteration is its own commit');

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    A.ok(/^loop\//.test(branch), 'the repo is on the loop-owned branch: ' + branch);
    A.ok(branch !== baseBranch, 'which is NOT the branch the Commander was on');
    A.eq(loop.branch, branch, 'and the loop record names the same branch the repo is actually on');
    A.eq(git(['rev-parse', baseBranch]).trim(), baseHead, 'the original branch was never moved');

    // the commits are real, and they say which iteration they were
    const log = git(['log', '--format=%s', baseHead + '..HEAD']);
    A.ok(/loop\(add-features\) #1:/.test(log), 'the commit subject names iteration #1 — ' + JSON.stringify(log));
    A.ok(/loop\(add-features\) #2:/.test(log), 'the commit subject names iteration #2');

    // ---- 2. the Commander's own uncommitted work was NOT swept in --------------------------------------
    const touched = git(['show', '--pretty=format:', '--name-only', cands[0].commit]);
    A.ok(/src\/feature1\.js/.test(touched), 'the commit contains the file that pass created — ' + JSON.stringify(touched));
    A.eq(/MY-NOTES\.txt/.test(touched), false, 'and NOT the Commander\'s own uncommitted file');
    A.ok(/MY-NOTES\.txt/.test(git(['status', '--porcelain'])), 'which is still sitting there, untracked and untouched');
    A.eq(fs.readFileSync(path.join(repo, 'MY-NOTES.txt'), 'utf8'), 'my own unsaved work\n', 'with its contents intact');

    // the agent's files really are committed, not just dirty
    A.eq(/src\/feature1\.js/.test(git(['status', '--porcelain'])), false, 'feature1.js is committed, not left dirty');
    A.eq(/src\/feature2\.js/.test(git(['status', '--porcelain'])), false, 'feature2.js is committed, not left dirty');

    // ---- 3. REJECT actually reverts the code, and cascades ----------------------------------------------
    A.ok(fs.existsSync(path.join(repo, 'src', 'feature1.js')), 'feature1.js exists before the rejection');
    A.ok(fs.existsSync(path.join(repo, 'src', 'feature2.js')), 'feature2.js exists before the rejection');

    const rejecting = fetch(B + '/api/loops/verdict', {
      method: 'POST', headers,
      body: JSON.stringify({ id, n: cands[0].n, verdict: 'rejected', note: 'wrong approach' })
    });
    await sleep(25);
    const competing = await fetch(B + '/api/loops/verdict', { method: 'POST', headers,
      body: JSON.stringify({ id, n: cands[1].n, verdict: 'approved' }) });
    A.eq(competing.status, 409, 'approval of a stacked candidate cannot race an in-flight rejection');
    const rej = await rejecting;
    A.eq(rej.status, 200, 'the rejection is accepted');
    const rejBody = await rej.json();
    A.eq(rejBody.undone.sort((a, b) => a - b), [cands[0].n, cands[1].n], 'it reports undoing the rejected pass AND the one stacked on it');
    A.ok(/^[0-9a-f]{7,40}$/.test(String(rejBody.undoCommit || '')), 'and names the commit that undid them: ' + rejBody.undoCommit);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR: the code is gone from the working tree.
    A.eq(fs.existsSync(path.join(repo, 'src', 'feature1.js')), false, 'REJECT REALLY REMOVED THE CODE — feature1.js is gone from the tree');
    A.eq(fs.existsSync(path.join(repo, 'src', 'feature2.js')), false, 'and the cascaded iteration\'s file is gone too');
    A.eq(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), '// base\n', 'the pre-existing file is untouched');
    A.eq(fs.readFileSync(path.join(repo, 'MY-NOTES.txt'), 'utf8'), 'my own unsaved work\n', 'and the Commander\'s uncommitted work survived the undo');

    // REVERT, NOT RESET — the original commits are all still reachable, so a mis-click is recoverable.
    A.ok(git(['cat-file', '-t', cands[0].commit]).trim() === 'commit', 'the rejected commit still exists (revert, never reset)');
    // The live loop can commit another candidate between these reads. Inspect the exact undo receipt.
    A.ok(/loop: undo rejected #/.test(git(['log', '--format=%s', '-1', rejBody.undoCommit])), 'and the undo is itself a readable commit');
    A.ok(git(['show', '--pretty=format:', '--name-only', rejBody.undoCommit]).indexOf('feature1.js') >= 0, 'the undo commit records what it removed');

    // the row and the tree now agree
    const after = await (await fetch(B + '/api/loops', { headers })).json();
    const l2 = after.loops.find(x => x.id === id);
    const it1 = (l2.recent || []).find(i => i.n === cands[0].n);
    const it2 = (l2.recent || []).find(i => i.n === cands[1].n);
    A.eq(it1.verdict, 'rejected', 'the rejected iteration is recorded rejected');
    A.eq(it2.verdict, 'discarded', 'and the stacked one is discarded — the STACKING LAW, now enforced in git too');

    // ---- 4. an unsafe reject is REFUSED, and the row is not touched -------------------------------------
    const st3 = await until(B, headers, s => {
      const l = s.loops.find(x => x.id === id);
      return l && (l.recent || []).filter(i => i.outcome === 'candidate' && !i.verdict).length >= 1;
    }, 'a fresh candidate after the rejection');
    const fresh = (st3.loops.find(x => x.id === id).recent || []).filter(i => i.outcome === 'candidate' && !i.verdict).sort((a, b) => a.n - b.n)[0];
    A.ok(fresh && fresh.commit, 'the loop kept working after the rejection and committed again');

    /* PAUSE FIRST. The next two phases assert on an uncommitted edit, and a live loop would commit it out
       from under them on its next pass — the harvest cannot tell that edit from the agent's. Pausing makes
       this deterministic instead of a race against the tick. */
    await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id, action: 'pause' }) });
    await sleep(1200);

    // dirty exactly the file that iteration committed — undoing it would clobber unsaved edits.
    const clashPath = git(['show', '--pretty=format:', '--name-only', fresh.commit]).split('\n').map(s => s.trim()).filter(Boolean)[0];
    fs.writeFileSync(path.join(repo, clashPath), 'MY LOCAL EDIT\n');
    const refused = await fetch(B + '/api/loops/verdict', {
      method: 'POST', headers, body: JSON.stringify({ id, n: fresh.n, verdict: 'rejected' })
    });
    A.eq(refused.status, 409, 'a reject that would overwrite unsaved edits is REFUSED, not performed');
    const refusedBody = await refused.json();
    A.ok(/uncommitted edits/.test(refusedBody.error || ''), 'and it says exactly why: ' + refusedBody.error);
    A.ok((refusedBody.error || '').indexOf(clashPath) >= 0, 'naming the file in the way: ' + refusedBody.error);
    A.eq(fs.readFileSync(path.join(repo, clashPath), 'utf8'), 'MY LOCAL EDIT\n', 'the unsaved edit is still there');

    const after2 = await (await fetch(B + '/api/loops', { headers })).json();
    const stillOpen = (after2.loops.find(x => x.id === id).recent || []).find(i => i.n === fresh.n);
    A.eq(stillOpen.verdict, null, 'and the iteration was NOT marked rejected — the row never claims a tree change that did not happen');

    // ---- 5. APPROVE keeps the code exactly where it is --------------------------------------------------
    git(['checkout', '-q', '--', clashPath]);                      // put the file back so the tree is sane
    const ok = await fetch(B + '/api/loops/verdict', {
      method: 'POST', headers, body: JSON.stringify({ id, n: fresh.n, verdict: 'approved' })
    });
    A.eq(ok.status, 200, 'the approval goes through');
    const okBody = await ok.json();
    A.eq(okBody.undone, [], 'an approval reverts nothing');
    A.eq(fs.existsSync(path.join(repo, clashPath)), true, 'the approved work is still in the tree');
    A.eq(git(['cat-file', '-t', fresh.commit]).trim(), 'commit', 'and still its own commit');
    A.eq(okBody.branch, branch, 'and the response tells the Commander which branch their approved work is on');

    // nothing was ever pushed and the original branch never moved
    A.eq(git(['rev-parse', baseBranch]).trim(), baseHead, 'the Commander\'s original branch is exactly where they left it');

    await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id, action: 'stop' }) });

    /* ---- 6. THE REGRESSION THE HARVEST ALMOST SHIPPED: tampering must survive the loop's own commit -------

       S2's law is "TRUST IS THE FULL UNCOMMITTED STATE" — are the check files in a state git has not recorded.
       The harvest broke that question's premise, because the loop now commits every pass: an agent that
       weakens a test file has it recorded by git seconds later, the working tree goes clean, and the next
       pass's green reads as TRUSTED. Tampering would only have to survive one settlement to become invisible,
       which is precisely the hole S2 exists to close. loopTrustSurface moves the baseline from the index to
       the loop's own baseCommit. This proves it, across a REAL commit made by the harvest itself. */
    const repo2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-looptamper-')));
    const git2 = (args) => execFileSync('git', ['-C', repo2].concat(args), { stdio: 'pipe' }).toString();
    fs.mkdirSync(path.join(repo2, 'test'));
    fs.writeFileSync(path.join(repo2, 'test', 'thing.test.js'), '// a real test file\n');
    fs.writeFileSync(path.join(repo2, 'check.js'),
      "const fs=require('fs');\nif(fs.existsSync(__dirname+'/fixed.txt')){console.log('1 passing');process.exit(0);}\nconsole.log('1 failing');process.exit(1);\n");
    git2(['init', '-q']); git2(['config', 'user.email', 't@t.local']); git2(['config', 'user.name', 't']);
    git2(['config', 'commit.gpgsign', 'false']); git2(['add', '-A']); git2(['commit', '-q', '-m', 'base']);

    /* The "agent" weakens the test file AND makes the check pass — a textbook reward hack — and then TOUCHES
       NOTHING EVER AGAIN. That last part is the whole point: if it kept re-tampering, the working tree would
       be dirty on every pass and the old index-based guard would keep catching it, proving nothing. Tampering
       once and stopping is exactly the shape that goes invisible the moment the harvest commits it. */
    let hacked = false;
    box.write = () => {
      if (hacked) return 'Nothing more to do — the check already passes.';
      hacked = true;
      fs.writeFileSync(path.join(repo2, 'test', 'thing.test.js'), '// weakened\n');
      fs.writeFileSync(path.join(repo2, 'fixed.txt'), 'ok\n');
      return 'I made the check pass.';
    };
    await fetch(B + '/api/projects/bless', { method: 'POST', headers, body: JSON.stringify({ path: repo2, surface: 'interactive' }) });
    const hack = await fetch(B + '/api/loops', {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'green it', objective: 'make the check pass', workdir: repo2, gate: 'auto', queueCap: 9,
        checkCmd: 'node check.js', exitOn: 'check-green', model: 'test/model', provider: 'openrouter'
      })
    });
    const hackId = (await hack.json()).loop.id;
    const H = (s) => s.loops.find(x => x.id === hackId);

    let hs = await until(B, headers, s => H(s) && H(s).lastCheck && H(s).lastCheck.passed, 'the hacked check to go green');
    A.eq(H(hs).lastCheck.passed, true, 'the check really does pass now');
    A.eq(H(hs).lastCheck.tampered, true, 'and the tampering is caught on the pass that did it');
    A.eq(H(hs).lastCheck.trusted, false, 'so the green is not trusted');

    /* Wait for the harvest to COMMIT the weakened test file and leave a clean tree. This wait is the setup
       for the real assertion, so it is on the repo itself — polling the API would let a stale snapshot
       satisfy the next step with a pass from the still-dirty era, which is exactly how the first draft of
       this test passed with the fix switched off. */
    await until(B, headers, () => { try { return git2(['status', '--porcelain']).trim() === ''; } catch (_) { return false; } },
      'the harvest to commit the hack and leave a clean tree');
    A.eq(git2(['status', '--porcelain']).trim(), '', 'the weakened test file is committed, so the tree is CLEAN');
    A.ok(/thing\.test\.js/.test(git2(['log', '--pretty=format:', '--name-only'])), 'and it really is inside a commit the loop made');

    /* THE ASSERTION: a pass that runs from HERE — clean tree, no fresh tampering — must STILL refuse the green.
       Keyed on lastCheck.n, NOT on iterationCount: iterationCount rises the moment a pass STARTS, so waiting
       on it hands back the PREVIOUS iteration's verdict while the new one is still in flight. That is the
       second way this test managed to pass with the fix switched off. */
    const nAt = H(await (await fetch(B + '/api/loops', { headers })).json()).iterationCount;
    hs = await until(B, headers, s => H(s) && H(s).lastCheck && H(s).lastCheck.n > nAt,
      'a check verdict from a pass that ran AFTER the tree went clean');
    A.ok(H(hs).lastCheck.n > nAt, 'the verdict under test is from the new pass (#' + H(hs).lastCheck.n + '), not a stale one');
    A.eq(H(hs).lastCheck.passed, true, 'the check still passes');
    A.eq(H(hs).lastCheck.tampered, true, 'TAMPERING SURVIVES THE COMMIT — a clean tree does not launder a weakened test');
    A.ok((H(hs).lastCheck.tamperedPaths || []).some(p => /thing\.test\.js/.test(p)), 'and it still names the real file: ' + JSON.stringify(H(hs).lastCheck.tamperedPaths));
    A.eq(H(hs).lastCheck.trusted, false, 'so the green is STILL not trusted');
    A.ok(H(hs).state !== 'done', 'and a laundered green CANNOT complete the objective');

    await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: hackId, action: 'stop' }) });
    try { fs.rmSync(repo2, { recursive: true, force: true }); } catch (_) {}
  } finally {
    try { child && child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('loops-git e2e (approve and reject are real)');
})().catch(e => { console.log('FAIL: threw — ' + (e && e.stack || e)); process.exit(1); });
