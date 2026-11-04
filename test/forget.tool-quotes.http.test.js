'use strict';
/* node test/forget.tool-quotes.http.test.js — A SESSION A RUN READ IS FORGOTTEN WITH THE SESSION (turn identity commit 11, A2-MIG-02, A2-FP-01/02).

   One REAL station (SidecarFixture) and a scripted model; the run reads session S through the real recall_conversation tool, the Commander
   deletes S (POST /api/save with forgetIds, exactly what the page sends), and every word the run took from S must leave every reader:

     setup   S says a codeword once. T's run recalls it and answers with it; U is a control that never reads S.
     base    before the delete the quoting rows carry quotes + quotesAt; after it display, recall and model-replay hold no word of S, T's earlier
             rows and U stay, GET /api/transcript lists what it hid (identity.forgotten), and the run record names the session it read
     (a)     the same, with replay and display flipped to the rollback modes (legacy) over POST /api/turn-identity/mode
     (c)     a desk run posting a full page window that holds T's quoting reply (once keyed, once id-less) under window shadow and legacy: the
             sentinel reaches no upstream body, T's typed directive and its pre-read rows still do (the floor never removes a row the store keeps)
     (d)     TurnMerge drops the page copies identity.forgotten lists (the real GET)
     (e)     a file the run wrote from what it read, and a routine's reply (a scheduled routine of the agent recalls S and returns to U through the real
             cron and TurnDelivery.write), leave display, recall and model-replay with S; a run that read nothing keeps its file
     restart the stamps and the ledger are on disk: after a restart nothing comes back
     (g)     session.list titles are metadata (Q25-2, I7's named limit (c)): T keeps running and its session.list row stays in replay after S is deleted
     limit   Q4(b), recorded as a passing control: a session that copied T's QUOTING reply (it read T, never S) keeps S's word after S is deleted
     the fast tier (test/turn-dual.forget.test.js) holds (b): turnDual.pick with a throwing id path over the real store.
   The other shards: the timing legs (an in-flight delete, a held drain, a restart, the page, a held observer) are test/forget.tool-quotes.timing.http.test.js;
   the 45-session overflow is test/forget.tool-quotes.overflow.http.test.js; the worker relays are test/forget.tool-quotes.relay.http.test.js; they share
   test/helpers/forget-quotes.js. Leg (f) of the design (MCP conversations_list over GET /api/runs) is the run-view family (runView, the registry step): it
   asserts the run list, which nothing filters yet.
   Debugging: FQ_TRACE=1 prints each leg as it starts; FQ_ONLY=a,b runs only those legs. */
const A = require('./_assert.js');
const Merge = require('../frontend/app/turnmerge.js');
const { station, rowsText } = require('./helpers/forget-quotes.js');

const S = 'ws_quokka', T = 'ws_reader', U = 'ws_control', PROBE = 'ws_probe';
const SENTINEL = 'Wallaby-Seven';
const WORKER = { agentId: 'worker-1', system: 'WORKER_MARK you are a worker.', name: 'WORKER', model: 'test/model', provider: 'openrouter', approvalMode: 'ask' };

