/* node test/nightshift-act.e2e.test.js — real sidecar proof for NS-3 (REACH-GATED REAL HANDS + approve-to-ship).

   Boots the ACTUAL sidecar with a mock OpenRouter, seeds a HOT dossier + the away grant, and drives the night
   shift the way it runs unattended (force-fired via POST /api/nightshift/beat for an attended test):

     · REACH GATE IS HONEST — at reach 'observe' a beat is reason-only: NO jailed workshop write, NO pending
       deliverable, NO ledger 'act'. The gate is load-bearing, not decorative.
     · REACH ≥ 'sandbox' + grant — the DO step becomes a REAL runOnce TASK run (tools on) that writes a file +
       manifest UNDER the jail; it lands as a pending workshop deliverable and workshop.built fires.
     · JAIL CONFINEMENT — a write the model attempts OUTSIDE the run dir never lands on disk (fs-jail + the manifest
       validator only surface disk-proven files).
     · APPROVE → SHIP — decide keep copies the artifact OUT and records a positive shared recommendation verdict.
     · DENY → LEARN — decide discard wipes the run dir and records a negative verdict in that same authority.
     · LEDGER TRUTH — the tool-run outcome records kind 'act' with the artifact path + runId; the verdicts record too.

   Uses the workshop return-card flow VERBATIM (/api/workshop/pending + /decide) — NS-3 reuses it, doesn't reinvent. */
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
const ACT_MARK = '[NIGHTSHIFT_ACT]';
let sawPriorBuilds = 0;   // propose prompts that listed the KEPT checklist tool as already built (prior-work memory)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter. Two shapes of call reach it:
//   1) the reason-only PROPOSE (the V2 candidate directive) — reply a grounded JOB block (text only, no tools).
//   2) the NIGHTSHIFT_ACT build run — write the deliverable file, then a manifest, then stop (like the workshop mock).
//      A SNEAKY control run (title carries "sneaky") also tries to write OUTSIDE the run dir first — proving the jail.
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
          const prompt = String((userMsg && userMsg.content) || '');
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };

          if (prompt.indexOf(ACT_MARK) === 0) {
            // the BUILD run. Pull the run dir the directive named so files land where the validator looks. EVERY
            // build first attempts a JAIL-ESCAPE write (a ../ traversal to the workspace parent) — the fs-jail must
            // refuse it, so no escape.txt ever lands. Then it writes the real artifact + manifest under the run dir.
            const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
            const dir = 'workshop/' + runId;
            if (toolResults === 0) {
              tool('esc', 'fs_write', { path: '../../escape.txt', content: 'should never land outside the jail' });
            } else if (toolResults === 1) {
              tool('f1', 'fs_write', { path: dir + '/tool.py', content: 'print("built by the night shift")\n' });
            } else if (toolResults === 2) {
              const jobTitle = ((prompt.match(/^- JOB: (.+)$/m) || [])[1] || 'Release checklist tool').trim();
              const manifest = { v: 1, runId: runId, agentId: 'agent', backlogId: '', title: jobTitle, kind: 'tool', summary: 'A tiny helper toward shipping the beta.', files: [{ path: 'tool.py', bytes: 34 }], howToUse: 'Run it.', notVerified: ['not executed'] };
              tool('f2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the tool in my workshop.'); }
          } else if (/JOB:/.test(prompt) && /GROUNDS:/.test(prompt)) {
            // the reason-only PROPOSE (V2 candidate directive). Reply ONE grounded, high-confidence build job.
            // PRIOR WORK (2026-10-05): once the checklist tool was KEPT, the propose prompt lists it as already built.
            // The mock still re-proposes it FIRST (a model ignoring the courtesy) — the host veto must drop it — and
            // offers a genuinely new job second, which is what then gets built.
            const keptBefore = /ALREADY BUILT ON EARLIER NIGHTS[\s\S]*"Release checklist tool" — kept/.test(prompt);
            if (keptBefore) sawPriorBuilds++;
            text([
              'JOB: Release checklist tool',
              'KIND: advance-goal',
              'GROUNDS: ship the StarNet beta to 100 users',
              'CONFIDENCE: high',
              'SPEC: a small script that helps ship the beta'
            ].concat(keptBefore ? ['', 'JOB: Beta signup tracker', 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a tiny tracker of beta signups'] : []).join('\n'));
          } else {
            text('ok');
          }
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
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
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

// a HOT dossier snapshot: goals (the keystone) + 4 usable, freshly-stamped dims → readiness tier 'hot'.
function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return {
    known: ['goals', 'pain', 'stack', 'ambition'],
    beliefs: {
      goals: b('ship the StarNet beta to 100 users'),
      pain: b('manual release notes eat my fridays'),
      stack: b('node and a pixel-art canvas'),
      ambition: b('a living agent station people watch')
    }
  };
}

async function setPosture(B, headers, reach, beliefs) {
  const r = await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: reach, leashPerDay: 12 }, beliefs: beliefs }) });
  return r.json();
}

