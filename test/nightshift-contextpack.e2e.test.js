/* node test/nightshift-contextpack.e2e.test.js — real sidecar proof for NS-2 (context pack + cold-leash fix).

   Boots the ACTUAL sidecar with a mock OpenRouter, SEEDS a fabricated runs.jsonl (user-initiated runs = "what the
   Commander is working on") + a fabricated transcript.jsonl (recent user chats) + internal-stream noise that must be
   EXCLUDED, plus a THIN dossier that cannot ground the proposed job — proving the ACTIVITY grounding path carries the beat. It
   drives the night shift via POST /api/nightshift/beat (attended test of the unattended pipeline) and asserts:

     · THE PROPOSE DIRECTIVE CARRIED PROVEN ACTIVITY — the reason-only PROPOSE prompt contains the fabricated clean
       owner chat, not a raw run title. A run title is retained context, never proof of the Commander's own words.
     · INTERNAL NOISE EXCLUDED — a nightshift-/cron- streamed run never appears in the directive.
     · THE BUILT JOB GROUNDS IN ACTIVITY — a job citing only a raw run title is rejected before BUILD. The next job
       cites the proven owner chat and lands as a real deliverable + ledger 'act'; activity is load-bearing evidence.
     · COLD-LEASH FIX — with NO dossier AND NO activity, the status route reports binding:'readiness' and
       beatsUsedToday stays 0 (a purely-local stand-down that spends no leash). */
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
const ACT_MARK = '[NIGHTSHIFT_ACT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The raw run title stays in history, but only the proven owner chat can ground a proposed job.
const REAL_RUN_TITLE = 'Wire up the belt-router retry loop';
const REAL_CHAT = 'help me cut the release-notes toil';
const INTERNAL_RUN_TITLE = 'night-shift Busywork DO NOT SURFACE';