(async () => {
  const rig = await station('forget-quotes-core-', { crew: [WORKER], env: { SKYNET_CRON_TICK_MS: '1000', STARNET_CRON_TICK_MS: '1000', SKYNET_CRON_ENABLED: '', STARNET_CRON_ENABLED: '' } });
  const { up } = rig;
  const failed = [];
  const leg = async (name, fn) => { if (process.env.FQ_ONLY && !process.env.FQ_ONLY.split(',').includes(name)) return; if (process.env.FQ_TRACE) console.log('[leg] ' + name); try { await fn(); } catch (e) { failed.push(name); console.error('LEG ' + name + ' THREW', e && e.stack || e); A.ok(false, 'leg ' + name + ' ran to its end (' + ((e && e.message) || e) + ')'); } };
  try {
    await rig.start();
    await rig.list([S, 'quokka plan ' + SENTINEL], [T, 'reader'], [U, 'control']);

    // ---------------- setup: S holds the codeword; T reads it and answers with it; U is a control
    up.behave = ctx => ({ text: 'The quokka codeword is ' + SENTINEL + '.' });
    let r = await rig.run(S, 'echo session uniqueword quokka ' + SENTINEL);   // S's own words: the typed line holds the sentinel too, so a routine that reads it by its own word (uniqueword) takes it straight from S
    A.eq(r.end && r.end.reason, 'done', 'S seeded');
    up.behave = () => ({ text: 'platypus notes, nothing else.' });
    r = await rig.run(U, 'tell me about the platypus plan');
    A.eq(r.end && r.end.reason, 'done', 'U (the control) seeded');
    up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'codeword', scope: 'all' } } : { text: 'I recall the codeword: ' + SENTINEL + '.' };
    const ASK = 'what codeword do you recall?';
    const t1 = await rig.run(T, ASK);
    A.eq(t1.end && t1.end.reason, 'done', 'T read S and answered');
    const sawIt = up.bodies.find(b => b.main && b.text.includes(ASK) && JSON.stringify(b.body.messages).includes('"role":"tool"') && b.text.includes(SENTINEL));
    A.ok(!!sawIt, 'the scripted model really was handed S\'s word by the real recall tool (the test would be vacuous otherwise)');

    // a run that writes a file from what it read (leg e), and one that reads nothing and writes a file (the control)
    up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'codeword', scope: 'all' } }
      : ctx.made('fs_write') === 0 ? { tool: 'fs_write', args: { path: 'codeword-notes.md', content: 'notes from what I read: ' + SENTINEL } } : { text: 'wrote the notes' };
    const tFile = await rig.run(T, 'write down that codeword');
    A.eq(tFile.end && tFile.end.reason, 'done', 'T wrote a file from what it read');
    up.behave = ctx => ctx.made('fs_write') === 0 ? { tool: 'fs_write', args: { path: 'platypus-notes.md', content: 'platypus facts' } } : { text: 'wrote the platypus notes' };
    const uFile = await rig.run(U, 'write the platypus notes');
    A.eq(uFile.end && uFile.end.reason, 'done', 'U wrote a file and read nothing');
    // leg (e), the routine: a scheduled routine of the agent recalls S and returns its reply to U (a session return, written by TurnDelivery.write through the real cron)
    const page = await rig.page();
    up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'uniqueword', scope: 'all' } } : { text: 'Routine result: the word is ' + SENTINEL + '.' };
    const job = await rig.routine('Recall', 'ROUTINE recall the codeword', U);
    page.close();
    A.eq(page.commands.length, 1, 'the routine\'s reply was handed to the page once (the cron delivered it)');
    const delivery = (await rig.transcript(U)).turns.find(row => row.kind === 'delivery');
    A.ok(delivery && delivery.content.includes(SENTINEL) && delivery.quotes && delivery.quotes.includes(S), 'leg e: the routine\'s delivery row in U carries the routine run\'s latch (it read S): ' + JSON.stringify(delivery && delivery.quotes));
    A.ok((await rig.transcript('cron-' + job.lastRunId)).turns.some(row => Array.isArray(row.quotes) && row.quotes.includes(S)), 'leg e: and the routine run\'s own rows carry the same stamp (the delivery copied it from them)');

    // an internal call the page composed from S's words (the retitle, the goal judge) names S in an additive quotesStream: the run record quotes S, a bad id is dropped
    {
      const asked = Date.now();
      up.behave = () => ({ text: 'Quokka Codeword Plan' });
      const titled = await rig.run(null, 'Title this session in 3 to 6 words: ' + SENTINEL, { internal: true, isTask: false, quotesStream: S, system: 'Reply with ONLY a title.' });
      const titledRow = ((await rig.json('GET', '/api/runs?runId=' + encodeURIComponent(titled.runId))).body.runs || [])[0];
      A.ok(titledRow && Array.isArray(titledRow.quotes) && titledRow.quotes[0] === S && titledRow.quotesAt[0] >= asked, 'an internal call that names its session (quotesStream) is a quote of it, read at the request\'s receipt: ' + JSON.stringify(titledRow && [titledRow.quotes, titledRow.quotesAt]));
      const stray = await rig.run(null, 'Title this session: nothing', { internal: true, isTask: false, quotesStream: 'not a stream id!', system: 'Reply with ONLY a title.' });
      const strayRow = ((await rig.json('GET', '/api/runs?runId=' + encodeURIComponent(stray.runId))).body.runs || [])[0];
      A.ok(strayRow && !strayRow.quotes, 'a quotesStream that is not a stream id is dropped, not stamped');
    }

    // ---------------- base: the stamp, before the delete
    const before = await rig.transcript(T);
    const quoting = before.turns.filter(row => Array.isArray(row.quotes));
    A.ok(quoting.length >= 3, 'rows T drained after its read carry the stamp (the tool row, the reply, the file row): ' + quoting.length);
    A.ok(quoting.every(row => row.quotes.length === 1 && row.quotes[0] === S && Number.isSafeInteger(row.quotesAt[0]) && row.quotesAt[0] > 0), 'the stamp is one stream with its read time');
    const directive = before.turns.find(row => row.role === 'user' && row.content === ASK);
    A.ok(directive && !directive.quotes, 'T\'s typed directive of the run that read S carries no stamp (it predates the read)');
    const reply = before.turns.find(row => row.role === 'assistant' && row.content.includes(SENTINEL) && row.sourceRunId === t1.runId);
    A.ok(reply && reply.quotes && reply.rowId, 'T\'s quoting reply is a keyed row with the stamp');
    const fileRow = before.turns.find(row => row.kind === 'deliverable' && row.sourceRunId === tFile.runId);
    A.ok(fileRow && fileRow.quotes && fileRow.quotes[0] === S, 'the file the reading run wrote is a deliverable row with the same stamp (leg e)');
    const uBefore = await rig.transcript(U);
    const uFileRow = uBefore.turns.find(row => row.kind === 'deliverable');
    A.ok(uFileRow && !uFileRow.quotes, 'the control\'s file row carries no stamp');
    A.eq((before.identity.forgotten || {}).keys, [], 'nothing is listed as forgotten before the delete');
    const runRecord = (await rig.runs()).find(x => x.runId === t1.runId);
    A.ok(runRecord && runRecord.quotes && runRecord.quotes[0] === S && runRecord.quotesAt[0] === quoting[0].quotesAt[0], 'the run record names the session it read, at the same read time as its rows');
    // control: before the delete a third session's recall really does find T's quoting reply (so its absence afterwards means something)
    up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'codeword', scope: 'all' } } : { text: 'ok' };
    const k0 = up.bodies.length;
    await rig.run(PROBE, 'what codeword is out there?');   // a session that exists only for this look: it is deleted with S below, so nothing it copied is a stray copy
    const recallText = up.bodies.slice(k0).filter(b => b.main).map(b => b.body.messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n')).join('\n');
    A.ok(recallText.split('\n').some(line => line.includes('[' + T + ' ·') && line.includes(SENTINEL)), 'control: before the delete, a third session\'s recall finds a row of T that quotes S (T\'s rows are in recall)');

    // ---------------- the delete
    const del = await rig.forget(S, PROBE);
    A.eq(del.status, 200, 'the page\'s save with forgetIds is accepted');
    const after = await rig.transcript(T);
    const display = rowsText(after.turns);
    A.ok(!display.includes(SENTINEL), 'display: no word of S in T\'s rows after the delete');
    A.ok(after.turns.some(row => row.rowId === directive.rowId) && after.turns.filter(row => row.role === 'assistant' && row.sourceRunId === t1.runId && !row.quotes).length >= 1, 'display: T\'s rows from before the read stay (the typed directive, the assistant row that asked for the read)');
    A.ok(!after.turns.some(row => row.kind === 'deliverable' && row.sourceRunId === tFile.runId), 'leg e: the file row the reading run wrote left display with S');
    A.ok((await rig.transcript(U)).turns.some(row => row.kind === 'deliverable'), 'leg e control: the file row of the run that read nothing stays');
    A.ok(!(await rig.transcript(U)).turns.some(row => row.rowId === delivery.rowId) && !rowsText((await rig.transcript(U)).turns).includes(SENTINEL), 'leg e: the routine\'s delivered reply left U with S, in display');
    A.ok(!rowsText((await rig.transcript('cron-' + job.lastRunId)).turns).includes(SENTINEL), 'leg e: the routine run\'s own rows are gone too');
    const listed = after.identity.forgotten;
    A.ok(listed.keys.some(k => k[0] === T && k[1] === reply.rowId) && listed.runIds.includes(t1.runId) && listed.keys.length <= 2000 && listed.runIds.length <= 200, 'GET identity lists what it hid: the row keys and the runs they came from, bounded');
    A.eq((await rig.transcript(S)).turns.length, 0, 'S\'s own rows are gone (the existing tombstone)');
    A.ok((await rig.transcript(U)).turns.some(row => String(row.content).includes('platypus')), 'U, the control, is untouched');

    // recall and replay through real runs: nothing of S reaches a model
    const since = Date.now();
    up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'codeword quokka', scope: 'all' } } : { text: 'nothing found' };
    const probe = await rig.run(T, 'search everything for the codeword again', { windowFrom: 'station', turnId: 'probe_turn_0001', turnAt: Date.now(), clientNow: Date.now(), windowTokens: 92800 });
    A.eq(probe.end && probe.end.reason, 'done', 'a later T run completes');
    A.ok(rig.mentionedSince(since, SENTINEL).length === 0, 'recall + model-replay: no upstream body after the delete holds S\'s word (the station-built window, the recall result, both): ' + rig.whereSince(since, SENTINEL));
    A.ok(up.bodies.slice().reverse().find(b => b.main && b.text.includes('search everything for the codeword again')).text.includes(directive.content), 'T\'s own earlier typed words are still in the window (only the quoting rows left)');
    {   // leg e, model-replay: U's next window holds none of S's words (the delivered reply is out) and still holds U's own rows
      const at = Date.now(); up.behave = () => ({ text: 'platypus again' });
      await rig.run(U, 'anything new here', { windowFrom: 'station', turnId: 'control_turn_0001', turnAt: at, clientNow: at, windowTokens: 92800 });
      A.ok(rig.mentionedSince(at, SENTINEL).length === 0 && rig.mentionedSince(at, 'platypus').length >= 1, 'leg e: U\'s model-replay window holds none of S\'s words and still holds its own platypus rows: ' + rig.whereSince(at, SENTINEL));
    }
    // tool pairing: a forgotten tool result must not leave its call behind (a provider refuses an assistant call with no result)
    const orphans = body => { const msgs = body.messages || []; let n = 0; msgs.forEach((m, i) => { for (const c of m.tool_calls || []) if (!msgs.slice(i + 1).some(x => x.role === 'tool' && x.tool_call_id === c.id)) n++; }); return n; };
    const afterBodies = up.bodies.filter(x => x.at >= since && x.main);
    A.ok(afterBodies.length >= 2 && afterBodies.every(b => orphans(b.body) === 0), 'every window the model got after the delete keeps its tool calls paired with their results (' + afterBodies.map(b => orphans(b.body)).join(',') + ' orphans)');

    // ---------------- (a) the rollback modes
    await leg('a', async () => {
      await rig.mode('replay', 'legacy'); await rig.mode('display', 'legacy');
      const seedAt = Date.now();
      up.behave = () => ({ text: 'ok' });
      const seeded = await rig.run(T, 'one more thing', { messages: [{ role: 'user', content: 'one more thing' }] });   // <= 1 message: the station seeds the history itself
      A.eq(seeded.end && seeded.end.reason, 'done', '(a) a T run with one message completes in replay:legacy');
      A.ok(rig.mentionedSince(seedAt, SENTINEL).length === 0, '(a) replay:legacy: the seeded history holds no word of S: ' + rig.whereSince(seedAt, SENTINEL));
      A.ok(!rowsText((await rig.transcript(T)).turns).includes(SENTINEL), '(a) display:legacy: GET holds no word of S');
      A.ok(rig.mentionedSince(seedAt, ASK).length >= 1, '(a) ...and the seed is not empty: T\'s own typed words are in it');
      await rig.mode('replay', 'id'); await rig.mode('display', 'id');
    });

    // ---------------- (c) a posted full window, keyed and id-less, under window shadow and legacy
    await leg('c', async () => {
      for (const windowMode of ['shadow', 'legacy']) {
        await rig.mode('window', windowMode);
        const at = Date.now();
        const posted = [
          { role: 'user', content: directive.content, rowId: directive.rowId, streamId: T, sourceRunId: t1.runId },
          { role: 'assistant', content: reply.content, rowId: reply.rowId, streamId: T, sourceRunId: t1.runId },
          { role: 'assistant', content: 'a provisional copy: ' + SENTINEL, sourceRunId: t1.runId },
          { role: 'user', content: 'and now something else' }
        ];
        up.behave = () => ({ text: 'fine' });
        const sent = await rig.run(T, 'and now something else', { messages: posted, windowTokens: 92800, turnId: 'posted_' + windowMode + '_0001', turnAt: at, clientNow: at });
        A.eq(sent.end && sent.end.reason, 'done', '(c) a desk run posting the full window completes under window:' + windowMode);
        A.ok(rig.mentionedSince(at, SENTINEL).length === 0, '(c) window:' + windowMode + ': the sentinel reaches no upstream body (the keyed copy and the id-less copy are both dropped)');
        A.ok(rig.mentionedSince(at, directive.content).length >= 1 && rig.mentionedSince(at, 'and now something else').length >= 1, '(c) window:' + windowMode + ': T\'s typed directive of the run that read S, and the new question, are still in the body');
      }
      await rig.mode('window', 'shadow');
    });

    // ---------------- (d) TurnMerge drops the page's copies that identity.forgotten lists
    await leg('d', async () => {
      const read = await rig.transcript(T);
      const stale = [
        { role: 'assistant', content: reply.content, rowId: reply.rowId, streamId: T, sourceRunId: t1.runId, turnId: reply.turnId },
        { role: 'assistant', content: 'a provisional ' + SENTINEL + ' reply', sourceRunId: t1.runId, turnId: reply.turnId, ts: Date.now() },
        { role: 'user', content: directive.content, rowId: directive.rowId, streamId: T, sourceRunId: t1.runId, turnId: directive.turnId }
      ];
      const merged = Merge.merge(stale, read.turns, { identity: read.identity });
      A.ok(!merged.rows.some(row => String(row.content).includes(SENTINEL)), '(d) the page\'s keyed copy (R2) and its id-less reply of a forgotten run (R4) are dropped by the real GET');
      A.ok(merged.rows.some(row => row.rowId === directive.rowId), '(d) ...the typed directive stays');
      const without = Merge.merge(stale, read.turns, { identity: Object.assign({}, read.identity, { forgotten: { keys: [], runIds: [] } }) });
      A.ok(without.rows.some(row => row.rowId === reply.rowId), '(d) control: without the list the cached copy survives (it is the list that drops it)');
    });

    // ---------------- restart: the stamps and the ledger are on disk, so nothing comes back
    await leg('restart', async () => {
      await rig.restart();
      const again = await rig.transcript(T);
      A.ok(!rowsText(again.turns).includes(SENTINEL), 'after a restart display holds no word of S');
      A.ok(again.identity.forgotten.keys.some(k => k[1] === reply.rowId) && again.identity.forgotten.runIds.includes(t1.runId), '...and identity.forgotten still lists what it hid');
      const at = Date.now();
      up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'codeword quokka', scope: 'all' } } : { text: 'still nothing' };
      const run = await rig.run(T, 'after the restart: any codeword?', { windowFrom: 'station', turnId: 'restart_turn_0001', turnAt: at, clientNow: at, windowTokens: 92800 });
      A.eq(run.end && run.end.reason, 'done', 'a run after the restart completes');
      A.ok(rig.mentionedSince(at, SENTINEL).length === 0, 'after a restart no upstream body holds S\'s word (the window, the recall result): ' + rig.whereSince(at, SENTINEL));
    });

    // ---------------- (g) session.list titles are metadata: the run keeps running and its list row stays in replay
    await leg('g', async () => {
      const S2 = 'ws_quokka_two';   // a second session whose TITLE holds the sentinel
      await rig.list([S2, 'second ' + SENTINEL + ' plan'], [T, 'reader'], [U, 'control']);
      up.behave = ctx => ctx.made('session_list') === 0 ? { tool: 'session_list', args: {} } : { text: 'I listed the sessions.' };
      const lists = await rig.run(T, 'list the sessions please');
      A.eq(lists.end && lists.end.reason, 'done', '(g) T called session.list');
      const body = up.bodies.slice().reverse().find(b => b.main && b.text.includes('list the sessions please') && b.text.includes('"role":"tool"'));
      A.ok(body && body.text.includes(SENTINEL), '(g) the title of S2 (it holds the sentinel) really reached the model through session.list');
      const delAt = await rig.forget(S2);
      A.eq(delAt.status, 200, '(g) S2 deleted');
      const T2 = await rig.transcript(T);
      const listRow = T2.turns.find(row => row.role === 'tool' && String(row.content).includes('second'));
      A.ok(!!listRow && !listRow.quotes, '(g) T\'s earlier session.list tool row stays in display (titles are metadata: no stamp)');
      const k = Date.now();
      up.behave = ctx => ctx.made('session_list') === 0 ? { tool: 'session_list', args: {} } : { text: 'listed again.' };
      const again = await rig.run(T, 'list the sessions once more');
      A.eq(again.end && again.end.reason, 'done', '(g) a later session.list runs');
      const second = up.bodies.slice().reverse().find(b => b.main && b.at >= k && b.text.includes('"role":"tool"') && b.text.includes('list the sessions once more'));
      const toolTexts = second ? second.body.messages.filter(m => m.role === 'tool').map(m => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))) : [];
      A.ok(second && !toolTexts.slice(-1)[0].includes('second ' + SENTINEL), '(g) a later session.list omits the deleted session');
      A.ok(second && toolTexts.slice(0, -1).some(t => t.includes('second ' + SENTINEL)), '(g) ...while the earlier session.list row stays in model-replay (I7\'s named limit (c): a title is metadata, not a quote)');
    });

    // ---------------- the recorded limit (Q4(b)): words another session took from a QUOTING row are not tracked
    // V reads T3's quoting reply (never S3 itself); S3 is deleted. T3's rows go, V's row that copied them stays. A passing control, not an aim: it flips if Q4(b) is answered "track".
    await leg('limit-b', async () => {
      const S3 = 'ws_nine', T3 = 'ws_nine_reader', V3 = 'ws_nine_copier', NINE = 'Quokka-Nine';
      await rig.list([S3, 'nine'], [T3, 'nine reader'], [V3, 'nine copier'], [T, 'reader'], [U, 'control']);
      up.behave = () => ({ text: 'The nine codeword is ' + NINE + '.' });
      await rig.run(S3, 'nine says a codeword');
      up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'nine codeword', scope: 'all' } } : { text: 'it was ' + NINE + ' recalled' };
      await rig.run(T3, 'what does nine say?');
      up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'recalled', scope: 'stream', stream: T3 } } : { text: 'copied' };
      up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'recalled', scope: 'all' } } : { text: 'copied' };
      const v = await rig.run(V3, 'what was recalled?');
      A.eq(v.end && v.end.reason, 'done', 'V read T3\'s quoting reply');
      const vRows = (await rig.transcript(V3)).turns;
      const copy = vRows.find(row => row.role === 'tool' && String(row.content).includes(NINE));
      A.ok(copy && Array.isArray(copy.quotes) && copy.quotes.includes(T3) && !copy.quotes.includes(S3), 'V\'s tool row holds S3\'s word and names the session it read (T3), not S3');
      await rig.forget(S3);
      A.ok(!rowsText((await rig.transcript(T3)).turns).includes(NINE), 'T3\'s rows (it read S3) are gone');
      A.ok(rowsText((await rig.transcript(V3)).turns).includes(NINE), 'RECORDED LIMIT (Q4(b), the paraphrase/transitive limit): the row of the session that copied T3\'s quoting reply keeps the word');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(rig.fx.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await rig.dispose();
  }
  if (failed.length) process.exitCode = 1;
  A.report('forget.tool-quotes.http');
})().catch(e => { console.error(e); process.exit(1); });
