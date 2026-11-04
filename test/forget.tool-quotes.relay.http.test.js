'use strict';
/* node test/forget.tool-quotes.relay.http.test.js — A WORKER'S READS ARE ITS LEAD'S (turn identity commit 11, A2-FP-02, Q25, Q27).

   A lead dispatches a worker through the real team.dispatch; the worker reads sessions through the real recall tool and answers with their words; the
   lead answers with the worker's. One REAL station, a scripted model that plays both. Sessions are seeded straight into the transcript (a01-a30 are the
   lead's reading material, q01-q25 the workers' and the deleted ones, u01/u02 unrelated). Each leg has its own lead and its own words.

     r1   the worker read S and returns a quote of it: the lead's rows from the result on carry S (the live chain), and a delete of S hides them; the rows
          from before the dispatch stay
     r2   the lead holds 30 latched sources, the worker reads 5 others (S, the oldest, in none of the lead's list): the lead saturates (its rows say '*'),
          and deleting S alone hides every lead row drained after the relay and none before it, with and without a restart
     r3   the worker is no longer live and its run record is gone when a later lead collects its answer: that lead saturates (read from no record); a delete of
          anything stamped at or after its start hides its later rows
     r4   control for the cost side: a session deleted BEFORE the lead began leaves its rows visible, with and without a restart
     r5   the conservative boundary: an unrelated session is deleted after the lead started and before the relay saturated it: every lead row drained after
          the saturation is hidden, the ones before stay, with and without a restart
     r6   the delete lands while the worker that read S is still running (its next model call is held): the lead above it holds S through the live chain, so
          the delete stops the lead too (it ends cancelled), and no model call made after the delete carries a word of S */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const { station, seedRows, rowsText, gate, sleep, until } = require('./helpers/forget-quotes.js');

const WORKER = { agentId: 'worker-1', system: 'WORKER_MARK you are a worker.', name: 'WORKER', model: 'test/model', provider: 'openrouter', approvalMode: 'ask' };
const at0 = Date.now() - 3600 * 1000;
const word = id => 'Sent-' + id;
const GROUP = { a: ['amber', 1, 15, 'a'], b: ['brass', 16, 30, 'a'], r1: ['cobalt', 1, 5, 'q'], r2: ['delta', 6, 10, 'q'], r4: ['epsilon', 11, 15, 'q'], r5: ['zeta', 16, 20, 'q'], r3: ['eta', 21, 25, 'q'], r6: ['fennec', 26, 30, 'q'] };
const nid = (prefix, n) => prefix + String(n).padStart(2, '0');
const sentinels = text => Array.from(new Set(String(text).match(/Sent-[aqu]\d\d/g) || []));

