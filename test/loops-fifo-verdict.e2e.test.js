/* node test/loops-fifo-verdict.e2e.test.js — a stacked candidate cannot be APPROVED past an older one it was built
   on (sweep/autonomy 2026-10-20). LIVE: real sidecar, real throwaway repo, mock provider writes the "agent" edit.

   THE HOLE (found live): the STACKING LAW says iteration N+1 is built on a tree containing un-approved N, so the
   review queue is strictly FIFO and rejecting N cascades to everything above it. But the verdict route only
   cascaded over UN-APPROVED candidates and accepted an approval of ANY pending candidate. So:
     · independent edits: APPROVE #2, then REJECT #1 -> #1 reverted, #2 kept as "approved" — a pass built on rejected
       work survives, exactly the tree state the law says the app must never assert;
     · dependent edits (#2 builds on #1's code): APPROVE #2, then REJECT #1 -> 409 with raw git conflict hints, and
       #1 can never be rejected again — the Commander is left able only to keep work they want gone.
   Now an approval of #N while an older candidate is still unreviewed is refused (409, names the one to review
   first) on BOTH the HTTP and the store seam, so the cascade stays whole: rejecting #1 discards #2 and the tree
   loses both. Approving twice stays a 409. */
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMock(onPrompt) {
  let nth = 0;
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          nth += 1;
          const reply = onPrompt(nth);
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

// the pure store seam holds the same rule (defense in depth for every caller of recordVerdict)
{
  const store = require('../sidecar/loopjob-store.js');
  const loop = { id: 'l', gate: 'review', state: 'idle', iterations: [{ n: 1, outcome: 'candidate', verdict: null }, { n: 2, outcome: 'candidate', verdict: null }] };
  const v = (loops, n) => store.getLoop(loops, 'l').iterations.find(it => it.n === n).verdict;
  let loops = store.recordVerdict([loop], 'l', 2, 'approved', { now: 1 });
  A.eq(v(loops, 2), null, 'store: approving #2 over an unreviewed #1 is a no-op');
  loops = store.recordVerdict(loops, 'l', 1, 'approved', { now: 2 });
  loops = store.recordVerdict(loops, 'l', 2, 'approved', { now: 3 });
  A.eq([v(loops, 1), v(loops, 2)], ['approved', 'approved'], 'store: oldest-first approvals both land');
}

(async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopfifo-')));
  const git = a => execFileSync('git', ['-C', repo].concat(a), { stdio: 'pipe' }).toString();
  fs.writeFileSync(path.join(repo, 'README.md'), '# scratch\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), '// base\n');
  git(['init', '-q']); git(['config', 'user.email', 'loop@test.local']); git(['config', 'user.name', 'loop test']); git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
  const file = n => path.join(repo, 'src', 'feature' + n + '.js');
  const mock = await startMock(n => { fs.mkdirSync(path.dirname(file(n)), { recursive: true }); fs.writeFileSync(file(n), 'module.exports = ' + n + ';\n'); return 'I added feature ' + n + '.'; });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loopfifows-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-fifo-fake', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_LOOP_TICK_MS: '1000', SKYNET_FULL_ACCESS: '1', SKYNET_QUEST_REFRESH: '0' };
  let child;
  try {
    let port;
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = async (route, body) => { const r = await fetch(B + route, { method: 'POST', headers, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j || {} }; };
    const loopOf = async id => ((await (await fetch(B + '/api/loops', { headers })).json()).loops || []).find(x => x.id === id);

    A.eq((await post('/api/projects/bless', { path: repo, surface: 'interactive' })).status, 200, 'the project is approved');
    const created = await post('/api/loops', { name: 'add features', objective: 'add one feature per pass', workdir: repo, queueCap: 3, exitOn: 'never', model: 'test/model', provider: 'openrouter' });
    A.eq(created.status, 200, 'the loop is created');
    const id = created.body.loop.id;
    let loop = null;
    for (let i = 0; i < 100; i++) { loop = await loopOf(id); if (loop && (loop.recent || []).filter(r => r.outcome === 'candidate').length >= 2) break; await sleep(250); }
    await post('/api/loops/control', { id, action: 'pause' });
    await sleep(1500);
    loop = await loopOf(id);
    const pend = (loop.recent || []).filter(r => r.outcome === 'candidate' && !r.verdict).sort((a, b) => a.n - b.n);
    A.ok(pend.length >= 2 && pend[0].commit && pend[1].commit, 'two committed candidates are stacked for review');
    const [older, newer] = pend;

    const jump = await post('/api/loops/verdict', { id, n: newer.n, verdict: 'approved' });
    A.eq(jump.status, 409, 'approving #' + newer.n + ' while #' + older.n + ' (which it was built on) is unreviewed is refused');
    A.ok(new RegExp('#' + older.n).test(jump.body.error || ''), 'and the refusal names the candidate to review first: ' + jump.body.error);
    A.eq(((await loopOf(id)).recent || []).find(r => r.n === newer.n).verdict, null, 'the newer candidate stays unreviewed');

    const rej = await post('/api/loops/verdict', { id, n: older.n, verdict: 'rejected', note: 'wrong approach' });
    A.eq(rej.status, 200, 'rejecting the older candidate goes through');
    A.eq((rej.body.undone || []).slice().sort((a, b) => a - b), [older.n, newer.n], 'and undoes the one stacked on it too');
    A.eq([fs.existsSync(file(older.n)), fs.existsSync(file(newer.n))], [false, false], 'THE TREE AGREES: both passes are gone');
    loop = await loopOf(id);
    A.eq([older.n, newer.n].map(n => (loop.recent || []).find(r => r.n === n).verdict), ['rejected', 'discarded'], 'the rows say rejected + discarded (the STACKING LAW holds)');
    A.eq(loop.approvedCount || 0, 0, 'nothing built on the rejected pass is counted approved');

    // approve-twice: resume, take the next candidate (now the oldest), approve it twice
    await post('/api/loops/control', { id, action: 'resume' });
    let fresh = null;
    for (let i = 0; i < 100 && !fresh; i++) { const l = await loopOf(id); fresh = (l.recent || []).filter(r => r.outcome === 'candidate' && !r.verdict).sort((a, b) => a.n - b.n)[0]; if (!fresh) await sleep(250); }
    await post('/api/loops/control', { id, action: 'pause' });
    await sleep(1500);
    const oldest = ((await loopOf(id)).recent || []).filter(r => r.outcome === 'candidate' && !r.verdict).sort((a, b) => a.n - b.n)[0];
    const ok1 = await post('/api/loops/verdict', { id, n: oldest.n, verdict: 'approved' });
    A.eq(ok1.status, 200, 'the OLDEST unreviewed candidate can be approved');
    const ok2 = await post('/api/loops/verdict', { id, n: oldest.n, verdict: 'approved' });
    A.eq(ok2.status, 409, 'approving it a second time is refused');
    A.ok(fs.existsSync(file(oldest.n)), 'the approved pass\'s file stays in the tree');
    await post('/api/loops/control', { id, action: 'stop' });
  } finally {
    try { child && child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('loops-fifo-verdict e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
