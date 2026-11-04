/* node test/channels.inbox-recovery.test.js — a crash mid-run never replays a channel message from the top (e5ecd6b8).

   Live-caught 2026-10-20 (sweep/channels): the station was killed while a Telegram "append audit line now" run held its
   final reply (the fs_append had already run). On boot the durable inbox replayed message 7046 as a brand-new second
   user turn, the model appended the line AGAIN (audit.log 11 -> 22 bytes), and the phone was told "Appended one line".
   The `recovered` intake flag had no reader at all.

   Every case below is the real hub over the real channel store on one in-memory disk. A "crash" is the first process's
   hub closed with its run still hanging, and a NEW store instance over the same disk (its live claims die with the old
   process) — exactly what a restarted sidecar sees. Proves:
     A. a receipt whose run had begun a tool step is NOT run again: one notice says so, the next run is told, once
     B. a receipt whose run had begun NO tool step runs again once, is said to be a second go, and files ONE copy of the turn
     C. the same holds when the second go reads the canonical stream (the interrupted run's directive row is not doubled)
     D. a merged text batch (one run, two receipts) gets ONE notice, no run, and both receipts are cleared
     E. Telegram handing the SAME update over again after the restart (no recovery pass) is held to the same rule
     F. the ledger's attempt marker: unknown id is a no-op, the tool count never goes down, it survives a restart, every
        mark stamps the boot of the process that wrote it, and a replay counts itself
     G. ONE attempt rule, whichever process left the attempt (channel-delivery-ledger S2; was: an attempt THIS process left
        replayed from the top, tool steps included — c1, r6): N tool steps get the interrupted notice and never re-run;
        0 steps re-run once, and a second failure is settled with a notice; the chat is told it stopped on an error, not
        that StarNet restarted
     H. a finished answer a v1 inbox held (the full outbox had refused it) becomes one delivery at the upgrade: sent once,
        never re-run (was: kept on the receipt and replayed)
   (the store's receipts and replies live in the delivery ledger, channels/delivery-ledger.js) */
'use strict';
const History = require('./helpers/channel-history.js');
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = (() => {
  if (!process.env.CHANNEL_RETRY_HUB_SOURCE) return require('../sidecar/channels/hub.js');
  const Module = require('node:module'), filename = require.resolve('../sidecar/channels/hub.js');
  const owner = new Module(filename, module); owner.filename = filename; owner.paths = Module._nodeModulePaths(pathMod.dirname(filename));
  owner._compile(require('node:fs').readFileSync(process.env.CHANNEL_RETRY_HUB_SOURCE, 'utf8'), filename);
  return owner.exports;
})();

function memFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}

let clk = 1000;
const clock = { now: () => clk++ };
const ROOT = '/ws/channels';
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, n) { for (let i = 0; i < (n || 80) && !pred(); i++) await tick(); }
const hang = () => new Promise(() => {});   // the run the kill interrupted: it never returns

// ONE PROCESS: a fresh store over the shared disk + a hub whose runOnce is `script`. Each boot mints its own run ids.
let bootN = 0;
function boot(disk, script, extra, storeOpts) {
  const tag = 'p' + (++bootN);
  const store = makeChannelStore(Object.assign({ fs: disk, pathMod, root: ROOT, clock }, storeOpts || {}));
  const sends = [], runs = [];
  const supplied = Object.assign({}, extra || {});
  if (typeof supplied.historyForStore === 'function') { supplied.history = supplied.historyForStore(store); delete supplied.historyForStore; }
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram',
    runOnce: async (o) => { runs.push(o); return script(o, runs.length); },
    store,
    send: async (chatId, text) => { sends.push({ chatId: String(chatId), text: String(text) }); return { ok: true, messageId: tag + '-m' + sends.length }; },
    secrets: () => ({ key: 'k', model: 'm', configured: true }),
    emit: () => {},
    newId: (() => { let n = 0; return () => tag + '-run-' + (++n); })(),
    sleep: () => Promise.resolve(), outboxRetryMs: 5
  }, supplied));
  return { store, hub, sends, runs };
}
const userCopies = (list, words) => (list || []).filter(m => m && m.role === 'user' && m.content === words).length;

