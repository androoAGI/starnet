'use strict';
/* node test/forget.tool-quotes.overflow.http.test.js — ONE RUN HOLDS AT MOST 32 SESSIONS (turn identity commit 11, A2-FP-02).

   Forty-five sessions exist, each with a word of its own (seeded straight into the station's transcript while it was stopped). One REAL station, a
   scripted model, and the real recall_conversation, session.peek and code.run tools. T makes three cross-stream recall searches, a session.peek of a session
   past the room, and a nested code.run recall:

     - every result holds only words of latched sessions; the third search says what it withheld, with counts only; the peek is refused and none of the
       refused session's words are in the refusal; the nested recall obeys the same room
     - every row T drained carries a stamp inside the latch: at most 32 ids (or the saturated '*'); the latch never shrinks; no workspace file holds a word
     - deleting a LATE latched source hides exactly the rows drained from that read on and leaves the earlier ones; deleting an EARLY one hides everything
       after it; with and without a restart; recall (from another session), display and model-replay (T's next window) agree
     - park: a session.peek of another session that is bigger than a tool result may be is clamped, never saved to a workspace file (the host's parkOutput
       refuses a quoted read), while the same-sized read of the run's own session is saved (the control: the cap fires in this rig)
   The relays (a worker's reads are its lead's) are test/forget.tool-quotes.relay.http.test.js. */
const A = require('./_assert.js');
const path = require('node:path');
const { station, seedRows, filesHolding, rowsText } = require('./helpers/forget-quotes.js');

const WORKER = { agentId: 'worker-1', system: 'WORKER_MARK you are a worker.', name: 'WORKER', model: 'test/model', provider: 'openrouter', approvalMode: 'ask' };
const GROUPS = [['alpha', 1], ['beta', 16], ['gamma', 31]];   // word, first session number (15 sessions each)
const idOf = n => 'o' + String(n).padStart(2, '0');
const wordOf = n => 'Sent-' + idOf(n);

