'use strict';
/* node test/forget.tool-quotes.timing.http.test.js — WHEN THE DELETE LANDS (turn identity commit 11, A2-FP-01, A2-FP-R01).

   A run reads session S through the real recall tool, and the Commander deletes S at the worst moments. One REAL station and a scripted model whose
   calls the test holds open and releases. Every leg has its own session, its own run and its own word, and each asserts the same thing from a different
   side: after the save that deleted S answered 200, no upstream body of the run holds S's word, no row the run wrote after the read is in a reader, and
   the rows it wrote before the read are.

     (1) in flight   the run has latched S and its next model call is held; the delete lands; the run is stopped (cancelled, the existing stopped
                     path) and what it drained afterwards, a partial it had already said included, is forgotten with S
     (2) held drain  the run's writes are held under the pasted-key hold; the delete lands mid-run; the rows written at the run's end are hidden
     (3) restart     killed after the tool result was journaled; the delete lands after the restart: the continuation of the run that read S is
                     refused, the one that read a session nobody deleted is not, and the journal's quotes record came before its result record
     (4) page        a page (the production send/reconcile code) holds T's bound reply: its next reconcile drops it, and its next send posts no sentinel
     (5) observer    a post_tool_call hook holds the read after the tool produced S's word; the delete lands and its save answers before the hook
                     returns: the result the run gets is the host's notice (turn.quotes.deleted), no body and no journal line holds the word, and the
                     run goes on; killed at its next held call, the restart's continuation and every view hold no word either
   Leg (f) of the design (MCP over GET /api/runs) and the runView half of (3) (the interrupted title) belong to the run-view family (not built here). */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const { station, rowsText, gate, until, sleep } = require('./helpers/forget-quotes.js');
const { PageModel } = require('./helpers/page-model.js');

const WORD = { one: 'Quokka-One', two: 'Wombat-Two', three: 'Numbat-Three', four: 'Dingo-Four', five: 'Bilby-Five' };
const KEY_SHAPED = 'sk-' + 'proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f';   // a pasted key: the run holds its writes until it ends
const recall = (query, then) => ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query, scope: 'all' } } : then(ctx);