(async () => {
  const rig = await station('forget-quotes-relay-', { crew: [WORKER] });
  const { up } = rig;
  const failed = [];
  const leg = async (name, fn) => { if (process.env.FQ_ONLY && !process.env.FQ_ONLY.split(',').includes(name)) return; if (process.env.FQ_TRACE) console.log('[leg] ' + name); try { await fn(); } catch (e) { failed.push(name); console.error('LEG ' + name + ' THREW', e && e.stack || e); A.ok(false, 'leg ' + name + ' ran to its end (' + ((e && e.message) || e) + ')'); } };
  const rowsOf = async stream => (await rig.transcript(stream)).turns;
  const idsOf = rows => rows.map(r => r.rowId);
  const lastTool = ctx => ctx.toolResults[ctx.toolResults.length - 1] || '';
  // the scripted model: a worker (its system says so) recalls its group and reports the words it found; a lead plays the script the leg gave it
  const lead = {}, workerHold = {};
  const behave = ctx => {
    if (/WORKER_MARK/.test(ctx.system)) {
      const tag = (/\((r\d)\)/.exec(ctx.userText) || [])[1];
      if (!tag || !GROUP[tag]) return { text: 'nothing to do' };
      if (workerHold[tag] && ctx.made('recall_conversation') > 0) return { hold: workerHold[tag], partial: 'WORKER PARTIAL (' + tag + '): ' + sentinels(lastTool(ctx)).join(' ') };   // a worker that has read its group and is held at its next call
      return ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: GROUP[tag][0], scope: 'all', limit: 20 } } : { text: 'WORKER REPORT (' + tag + '): ' + sentinels(lastTool(ctx)).join(' ') };
    }
    const tag = (/\((r\d)\)/.exec(ctx.userText) || [])[1];
    return lead[tag] ? lead[tag](ctx) : { text: 'ok' };
  };
  up.behave = ctx => { const act = behave(ctx); if (process.env.FQ_TRACE) console.log('[model]', /WORKER_MARK/.test(ctx.system) ? 'worker' : 'lead', (/((rd))/.exec(ctx.userText) || [])[1], JSON.stringify(act).slice(0, 160)); return act; };
  const dispatchWorker = tag => ({ tool: 'team_dispatch', args: { workers: [{ agentId: 'worker-1', prompt: 'WORKER TASK (' + tag + '): recall your group and report the words' }] } });
  // lead script: n reads (amber, then brass), then [hold], then the dispatch, then an answer quoting the worker
  const leadScript = (tag, o) => ctx => {
    const reads = ctx.made('recall_conversation');
    if (o && o.reads >= 1 && reads === 0) return { tool: 'recall_conversation', args: { query: 'amber', scope: 'all', limit: 20 } };
    if (o && o.reads >= 2 && reads === 1) return { tool: 'recall_conversation', args: { query: 'brass', scope: 'all', limit: 20 } };
    if (ctx.made('team_dispatch') === 0) return o && o.hold && !o.held ? (o.held = true, { hold: o.hold, then: dispatchWorker(tag) }) : dispatchWorker(tag);
    return { text: 'The worker reported: ' + sentinels(lastTool(ctx)).join(' ') };
  };
  try {
    await rig.start();
    const rows = [];
    const seedGroup = ([group, from, to, prefix]) => {
      for (let n = from; n <= to; n++) {
        const id = nid(prefix, n), turn = 'seed_' + id + '_01';
        rows.push({ streamId: id, agentId: 'agent', role: 'user', content: 'tell me about the topic of ' + id, ts: at0 + n * 10, turnId: turn, kind: 'turn', directive: true, taint: null, taintKnown: true });
        rows.push({ streamId: id, agentId: 'agent', role: 'assistant', content: 'About ' + group + ': ' + word(id) + ' is the word of session ' + id + '.', ts: at0 + n * 10 + 1, turnId: turn, kind: 'turn', taint: null, taintKnown: true });
      }
    };
    for (const g of Object.values(GROUP)) seedGroup(g);
    for (const u of ['u01', 'u02']) rows.push({ streamId: u, agentId: 'agent', role: 'assistant', content: 'unrelated ' + word(u), ts: at0 + 5, turnId: 'seed_' + u + '_01', kind: 'turn', taint: null, taintKnown: true });
    await seedRows(rig, rows);
    const all = [...new Set(rows.map(r => r.streamId))];
    await rig.list(...all.map(id => [id, 'session ' + id]), ['l1', 'lead one'], ['l2', 'lead two'], ['l3', 'lead three'], ['l3b', 'lead three b'], ['l4', 'lead four'], ['l5', 'lead five'], ['l6', 'lead six']);

    // after-the-fact checks every leg shares: what the lead's rows say, and what a model is handed
    const rowsAfter = rowsOf;
    const replayHas = async (stream, words) => {
      const at = Date.now(), keep = up.behave;
      up.behave = () => ({ text: 'replayed' });
      try { await rig.run(stream, 'one more thing here', { windowFrom: 'station', turnId: 'replay_' + stream + '_' + at, turnAt: at, clientNow: at, windowTokens: 92800 }); } finally { up.behave = keep; }
      return words.filter(w => up.bodies.some(b => b.at >= at && b.text.includes(w)));
    };

    // ---------------- r1
    await leg('r1', async () => {
      lead.r1 = leadScript('r1', { reads: 0 });
      const run = await rig.run('l1', 'ask the worker to look (r1)');
      A.eq(run.end && run.end.reason, 'done', 'r1: the lead completes');
      const before = await rowsAfter('l1');
      const toolRow = before.find(r => r.role === 'tool' && /WORKER REPORT \(r1\)/.test(r.content));
      A.ok(toolRow && sentinels(toolRow.content).length > 0, 'r1: the worker\'s answer reached the lead with its words: ' + sentinels(rowsText(before)).join(' '));
      const said = sentinels(rowsText(before));
      const S = said[0].slice(5);   // 'q01' ... the first session the worker's answer quotes
      A.ok(toolRow.quotes && toolRow.quotes.includes(S), 'r1: the lead\'s result row carries the worker\'s read ' + S + ' (the live chain): ' + JSON.stringify(toolRow.quotes));
      const directive = before.find(r => r.role === 'user' && /\(r1\)/.test(r.content));
      A.ok(directive && !directive.quotes, 'r1: the lead\'s directive predates the dispatch and carries nothing');
      // the worker's own run record (the dispatch result names its run; agent=* because the route answers for the Commander's agent by default): its brief was composed from the lead's conversation, so it quotes the lead's session before any tool ran, and the session it read
      const workerRunId = (/"runId"\s*:\s*"([^"]+)"/.exec(toolRow.content) || [])[1];
      const workerRun = workerRunId && ((await rig.json('GET', '/api/runs?agent=*&runId=' + encodeURIComponent(workerRunId))).body.runs || [])[0];
      A.ok(workerRun && Array.isArray(workerRun.quotes) && workerRun.quotes.includes('l1') && workerRun.quotes.includes(S), 'r1: the worker\'s own run quotes its lead\'s session and the session it read: ' + JSON.stringify(workerRun && workerRun.quotes));
      await rig.forget(S);
      const after = await rowsAfter('l1');
      A.ok(!rowsText(after).includes(word(S)), 'r1: after the delete the lead\'s rows hold no word of ' + S);
      A.ok(after.some(r => r.rowId === directive.rowId), 'r1: ...the rows from before the dispatch stay');
      A.eq((await replayHas('l1', [word(S)])), [], 'r1: model-replay hands the lead nothing of ' + S);
    });

    // ---------------- r2
    await leg('r2', async () => {
      lead.r2 = leadScript('r2', { reads: 2 });
      const run = await rig.run('l2', 'read the first two groups then ask the worker to look (r2)');
      A.eq(run.end && run.end.reason, 'done', 'r2: the lead completes');
      const rowsNow = await rowsAfter('l2');
      const stamped = rowsNow.filter(r => Array.isArray(r.quotes));
      const sat = stamped.filter(r => r.quotes.length === 1 && r.quotes[0] === '*');
      const explicit = stamped.filter(r => !(r.quotes.length === 1 && r.quotes[0] === '*'));
      A.ok(sat.length >= 2, 'r2: the lead\'s rows after the relay carry the saturated stamp (' + stamped.map(r => r.quotes.length === 1 && r.quotes[0] === '*' ? '*' : r.quotes.length).join(',') + ')');
      A.ok(explicit.length >= 2 && explicit.every(r => r.quotes.length <= 32), 'r2: the rows before the relay carry explicit lists of at most 32');
      const reported = sentinels(rowsText(rowsNow).split('The worker reported').pop());
      A.ok(reported.length === 5, 'r2: the worker\'s answer carried its five sessions\' words (' + reported.join(' ') + ')');
      const S = 'q06';   // the oldest of the worker\'s five: it ranks last, so it is in none of the lead\'s explicit lists
      A.ok(!explicit.some(r => r.quotes.includes(S)), 'r2: S is in none of the lead\'s explicit lists');
      await rig.forget(S);
      const visibleSat = (await rowsAfter('l2')).filter(r => sat.some(x => x.rowId === r.rowId));
      A.eq(visibleSat.length, 0, 'r2: deleting S alone hides every lead row drained after the relay');
      A.eq((await rowsAfter('l2')).filter(r => explicit.some(x => x.rowId === r.rowId)).length, explicit.length, 'r2: ...and none before it');
      A.ok(!rowsText(await rowsAfter('l2')).includes(word(S)), 'r2: display holds no word of S');
      A.eq(await replayHas('l2', [word(S)]), [], 'r2: model-replay hands the lead nothing of S');
      await rig.restart();
      A.eq((await rowsAfter('l2')).filter(r => sat.some(x => x.rowId === r.rowId)).length, 0, 'r2: after a restart the same rows are hidden');
    });

    // ---------------- r4: the cost side
    await leg('r4', async () => {
      await rig.forget('u01');   // BEFORE the lead begins
      lead.r4 = leadScript('r4', { reads: 2 });
      const run = await rig.run('l4', 'read the first two groups then ask the worker to look (r4)');
      A.eq(run.end && run.end.reason, 'done', 'r4: the lead completes');
      const now = await rowsAfter('l4');
      const sat = now.filter(r => Array.isArray(r.quotes) && r.quotes.length === 1 && r.quotes[0] === '*');
      A.ok(sat.length >= 2, 'r4: the lead saturated all the same');
      A.ok(sat.every(r => r.quotesAt[0] >= 0), 'r4: its saturated stamp carries a time');
      A.eq(idsOf(await rowsAfter('l4')), idsOf(now), 'r4: a session deleted before the lead began (u01) leaves every row of it visible');
      await rig.restart();
      A.eq(idsOf(await rowsAfter('l4')), idsOf(now), 'r4: ...with and without a restart');
    });

    // ---------------- r5: the conservative boundary
    await leg('r5', async () => {
      const held = gate();
      lead.r5 = leadScript('r5', { reads: 2, hold: held });
      const t = await rig.run('l5', 'read the first two groups then ask the worker to look (r5)', {}, { detach: true });
      await held.wait();
      await rig.forget('u02');   // unrelated: neither the lead nor the worker reads it; it lands after the lead started and before the relay
      held.release();
      await Promise.race([t.done, sleep(20000)]);
      A.eq(t.end && t.end.reason, 'done', 'r5: the lead is not stopped (it latched nothing u02 has to do with) and completes: ' + JSON.stringify(t.events.slice(-6).map(e => [e.name, e.payload && (e.payload.reason || e.payload.message || e.payload.name)])));
      const afterDelete = await rowsAfter('l5');
      const sat = afterDelete.filter(r => Array.isArray(r.quotes) && r.quotes.length === 1 && r.quotes[0] === '*');
      A.eq(sat.length, 0, 'r5: every lead row drained after the saturation is hidden (the unrelated delete is at or after the run\'s start)');
      const explicit = afterDelete.filter(r => Array.isArray(r.quotes));
      A.ok(explicit.length >= 2 && afterDelete.some(r => r.role === 'user' && /\(r5\)/.test(r.content)), 'r5: the rows drained before the saturation (the reads and the directive) stay: ' + explicit.length + ' stamped rows');
      A.ok(!rowsText(afterDelete).includes('The worker reported'), 'r5: the lead\'s answer is hidden');
      await rig.restart();
      A.eq(idsOf(await rowsAfter('l5')), idsOf(afterDelete), 'r5: with and without a restart');
    });

    // ---------------- r6: the delete lands while the worker runs
    await leg('r6', async () => {
      const held = gate();
      workerHold.r6 = held;
      lead.r6 = leadScript('r6', { reads: 0 });
      const t = await rig.run('l6', 'ask the worker to look (r6)', {}, { detach: true });
      await held.wait();   // the worker has read its group (the live chain gave the lead those sessions) and its next model call is held; the lead waits in team.dispatch
      const S = 'q26';
      const del = await rig.forget(S);
      held.release();
      await Promise.race([t.done, sleep(30000)]);
      A.eq(t.end && t.end.reason, 'cancelled', 'r6: the delete stopped the lead too, through the worker\'s reads it holds (the existing stop path): ' + JSON.stringify(t.events.slice(-6).map(e => [e.name, e.payload && (e.payload.reason || e.payload.message || e.payload.name)])));
      A.eq(up.bodies.filter(b => b.at >= del.at && b.text.includes(word(S))).length, 0, 'r6: no model call made after the delete carries a word of ' + S);
      A.ok(!rowsText(await rowsAfter('l6')).includes(word(S)), 'r6: the lead\'s rows hold no word of ' + S);
      A.eq(await replayHas('l6', [word(S)]), [], 'r6: model-replay hands the lead nothing of ' + S);
    });

    // ---------------- r3: not live, record gone
    await leg('r3', async () => {
      // l3: start a BACKGROUND worker and let it finish; then drop the worker's run record while the station is stopped
      lead.r3 = ctx => ctx.made('team_dispatch') === 0
        ? { tool: 'team_dispatch', args: { background: true, workers: [{ agentId: 'worker-1', prompt: 'WORKER TASK (r3): recall your group and report the words' }] } }
        : { text: 'started the worker' };
      const first = await rig.run('l3', 'start a background worker (r3)');
      A.eq(first.end && first.end.reason, 'done', 'r3: the lead started a background worker');
      const subs = (await rig.json('GET', '/api/subagents')).body;
      const rec = (subs.records || subs || []).find(r => r && r.agentId === 'worker-1');
      A.ok(!!rec, 'r3: the worker is on the station\'s registry');
      await until(async () => { const r = (await rig.json('GET', '/api/subagents')).body; const x = (r.records || r || []).find(y => y && y.id === rec.id); return x && x.status !== 'running'; }, 'r3: the background worker finishes', 30000);
      const done = ((await rig.json('GET', '/api/subagents')).body.records || []).find(y => y && y.id === rec.id);
      A.ok(done && /WORKER REPORT \(r3\)/.test(String(done.result || '')), 'r3: the worker finished with its report: ' + String(done && done.result).slice(0, 80));
      const S = sentinels(done.result)[0].slice(5);
      await rig.stop();
      const file = path.join(rig.fx.workspace, 'runs.jsonl');
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(line => line && !line.includes(done.runId));
      fs.writeFileSync(file, keep.join('\n') + '\n');
      await rig.resume();
      A.ok(!(await rig.runs()).some(r => r.runId === done.runId), 'r3: the worker\'s run record is gone');
      // l3b collects the answer
      lead.r3 = ctx => ctx.made('team_subagents') === 0 ? { tool: 'team_subagents', args: { id: rec.id } } : { text: 'collected: ' + sentinels(lastTool(ctx)).join(' ') };
      const second = await rig.run('l3b', 'collect the background worker (r3)');
      A.eq(second.end && second.end.reason, 'done', 'r3: a later lead collects the answer');
      const rowsB = await rowsAfter('l3b');
      const satB = rowsB.filter(r => Array.isArray(r.quotes) && r.quotes.length === 1 && r.quotes[0] === '*');
      A.ok(satB.length >= 1, 'r3: the lead that collected an answer nothing records saturated (its rows say \'*\')');
      A.ok(rowsText(rowsB).includes(word(S)), 'r3: it holds the worker\'s word');
      await rig.forget(S);   // a saturated lead forgets after ANY non-adopted delete at or after its start
      A.ok(!rowsText(await rowsAfter('l3b')).includes(word(S)), 'r3: a delete after the lead began hides its saturated rows');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(rig.fx.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await rig.dispose();
  }
  if (failed.length) process.exitCode = 1;
  A.report('forget.tool-quotes.relay.http');
})().catch(e => { console.error(e); process.exit(1); });
