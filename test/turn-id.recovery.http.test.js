'use strict';
/* node test/turn-id.recovery.http.test.js — a recovery continuation answers its SOURCE's turn (turn identity, commit 3; A2-SP-03).

   Real sidecar. Before boot the fixture workspace is seeded with what a station killed mid-run leaves behind: the run
   journal of the interrupted source run (its begin record names turn T1; a read-only tool call had begun) and the
   transcript, holding T1's directive row and then a LATER turn T2 (the page's tail has moved on). Proves:
     1. the interrupted run's history record names its turn and directive row (turnId T1 + directiveRowId), from the journal
     2. a continuation POSTed while the page names T2 (turnId:T2, retryOf:T2, as a page that sent its tail ids would)
        answers T1: run.start.turnId == T1, the page's ids are ignored and counted (turn.recovery.ids-ignored)
     3. every row the continuation writes carries T1; T2's rows are untouched (same rows, same rowIds); T1 still holds ONE
        directive row
     4. (commit 4) the source's journal names its directive title (the typed caption, 'quokka plan'; its userTitle is the
        longer expanded text): the interrupted record and the continuation's run are both titled by it, through the one
        runTitle (scrubStored(nameSavedKeys(…)), cut at 120 by runstore) */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const TurnKinds = require('../frontend/app/turnkinds.js');

const requests = [];
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Continued from the checkpoint: the quokka plan is ready.' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});