(async () => {
  const rig = await station('forget-quotes-timing-', { env: { SKYNET_MAX_CONCURRENT_AGENTS: '6', STARNET_MAX_CONCURRENT_AGENTS: '6' } });   // leg 3 holds three runs open at once
  const { up } = rig;
  const failed = [];
  const leg = async (name, fn) => { if (process.env.FQ_ONLY && !process.env.FQ_ONLY.split(',').includes(name)) return; if (process.env.FQ_TRACE) console.log('[leg] ' + name); try { await fn(); } catch (e) { failed.push(name); console.error('LEG ' + name + ' THREW', e && e.stack || e); A.ok(false, 'leg ' + name + ' ran to its end (' + ((e && e.message) || e) + ')'); } };
  const seed = async (id, title, word) => { up.behave = () => ({ text: 'The ' + title + ' codeword is ' + word + '.' }); const r = await rig.run(id, 'echo session about ' + title); A.eq(r.end && r.end.reason, 'done', id + ' seeded'); };
  const rowsOf = async stream => (await rig.transcript(stream)).turns;
  try {
    await rig.start();
    await rig.list(['s1', 'one'], ['t1', 'reader one'], ['s2', 'two'], ['t2', 'reader two'], ['s3', 'three'], ['t3', 'reader three'], ['s4', 'four'], ['t4', 'reader four'], ['s5', 'five'], ['t5', 'reader five'], ['u1', 'control']);
    for (const [id, title, word] of [['s1', 'quokka', WORD.one], ['s2', 'wombat', WORD.two], ['s3', 'numbat', WORD.three], ['s4', 'dingo', WORD.four], ['s5', 'bilby', WORD.five]]) await seed(id, title, word);

    // ---------------- (1) in flight
    await leg('1', async () => {
      const held = gate();
      up.behave = recall('quokka', () => ({ hold: held, partial: 'thinking about ' + WORD.one + ' ' }));
      const t = await rig.run('t1', 'what do you recall about the quokka (one)?', {}, { detach: true });
      await held.wait();
      const del = await rig.forget('s1');
      held.release();
      await Promise.race([t.done, sleep(15000)]);
      A.ok(!!t.end, '(1) the run ended (it was stopped, not left hanging)');
      A.eq(t.end && t.end.reason, 'cancelled', '(1) the run that had latched S ends cancelled, through the existing stop path');
      A.ok(rig.mentionedSince(del.at, WORD.one).length === 0, '(1) no upstream body after the delete\'s 200 holds S\'s word: ' + rig.whereSince(del.at, WORD.one));
      const rows = await rowsOf('t1');
      A.ok(!rowsText(rows).includes(WORD.one), '(1) display: nothing T wrote after its read (the tool result, the partial it had already said) is there');
      A.ok(rows.some(r => r.role === 'user' && /quokka \(one\)/.test(r.content)) && rows.some(r => r.role === 'assistant'), '(1) ...the rows from before the read are (the typed directive, the assistant row that asked for the read)');
      const at = Date.now();
      up.behave = recall('quokka', () => ({ text: 'nothing' }));
      await rig.run('t1', 'one more look (one)', { windowFrom: 'station', turnId: 'timing_one_0001', turnAt: at, clientNow: at, windowTokens: 92800 });
      A.ok(rig.mentionedSince(at, WORD.one).length === 0, '(1) recall and model-replay: a later run of T is handed nothing of S: ' + rig.whereSince(at, WORD.one));
    });

    // ---------------- (2) held drain: the pasted-key hold keeps the run's rows back until it ends
    await leg('2', async () => {
      const held = gate();
      up.behave = recall('wombat', () => ({ hold: held, partial: 'noting ' + WORD.two + ' ' }));
      const t = await rig.run('t2', 'my key is ' + KEY_SHAPED + ' - what do you recall about the wombat (two)?', {}, { detach: true });
      await held.wait();
      A.ok(!rowsText(await rowsOf('t2')).includes(WORD.two), '(2) while the run holds its writes nothing of what it read is in the transcript yet');
      const del = await rig.forget('s2');
      held.release();
      await Promise.race([t.done, sleep(15000)]);
      A.eq(t.end && t.end.reason, 'cancelled', '(2) the run is stopped');
      A.ok(rig.mentionedSince(del.at, WORD.two).length === 0, '(2) no upstream body after the delete holds S\'s word');
      const rows = await rowsOf('t2');
      A.ok(!rowsText(rows).includes(WORD.two), '(2) the rows the run wrote at its end, after the delete, are hidden (the rule reads the read epoch, never the write time)');
      A.ok(rows.some(r => r.role === 'user'), '(2) ...the typed directive of the run is still there');
    });

    // ---------------- (3) restart: killed after the tool result was journaled, before the run could finish
    await leg('3', async () => {
      const hA = gate(), hB = gate(), hC = gate();
      up.behave = ctx => ctx.userText.includes('(three-b)') ? recall('numbat', () => ({ hold: hC, partial: 'again about ' + WORD.three }))(ctx)
        : ctx.userText.includes('(three)') ? recall('numbat', () => ({ hold: hA, partial: 'about ' + WORD.three }))(ctx)
        : recall('dingo', () => ({ hold: hB, partial: 'only the dingo' }))(ctx);   // the markers are literal and the longer one comes first: a bare /(three)/ is a substring match that also took the (three-b) run
      const a = await rig.run('t3', 'what do you recall about the numbat (three)?', {}, { detach: true });
      const c = await rig.run('t3b', 'and once more about the numbat (three-b)', {}, { detach: true });   // a second run, in its own session, that read the same session
      const b = await rig.run('u1', 'what does the dingo say (control)?', {}, { detach: true });   // reads s4, which nobody deletes in this leg
      await Promise.all([hA.wait(), hB.wait(), hC.wait()]);
      // the journal of the run in t3, named by its begin record's stream (a recall result can quote the other run's directive, so its text proves nothing)
      const mine = rig.journals().find(j => { try { return JSON.parse(j.text.split('\n').filter(Boolean)[0]).payload.streamId === 't3'; } catch (_) { return false; } });
      A.ok(!!mine, '(3) the run has a journal');
      const types = mine.text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).type; } catch (_) { return ''; } });
      const qAt = types.indexOf('quotes');
      A.ok(qAt > 0 && types[qAt - 1] === 'tool_dispatch' && types[qAt + 1] === 'tool_result', '(3) its journal holds a quotes record, and it sits between the read\'s dispatch and the tool_result record it covers: ' + types.join(','));
      await rig.crash();
      await Promise.race([Promise.all([a.done, b.done, c.done]), sleep(3000)]);
      await rig.resume();
      // one continuation is PREPARED while S still exists (the Commander said yes, then deleted S before the run was started)
      const before = ((await rig.json('GET', '/api/run-recoveries')).body.recoveries || []);
      const preA = before.find(r => r.streamId === 't3');
      A.ok(preA && preA.canAutoContinue === true, '(3) before the delete the interrupted run is continuable');
      const prepared = await rig.json('POST', '/api/run-recoveries/continue', { runId: preA.runId, agentId: 'agent', recoveryToken: preA.recoveryToken, continuationId: 'timing-three-0001', mode: 'automatic' });
      A.eq(prepared.status, 200, '(3) ...and its continuation is prepared');
      const del = await rig.forget('s3');   // the delete lands after the restart and after the preparation
      const list = ((await rig.json('GET', '/api/run-recoveries')).body.recoveries || []);
      const ra = list.find(r => r.runId === preA.runId), rc = list.find(r => r.streamId === 't3b'), rb = list.find(r => r.streamId === 'u1');
      A.ok(!!ra && !!rb && !!rc, '(3) all three interrupted runs are listed');
      // the list is a reader too: a forgotten run stays listed as evidence, but serves neither S's word nor the directive that read it
      const listText = JSON.stringify(list.filter(r => r.streamId === 't3' || r.streamId === 't3b'));
      A.ok(!listText.includes(WORD.three) && !/numbat/i.test(listText), '(3) the recoveries list holds neither the word of S nor the directive of a run that read it');
      A.ok(ra && rc && ra.userTitle === '' && rc.checkpoint.messages.length === 0, '(3) ...the forgotten rows are stubs (no title, no checkpoint messages)');
      A.ok(rb && rb.userTitle !== '' && rb.checkpoint.messages.length > 0, '(3) control: the row of the run that read a live session keeps its title and checkpoint');
      A.ok(rb && rb.canAutoContinue === true, '(3) control: the run that read a session nobody deleted is continuable');
      A.ok(ra && ra.canAutoContinue !== true && rc && rc.canAutoContinue !== true, '(3) the runs that read the deleted session are not continuable');
      const asked = await rig.json('POST', '/api/run-recoveries/continue', { runId: rc.runId, agentId: 'agent', recoveryToken: rc.recoveryToken, continuationId: 'timing-threeb-0001', mode: 'automatic' });
      A.eq(asked.status, 409, '(3) asking to continue one is refused (' + JSON.stringify(asked.body).slice(0, 140) + ')');
      A.ok(/deleted/.test(JSON.stringify(asked.body)), '(3) ...with the reason');
      // the prepared one: starting it is refused too, before anything is spent
      const at = Date.now();
      up.behave = () => ({ text: 'must not run' });
      const started = await rig.run('t3', '', { messages: [], recovery: { sourceRunId: preA.runId, continuationId: 'timing-three-0001', continuationToken: prepared.body.continuationToken } });
      A.ok(started.status !== 200 || !started.end || started.end.reason !== 'done', '(3) starting the continuation prepared before the delete is refused (status ' + started.status + ')');
      A.eq(up.bodies.filter(x => x.at >= at && x.main).length, 0, '(3) ...and no model call was made for it');
      const again = await rig.json('POST', '/api/run-recoveries/continue', { runId: rb.runId, agentId: 'agent', recoveryToken: rb.recoveryToken, continuationId: 'timing-control-0001', mode: 'automatic' });
      A.eq(again.status, 200, '(3) control: the other one is prepared as before');
      // the display view hides the forgotten run now, so the record is read from the station's own run file
      const interrupted = fs.readFileSync(path.join(rig.fx.workspace, 'runs.jsonl'), 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && r.runId === ra.runId).pop();
      A.ok(interrupted && interrupted.reason === 'interrupted' && Array.isArray(interrupted.quotes) && interrupted.quotes[0] === 's3', '(3) the interrupted run\'s record names the session it read (taken from its journal)');
      A.ok(!rowsText(await rowsOf('t3')).includes(WORD.three), '(3) display: nothing of S in T');
      A.ok(rig.mentionedSince(del.at, WORD.three).length === 0, '(3) no upstream body after the restart holds S\'s word');
    });

    // ---------------- (4) the page
    await leg('4', async () => {
      const page = new PageModel({ streamId: 't4', now: () => Date.now(), rng: () => Math.random(),
        model: { getModel: () => 'test/model', contextLimitOf: () => 128000 },
        read: sid => rig.transcript(sid).then(body => body),
        dispatch: async body => { const r = await rig.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ model: 'test/model', provider: 'openrouter', isTask: true, system: 'You are NOVA.' }, body)) }); return r.text(); },
        redactAsk: async rows => { const out = await rig.json('POST', '/api/transcript/redact', { texts: rows.map(r => r.content) }); return new Map(rows.map((r, i) => [r.content, out.body.texts[i]])); } });
      up.behave = recall('dingo', () => ({ text: 'I recall the dingo: ' + WORD.four + '.' }));
      await page.load();
      const sent = await page.send('what do you recall about the dingo (four)?');
      A.eq(sent.ended && sent.ended.reason, 'done', '(4) the page\'s run completed');
      await page.load();
      A.ok(page.ws.history.some(r => String(r.content).includes(WORD.four) && r.rowId), '(4) the page holds T\'s bound reply (a keyed row quoting S)');
      page.save();
      await rig.forget('s4');
      await page.load();
      A.ok(!page.ws.history.some(r => String(r.content).includes(WORD.four)), '(4) on its next reconcile the page drops T\'s bound reply');
      A.ok(page.ws.history.some(r => r.role === 'user' && /dingo \(four\)/.test(r.content)), '(4) ...and keeps the typed directive');
      const at = Date.now();
      up.behave = () => ({ text: 'fine' });
      const next = await page.send('and something else (four)');
      A.eq(next.ended && next.ended.reason, 'done', '(4) the page\'s next send completes');
      A.ok(rig.mentionedSince(at, WORD.four).length === 0, '(4) the next shadow-mode send posts no sentinel: ' + rig.whereSince(at, WORD.four));
      // a page that never reconciled: its cache still holds the copy, and the station's posted-window floor keeps it out
      const stale = JSON.parse(page.saved).concat([{ role: 'user', content: 'a send from the stale cache (four)', ts: Date.now() }]);
      const at2 = Date.now();
      up.behave = () => ({ text: 'fine again' });
      const posted = await rig.run('t4', 'a send from the stale cache (four)', { messages: stale.map(r => ({ role: r.role, content: r.content, rowId: r.rowId, streamId: r.rowId ? 't4' : undefined, sourceRunId: r.sourceRunId })), windowTokens: 92800, turnId: 'timing_page_stale1', turnAt: at2, clientNow: at2 });
      A.eq(posted.end && posted.end.reason, 'done', '(4) a send from the stale cache completes');
      A.ok(rig.mentionedSince(at2, WORD.four).length === 0, '(4) a page that has not reconciled yet still posts no sentinel to the model (the station\'s posted-window floor): ' + rig.whereSince(at2, WORD.four));
    });

    // ---------------- (5) the held observer
    await leg('5', async () => {
      const hook = path.join(rig.fx.workspace, 'hook-hold.cjs').replace(/\\/g, '/'), signal = path.join(rig.fx.workspace, 'hook.signal').replace(/\\/g, '/'), started = path.join(rig.fx.workspace, 'hook.started').replace(/\\/g, '/');
      fs.writeFileSync(hook, [
        "const fs = require('fs'); const signal = process.argv[2], started = process.argv[3]; let raw = '';",
        "process.stdin.on('data', d => { raw += d; });",
        "process.stdin.on('end', () => {",
        "  let name = ''; try { name = JSON.parse(raw).tool_name || ''; } catch (_) {}",
        "  if (!/recall_conversation/.test(name)) { process.stdout.write('{}'); return; }",
        "  fs.writeFileSync(started, '1');",
        "  const t = setInterval(() => { if (fs.existsSync(signal)) { clearInterval(t); process.stdout.write('{}'); } }, 20);",
        "});"
      ].join('\n'));
      const made = await rig.json('POST', '/api/hooks/create', { event: 'post_tool_call', command: 'node "' + hook + '" "' + signal + '" "' + started + '"', name: 'hold the read' });
      A.eq(made.status, 200, '(5) the hook is installed (the Commander typed it: approved)');
      const held = gate();
      up.behave = recall('bilby', () => ({ hold: held, partial: 'continuing' }));
      const t5Start = Date.now();
      const t = await rig.run('t5', 'what do you recall about the bilby (five)?', {}, { detach: true });
      await until(() => fs.existsSync(started), '(5) the observer holds the read', 15000);
      const del = await rig.forget('s5');   // the save answers while the observer still holds the result
      fs.writeFileSync(signal, '1');
      await held.wait();                   // the run went on to its next call
      A.ok(!t.end, '(5) the run keeps running');
      const next = up.bodies[up.bodies.length - 1];
      const tools = next.body.messages.filter(m => m.role === 'tool').map(m => String(m.content));
      A.ok(tools.some(x => /deleted while the read was in flight/.test(x)), '(5) the result the run was handed is the host\'s notice');
      A.ok(rig.mentionedSince(t5Start, WORD.five).length === 0, '(5) no body the model got from the run\'s start on holds S\'s word: ' + rig.whereSince(t5Start, WORD.five));
      const journal = rig.journals().find(j => j.text.includes('(five)'));
      A.ok(journal && !journal.text.includes(WORD.five), '(5) no line of the run\'s journal holds it');
      A.ok(!rowsText(await rowsOf('t5')).includes(WORD.five), '(5) no row holds it');
      // kill at the held call and restart: the continuation, offered or refused, and every view hold no word
      await rig.crash(); await Promise.race([t.done, sleep(3000)]);
      await rig.resume();
      const recs = ((await rig.json('GET', '/api/run-recoveries')).body.recoveries || []);
      const rec = recs.find(r => JSON.stringify(r).includes('(five)'));
      A.ok(!JSON.stringify(recs).includes(WORD.five), '(5) the recovery listing holds no word of S');
      A.ok(!rowsText(await rowsOf('t5')).includes(WORD.five), '(5) after the restart no row holds it');
      if (rec && rec.canAutoContinue === true) {
        const at = Date.now();
        const prepared = await rig.json('POST', '/api/run-recoveries/continue', { runId: rec.runId, agentId: 'agent', recoveryToken: rec.recoveryToken, continuationId: 'timing-five-0001', mode: 'automatic' });
        A.eq(prepared.status, 200, '(5) the continuation is offered and prepared');
        up.behave = () => ({ text: 'continued fine' });
        const cont = await rig.run('t5', '', { messages: [], recovery: { sourceRunId: rec.runId, continuationId: 'timing-five-0001', continuationToken: prepared.body.continuationToken } });
        A.eq(cont.status, 200, '(5) the continuation runs');
        A.ok(rig.mentionedSince(at, WORD.five).length === 0, '(5) the continuation hands the model nothing of S: ' + rig.whereSince(at, WORD.five));
      } else A.ok(true, '(5) the continuation is refused');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(rig.fx.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await rig.dispose();
  }
  if (failed.length) process.exitCode = 1;
  A.report('forget.tool-quotes.timing.http');
})().catch(e => { console.error(e); process.exit(1); });
