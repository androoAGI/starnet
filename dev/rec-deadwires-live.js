/* node dev/rec-deadwires-live.js — LIVE PROOF of the rec dead-wires lane (2026-08-28).
   Boots a REAL sidecar on an isolated temp workspace, then drives the REAL browser modules
   (frontend/app/recledger.js + recqualitystore.js) over real HTTP — the exact production seam:
     note() → accepted() → run completes → Commander rates 'great' → settle() posts to the server.
   Proves, against the live durable ledger:
     1. the spine impression lands with a declared expiresAt (the TTL writer exists)
     2. the accepted row advances to state `completed` when the attributed run finishes
     3. the Commander's 👍 lands as outcome.quality=1 with the run id (spine outcomes reach the server)
     4. the learned model now reads the kind positive (replay() is no longer blind to the spine)
     5. ALL of it survives a sidecar restart (persistence, the top recurring bug class). */
'use strict';
const A = require('../test/_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('../test/_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('../test/helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rec-deadwires-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_KEY: 'sk-or-v1-deadwires-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  let child, port;
  try {
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // the REAL browser modules, driven over the REAL wire (injected fetch adds the launch token)
    const { RecLedger } = require('../frontend/app/recledger.js');
    global.RecQuality = require('../frontend/app/recquality.js');
    const mem = {};
    global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
    const { RecQualityStore } = require('../frontend/app/recqualitystore.js');
    const liveFetch = (u, init) => fetch(B + u, Object.assign({}, init, { headers: Object.assign({}, headers, (init && init.headers) || {}) }));
    RecLedger.init({ fetch: liveFetch });
    RecQualityStore.init({ recLedger: RecLedger });

    // the production sequence: offer shown → accepted → run claims the stamp → run finishes → Commander rates it
    const rowId = RecLedger.note({ kind: 'seed', title: 'summarize my inbox every morning', why: 'you keep asking me to “summarize my inbox” (4×)' });
    A.ok(rowId.indexOf('spine:seed:') === 0, 'note() minted a spine row against the LIVE server');
    RecLedger.accepted('seed');
    RecQualityStore.noteAccept({ channel: 'seed', dim: '', spawnsWork: true, id: rowId });
    RecQualityStore.claimForRun('run-live-1', 'agent');
    RecQualityStore.onRunEnd({ runId: 'run-live-1', reason: 'done' });
    RecQualityStore.noteVerdict('run-live-1', 'great');
    await sleep(600);   // the posts are fire-and-forget; let them land on the durable store

    const read = async () => {
      const r = await fetch(B + '/api/recommendations?surface=spine&limit=10', { headers });
      A.eq(r.status, 200, 'GET /api/recommendations answers');
      return r.json();
    };
    let j = await read();
    let row = (j.entries || []).find(e => e.id === rowId);
    A.ok(!!row, 'the impression is on the durable ledger');
    A.ok(row.expiresAt > 0, '…and it DECLARED an expiry (' + row.expiresAt + ') — the TTL writer exists');
    A.eq(row.state, 'completed', 'the attributed run finishing advanced the row to `completed` on the server');
    A.eq(row.outcome.quality, 1, 'the Commander’s 👍 landed as outcome.quality=1 — spine outcomes reach the durable ledger');
    A.eq(row.outcome.runId, 'run-live-1', '…attributed to the run that earned it');
    const m = await (await fetch(B + '/api/recommendations?state=declined&limit=250', { headers })).json();
    A.ok(m.model && m.model.kinds && m.model.kinds.seed && m.model.kinds.seed.weight > 0,
      'replay() now reads the seed kind POSITIVE from the spine’s own outcome (weight=' + (m.model && m.model.kinds && m.model.kinds.seed && m.model.kinds.seed.weight) + ')');

    // persistence: restart the sidecar on the same workspace — the outcome must survive
    try { child.kill(); } catch (_) {}
    await sleep(400);
    ({ child, port } = await boot(port, env, 20));
    const B2 = 'http://' + HOST + ':' + port;
    const token2 = await bootToken(B2, B2);
    const h2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token2, Origin: B2 };
    const j2 = await (await fetch(B2 + '/api/recommendations?surface=spine&limit=10', { headers: h2 })).json();
    const row2 = (j2.entries || []).find(e => e.id === rowId);
    A.ok(!!row2 && row2.state === 'completed' && row2.outcome.quality === 1,
      'the completed row and its quality SURVIVED a sidecar restart (state=' + (row2 && row2.state) + ', q=' + (row2 && row2.outcome && row2.outcome.quality) + ')');

    A.report('rec-deadwires live proof');
  } finally {
    try { child && child.kill(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