(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const orBase = 'http://127.0.0.1:' + mock.address().port + '/api/v1';
  const fx = SidecarFixture.create({ prefix: 'turn-id-recovery-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-turn-recovery-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-turn-recovery-fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const S = 'turn-recovery', SRC = 'src-run-0001';
  const T1 = TurnKinds.mintTurnId(() => 0.11), T2 = TurnKinds.mintTurnId(() => 0.77);
  const words = 'quokka plan: list the three habitats';
  const typedTitle = 'quokka plan';   // the source's captured wording (its journal directiveTitle)
  const diskRows = () => {
    const root = path.join(fx.workspace, 'transcript-history-v2');
    const out = [];
    for (const f of fs.readdirSync(root).filter(n => /^segment-\d{6}\.jsonl$/.test(n))) for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
      if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && r.streamId === S) out.push(r); } catch (_) {}
    }
    return out;
  };
  const tagCount = tag => { let n = 0; const re = /\[failopen\] ([^\s]+) \(x(\d+)\)/g; let m; while ((m = re.exec(fx.output()))) if (m[1] === tag) n = Math.max(n, Number(m[2])); return n; };
  try {
    // ---- the station a kill left behind ----
    const now = Date.now();
    fs.mkdirSync(path.join(fx.workspace, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(fx.workspace, 'agent', 'habitats.txt'), 'forest, scrub, coast', 'utf8');
    const journal = makeRunJournal({ dir: path.join(fx.workspace, '.run-journal') });
    journal.begin({ turnId: T1, directiveTitle: typedTitle, runId: SRC, agentId: 'agent', streamId: S, trigger: 'directive', model: 'test/model', userTitle: words, startedAt: now - 60000 });
    journal.checkpoint(SRC, { phase: 'initial', turn: 0, messages: [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: words }] });
    journal.checkpoint(SRC, { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"habitats.txt"}' } }] }] });
    journal.toolIntent(SRC, { callId: 'read-1', name: 'fs.read', argsRaw: '{"path":"habitats.txt"}', mutating: false, boundaryModel: 'prepared-dispatch-v1' });
    journal.toolDispatch(SRC, { callId: 'read-1', name: 'fs.read', mutating: false });
    const quick = Object.create(fs); quick.fsyncSync = () => {};
    const io = makeSegmentedTranscriptIo({ fs: quick, path, root: path.join(fx.workspace, 'transcript-history-v2') });
    const d1 = io.appendDurable({ streamId: S, agentId: 'agent', role: 'user', content: words, ts: now - 60000, turnId: T1, directive: true, sourceRunId: SRC });
    const t2u = io.appendDurable({ streamId: S, agentId: 'agent', role: 'user', content: 'and a later question', ts: now - 30000, turnId: T2, directive: true, sourceRunId: 'later-run-0001' });
    const t2a = io.appendDurable({ streamId: S, agentId: 'agent', role: 'assistant', content: 'A later answer.', ts: now - 29000, turnId: T2, sourceRunId: 'later-run-0001' });
    io.close();
    const t2Before = JSON.stringify([t2u, t2a].map(r => [r.rowId, r.role, r.content, r.turnId]));

    await fx.start();

    // 1. the interrupted record names its turn and directive row
    const recs = await fx.json('GET', '/api/run-recoveries');
    const row = ((recs.body && recs.body.recoveries) || []).find(x => x.runId === SRC);
    A.ok(row && row.canAutoContinue, 'fixture: the interrupted source is listed and safe to continue automatically');
    const hist = (((await fx.json('GET', '/api/runs?agent=agent&runId=' + SRC)).body || {}).runs || []).find(x => x.runId === SRC) || {};
    A.eq([hist.reason, hist.turnId, hist.directiveRowId], ['interrupted', T1, d1.rowId], 'the interrupted run\'s record names its turn and directive row');
    A.eq(hist.title, typedTitle, 'the interrupted record is titled by the journal\'s directive title, not its userTitle');

    // 2. continue while the page names its tail turn T2
    const prepared = await fx.json('POST', '/api/run-recoveries/continue', { runId: SRC, agentId: 'agent', recoveryToken: row && row.recoveryToken, continuationId: 'cont-0001', mode: 'automatic' });
    A.eq(prepared.status, 200, 'fixture: the continuation is prepared');
    const r = await fx.json('POST', '/api/run', {
      model: 'test/model', provider: 'openrouter', agentId: 'agent', isTask: true, streamId: S, system: '', messages: [],
      turnId: T2, retryOf: T2, turnAt: now - 30000, clientNow: Date.now(),
      recovery: { sourceRunId: SRC, continuationId: 'cont-0001', continuationToken: prepared.body && prepared.body.continuationToken }
    });
    A.eq(r.status, 200, 'fixture: the continuation streams');
    const events = String(r.text || '').split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
    const start = (events.find(e => e.name === 'agent.run.start') || {}).payload || {};
    A.eq(start.turnId, T1, 'run.start.turnId == T1: the continuation answers its source\'s turn, not the page\'s T2');
    A.ok(requests.length >= 1, 'fixture: the continuation reached the provider');
    A.ok(tagCount('turn.recovery.ids-ignored') >= 1, 'the page\'s ids are ignored and counted (turn.recovery.ids-ignored)');

    // 3. the rows
    const rows = diskRows();
    const mine = rows.filter(x => x.sourceRunId === start.runId);
    A.ok(mine.length >= 1, 'fixture: the continuation wrote rows (' + mine.length + ')');
    A.ok(mine.every(x => x.turnId === T1), 'every continuation row carries T1: ' + JSON.stringify(mine.map(x => [x.role, x.turnId])));
    A.eq(JSON.stringify(rows.filter(x => x.turnId === T2).map(x => [x.rowId, x.role, x.content, x.turnId])), t2Before, 'T2\'s rows are untouched');
    A.eq(rows.filter(x => x.role === 'user' && x.directive === true && x.turnId === T1).length, 1, 'T1 holds ONE directive row');

    // 4. the continuation's own run is titled by its source's directive title
    let cont = null;
    for (let i = 0; i < 30 && !cont; i++) {
      cont = (((await fx.json('GET', '/api/runs?agent=agent&runId=' + start.runId)).body || {}).runs || []).find(x => x.runId === start.runId) || null;
      if (!cont) await new Promise(res => setTimeout(res, 100));
    }
    A.eq(cont && cont.title, typedTitle, 'the continuation\'s run is titled by its source\'s directive title (the recovery capture), not the recovered prompt');
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    try { await fx.dispose(); } catch (_) {}
    mock.close();
  }
  A.report('turn-id.recovery.http');
})();
