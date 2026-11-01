/* node test/workshop-undo.e2e.test.js — real sidecar proof for EL-11 #8: UNDO for out-of-jail workshop artifacts.

   handleWorkshopDecide's KEEP copies a deliverable's files OUT of the jail to a destPath and retires the backlog
   item; before this there was no reverse operation. POST /api/workshop/undo deletes exactly the files the keep
   copied out (each verified gone), removes only now-empty dirs the keep created, and flips the durable decision
   back to PENDING so /pending re-lists it. This EL-3-style escape test boots the ACTUAL sidecar with a mock
   OpenRouter and drives the true round-trip the Commander would:
     grant → queue → shift (build a real deliverable on disk) → decide keep (copy OUT) → undo (remove the copy).
   It asserts ON-DISK truth at every step, and proves the honesty guarantees the feature exists for:
     • undo removes EXACTLY the kept files and returns them in `removed` (destPath is empty afterwards);
     • the build is PENDING again (/pending re-lists it) and the stale 'kept' library row yields to it;
     • a SECOND undo (nothing left to remove) reports honestly — removed:[], everything in `missing`, never a
       phantom removal;
     • undo-AFTER-the-user-deleted-a-file reports that file in `missing`, not `removed`;
     • undo of a run that was never kept is refused (no kept lifecycle row → 404). */
'use strict';