(async () => {
  // ---- A. the live repro: a tool step had begun -> no second run, the chat is told, the next run knows ----
  {
    const disk = memFs();
    const audit = [];
    const msg = { chatId: '4242', chatType: 'dm', userId: 'u1', text: 'append audit line now', messageId: '7046', ts: 1 };
    // the scripted model: brief, then fs_append (the side effect lands), then the final text turn is held open — killed here
    const p1 = boot(disk, async (o) => {
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.tool_call', { runId: o.runId, callId: 'c1', name: 'fs_append' });
      audit.push('AUDIT-LINE');
      await hang();
    });
    p1.hub.onInbound(msg);
    await waitFor(() => audit.length === 1);
    A.eq(audit.length, 1, 'fixture: the first attempt appended its line before the kill');
    const receipt = p1.store.ledger.pending('telegram')[0];
    A.ok(receipt && receipt.attempt && receipt.attempt.runId === p1.runs[0].runId && receipt.attempt.tools === 1,
      'the durable receipt names the run that started and the tool step it began (written before the step ran)');
    p1.hub.close();                                                    // the kill

    // the same scripted model, booted again: given the chance it would append the line again
    const p2 = boot(disk, async (o) => {
      o.emit('agent.run.start', { runId: o.runId });
      if (/append audit line/.test(String((o.messages[o.messages.length - 1] || {}).content || ''))) {
        o.emit('agent.tool_call', { runId: o.runId, callId: 'c2', name: 'fs_append' });
        audit.push('AUDIT-LINE');
        o.emit('agent.token', { delta: 'Appended one line to audit.log.' });
      } else {
        o.emit('agent.token', { delta: 'ok' });
      }
      o.emit('agent.run.end', { reason: 'done' });
    });
    p2.hub.onStatus({ state: 'up' });                                  // the first poll-up replays the durable inbox
    await waitFor(() => p2.store.ledger.pending('telegram').length === 0);
    A.eq(p2.store.ledger.pending('telegram'), [], 'the recovered receipt is settled');
    A.eq(p2.runs.length, 0, 'the replay does NOT run the interrupted task again from the top');
    A.eq(audit.length, 1, 'the audit line is in the file exactly once');
    A.eq(p2.sends.length, 1, 'the chat gets exactly one message after the restart');
    const notice = (p2.sends[0] || {}).text || '';
    A.ok(/restarted/.test(notice) && /"append audit line now"/.test(notice), 'it says the station restarted while working on THAT request');
    A.ok(/already begun 1 tool step/.test(notice) && /NOT run again/.test(notice), 'it says a step had begun and that nothing was run again');
    A.ok(!/Appended one line/.test(notice), 'no reply claims the work was just done');
    A.eq(userCopies(p2.store.loadHistory('tg_4242'), 'append audit line now'), 1, 'the transcript holds the request once, not twice');

    // the Commander says "continue": that run is told what the interrupted attempt had already begun — once
    await p2.hub.onInbound({ chatId: '4242', chatType: 'dm', userId: 'u1', text: 'continue', messageId: '7048', ts: 2 });
    A.eq(p2.runs.length, 1, 'a real follow-up runs normally');
    A.ok(/AN EARLIER REQUEST WAS INTERRUPTED/.test(p2.runs[0].system) && /begun 1 tool step/.test(p2.runs[0].system),
      'the next run\'s system context carries the host note naming the steps that already began');
    A.ok(!/append audit line now/.test(p2.runs[0].system), 'the note never copies the chat text into the system prompt');
    await p2.hub.onInbound({ chatId: '4242', chatType: 'dm', userId: 'u1', text: 'thanks', messageId: '7050', ts: 3 });
    A.ok(!/AN EARLIER REQUEST WAS INTERRUPTED/.test(p2.runs[1].system), 'the note is one-shot');
    p2.hub.close();
  }

  // ---- B. no tool step had begun -> it runs again once, said so, with one copy of the turn ----
  {
    const disk = memFs();
    const words = 'what is the capital of peru';
    const p1 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); await hang(); });   // killed mid-thought
    p1.hub.onInbound({ chatId: '55', chatType: 'dm', userId: 'u1', text: words, messageId: '900', ts: 1 });
    await waitFor(() => p1.runs.length === 1);
    const firstRunId = p1.runs[0].runId;
    const att = (p1.store.ledger.pending('telegram')[0] || {}).attempt || {};
    A.eq({ runId: att.runId, tools: att.tools, boot: att.boot }, { runId: firstRunId, tools: 0, boot: p1.store.bootId }, 'fixture: the receipt names the started run, no tool step, and this process');
    p1.hub.close();

    const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'Lima.' }); o.emit('agent.run.end', { reason: 'done' }); });
    p2.hub.onStatus({ state: 'up' });
    await waitFor(() => p2.store.ledger.pending('telegram').length === 0 && p2.sends.length >= 2);
    A.eq(p2.runs.length, 1, 'nothing could have happened twice, so the message runs again — once');
    A.eq(userCopies(p2.runs[0].messages, words), 1, 'the second go sends the model the request ONCE, not as the Commander asking twice');
    A.eq(p2.runs[0].retryUserRunId, firstRunId, 'the second go reuses the interrupted run\'s directive row (runOnce retryUserRunId)');
    A.eq(userCopies(p2.store.loadHistory('tg_55'), words), 1, 'the transcript files the request once');
    A.ok(/restarted/.test(p2.sends[0].text) && /had not begun any tool step/.test(p2.sends[0].text), 'the chat is told this is a second go after a restart');
    A.ok(/Lima\./.test(p2.sends[1].text), 'and then gets the real answer');
    A.eq(p2.store.ledger.pending('telegram'), [], 'the receipt is settled by the answer');
    p2.hub.close();
  }

  // ---- C. the second go over the CANONICAL stream: the interrupted run's directive row is not doubled ----
  {
    const disk = memFs();
    const words = 'summarise the meeting notes';
    let io, transcript;
    const historyForStore = store => {
      const canonical = History.make(store, { io });
      transcript = canonical.transcript;
      if (!io) for (const row of [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: words, directive: true, turnId: 'earlier_same_words', sourceRunId: 'earlier_run' }])
        transcript.appendStrict(Object.assign({ streamId: 'channel_telegram_66', agentId: 'tg_66', kind: 'turn' }, row));
      io = canonical.io; return canonical.history;
    };
    // the host writes the triggering words into the canonical stream before the first model call (transcript-run.js start)
    const p1 = boot(disk, async (o) => {
      transcript.appendStrict({ streamId: o.streamId, agentId: o.agentId, role: 'user', kind: 'turn', directive: true, turnId: o.turnId, content: o.messages[o.messages.length - 1].content, sourceRunId: o.runId });
      o.emit('agent.run.start', { runId: o.runId });
      await hang();
    }, { historyForStore });
    p1.hub.onInbound({ chatId: '66', chatType: 'dm', userId: 'u1', text: words, messageId: '910', ts: 1 });
    await waitFor(() => p1.runs.length === 1);
    p1.hub.close();
    const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'Summary.' }); o.emit('agent.run.end', { reason: 'done' }); }, { historyForStore });
    p2.hub.onStatus({ state: 'up' });
    await waitFor(() => p2.store.ledger.pending('telegram').length === 0);
    A.eq(p2.runs.length, 1, 'canonical: the second go runs once');
    A.eq(userCopies(p2.runs[0].messages, words), 2, 'canonical: the interrupted directive is excluded but the distinct earlier same-text turn remains beside the current input');
    A.eq(p2.runs[0].messages.map(row => row.content), ['earlier question', 'earlier answer', words, words], 'canonical: retry exclusion uses turn identity, never the now-last equal text');
    A.eq(userCopies(p2.runs[0].messages, 'earlier question'), 1, 'canonical: the real earlier history is untouched');
    p2.hub.close();
  }

  // ---- D. a merged text batch: one interrupted run over two receipts -> one notice, no run, both cleared ----
  {
    const disk = memFs();
    const p1 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.tool_call', { runId: o.runId, callId: 'c1', name: 'web_fetch' }); o.emit('agent.tool_call', { runId: o.runId, callId: 'c2', name: 'fs_write' }); await hang(); }, { textBatchWaitMs: 5 });
    p1.hub.onInbound({ chatId: '77', chatType: 'dm', userId: 'u1', text: 'write the report', messageId: 'b1', ts: 1 });
    p1.hub.onInbound({ chatId: '77', chatType: 'dm', userId: 'u1', text: 'and email it', messageId: 'b2', ts: 2 });
    await waitFor(() => p1.runs.length === 1 && (p1.store.ledger.pending('telegram')[1] || {}).attempt && p1.store.ledger.pending('telegram')[1].attempt.tools === 2);
    A.eq(p1.runs.length, 1, 'fixture: the two bubbles ran as one merged run');
    A.eq(p1.store.ledger.pending('telegram').map(x => x.attempt && x.attempt.tools), [2, 2], 'BOTH receipts carry the merged run\'s two begun steps');
    p1.hub.close();
    const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.run.end', { reason: 'done' }); }, { textBatchWaitMs: 5 });
    p2.hub.onStatus({ state: 'up' });
    await waitFor(() => p2.store.ledger.pending('telegram').length === 0);
    A.eq(p2.store.ledger.pending('telegram'), [], 'both receipts are settled');
    A.eq(p2.runs.length, 0, 'neither bubble starts a run of its own');
    A.eq(p2.sends.filter(s => /restarted/.test(s.text)).length, 1, 'the chat is told once for the one interrupted run');
    A.ok(/already begun 2 tool steps/.test((p2.sends[0] || {}).text || ''), 'the notice counts the run\'s steps');
    p2.hub.close();
  }

  // ---- E. Telegram re-delivers the SAME update after the restart (no recovery pass ran) -> same rule ----
  {
    const disk = memFs();
    const msg = { chatId: '88', chatType: 'dm', userId: 'u1', text: 'create the invoice', messageId: '700', ts: 1 };
    const p1 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.tool_call', { runId: o.runId, callId: 'c1', name: 'mcp__crm__create_invoice' }); await hang(); });
    p1.hub.onInbound(msg);
    await waitFor(() => ((p1.store.ledger.pending('telegram')[0] || {}).attempt || {}).tools === 1);
    p1.hub.close();
    const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.run.end', { reason: 'done' }); });
    await p2.hub.onInbound(Object.assign({}, msg));                   // the adapter hands the same update over again
    A.eq(p2.runs.length, 0, 'a re-delivered update whose run had begun a step is not run again');
    A.ok(p2.sends.length === 1 && /NOT run again/.test(p2.sends[0].text), 'the chat is told instead');
    A.eq(p2.store.ledger.pending('telegram'), [], 'and its receipt is settled');
    p2.hub.close();
  }

  // ---- F. the ledger's attempt marker ----
  {
    const disk = memFs();
    const s = makeChannelStore({ fs: disk, pathMod, root: ROOT, clock });
    const L = s.ledger;
    A.eq(L.markAttempt(['telegram|1|1'], { runId: 'r1' }), false, 'marking a receipt that already completed is a no-op');
    L.receive({ id: 'telegram|1|1', channel: 'telegram', chatId: '1', message: { chatId: '1', text: 'x', messageId: '1' } });
    L.markAttempt(['telegram|1|1'], { runId: 'r1' });
    L.markAttempt(['telegram|1|1'], { tools: 3 });
    L.markAttempt(['telegram|1|1'], { tools: 1 });
    L.markAttempt(['telegram|1|1'], { runId: 'x'.repeat(500) });
    const back = makeChannelStore({ fs: disk, pathMod, root: ROOT, clock }).ledger.pending('telegram')[0];
    A.eq(back.attempt.tools, 3, 'the begun-step count never goes down, and survives a store restart');
    A.eq(back.attempt.runId.length, 200, 'the run id is bounded');
    A.eq(L.receive({ id: 'telegram|1|1', channel: 'telegram', chatId: '1', message: { chatId: '1', text: 'x', messageId: '1' } }).attempt.tools, 3,
      'a duplicate intake returns the receipt WITH its attempt (what a re-delivery is judged by)');
    A.ok(typeof s.bootId === 'string' && s.bootId && back.attempt.boot === s.bootId, 'every mark stamps the boot of the process that wrote it');
    A.ok(makeChannelStore({ fs: disk, pathMod, root: ROOT, clock }).bootId !== s.bootId, 'a new store instance (a restarted process) has a boot of its own');
    A.eq(makeChannelStore({ fs: disk, pathMod, root: ROOT, clock, bootId: 'b-7' }).bootId, 'b-7', 'the boot is injectable');
    L.markAttempt(['telegram|1|1'], { runId: 'r2', replay: true });
    A.eq(L.receipt('telegram|1|1').attempt.replays, 1, 'a second go counts itself on the attempt');
  }

  // ---- G. ONE attempt rule, whichever process left the attempt ----
  // An attempt THIS process left (its processing threw, recovery replays it on its next cue) used to replay from the top:
  // one EBUSY after a delivered reply, or a throw after a tool step, ran the step twice and sent the answer twice (c1, r6).
  // Case G locked that rule; it now locks the one rule a restart gets too, worded for what really happened.
  {
    const disk = memFs();
    const p = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'Tidied.' }); o.emit('agent.run.end', { reason: 'done' }); });
    const id = 'telegram|61|610';
    p.store.ledger.receive({ id: id, channel: 'telegram', chatId: '61', message: { chatId: '61', chatType: 'dm', userId: 'u1', text: 'tidy the notes', messageId: '610', ts: 1 } });
    p.store.ledger.markAttempt([id], { runId: 'earlier-run', tools: 2 });
    A.eq(p.store.ledger.pending('telegram')[0].attempt.boot, p.store.bootId, 'fixture: the attempt was stamped by this process');
    p.hub.onStatus({ state: 'up' });
    await waitFor(() => p.store.ledger.pending('telegram').length === 0 && p.sends.length >= 1);
    A.eq(p.runs.length, 0, 'an attempt that began tool steps is NEVER run again, even in the process that left it');
    A.eq(p.sends.length, 1, 'the chat gets one notice');
    A.ok(/stopped on an error/.test(p.sends[0].text) && /already begun 2 tool steps/.test(p.sends[0].text) && /NOT run again/.test(p.sends[0].text),
      'it says the attempt stopped on an error (nothing restarted) after 2 steps, and that nothing was run again');
    A.ok(!/restarted/i.test(p.sends[0].text), 'and never that StarNet restarted');
    await p.hub.onInbound({ chatId: '61', chatType: 'dm', userId: 'u1', text: 'continue', messageId: '611', ts: 2 });
    A.ok(/AN EARLIER REQUEST WAS INTERRUPTED: An earlier request in this chat stopped on an error/.test((p.runs[0] || {}).system || ''), 'the next run\'s note says it stopped on an error');
    p.hub.close();
  }
  {
    // 0 tool steps, this process: run again ONCE, said so; a second failure is settled with a notice, never a third run
    const disk = memFs();
    let n = 0;
    const p = boot(disk, async (o) => { n++; o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'Done.' }); o.emit('agent.run.end', { reason: 'done' }); },
      { taskIntent: { parse: () => { throw new Error('the reply could not be read'); }, strip: (t) => t } });
    let threw = false;
    try { await p.hub.onInbound({ chatId: '63', chatType: 'dm', userId: 'u1', text: 'plan the trip', messageId: '630', ts: 1 }); } catch (_) { threw = true; }
    A.ok(threw && n === 1, 'fixture: processing threw after the run, before any reply (no tool step)');
    p.hub.onStatus({ state: 'up' });
    await waitFor(() => n === 2 && p.store.ledger.pending('telegram').length === 1 && p.sends.length >= 1);
    A.ok(/stopped on an error before it began any tool step/.test((p.sends[0] || {}).text || '') && /running it again now/.test((p.sends[0] || {}).text || ''),
      'the first replay runs it again once, and says it is a second go after an error');
    A.eq((p.store.ledger.pending('telegram')[0] || {}).attempt && p.store.ledger.pending('telegram')[0].attempt.replays, 1, 'the second go counted itself');
    p.hub.onStatus({ state: 'up' });
    await waitFor(() => p.store.ledger.pending('telegram').length === 0);
    A.eq(n, 2, 'it is never run a third time');
    A.ok(/was not finished/.test(p.sends[p.sends.length - 1].text) && /NOT run again/.test(p.sends[p.sends.length - 1].text), 'the chat is told it was not finished and not run again');
    p.hub.close();
  }

  // ---- H. a finished answer a v1 inbox held survives the upgrade as ONE delivery: sent, never re-run ----
  {
    const disk = memFs();
    const msg = { channel: 'telegram', chatId: '62', chatType: 'dm', userId: 'u1', text: 'file the report', messageId: '620', ts: 1 };
    const held = { text: 'Report filed.', runId: 'dead-run', reason: 'done', agentId: 'tg_62', ids: ['telegram|62|620'] };
    // what an older build left: the receipt, its attempt (a step had begun), and the answer the full v1 outbox refused
    disk.files.set(pathMod.join(ROOT, 'inbox.json'), JSON.stringify({ version: 1, items: [{ id: 'telegram|62|620', channel: 'telegram', message: msg, ts: 1, attempt: { runId: 'dead-run', tools: 1, boot: 'old' }, held: held }] }));
    const filed = [];
    const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.tool_call', { runId: o.runId, callId: 'c2', name: 'fs_write' }); filed.push(2); o.emit('agent.run.end', { reason: 'done' }); });
    A.eq(p2.store.ledger.pending('telegram'), [], 'the upgrade settles the receipt its held answer answered');
    p2.hub.onStatus({ state: 'up' });
    await waitFor(() => p2.sends.length >= 1);
    await waitFor(() => p2.store.ledger.deliveries().length === 0);
    A.eq(p2.runs.length, 0, 'the finished run is not run again');
    A.eq(filed.length, 0, 'its step happens no second time');
    A.eq(p2.sends.map(s => s.text), ['Report filed.'], 'the chat gets the answer the run finished, once, and no restart notice for work that was done');
    p2.hub.close();
  }
  A.report('channels.inbox-recovery.test');
})().catch(e => { console.error(e); process.exit(1); });