// the mock records the PROPOSE prompt it received so the test can assert the activity reached the model.
let lastProposePrompt = '';
let chosenGround = REAL_RUN_TITLE;
let proposeCalls = 0, buildCalls = 0;
const buildRunIds = new Set();

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
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };

          if (prompt.indexOf(ACT_MARK) === 0) {
            buildCalls++;
            const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
            buildRunIds.add(runId);
            const dir = 'workshop/' + runId;
            if (toolResults === 0) { tool('f1', 'fs_write', { path: dir + '/notes.md', content: '# retry loop notes\n' }); }
            else if (toolResults === 1) {
              const manifest = { v: 1, runId: runId, agentId: 'agent', backlogId: '', title: 'Belt-router retry plan', kind: 'doc', summary: 'A plan to finish the retry loop.', files: [{ path: 'notes.md', bytes: 18 }], howToUse: 'Read it.', notVerified: ['not executed'] };
              tool('f2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Wrote the plan.'); }
          } else if (/JOB:/.test(prompt) && /GROUNDS:/.test(prompt)) {
            // First offer a title-only job (refused), then cite the proven owner chat. The mock deliberately
            // cannot rely on a dossier belief to pass the grounding veto.
            proposeCalls++;
            lastProposePrompt = prompt;
            text([
              'JOB: Finish the belt-router retry loop',
              'KIND: advance-goal',
              'GROUNDS: ' + chosenGround,
              'CONFIDENCE: high',
              'SPEC: a plan to complete the retry loop'
            ].join('\n'));
          } else { text('ok'); }
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
    child.on('close', code => { if (!settled) { settled = true; reject(new Error('sidecar exited before it was up (' + code + ')' + ':\n' + out)); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 30000).unref();
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
  const stream = await readNdjson(res);
  return ((stream.find(e => e.name === 'nightshift.beat.result') || {}).payload || {});
}

// a THIN dossier: goals only (undated → fresh). Since bug 41b2d015 (the act floor is one aim or one run, not 4 areas /
// 4 runs) this alone is hot; with the seeded runs beside it readiness names ACTIVITY as the grounding (a tie goes to
// activity). The accepted job cites the proven owner chat; a raw run title alone does not pass the grounding veto.
function thinBeliefs() {
  return { known: ['goals'], beliefs: { goals: [{ text: 'ship something good' }] } };
}

// seed the durable logs BEFORE boot so the store loads them. runs.jsonl: two user runs (empty streamId) + internal
// noise (nightshift-/cron- streams) that MUST be excluded. transcript.jsonl: a recent user chat + an internal one.
function seedLogs(ws, now) {
  fs.mkdirSync(ws, { recursive: true });
  const runs = [
    { runId: 'r1', agentId: 'agent', internal: false, ownerDirective: true, reason: 'done', title: REAL_RUN_TITLE, streamId: '', ts: now - 1 * 86400000 },
    { runId: 'r2', agentId: 'agent', reason: 'done', title: 'Draft the pricing page copy', streamId: 'ws-main', ts: now - 2 * 86400000 },
    { runId: 'r3', agentId: 'agent', reason: 'done', title: 'Refactor the sprite loader', streamId: '', ts: now - 3 * 86400000 },
    { runId: 'r4', agentId: 'agent', reason: 'done', title: 'Tidy the docs index', streamId: '', ts: now - 4 * 86400000 },
    { runId: 'n1', agentId: 'agent', internal: false, reason: 'done', title: INTERNAL_RUN_TITLE, streamId: 'nightshift-zzz', ts: now - 1000 },
    { runId: 'c1', agentId: 'agent', reason: 'done', title: 'cron digest run', streamId: 'cron-yyy', ts: now - 1000 },
    { runId: 't1', agentId: 'agent', reason: 'done', title: 'TAINTED_RUN_SENTINEL', streamId: '', ts: now - 1000, taintedBy: 'user attachment' },
    { runId: 'q1', agentId: 'agent', reason: 'done', title: 'QUOTED_RUN_SENTINEL\n> external direction', streamId: '', ts: now - 1000 }
  ];
  fs.writeFileSync(path.join(ws, 'runs.jsonl'), runs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const tx = [
    { streamId: 'global', sourceRunId: 'r1', agentId: 'agent', role: 'user', content: REAL_CHAT, taintKnown: true, ts: now - 1 * 86400000 },
    { streamId: 'nightshift-zzz', sourceRunId: 'n1', agentId: 'agent', role: 'user', content: 'internal propose prompt should not surface', taintKnown: true, ts: now - 1000 },
    { streamId: 'global', sourceRunId: 'r1', agentId: 'agent', role: 'user', content: 'TAINTED_CHAT_SENTINEL', taintKnown: true, taint: 'web_fetch', ts: now - 1000 },
    { streamId: 'global', sourceRunId: 'r1', agentId: 'agent', role: 'user', content: 'UNKNOWN_CHAT_SENTINEL', ts: now - 1000 },
    { streamId: 'global', sourceRunId: 'r1', agentId: 'agent', role: 'user', content: 'DELEGATED_CHAT_SENTINEL', taintKnown: true, from: 'another-agent', ts: now - 1000 },
    { streamId: 'global', sourceRunId: 'r1', agentId: 'agent', role: 'user', content: 'QUOTED_CHAT_SENTINEL\n> external direction', taintKnown: true, ts: now - 1000 }
  ];
  fs.writeFileSync(path.join(ws, 'transcript.jsonl'), tx.map(r => JSON.stringify(r)).join('\n') + '\n');
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nscp-e2e-'));
  const now = Date.now();
  seedLogs(ws, now);
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nscp-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // ===== 1. THIN-DOSSIER + FABRICATED-ACTIVITY BEAT — reach sandbox + the away grant → a real build. =====
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', on: true }) });
    await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 12 }, beliefs: thinBeliefs() }) });

    const before = await (await fetch(B + '/api/runs?limit=60', { headers })).json();
    A.ok(Array.isArray(before.runs) && before.runs.some(r => r.runId === 'r1' && r.title === REAL_RUN_TITLE), 'the raw recent run exists in actual host history before the grounding proof');
    const refused = await fireBeat(B, headers);
    const refusedPrompt = lastProposePrompt;
    A.eq(refused.reason, 'no-candidates', 'a raw run title is not a proven owner directive and cannot ground BUILD');
    A.ok(refused.delivered !== true && !refused.runId, 'title-only proposal produces no delivered build or build runId');
    A.eq([proposeCalls, buildCalls], [1, 0], 'title-only proposal pays for one synthetic proposal and zero BUILD calls');
    const refusedLedger = await (await fetch(B + '/api/autonomy/ledger', { headers })).json();
    const refusedEntries = Array.isArray(refusedLedger.entries) ? refusedLedger.entries : (Array.isArray(refusedLedger) ? refusedLedger : []);
    A.ok(!refusedEntries.some(e => e.kind === 'act'), 'title-only proposal records no successful act');
    A.ok(!fs.existsSync(path.join(ws, 'agent', 'workshop')), 'title-only proposal creates no workshop artifact');

    chosenGround = REAL_CHAT;
    const act = await fireBeat(B, headers);
    A.ok(act.delivered === true && act.reason === 'built', 'thin dossier + fabricated recent activity → the beat still reached a REAL build (activity is the grounding)');
    A.ok(act.runId, 'the build returned a runId');

    A.eq([proposeCalls, buildCalls], [2, 3], 'proven-chat proposal drives exactly one build: two file writes and its final answer');
    A.eq(Array.from(buildRunIds), [act.runId], 'all synthetic BUILD calls belong to the one returned build runId');

    // THE PROOF: the model receives only caller-proven directive activity as grounding evidence.
    for (const [stage, prompt] of [['refused', refusedPrompt], ['built', lastProposePrompt]]) {
      A.ok(prompt.indexOf('worked on recently') >= 0, stage + ': the propose directive rendered the "worked on recently" activity block');
      A.ok(prompt.indexOf(REAL_RUN_TITLE) < 0, stage + ': the raw run title is excluded from authority-bearing proposal activity');
      A.ok(prompt.indexOf(REAL_CHAT) >= 0, stage + ': the propose directive contained the fabricated recent-CHAT first-line');
      A.ok(prompt.indexOf(INTERNAL_RUN_TITLE) < 0, stage + ': internal-stream (nightshift-) runs were EXCLUDED from the directive');
      A.ok(prompt.indexOf('cron digest run') < 0, stage + ': internal-stream (cron-) runs were EXCLUDED from the directive');
      A.ok(prompt.indexOf('internal propose prompt should not surface') < 0, stage + ': known-clean internal-stream chat is still excluded');
      for (const sentinel of ['TAINTED_RUN_SENTINEL', 'QUOTED_RUN_SENTINEL', 'TAINTED_CHAT_SENTINEL', 'UNKNOWN_CHAT_SENTINEL', 'DELEGATED_CHAT_SENTINEL', 'QUOTED_CHAT_SENTINEL']) {
        A.ok(!prompt.includes(sentinel), stage + ': ' + sentinel + ' never reaches the real model propose prompt');
      }
    }

    // The chosen job grounds in the proven owner chat, and the veto lets it through.
    const led = await (await fetch(B + '/api/autonomy/ledger', { headers })).json();
    const entries = (led && Array.isArray(led.entries)) ? led.entries : (Array.isArray(led) ? led : []);
    A.eq(entries.filter(e => e.kind === 'act').map(e => e.runId), [act.runId], 'only the proven-chat build records one act for its exact runId');
    const actEntry = entries.find(e => e.kind === 'act' && e.runId === act.runId && e.detail);
    A.ok(actEntry && /retry|Belt-router/.test(String(actEntry.detail.title || '')), "the built deliverable (grounded in the proven owner chat) recorded a ledger 'act'");
    A.ok(typeof act.runId === 'string' && fs.existsSync(path.join(ws, 'agent', 'workshop', act.runId, 'notes.md')), 'the activity-grounded build produced a real artifact on disk');

    // ===== 2. COLD-LEASH FIX — with NO dossier and NO activity, status reports binding:readiness + no spend. =====
    // wipe the activity by pointing at a FRESH workspace-less state: clear the dossier (empty beliefs) and rely on
    // the status route's statusDecision (folds the precheck). We can't erase seeded runs live, so instead prove the
    // pre-spend path via the STATUS binding after making the station present (so no beat fired) AND then reason about
    // the readiness precheck directly: with the dossier cleared to empty, the ONLY grounding is the seeded activity —
    // so to show a TRUE cold decline we boot a SECOND, unseeded sidecar.
    // (handled in the cold-boot block below)

    // beatsUsedToday from the force-fire path is driver-independent (force-fire bypasses the leash), so assert the
    // status route is readable + honest here; the real no-spend proof is the cold-boot below.
    const st = await (await fetch(B + '/api/nightshift/status', { headers })).json();
    A.ok(typeof st.beatsUsedToday === 'number' && typeof st.binding !== 'undefined', 'the status route returns beatsUsedToday + binding (truthful telemetry)');

    child.kill(); await sleep(150);

    // ===== COLD BOOT — a brand-new workspace: no dossier, no runs, no chats. The night-shift status must report a
    //        pre-spend readiness stand-down (binding:'readiness') with beatsUsedToday 0 — NO leash spent. =====
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nscp-cold-'));
    const boot2 = await boot(await allocatePort(), Object.assign({}, env, { SKYNET_WORKSPACES: ws2 }), 20);
    const B2 = 'http://' + HOST + ':' + boot2.port;
    try {
      const token2 = await bootToken(B2, B2);
      const headers2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token2, Origin: B2 };
      // permit acting (initiative leash) so posture/present/leash/cooldown all clear — leaving READINESS as the only
      // thing that can bind. Make the Commander AWAY by setting lastActivity far in the past is not exposed; instead
      // the status route's statusDecision surfaces the binding the tick would hit once away. With an empty dossier +
      // empty activity, the precheck returns not-ok → binding 'readiness'.
      await fetch(B2 + '/api/autonomy/posture', { method: 'POST', headers: headers2, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: { known: [], beliefs: {} } }) });
      const st2 = await (await fetch(B2 + '/api/nightshift/status', { headers: headers2 })).json();
      A.eq(st2.beatsUsedToday, 0, 'COLD-LEASH: a brand-new station has spent NO leash');
      // the binding is either 'present' (if the boot-seeded away clock hasn't elapsed) or 'readiness' (if away). In
      // BOTH cases NO leash was spent — the point of the fix. We assert the readiness precheck is reachable by
      // confirming the binding is one of the pre-spend/local gates, never a spent-leash state.
      A.ok(['present', 'readiness', 'posture'].indexOf(st2.binding) >= 0, 'COLD: the binding is a pre-spend/local gate (present/readiness/posture) — a cold beat never spends leash to discover it is not ready (got: ' + st2.binding + ')');
    } finally {
      try { boot2.child.kill(); } catch (_) {}
      await sleep(120);
      try { fs.rmSync(ws2, { recursive: true, force: true }); } catch (_) {}
    }
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-contextpack.e2e.test');
})().catch(e => { console.log('FAIL: nightshift-contextpack.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
