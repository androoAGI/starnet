/* node test/e2e.pathtrust.test.js — TRUE end-to-end for NS-5 CONVERSATIONAL PATH TRUST: boot the ACTUAL
   sidecar and drive real streaming runs whose (mocked) model calls fs.read on an ABSOLUTE path OUTSIDE the
   agent jail. Proves the whole live loop: an un-blessed outside read raises exactly ONE permission.prompt
   (tool 'path.trust'); answering "always" over POST /api/consent records a standing `path:<root>` grant that
   the read then flows through; the grant shows in GET /api/permissions with grantedAt; GET /api/projects lists
   the root (isGitRepo, lastTouchedAt, blessed); a second file under the now-blessed root reads with NO prompt;
   and revoking the grant makes the very next run prompt again. No real key, no network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// mock OpenRouter: first turn of a run (no tool result yet) → fs_read the path in the LAST user message;
// once a tool result is in the transcript → a short final text. So the directive IS the absolute path to read.
function startMockOpenRouter() {
  const requests = [];
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
          requests.push(msgs);
          const hasToolResult = msgs.some(m => m && m.role === 'tool');
          const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
          const target = lastUser ? String(lastUser.content || '') : '';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (!hasToolResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: target }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done reading' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
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

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrust-ws-'));
  const alphaWorkspace = path.join(ws, 'alpha');
  const betaWorkspace = path.join(ws, 'beta');
  fs.mkdirSync(alphaWorkspace, { recursive: true });
  fs.mkdirSync(betaWorkspace, { recursive: true });
  const alphaPrivate = path.join(alphaWorkspace, 'private.txt');
  fs.writeFileSync(alphaPrivate, 'LIVE_ALPHA_PRIVATE_MARKER\n');
  // a real project OUTSIDE the workspaces jail: a git repo with two files + a protected .env.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrust-proj-'));
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'main.js'), 'const MARKER_MAIN = 1;\n');
  fs.writeFileSync(path.join(proj, 'README.md'), 'MARKER_README\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=hunter2\n');
  const fileA = path.join(proj, 'src', 'main.js');
  const fileB = path.join(proj, 'README.md');
  // NS-5c: a SECOND real git repo to bless via the ADD-a-project route (POST /api/projects/bless), plus a plain file.
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrust-repo2-'));
  fs.mkdirSync(path.join(repo2, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo2, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo2, 'index.js'), 'const MARKER_TWO = 2;\n');
  const subDir = path.join(repo2, 'src');       // a folder INSIDE the repo — bless it, the repo ROOT gets trusted
  const looseFile = path.join(repo2, 'index.js');

  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, STARNET_PROJECT_DISCOVERY_ROOTS: repo2 };   // NO FULL_ACCESS → the consent broker is live
  let running = await boot(8760 + (process.pid % 40), env, 25);
  let B = 'http://' + HOST + ':' + running.port;
  let token;

  // drive an interactive run reading `target`; answer any path.trust prompt with `decision`.
  async function driveRead(agentId, target, decision) {
    const res = await fetch(B + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId, isTask: true, placed: ['cabinet'], messages: [{ role: 'user', content: target }] })
    });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', runId = '', prompts = [], names = [];
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        names.push(ev.name);
        if (ev.name === 'agent.run.start') runId = ev.payload.runId;
        if (ev.name === 'permission.prompt') {
          prompts.push(ev.payload);
          fetch(B + '/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
            body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
        }
      }
    }
    return { names, prompts };
  }

  try {
    token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');

    // ---- projects store starts empty ----
    const p0 = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((p0.projects || []).length, 0, 'GET /api/projects is empty before any bless');

    // Agent workspaces are private even if one is accidentally recorded in the station-global project-grant
    // store. A global `path:<WORKSPACES/alpha>` grant must never override beta's workspace boundary.
    const blessWorkspace = await fetch(B + '/api/projects/bless', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ path: alphaWorkspace })
    });
    A.eq(blessWorkspace.status, 200, 'setup: the current Projects doorway records the alpha workspace grant');
    const workspaceGrant = 'path:' + path.resolve(alphaWorkspace);
    const beforeIsolationRead = mock.requests.length;
    const crossAgentRead = await driveRead('beta', alphaPrivate, 'deny');
    A.eq(crossAgentRead.prompts.filter(p => p.tool === 'path.trust').length, 0,
      'a sibling workspace is a hard floor, not a consent prompt');
    const leakedAcrossAgents = mock.requests.slice(beforeIsolationRead).some(msgs =>
      msgs.some(m => m && m.role === 'tool' && String(m.content).indexOf('LIVE_ALPHA_PRIVATE_MARKER') >= 0));
    A.eq(leakedAcrossAgents, false, 'beta cannot read alpha private bytes through a station-global path grant');
    await fetch(B + '/api/permissions/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: workspaceGrant })
    });

    // Discovery is a read-only candidate scan. Even finding a real git repo must not mint path authority.
    const discovered = await (await fetch(B + '/api/projects/discover', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: '{}' })).json();
    A.eq(discovered.ok, true, 'project discovery route completes');
    A.eq(discovered.grantsChanged, false, 'project discovery explicitly reports no authority change');
    A.ok((discovered.candidates || []).some(x => path.resolve(x.root) === path.resolve(repo2) && x.kind === 'git'), 'bounded discovery finds the configured real git repo');
    const permsBeforeDiscoverGrant = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((permsBeforeDiscoverGrant.grants || []).includes('path:' + repo2), false, 'discovering a project does not grant its path');

    // ---- NS-5c: POST /api/projects/bless is the ADD-a-project doorway (same grant machinery, honest errors) ----
    const bless = (p) => fetch(B + '/api/projects/bless', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: JSON.stringify({ path: p }) });
    // a) honest rejects: relative path + a nonexistent folder both 400 with a reason, no grant recorded.
    const bRel = await bless('some/rel/path'); const jRel = await bRel.json();
    A.eq(bRel.status, 400, 'bless of a relative path is 400'); A.eq(jRel.ok, false, 'relative path ok:false'); A.eq(jRel.code, 'relative', 'relative code');
    const bMiss = await bless(path.join(repo2, 'does-not-exist')); const jMiss = await bMiss.json();
    A.eq(bMiss.status, 400, 'bless of a missing folder is 400'); A.eq(jMiss.code, 'missing', 'missing code');
    // b) HAPPY: blessing a SUBDIR inside a git repo blesses the repo ROOT and records the standing grant.
    const bOk = await bless(subDir); const jOk = await bOk.json();
    A.eq(bOk.status, 200, 'bless of a real folder/file is 200'); A.eq(jOk.ok, true, 'bless ok:true');
    A.ok(path.resolve(jOk.root).toLowerCase() === path.resolve(repo2).toLowerCase(), 'the blessed root is the git repo root (not the file dir): ' + jOk.root);
    A.eq(jOk.isGitRepo, true, 'blessed root reported as a git repo');
    // c) the added project shows in BOTH surfaces — /api/projects AND the SAME path grant in /api/permissions.
    const projAdd = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const addedRow = (projAdd.projects || []).find(p => path.resolve(p.root).toLowerCase() === path.resolve(repo2).toLowerCase());
    A.ok(addedRow && addedRow.blessed === true && addedRow.isGitRepo === true, 'GET /api/projects lists the ADDED project (blessed, git)');
    const forget = (root) => fetch(B + '/api/projects/forget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: JSON.stringify({ root }) });
    const forgetBlessed = await forget(addedRow.root); const forgetBlessedJson = await forgetBlessed.json();
    A.eq(forgetBlessed.status, 409, 'forget refuses an actively blessed project (trust must be revoked first)');
    A.eq(forgetBlessedJson.ok, false, 'active-project forget reports ok:false');
    const permsAdd = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((permsAdd.grants || []).some(g => g.indexOf('path:') === 0 && path.resolve(g.slice(5)).toLowerCase() === path.resolve(repo2).toLowerCase()), 'the SAME path:<root> grant appears in /api/permissions (one grant store, two doorways)');
    // d) an interactive run reads under the ADDED root with NO prompt (the route-blessed grant is real trust).
    const rAdd = await driveRead('ptagent-added', looseFile, 'deny');
    A.eq(rAdd.prompts.filter(p => p.tool === 'path.trust').length, 0, 'a read under the ADDED (route-blessed) root does NOT prompt');
    // e) remove = revoke through the existing surface → /api/projects reflects blessed:false (list mirrors the grant store).
    const revAdd = (permsAdd.grants || []).find(g => g.indexOf('path:') === 0 && path.resolve(g.slice(5)).toLowerCase() === path.resolve(repo2).toLowerCase());
    await fetch(B + '/api/permissions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: JSON.stringify({ key: revAdd }) });
    const projAfter = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const afterRow = (projAfter.projects || []).find(p => path.resolve(p.root).toLowerCase() === path.resolve(repo2).toLowerCase());
    A.ok(afterRow && afterRow.blessed === false, 'after revoke, the ADDED project reports blessed:false (truthful telemetry)');
    const forgotten = await forget(afterRow.root); const forgottenJson = await forgotten.json();
    A.eq(forgotten.status, 200, 'forget accepts a revoked project');
    A.eq(forgottenJson.ok, true, 'revoked-project forget reports ok:true');
    const projForgotten = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(!(projForgotten.projects || []).some(p => path.resolve(p.root).toLowerCase() === path.resolve(repo2).toLowerCase()),
      'forget removes the revoked project metadata row instead of only claiming removal');

    // ---- 1. first outside read → exactly ONE path.trust prompt; "always" lets the read flow ----
    const r1 = await driveRead('ptagent', fileA, 'always');
    const trustPrompts = r1.prompts.filter(p => p.tool === 'path.trust');
    A.eq(trustPrompts.length, 1, 'exactly ONE path.trust consent prompt for the first outside reference');
    A.ok(path.resolve(trustPrompts[0].argsSummary).toLowerCase() === path.resolve(proj).toLowerCase(),
      'the prompt proposes the git-repo ROOT (not the file\'s own dir): ' + trustPrompts[0].argsSummary);
    A.ok(r1.names.filter(n => n === 'agent.run.end').length === 1, 'the run completed after the grant');
    const sawMain = mock.requests.some(msgs => msgs.some(m => m && m.role === 'tool' && String(m.content).indexOf('MARKER_MAIN') >= 0));
    A.ok(sawMain, 'the blessed read returned the real file content into the run (MARKER_MAIN reached the provider)');

    // ---- 2. the standing grant is listed by /api/permissions with grantedAt provenance ----
    const perms = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const grantKey = (perms.grants || []).find(g => g.indexOf('path:') === 0 && path.resolve(g.slice(5)).toLowerCase() === path.resolve(proj).toLowerCase());
    A.ok(grantKey, 'GET /api/permissions lists a path:<root> standing grant for the blessed project');
    A.ok(perms.meta && perms.meta[grantKey] && typeof perms.meta[grantKey].grantedAt === 'number', 'the path grant carries a grantedAt timestamp');

    // ---- 3. /api/projects lists the blessed root with its metadata ----
    const proj1 = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const row = (proj1.projects || []).find(p => path.resolve(p.root).toLowerCase() === path.resolve(proj).toLowerCase());
    A.ok(row, 'GET /api/projects lists the blessed root');
    A.eq(row.isGitRepo, true, 'the project is recorded as a git repo (.git present)');
    A.eq(row.blessed, true, 'the project reports blessed:true (joined against the live grant)');
    A.ok(typeof row.lastTouchedAt === 'number' && row.lastTouchedAt > 0, 'lastTouchedAt was stamped on the fs I/O');

    // ---- 3b. RESTART-SAFE: the standing grant + project metadata survive a sidecar reboot on the same
    //          workspace (the top recurring bug class is "worked until restart"). ----
    try { running.child.kill(); } catch (_) {}
    running = await boot(8830 + (process.pid % 40), env, 25);
    B = 'http://' + HOST + ':' + running.port;
    token = await bootToken(B, B);
    const permsR = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((permsR.grants || []).some(g => g.indexOf('path:') === 0 && path.resolve(g.slice(5)).toLowerCase() === path.resolve(proj).toLowerCase()), 'RESTART-SAFE: the path grant survived the reboot');
    const projR = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((projR.projects || []).some(p => path.resolve(p.root).toLowerCase() === path.resolve(proj).toLowerCase() && p.blessed === true && p.isGitRepo === true), 'RESTART-SAFE: the known-project row (blessed, isGitRepo) survived the reboot');
    A.ok(!(projR.projects || []).some(p => path.resolve(p.root).toLowerCase() === path.resolve(repo2).toLowerCase()),
      'RESTART-SAFE: a hard-forgotten revoked project does not reappear after reboot');
    const rReboot = await driveRead('ptagent-reboot', fileA, 'deny');
    A.eq(rReboot.prompts.filter(p => p.tool === 'path.trust').length, 0, 'RESTART-SAFE: a read under the blessed root does NOT re-prompt after the reboot');

    // ---- 4. a SECOND file under the now-blessed root reads with NO prompt ----
    const before = mock.requests.length;
    const r2 = await driveRead('ptagent2', fileB, 'deny');   // 'deny' would refuse IF asked — it must NOT be asked
    A.eq(r2.prompts.filter(p => p.tool === 'path.trust').length, 0, 'a second file under the blessed root does NOT re-prompt');
    const sawReadme = mock.requests.slice(before).some(msgs => msgs.some(m => m && m.role === 'tool' && String(m.content).indexOf('MARKER_README') >= 0));
    A.ok(sawReadme, 'the second (un-prompted) read returned the real file content (MARKER_README)');

    // ---- 5. REVOKE the grant → the very next run prompts again (revoke takes effect with no restart) ----
    const rev = await (await fetch(B + '/api/permissions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: JSON.stringify({ key: grantKey }) })).json();
    A.ok(rev.ok === true, 'POST /api/permissions/revoke withdrew the path grant');
    const r3 = await driveRead('ptagent3', fileA, 'deny');
    A.eq(r3.prompts.filter(p => p.tool === 'path.trust').length, 1, 'after revoke, the next outside read PROMPTS again');
    const proj2 = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const row2 = (proj2.projects || []).find(p => path.resolve(p.root).toLowerCase() === path.resolve(proj).toLowerCase());
    A.ok(row2 && row2.blessed === false, 'post-revoke: /api/projects reports the remembered root as blessed:false');

    /* ---- 6. "FULL ACCESS" ON THE CARD IS AT LEAST AS STRONG AS "ALWAYS" (live-caught 2026-07-27) ----
       The card offers four grades; "full" used to be handled as a one-time allow that recorded nothing, so the
       Commander clicking the STRONGEST button was asked again on the very next file touch in the same folder —
       a user clicked it five times for five reads and never got a standing grant. Proven here over real HTTP:
       one "full" answer, then subsequent reads carry a 'deny' answerer that must NEVER be consulted. The root
       is un-blessed at this point (section 5 revoked it), so this starts from a genuinely cold trust store. */
    const rFull = await driveRead('ptagent-full', fileA, 'full');
    A.eq(rFull.prompts.filter(p => p.tool === 'path.trust').length, 1, '"full": exactly ONE path.trust prompt on the first outside read');
    const permsFull = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const fullKey = (permsFull.grants || []).find(g => g.indexOf('path:') === 0 && path.resolve(g.slice(5)).toLowerCase() === path.resolve(proj).toLowerCase());
    A.ok(fullKey, '"full" RECORDED a standing path:<root> grant, visible in /api/permissions (revocable, not invisible)');
    const projFull = await (await fetch(B + '/api/projects', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((projFull.projects || []).some(p => path.resolve(p.root).toLowerCase() === path.resolve(proj).toLowerCase() && p.blessed === true), '"full" blessed the project root (/api/projects reports blessed:true)');
    // THE ACTUAL BUG: every following read in that folder must be silent. 'deny' would refuse IF asked.
    for (const [i, f] of [fileB, fileA, fileB].entries()) {
      const rAgain = await driveRead('ptagent-full-' + i, f, 'deny');
      A.eq(rAgain.prompts.filter(p => p.tool === 'path.trust').length, 0, 'after "full", read #' + (i + 2) + ' in that folder raises NO card');
    }
  } finally {
    try { running.child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(repo2, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.pathtrust.test');
})().catch(e => { console.error(e); process.exit(1); });