async function fireBeat(B, headers) {
  const res = await fetch(B + '/api/nightshift/beat', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent' }) });
  const stream = await readNdjson(res);
  return ((stream.find(e => e.name === 'nightshift.beat.result') || {}).payload || {});
}

async function ledger(B, headers) {
  const r = await fetch(B + '/api/autonomy/ledger', { headers });
  const j = await r.json().catch(() => null);
  return (j && Array.isArray(j.entries)) ? j.entries : (Array.isArray(j) ? j : []);
}

async function recommendations(B, headers) {
  const r = await fetch(B + '/api/recommendations?surface=nightshift&limit=20', { headers });
  return r.json();
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsact-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nsact-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const { child, port } = await boot(8930 + (process.pid % 30), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const now = Date.now();
    const beliefs = hotBeliefs(now);

    // ===== 1. REACH GATE IS HONEST — reach 'observe' → reason-only, NO jailed build, NO pending deliverable. =====
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', on: true }) });
    await setPosture(B, headers, 'observe', beliefs);
    const obs = await fireBeat(B, headers);
    A.ok(obs.reason !== 'built' && !obs.runId, 'reach observe: the beat did NOT run a real build (no runId, reason≠built) — gate is honest');
    const pendObs = await (await fetch(B + '/api/workshop/pending?agent=agent', { headers })).json();
    A.eq((pendObs.pending || []).length, 0, 'reach observe: nothing surfaces as a pending workshop deliverable');
    A.ok(!fs.existsSync(path.join(ws, 'agent', 'workshop')), 'reach observe: no workshop dir was written (reason-only path)');

    // ===== 2. REACH sandbox → a REAL tool-run builds an artifact IN THE JAIL and lands as a pending deliverable. =====
    await setPosture(B, headers, 'sandbox', beliefs);
    const act = await fireBeat(B, headers);
    A.ok(act.delivered === true && act.reason === 'built', 'reach sandbox: the beat ran a REAL build (delivered, reason:built)');
    const runId = act.runId;
    A.ok(runId, 'the act returned a runId');
    A.ok(act.artifactPaths && /tool\.py/.test(act.artifactPaths), 'the result names the artifact path(s) it built');

    // the file is REALLY on disk, inside the jail (written through the fs-jail unlocked by the away grant).
    const runDir = path.join(ws, 'agent', 'workshop', runId);
    A.ok(fs.existsSync(path.join(runDir, 'tool.py')), 'the built artifact exists on disk inside the jail');
    A.ok(fs.existsSync(path.join(runDir, 'deliverable.json')), 'a valid manifest exists on disk');

    // it surfaces as a PENDING deliverable for the return card (the workshop flow, reused verbatim).
    const pend = await (await fetch(B + '/api/workshop/pending?agent=agent', { headers })).json();
    A.ok((pend.pending || []).some(m => m.runId === runId && /Release checklist/.test(m.title)), '/pending lists the night-shift-built deliverable (return-card ready)');

    // LEDGER TRUTH: the tool-run outcome recorded kind 'act' with the artifact + runId.
    const led = await ledger(B, headers);
    const actEntry = led.find(e => e.kind === 'act' && e.runId === runId && e.detail && e.detail.artifacts);
    A.ok(actEntry, "the ledger recorded kind 'act' naming the runId + artifact path(s)");
    A.ok(/tool\.py/.test(actEntry.detail.artifacts), 'the ledger act detail carries the real artifact path');

    // ===== 3. JAIL CONFINEMENT — every build first attempts a ../../escape.txt write; the fs-jail refuses it, so no
    //          escape file ever lands outside the run dir (checked at the workspace root, its parent, and the run
    //          dir's own parent). The deliverable still built (proven above), so the refusal didn't break the run. =====
    A.ok(!fs.existsSync(path.join(ws, 'escape.txt')), 'no escaped write at the workspace root');
    A.ok(!fs.existsSync(path.join(path.dirname(ws), 'escape.txt')), 'no escaped write at the workspace parent');
    A.ok(!fs.existsSync(path.join(ws, 'agent', 'escape.txt')), 'no escaped write at the agent-jail root (../ from workshop was refused)');

    // ===== 4. APPROVE → SHIP — keep copies the artifact OUT to a Commander folder; the archetype UP-weights. =====
    const dest = path.join(os.tmpdir(), 'ns-ship-' + Date.now());
    const keep = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', runId: runId, decision: 'keep', destPath: dest }) });
    const keepJ = await keep.json();
    A.ok(keep.status === 200 && keepJ.ok === true && keepJ.copied >= 1, 'APPROVE: keep copies the artifact out of the jail');
    A.ok(fs.existsSync(path.join(dest, 'tool.py')), 'APPROVE: the shipped artifact is observable at its destination (out of the jail)');
    A.ok(fs.existsSync(runDir), 'APPROVE: the run dir stays in the workshop as an archive (undo/rollback path present)');
    const prefs1 = await recommendations(B, headers);
    const keptRec = (prefs1.entries || []).find(e => e.id === 'nightshift:' + runId);
    A.ok(keptRec && keptRec.state === 'completed', 'APPROVE records completion in the shared recommendation ledger');
    A.eq(keptRec.outcome.adopted, true, 'APPROVE separately records explicit adoption');
    A.eq(keptRec.outcome.quality, 0, 'APPROVE does not invent a satisfaction rating');
    const keptWeight = prefs1.model && prefs1.model.kinds && prefs1.model.kinds['advance-goal'] && prefs1.model.kinds['advance-goal'].weight;
    A.ok(keptWeight > 0, 'APPROVE raises the effective advance-goal preference');
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}

    // ===== 5. DENY → LEARN — build a fresh deliverable, discard it → run dir wiped + archetype DOWN-weighted. =====
    const act2 = await fireBeat(B, headers);
    A.ok(act2.reason === 'built' && act2.runId && act2.runId !== runId, 'a fresh beat built a second deliverable with its own runId');
    // PRIOR-WORK MEMORY + DUPLICATE VETO (2026-10-05): the propose prompt named the kept build, and the re-proposal of
    // it was dropped by the host — the second build is the NEW job, not a rebuild of the kept one.
    A.ok(sawPriorBuilds >= 1, 'the propose prompt listed the kept build under ALREADY BUILT ON EARLIER NIGHTS');
    A.ok(/Beta signup tracker/.test(String(act2.title || '')), 'the near-duplicate of kept work was vetoed; the new job was built instead');
    const vetoNote = (await ledger(B, headers)).find(e => e.reason === 'duplicate-veto' && e.detail && /Release checklist tool/.test(String(e.detail.droppedTitles || '')));
    A.ok(vetoNote && /\[kept\]/.test(vetoNote.detail.droppedTitles), 'the ledger records the veto (dropped title ~ matched kept build)');
    const runId2 = act2.runId;
    const runDir2 = path.join(ws, 'agent', 'workshop', runId2);
    A.ok(fs.existsSync(runDir2), 'the second build landed on disk');
    const disc = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', runId: runId2, decision: 'discard' }) })).json();
    A.ok(disc.ok === true && disc.decision === 'discard', 'DENY: discard accepted');
    A.ok(!fs.existsSync(runDir2), 'DENY: discard wiped the run dir');
    const prefs2 = await recommendations(B, headers);
    const declinedRec = (prefs2.entries || []).find(e => e.id === 'nightshift:' + runId2);
    A.ok(declinedRec && declinedRec.state === 'declined' && declinedRec.reason === 'bad_quality', 'DENY records a typed negative verdict in the shared recommendation ledger');
    A.eq(declinedRec.outcome.adopted, false, 'DENY is not adoption');
    const kind2 = prefs2.model && prefs2.model.kinds && prefs2.model.kinds['advance-goal'];
    A.ok(kind2 && kind2.negative >= 1 && kind2.weight < keptWeight, 'DENY lowers the effective advance-goal preference');
    // a verdict was recorded in the ledger too.
    const led2 = await ledger(B, headers);
    A.ok(led2.some(e => e.reason === 'denied' && e.detail && e.detail.archetype === 'advance-goal'), 'DENY recorded a verdict in the autonomy ledger');

    // ===== 6. PERSISTENCE — one durable authority, with no fresh writes to the compatibility-only legacy file. =====
    const recommendationFile = path.join(ws, 'recommendations.json');
    A.ok(fs.existsSync(recommendationFile), 'the shared recommendation ledger persisted to disk');
    const persisted = JSON.parse(fs.readFileSync(recommendationFile, 'utf8'));
    A.ok(persisted.entries.some(e => e.id === 'nightshift:' + runId && e.state === 'completed') &&
      persisted.entries.some(e => e.id === 'nightshift:' + runId2 && e.state === 'declined'), 'both verdict directions survive in one durable ledger');
    A.eq(fs.existsSync(path.join(ws, 'nightshift.learn.json')), false, 'new installs do not recreate the compatibility-only legacy learn store');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-act.e2e.test');
})().catch(e => { console.log('FAIL: nightshift-act.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
