/* node test/ledger-aux-receipt.http.test.js — a crash after a housekeeping row under a LIVE run's id still leaves that
   run's spend unknown (2026-10-27). Hybrid recall embeds the query inside runOnce and books the call as an aux row under
   the run's id; the boot replay in sidecar/index.js (ledgerIo.readAll) counted ANY row's runId as settled, so it deleted
   the run's dispatch receipt and the next boot read an interrupted run as fully booked. ledger.aux-receipt.test pins
   ledger.js; this proves the host's reader and receipt cleanup on a real sidecar.
     A · seeded crash leftovers: an aux row + its settlement journals + the run's dispatch receipt -> the run is listed
         unsettled, both aux journals are cleared (one replayed into the ledger exactly once), nothing reads as damaged,
         and the Commander's settlement then clears the receipt.
     B · the real crash: a run embeds its recall query (an aux 'embed' row under the run's id), the provider holds the
         answer, the process is SIGKILLed -> the next boot lists that run as unsettled and its spend reads unknown.
   Zero network, fake key, no real spend. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const ledgerRows = ws => { try { return fs.readFileSync(path.join(ws, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
const pendingFiles = ws => { try { return fs.readdirSync(path.join(ws, '.spend-pending')).sort(); } catch (_) { return []; } };
const QUIET = { SKYNET_QUEST_REFRESH: '0', SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0' };

(async () => {
  // ================= A · seeded crash leftovers =================
  {
    const now = Date.now();
    const f = SidecarFixture.create({ prefix: 'ledger-aux-receipt-', timeoutMs: 30000, env: Object.assign({ SKYNET_BUDGET_PER_DAY: '10', SKYNET_AUX_BUDGET: '0' }, QUIET) });
    const ws = f.workspace, dir = path.join(ws, '.spend-pending');
    const row = (o) => Object.assign({ agentId: 'agent', turns: 0, tokens: 12, model: 'embed/m', unmetered: false }, o);
    const prior = row({ runId: 'prior', turns: 1, usd: 0.5, tokens: 10, model: 'test/m', ts: now - 1000, entryId: 'e-prior' });
    const aux1 = row({ runId: 'live-run', usd: 0.01, aux: 'embed', ts: now - 500, entryId: 'e-aux-1' });
    const aux2 = row({ runId: 'live-run', usd: 0.02, aux: 'embed', ts: now - 400, entryId: 'e-aux-2' });
    fs.writeFileSync(path.join(ws, 'ledger.jsonl'), JSON.stringify(prior) + '\n' + JSON.stringify(aux1) + '\n');
    fs.mkdirSync(dir, { recursive: true });
    const dispatch = sha('live-run') + '.json';
    fs.writeFileSync(path.join(dir, dispatch), JSON.stringify({ runId: 'live-run', agentId: 'agent', ts: now - 600, provider: 'openrouter', model: 'test/m' }));
    // aux1 was appended but the crash beat its cleanup; aux2 was journaled but never reached the ledger
    fs.writeFileSync(path.join(dir, sha('settlement:e-aux-1') + '.json'), JSON.stringify({ runId: 'live-run', entry: aux1 }));
    fs.writeFileSync(path.join(dir, sha('settlement:e-aux-2') + '.json'), JSON.stringify({ runId: 'live-run', entry: aux2 }));
    try {
      for (let boot = 0; boot < 2; boot++) {
        await f.start();
        const res = await f.json('GET', '/api/budget/status');
        A.eq(res.status, 200, 'A boot ' + boot + ': the spend status reads (no SPEND_RECEIPT_DAMAGED from an aux journal)');
        const st = res.body || {};
        A.eq((st.unsettled || []).map(r => [r.runId, r.provider, r.model]), [['live-run', 'openrouter', 'test/m']], 'A boot ' + boot + ': the run is listed unsettled — its aux rows did not settle it');
        A.eq(st.spentToday, null, 'A boot ' + boot + ': its spend reads unknown, never fully booked');
        A.ok(st.atLeast && near(st.atLeast.today, 0.53), 'A boot ' + boot + ': the known rows, both aux charges included, are a floor: ' + JSON.stringify(st.atLeast));
        A.eq(pendingFiles(ws), [dispatch], 'A boot ' + boot + ': both aux journals are cleared, the dispatch receipt stays');
        A.eq(ledgerRows(ws).filter(r => r.entryId === 'e-aux-2').length, 1, 'A boot ' + boot + ': the journaled aux row is replayed exactly once');
        await f.stop();
      }
      await f.start();
      const settled = await f.json('POST', '/api/budget/settle', { runId: 'live-run', usd: 0.3 });
      A.eq(settled.status, 200, 'A: the Commander can settle the run');
      A.ok(near(settled.body && settled.body.spentToday, 0.83), 'A: the entered charge joins the aux rows: ' + JSON.stringify(settled.body && settled.body.spentToday));
      A.eq([(settled.body.unsettled || []).length, pendingFiles(ws)], [0, []], 'A: that row (not an aux one) clears the receipt');
      await f.restart();
      const after = (await f.json('GET', '/api/budget/status')).body || {};
      A.ok(near(after.spentToday, 0.83) && (after.unsettled || []).length === 0, 'A: the settlement survives restart exactly once: ' + JSON.stringify({ spentToday: after.spentToday, unsettled: after.unsettled }));
      await f.stop();
    } finally { await f.dispose(); }
  }

  // ================= B · the real crash after a mid-run recall embed =================
  {
    const MODEL = 'run/model', EMBED_MODEL = 'openai/text-embedding-3-small';
    const count = { chat: 0, embed: 0 };
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0.000001', completion: '0.000002' } }] }));
        return;
      }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        if (req.url.indexOf('/embeddings') >= 0) {
          count.embed++;
          const body = JSON.parse(raw);
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: [1, 0, 0] })), usage: { prompt_tokens: 5 * inputs.length, total_tokens: 5 * inputs.length } }));
          return;
        }
        if (req.url.indexOf('/chat/completions') >= 0) { count.chat++; return; }   // the provider accepted it: hold the answer until the crash
        res.writeHead(404); res.end();
      });
    });
    await new Promise(r => server.listen(0, HOST, r));
    const base = 'http://' + HOST + ':' + server.address().port + '/api/v1';
    const f = SidecarFixture.create({ prefix: 'ledger-aux-crash-', timeoutMs: 30000, env: Object.assign({ SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_BUDGET_PER_DAY: '10' }, QUIET) });
    const ws = f.workspace;
    // one memory to recall: the run embeds it and its query through the hybrid lane before the first model call
    fs.writeFileSync(path.join(ws, 'agent.notebook.json'), JSON.stringify([{ id: 'mem-rollback', kind: 'note', title: 'Rollback notes', body: 'Keep rollback notes in every deploy summary.', ts: Date.now() - 60000 }]));
    try {
      await f.start();
      const cfg = await f.json('POST', '/api/memory/config', { embedModel: EMBED_MODEL });
      A.eq(cfg.body && cfg.body.embedEnabled, true, 'B: the embedding lane is live');
      const running = f.request('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent', provider: 'openrouter', model: MODEL, key: 'sk-or-v1-aux-receipt-fake', baseUrl: base, isTask: false, messages: [{ role: 'user', content: 'Write the deploy summary with the rollback notes' }] })
      }).then(r => r.text()).catch(() => '');
      for (let i = 0; i < 300 && count.chat < 1; i++) await sleep(50);
      A.eq(count.chat, 1, 'B: the provider accepted the run\'s model call (held) before the crash');
      A.ok(count.embed >= 1, 'B: the run embedded its recall query first');
      const embeds = ledgerRows(ws).filter(r => r.aux === 'embed');
      A.eq(embeds.length, 1, 'B: the embed is booked mid-run as an aux row: ' + JSON.stringify(embeds));
      const runId = embeds.length ? embeds[0].runId : '';
      A.ok(/\S/.test(runId), 'B: the aux row carries the live run\'s id');
      A.ok(!ledgerRows(ws).some(r => r.runId === runId && !r.aux), 'B: the run itself has not booked yet');
      A.ok(pendingFiles(ws).indexOf(sha(runId) + '.json') >= 0, 'B: the run\'s dispatch receipt is on disk before the crash');
      f.child.kill('SIGKILL'); await f.stop(); await running; server.closeAllConnections();
      for (let boot = 0; boot < 2; boot++) {
        await f.start();
        const st = (await f.json('GET', '/api/budget/status')).body || {};
        A.eq((st.unsettled || []).map(r => r.runId), [runId], 'B boot ' + boot + ': the next boot lists the crashed run as unsettled: ' + JSON.stringify(st.unsettled));
        A.eq(st.spentToday, null, 'B boot ' + boot + ': its spend reads unknown, never as fully booked by the embed row');
        await f.stop();
      }
    } finally { await f.dispose(); server.close(); }
  }

  A.report('ledger-aux-receipt.http.test');
})().catch(e => { console.log('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