const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter: on a WORKSHOP run write the deliverable file, then the manifest, then stop (turn inferred from
// how many tool results the transcript already carries). Mirrors test/workshop.e2e.test.js's generic build branch.
function startMockOpenRouter() {
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
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = userWords(userMsg);
          const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          const dir = 'workshop/' + runId;
          if (prompt.indexOf(WORKSHOP_MARK) === 0) {
            // build TWO files (one in a subdir) so undo's directory-cleanup path is exercised, then the manifest.
            if (toolResults === 0) {
              tool('u1', 'fs_write', { path: dir + '/cleaner.py', content: 'print("csv cleaned")\n' });
            } else if (toolResults === 1) {
              tool('u2', 'fs_write', { path: dir + '/lib/util.py', content: 'X = 1\n' });
            } else if (toolResults === 2) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'item-undo', title: 'Undo me', kind: 'tool', summary: 'A tiny tool used to prove keep/undo.', files: [{ path: 'cleaner.py', bytes: 21 }, { path: 'lib/util.py', bytes: 6 }], howToUse: 'Run it.', notVerified: ['not executed'] };
              tool('u3', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the tool in my workshop.'); }
          } else { text('done'); }
          res.write('data: [DONE]\n\n');
          res.end();
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
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
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

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-undo-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const firstBoot = await boot(await allocatePort(), env, 20);
  let child = firstBoot.child;
  const B = 'http://' + HOST + ':' + firstBoot.port;
  const keepDir = path.join(os.tmpdir(), 'starnet-undo-keep-' + process.pid + '-' + Date.now());
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // 1. grant + queue + build a real deliverable (two files, one in a subdir).
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', on: true }) });
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-undo', title: 'Undo me' }) }).then(r => r.json());
    const shiftStream = await readNdjson(await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) }));
    const shiftRes = ((shiftStream.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.ok(shiftRes.fired === true && shiftRes.reason === 'built', 'shift built the deliverable (fired:true, reason:built)');
    const runId = shiftRes.runId;
    A.ok(runId, 'shift returned a runId');
    const runDir = path.join(ws, 'builder', 'workshop', runId);
    A.ok(fs.existsSync(path.join(runDir, 'cleaner.py')) && fs.existsSync(path.join(runDir, 'lib', 'util.py')), 'both deliverable files exist in the jail run dir');

    // 2. UNDO BEFORE KEEP is refused — there is no kept copy to reverse yet.
    const preUndo = await fetch(B + '/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, destPath: keepDir }) });
    A.eq(preUndo.status, 404, 'undo with no prior keep is refused 404');

    // 3. KEEP → copy the files OUT of the jail to keepDir (COPYFILE_EXCL default; fresh folder so it succeeds).
    const keep = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, decision: 'keep', destPath: keepDir }) });
    const keepJ = await keep.json();
    A.ok(keep.status === 200 && keepJ.ok === true && keepJ.copied === 2, 'keep copied both files out to destPath');
    A.ok(fs.existsSync(path.join(keepDir, 'cleaner.py')) && fs.existsSync(path.join(keepDir, 'lib', 'util.py')), 'the kept copies really landed at destPath (incl. the subdir file)');
    // keep retires the backlog item → /pending no longer lists it; the library shows it kept.
    const pendingAfterKeep = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(!pendingAfterKeep.pending.some(m => m.runId === runId), 'after keep the build is NOT pending');
    const libAfterKeep = await (await fetch(B + '/api/deliverables', { headers })).json();
    A.ok(libAfterKeep.items.some(r => r.runId === runId && r.status === 'kept'), 'the library records the kept lifecycle');

    // Clear the kept card before undo: the pending decision must reappear despite sharing the same durable id.
    const clear = await fetch(B + '/api/deliverables/clear', { method: 'POST', headers, body: JSON.stringify({ ids: ['workshop:builder:' + runId] }) });
    const clearJ = await clear.json();
    A.ok(clear.status === 200 && clearJ.cleared === 1, 'kept build can be cleared from the library');
    const clearedList = await (await fetch(B + '/api/deliverables', { headers })).json();
    A.ok(!clearedList.items.some(r => r.runId === runId), 'cleared kept card is hidden before undo');
    A.ok(fs.existsSync(path.join(keepDir, 'cleaner.py')), 'clearing the library never deletes kept files');

    // 4. UNDO → delete EXACTLY the kept files, verified gone; the build returns to PENDING.
    const undo = await fetch(B + '/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, destPath: keepDir }) });
    const undoJ = await undo.json();
    A.ok(undo.status === 200 && undoJ.ok === true, 'undo succeeds');
    A.ok(undoJ.removed.length === 2 && undoJ.removed.indexOf('cleaner.py') >= 0 && undoJ.removed.indexOf('lib/util.py') >= 0, 'undo reports removing exactly the two kept files');
    A.ok(undoJ.missing.length === 0, 'nothing reported missing on the clean undo');
    A.ok(!fs.existsSync(path.join(keepDir, 'cleaner.py')) && !fs.existsSync(path.join(keepDir, 'lib', 'util.py')), 'both out-of-jail copies are really gone from disk');
    A.ok(!fs.existsSync(path.join(keepDir, 'lib')), 'the now-empty created subdir was removed too');
    // a USER-SUPPLIED destPath is never removed (the keep did not create it) — only its now-empty created subdirs
    // are cleaned. So keepDir itself survives (empty). Only the auto-created default folder would be removed.
    A.ok(fs.existsSync(keepDir) && fs.readdirSync(keepDir).length === 0, 'the user-chosen destPath folder is left in place (now empty), never recursively wiped');
    // JAIL ARCHIVE UNTOUCHED: undo only removes the out-of-jail COPY, never the workshop archive.
    A.ok(fs.existsSync(path.join(runDir, 'cleaner.py')), 'the jail run-dir archive is untouched by undo');
    A.ok(undoJ.restored === true, 'undo flipped the durable decision back to pending (restored:true)');
    const pendingAfterUndo = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(pendingAfterUndo.pending.some(m => m.runId === runId && m.title === 'Undo me'), '/pending re-lists the build after undo');
    // library truthful telemetry: the stale 'kept' row yields to the live pending item (no phantom "kept").
    const libAfterUndo = await (await fetch(B + '/api/deliverables', { headers })).json();
    A.ok(!libAfterUndo.items.some(r => r.runId === runId && r.status === 'kept'), 'the library no longer shows the build as kept after undo');
    A.ok(libAfterUndo.items.some(r => r.runId === runId && r.status === 'pending'), 'the library shows the build as pending again after undo');

    // 5. SECOND UNDO — the files are already gone: honest report (removed:[], all in missing), never phantom.
    const undo2 = await fetch(B + '/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, destPath: keepDir }) });
    const undo2J = await undo2.json();
    A.ok(undo2.status === 200 && undo2J.ok === true, 'a second undo still returns ok (it is honest, not an error)');
    A.ok(undo2J.removed.length === 0 && undo2J.missing.length === 2, 'second undo reports removed:[] and both files missing (already gone) — no phantom removal');
    A.ok(undo2J.missing.every(m => m.reason === 'already gone'), 'each missing entry names WHY (already gone)');

    // 6. UNDO AFTER A PARTIAL USER DELETION — re-keep, delete ONE file by hand, undo: the hand-deleted file is
    //    reported in `missing`, the surviving file in `removed`. Uses a fresh folder so re-keep's EXCL succeeds.
    const keepDir2 = keepDir + '-b';
    const rekeep = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, decision: 'keep', destPath: keepDir2 }) });
    const rekeepJ = await rekeep.json();
    A.ok(rekeep.status === 200 && rekeepJ.ok === true, 'the build can be kept AGAIN after undo (pending → keep round-trips)');
    fs.rmSync(path.join(keepDir2, 'cleaner.py'), { force: true });   // the user moved/deleted one file themselves
    const undo3 = await fetch(B + '/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, destPath: keepDir2 }) });
    const undo3J = await undo3.json();
    A.ok(undo3.status === 200 && undo3J.ok === true, 'undo after a partial user deletion still succeeds');
    A.ok(undo3J.removed.length === 1 && undo3J.removed[0] === 'lib/util.py', 'only the surviving file is reported removed');
    A.ok(undo3J.missing.length === 1 && undo3J.missing[0].path === 'cleaner.py', 'the user-deleted file is honestly reported missing, never as removed');

    // 7. GATE: undo needs a valid agent + run id shape.
    const badAgent = await fetch(B + '/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: '../etc', runId: runId, destPath: keepDir }) });
    A.eq(badAgent.status, 400, 'undo refuses a malformed agentId');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(keepDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(keepDir + '-b', { recursive: true, force: true }); } catch (_) {}
  }
  A.report('workshop-undo.e2e.test');
})().catch(e => { console.log('FAIL: workshop-undo.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