(async () => {
  const rig = await station('forget-quotes-overflow-', { crew: [WORKER] });   // a crew member is what opens the orchestrator tools (session.peek)
  const { up } = rig;
  const failed = [];
  const leg = async (name, fn) => { if (process.env.FQ_ONLY && !process.env.FQ_ONLY.split(',').includes(name)) return; if (process.env.FQ_TRACE) console.log('[leg] ' + name); try { await fn(); } catch (e) { failed.push(name); console.error('LEG ' + name + ' THREW', e && e.stack || e); A.ok(false, 'leg ' + name + ' ran to its end (' + ((e && e.message) || e) + ')'); } };
  const rowsOf = async stream => (await rig.transcript(stream)).turns;
  const stampsOf = rows => rows.filter(r => Array.isArray(r.quotes));
  const mentions = (text, from, to) => { const out = []; for (let n = from; n <= to; n++) if (String(text).includes(wordOf(n))) out.push(n); return out; };
  const toolTexts = body => body.messages.filter(m => m.role === 'tool').map(m => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  try {
    await rig.start();
    // 45 sessions that already exist: group alpha (1-15), beta (16-30), gamma (31-45), each a session of its own with its own word
    const at = Date.now() - 3600 * 1000;
    const rows = [];
    for (const [group, first] of GROUPS) for (let n = first; n < first + 15; n++) {
      const id = idOf(n), turn = 'seed_' + id + '_01';
      rows.push({ streamId: id, agentId: 'agent', role: 'user', content: 'tell me about the topic of ' + id, ts: at + n * 10, turnId: turn, kind: 'turn', directive: true, taint: null, taintKnown: true });
      rows.push({ streamId: id, agentId: 'agent', role: 'assistant', content: 'About ' + group + ': ' + wordOf(n) + ' is the word of session ' + id + '.', ts: at + n * 10 + 1, turnId: turn, kind: 'turn', taint: null, taintKnown: true });
    }
    // two long sessions for the park leg: thirty rows of about 2,900 characters each, so one session.peek of either is bigger than a tool result may be
    const PARK_BIG = 'Zephyr-Big', PARK_OWN = 'Zephyr-Own';
    const longRows = (id, word) => {
      const out = [];
      for (let k = 0; k < 15; k++) {
        const turn = 'seed_' + id + '_' + String(k).padStart(2, '0'), body = word + ' part ' + k + '. ' + 'quiet notes about moss and lichen. '.repeat(80);
        out.push({ streamId: id, agentId: 'agent', role: 'user', content: 'note ' + k + ' ' + body, ts: at + 100000 + k * 10, turnId: turn, kind: 'turn', directive: true, taint: null, taintKnown: true });
        out.push({ streamId: id, agentId: 'agent', role: 'assistant', content: 'kept ' + k + ' ' + body, ts: at + 100000 + k * 10 + 1, turnId: turn, kind: 'turn', taint: null, taintKnown: true });
      }
      return out;
    };
    rows.push(...longRows('pk_big', PARK_BIG), ...longRows('pk_own', PARK_OWN));
    await seedRows(rig, rows);
    await rig.list(...Array.from({ length: 45 }, (_, i) => [idOf(i + 1), 'session ' + idOf(i + 1)]), ['t1', 'reader'], ['pk_big', 'pkbig'], ['pk_own', 'pkown'], ['pk_t', 'park reader']);

    // ---------------- park: words a run quoted are never saved as a workspace file
    // A tool result over the output cap (window-scaled, at most 80,000 characters) is written to the agent's workspace in full and the model gets a pointer to
    // it. The words of ANOTHER session must not land there: the file would outlive the session's delete and the agent can read it back. The control is the
    // same read of the run's OWN session (not a quote), which is parked, so the cap really fires in this rig and the absence below means something.
    await leg('park', async () => {
      const agentDir = path.join(rig.fx.workspace, 'agent');
      const peek = (session, then) => ctx => ctx.made('session_peek') === 0 ? { tool: 'session_peek', args: { session, limit: 30 } } : { text: then };
      up.behave = peek('pkbig', 'peeked at the big session');
      const quoted = await rig.run('pk_t', 'peek at the big session (park-quoted)');
      A.eq(quoted.end && quoted.end.reason, 'done', 'park: the run that peeked at another session completes');
      A.ok(up.bodies.some(b => b.main && b.text.includes('(park-quoted)') && b.text.includes(PARK_BIG)), 'park: the model was handed the other session\'s words by the real session.peek (the read is a quote, and the test is not vacuous)');
      up.behave = peek('pkown', 'peeked at my own session');
      const own = await rig.run('pk_own', 'peek at my own session (park-own)');
      A.eq(own.end && own.end.reason, 'done', 'park: the control run completes');
      A.ok(filesHolding(agentDir, PARK_OWN).length >= 1, 'park control: the same-sized read of the run\'s OWN session is saved to a workspace file, so the output cap fires here: ' + JSON.stringify(filesHolding(agentDir, PARK_OWN)));
      A.eq(filesHolding(agentDir, PARK_BIG), [], 'park: the read of ANOTHER session is clamped and never saved: no file the agent can read holds its word');
      A.ok(rowsText((await rig.transcript('pk_t')).turns).includes(PARK_BIG), 'park: ...while the run\'s own rows do hold it, stamped, until the session is deleted');
      await rig.forget('pk_big');
      A.ok(!rowsText((await rig.transcript('pk_t')).turns).includes(PARK_BIG), 'park: after the delete the run\'s rows hold no word of the session');
      A.eq(filesHolding(agentDir, PARK_BIG), [], 'park: and still no file does');
    });

    // ---------------- overflow
    await leg('overflow', async () => {
      const t0 = Date.now();
      up.behave = ctx => {
        const n = ctx.made('recall_conversation') + ctx.made('session_peek') + ctx.made('code_run');
        if (n === 0) return { tool: 'recall_conversation', args: { query: 'alpha', scope: 'all', limit: 20 } };
        if (n === 1) return { tool: 'recall_conversation', args: { query: 'beta', scope: 'all', limit: 20 } };
        if (n === 2) return { tool: 'recall_conversation', args: { query: 'gamma', scope: 'all', limit: 20 } };
        if (n === 3) { const composed = new Set(mentions(ctx.toolResults[ctx.toolResults.length - 1], 31, 45)); let pick = 31; while (composed.has(pick)) pick++; return { tool: 'session_peek', args: { session: 'session ' + idOf(pick), limit: 5 } }; }
        if (n === 4) return { tool: 'code_run', args: { code: 'const r = await tool("recall_conversation", { query: "gamma", scope: "all", limit: 20 }); return r;' } };
        return { text: 'read them all' };
      };
      const run = await rig.run('t1', 'read everything you can find (overflow)');
      A.eq(run.end && run.end.reason, 'done', 'overflow: T completes');
      const bodies = up.bodies.filter(b => b.main && b.at >= t0 && b.text.includes('(overflow)'));
      const results = bodies.map(b => toolTexts(b.body)).map(t => t.slice(1));   // after the Task Brief notice
      const last = results[results.length - 1] || [];
      A.ok(last.length >= 5, 'overflow: five tool results reached the model (' + last.length + ')');
      const t1rows = await rowsOf('t1');
      const stamped = stampsOf(t1rows);
      const finalLatch = stamped.map(r => r.quotes).sort((a, b) => b.length - a.length)[0] || [];
      A.ok(stamped.length >= 5 && stamped.every(r => r.quotes.length <= 32 || (r.quotes.length === 1 && r.quotes[0] === '*')), 'overflow: every row T drained carries a stamp of at most 32 streams (or the saturated mark): ' + stamped.map(r => r.quotes.length).join(','));
      A.eq(finalLatch.length, 32, 'overflow: T\'s latch holds exactly 32 sessions when the room runs out');
      A.ok(stamped.every(r => r.quotes.every(id => finalLatch.includes(id) || id === '*')), 'overflow: every earlier stamp lies inside the final latch (the latch never shrinks)');
      const heard = new Set(); last.forEach(t => mentions(t, 1, 45).forEach(n => heard.add(idOf(n))));
      A.ok([...heard].every(id => finalLatch.includes(id)), 'overflow: every word any tool result held belongs to a latched session (' + heard.size + ' heard, ' + finalLatch.length + ' latched)');
      A.ok(last.some(t => /\d+ results? from \d+ other sessions? withheld: one run may read at most 32 sessions; continue in a new run\./.test(t)), 'overflow: the third search says what it withheld, with counts only');
      A.ok(last.some(t => /REFUSED/.test(t) && /at most 32 sessions/.test(t) && !mentions(t, 1, 45).length), 'overflow: the session.peek of a session past the room is refused, and none of its words are in the refusal: ' + JSON.stringify(last.map(t => t.slice(0, 160))));
      const nested = last[last.length - 1] || '';
      A.ok(/withheld|Relevant matches/.test(nested) && mentions(nested, 31, 45).every(n => finalLatch.includes(idOf(n))), 'overflow: the nested code.run recall obeys the same room');
      A.eq(filesHolding(path.join(rig.fx.workspace, 'agent'), 'Sent-o'), [], 'overflow: no workspace file the agent can read holds a word');
      const lateId = finalLatch[finalLatch.length - 1], earlyId = finalLatch[0];
      const firstStamp = stamped.find(r => r.quotes.includes(lateId));
      A.ok(!stamped[0].quotes.includes(lateId), 'overflow: the late source was read after the first rows were drained');
      globalThis.__overflow = { lateId, earlyId, lateRows: stamped.filter(r => r.quotes.includes(lateId)).map(r => r.rowId), allStamped: stamped.map(r => r.rowId) };
      void firstStamp;
    });

    // delete a LATE latched source, then an EARLY one, with a restart between
    await leg('overflow-delete', async () => {
      const { lateId, earlyId, lateRows, allStamped } = globalThis.__overflow;
      const probe = async label => {
        const at = Date.now();
        up.behave = ctx => ctx.made('recall_conversation') === 0 ? { tool: 'recall_conversation', args: { query: 'alpha beta gamma', scope: 'all', limit: 20 } } : { text: 'nothing more' };
        await rig.run('p_' + label, 'look around (' + label + ')');   // recall, from a stream that is not T
        up.behave = () => ({ text: 'replayed' });
        await rig.run('t1', 'look again (' + label + ')', { windowFrom: 'station', turnId: 'probe_' + label + '_0001', turnAt: at, clientNow: at, windowTokens: 92800 });   // model-replay, from T
        return up.bodies.filter(b => b.at >= at && b.main);
      };
      const visible = async () => (await rowsOf('t1')).filter(r => allStamped.includes(r.rowId)).map(r => r.rowId);
      await rig.forget(lateId);
      const afterLate = await visible();
      A.ok(lateRows.every(id => !afterLate.includes(id)) && afterLate.length === allStamped.length - lateRows.length && afterLate.length > 0, 'overflow: deleting the late source hides exactly the rows drained from that read on (' + afterLate.length + ' stamped rows stay of ' + allStamped.length + ')');
      let bodies = await probe('late');
      A.ok(bodies.every(b => !b.text.includes(wordOf(Number(lateId.slice(1))))), 'overflow: no body after it holds the late source\'s word');
      await rig.restart();
      A.eq((await visible()).length, afterLate.length, 'overflow: after a restart the same rows are hidden');
      await rig.forget(earlyId);
      const afterEarly = await visible();
      A.ok(afterEarly.length < afterLate.length, 'overflow: deleting the early source hides everything drained after its read too (' + afterEarly.length + ' stamped rows stay)');
      const t1 = await rig.transcript('t1');
      A.ok(!rowsText(t1.turns).includes(wordOf(Number(earlyId.slice(1)))) && !rowsText(t1.turns).includes(wordOf(Number(lateId.slice(1)))), 'overflow: display holds neither word: ' + [wordOf(Number(earlyId.slice(1))), wordOf(Number(lateId.slice(1)))].map(w => w + '=' + rowsText(t1.turns).includes(w)).join(' ') + ' ' + JSON.stringify(t1.turns.filter(r => rowsText([r]).includes('Sent-o')).map(r => [r.rowId, r.role, r.content.slice(0, 80), r.quotes && r.quotes.length])));
      bodies = await probe('early');
      A.ok(bodies.every(b => !b.text.includes(wordOf(Number(earlyId.slice(1)))) && !b.text.includes(wordOf(Number(lateId.slice(1))))), 'overflow: recall and model-replay hand the model neither word');
      await rig.restart();
      A.eq((await visible()).length, afterEarly.length, 'overflow: and the same after another restart');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(rig.fx.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await rig.dispose();
  }
  if (failed.length) process.exitCode = 1;
  A.report('forget.tool-quotes.overflow.http');
})().catch(e => { console.error(e); process.exit(1); });
