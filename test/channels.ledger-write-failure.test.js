/* node test/channels.ledger-write-failure.test.js — a write that fails while the process lives never runs a tool step
   twice and never sends an accepted part again (channel-delivery-ledger S2; c1, r6, r1 A).

   THE FAMILY. A live process whose writes fail while its sends succeed: an antivirus or indexer holding the file
   (EBUSY, EPERM), a full disk (ENOSPC), or an update freezing every durable write from its prepare to the frozen point
   (UPDATE_MUTATIONS_FROZEN). At trunk one EBUSY on the write that ended a message left its receipt behind; the next
   recovery cue in the SAME process took it for work never done and ran it from the top — the tool step twice, the answer
   twice (c1, r6) — and with writes frozen every flush pass resent a queued answer whose removal could not be written (r1
   A: four sends in four passes). The delivery ledger keeps the change in memory, where it is authoritative in this
   process; it holds every lane until a retry lands it, and starts no part while the update barrier is up.

   Every case runs the REAL hub over the REAL channel store on an in-memory disk that can refuse writes; the recovery cue
   is the adapter's 'up' (hub.onStatus) and the timers are held by hand. Proves:
     (a) one EBUSY on the write that answers a message, after its run began a tool step: the step runs once, and the
         reply lands once, after the write succeeds
     (b) a processing throw after N tool steps, in one process: one interrupted notice, nothing re-runs; after 0 steps
         the message runs again once, and a second failure is settled with a notice
     (c) writes frozen while a backlog drains: an accepted part is never sent again in this process, every lane holds,
         and the lanes resume after the thaw with no duplicate
     (d) while holding() is true, no lane starts a part, over the very barrier index.js hands the store (updateHolding), and
         every ledger write goes through the update freeze (writeFileDurable)
     (e) the status delivery line every status reader shows (index.js channelDeliveryLine) names the hold */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path').posix;
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { sidecarFunctionSource, readSidecarSource, callRegion, objectProps } = require('./helpers/source.js');

const ROOT = '/ws/channels';
// the files that carry delivery state, whatever this tree calls them (the ledger; the v1 inbox and outbox at trunk)
const DELIVERY_STATE = /\/(delivery|inbox|outbox)\.json$/;
function memDisk() {
  const files = new Map();
  const d = {
    files, freeze: '', faults: [],
    // refuse the next write whose target matches `re`
    failNext(code, re) { d.faults.push({ code: code, re: re || DELIVERY_STATE }); },
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) {
      if (d.freeze) throw Object.assign(new Error(d.freeze + ': durable writes are frozen'), { code: d.freeze });
      const i = d.faults.findIndex(f => f.re.test(b));
      if (i >= 0) { const f = d.faults.splice(i, 1)[0]; throw Object.assign(new Error(f.code + ': simulated, ' + b), { code: f.code }); }
      if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; }
      files.set(b, files.get(a)); files.delete(a);
    },
    mkdirSync() {}
  };
  return d;
}
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; list.push(t); return t; },
    clearTimeout(t) { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
    async fire() { const due = list.splice(0); for (const t of due) t.fn(); await settle(); }
  };
}
const settle = async (n) => { for (let i = 0; i < (n || 60); i++) await new Promise(r => setImmediate(r)); };
let T = 1761900000000;
const msg = (chatId, mid, text) => ({ channel: 'telegram', chatId: String(chatId), chatType: 'dm', userId: 'u1', text: text, messageId: String(mid), ts: 1 });

// one process: a store over the disk and a hub over it, both on the same hand-held timers
function boot(disk, opts) {
  const o = opts || {};
  const timers = fakeTimers();
  const store = makeChannelStore({ fs: disk, pathMod, root: ROOT, clock: { now: () => T }, timers, holding: o.holding });
  const sends = [], journal = [];
  let n = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store,
    runOnce: async (o2) => {
      const words = String(o2.messages[o2.messages.length - 1].content);
      o2.emit('agent.run.start', { runId: o2.runId });
      for (let i = 0; i < (o.steps || 0); i++) {
        o2.emit('agent.tool_call', { runId: o2.runId, callId: 'c' + i, name: 'fs_append' });
        journal.push(words + '#' + i);   // the tool step's side effect
      }
      if (o.afterSteps) o.afterSteps();
      o2.emit('agent.token', { delta: 'answer to ' + words });
      o2.emit('agent.run.end', { reason: 'done' });
    },
    send: async (chatId, text) => { if (o.sendFails && o.sendFails()) return { ok: false, error: 'Bad Gateway', retryable: true }; sends.push({ chatId: String(chatId), text: String(text) }); return { ok: true, messageId: 'm' + sends.length }; },
    secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => false,
    newId: () => 'run-' + (++n), sleep: () => Promise.resolve(), now: () => T,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
  }, o.hub || {}));
  return { store, hub, sends, journal, timers };
}
const answersTo = (p, words) => p.sends.filter(s => s.text.replace(/^⌛[^\n]*\n/, '') === 'answer to ' + words).length;

(async () => {
  // ---- (a) one EBUSY on the answering write after a run began a tool step ----
  {
    const disk = memDisk();
    const p = boot(disk, { steps: 1, afterSteps: () => disk.failNext('EBUSY') });   // armed after the step's own mark
    await p.hub.onInbound(msg(4242, 1, 'append the audit line')).catch(() => {});
    await settle();
    // the recovery cues of this same process: an 'up', the timers (the ledger's write retry, the hub's recover timer), an 'up'
    p.hub.onStatus({ state: 'up' }); await settle();
    await p.timers.fire();
    p.hub.onStatus({ state: 'up' }); await settle();
    await p.timers.fire();
    A.eq(p.journal, ['append the audit line#0'], '(a) the tool step ran ONCE (trunk: twice — the refused receipt write replayed the message in the same process)');
    A.eq(answersTo(p, 'append the audit line'), 1, '(a) the reply landed ONCE, after the write succeeded (trunk: twice)');
    p.hub.close();
  }

  // ---- (b) a processing throw after N tool steps, in one process: one notice, nothing re-runs ----
  {
    const disk = memDisk();
    const p = boot(disk, { steps: 2, hub: { taskIntent: { parse: () => { throw new Error('the reply could not be read'); }, strip: (t) => t } } });
    await p.hub.onInbound(msg(4242, 2, 'rename the files')).catch(() => {});
    for (let i = 0; i < 3; i++) { p.hub.onStatus({ state: 'up' }); await settle(); await p.timers.fire(); }
    A.eq(p.journal.filter(j => /^rename the files/.test(j)), ['rename the files#0', 'rename the files#1'], '(b) the two steps ran once each (trunk: the message ran again from the top)');
    const notices = p.sends.filter(s => /NOT run again/.test(s.text));
    A.eq(notices.length, 1, '(b) the chat gets ONE notice that it was not run again');
    A.ok(notices.length === 1 && /stopped on an error/.test(notices[0].text) && !/restarted/i.test(notices[0].text), '(b) saying it stopped on an error — nothing restarted');
    p.hub.close();
  }
  {
    // 0 steps: one second go, then a settle with a notice — never a third run
    const disk = memDisk();
    let runs = 0;
    const p = boot(disk, { steps: 0, afterSteps: () => { runs++; }, hub: { taskIntent: { parse: () => { throw new Error('the reply could not be read'); }, strip: (t) => t } } });
    await p.hub.onInbound(msg(4242, 3, 'what is the plan')).catch(() => {});
    for (let i = 0; i < 4; i++) { p.hub.onStatus({ state: 'up' }); await settle(); await p.timers.fire(); }
    A.eq(runs, 2, '(b) after 0 steps it runs again ONCE (trunk: again on every recovery cue)');
    A.eq(p.sends.filter(s => /was not finished/.test(s.text) && /NOT run again/.test(s.text)).length, 1, '(b) a second failure is settled with one notice');
    p.hub.close();
  }

  // ---- (c) writes frozen while a backlog drains ----
  {
    const disk = memDisk();
    let down = true;
    const p = boot(disk, { sendFails: () => down });
    for (let i = 0; i < 3; i++) await p.hub.onInbound(msg(4242, 10 + i, 'question ' + i)).catch(() => {});
    A.eq(p.sends.length, 0, '(c) fixture: three replies are owed while the transport was down');
    disk.freeze = 'UPDATE_MUTATIONS_FROZEN';   // an update's prepare froze every durable write...
    down = false;                              // ...and the transport is back
    for (let i = 0; i < 4; i++) { p.hub.onStatus({ state: 'up' }); await settle(); await p.timers.fire(); }
    A.ok(p.sends.length <= 1, '(c) frozen: at most the one part the platform took before its mark failed, then every lane holds (trunk: the queued answer went out on every pass) — sent ' + p.sends.length);
    disk.freeze = '';                          // the thaw (an update that was cancelled)
    for (let i = 0; i < 3; i++) { await p.timers.fire(); p.hub.onStatus({ state: 'up' }); await settle(); }
    A.eq([0, 1, 2].map(i => answersTo(p, 'question ' + i)), [1, 1, 1], '(c) thawed: every reply lands exactly once — an accepted part is never sent again in this process');
    p.hub.close();
  }

  // ---- (d) while holding() is true, no lane starts a part ----
  {
    // the store index.js builds, property by property: a lane knows the barrier only through what it was handed
    const bag = objectProps(callRegion(readSidecarSource(), 'const channelStore = makeChannelStore({', '});'));
    const prop = (k) => (bag.find(x => x.key === k) || {}).expr || '';
    A.eq(prop('writeDurable'), 'writeFileDurable', '(d) every ledger write index.js makes goes through the update freeze');
    A.eq(prop('holding'), '() => updateHolding()', '(d) index.js hands the store the update barrier');
    const disk = memDisk();
    let down = true, hold = false;
    const holding = prop('holding') ? new Function('updateHolding', 'return (' + prop('holding') + ');')(() => hold) : undefined;   // eslint-disable-line no-new-func
    const p = boot(disk, { sendFails: () => down, holding: holding });
    await p.hub.onInbound(msg(4242, 20, 'the late one')).catch(() => {});
    hold = true; down = false;                 // the update barrier is up; the transport is back
    for (let i = 0; i < 3; i++) { p.hub.onStatus({ state: 'up' }); await settle(); await p.timers.fire(); }
    A.eq(p.sends.length, 0, '(d) while the update barrier holds, no lane starts a part (the process may be killed any moment)');
    hold = false;
    await p.timers.fire(); p.hub.onStatus({ state: 'up' }); await settle();
    A.eq(answersTo(p, 'the late one'), 1, '(d) once it lowers, the reply goes, once');
    p.hub.close();
  }

  // ---- (e) the status delivery line names the hold ----
  {
    const src = sidecarFunctionSource('channelDeliveryLine');
    A.ok(!!src, '(e) index.js composes the status delivery line in one place (channelDeliveryLine)');
    if (src) {
      const disk = memDisk();
      const p = boot(disk);
      const line = new Function('channelStore', src + '\nreturn channelDeliveryLine;')(p.store);
      A.eq(line({ state: 'up', detail: '', at: 1 }).state, 'up', '(e) a healthy ledger leaves the line as the last send wrote it');
      disk.freeze = 'UPDATE_MUTATIONS_FROZEN';
      let refused = false;
      try { p.hub.onInbound(msg(4242, 30, 'during the freeze')); } catch (_) { refused = true; }
      A.ok(refused, '(e) a message arriving during the freeze is refused synchronously (its receipt cannot be written: the adapter does not acknowledge it)');
      await p.hub._internals.deliver('4243', 'a reply while frozen', 'run-z', 'done');
      const held = line({ state: 'up', detail: '', at: 1 });
      A.eq(held.state, 'down', '(e) a held ledger turns the line down (the CHANNELS panel and Live Doctor read it)');
      A.ok(/delivery ledger cannot be written \(UPDATE_MUTATIONS_FROZEN\); holding outbound, retrying/.test(held.detail || ''), '(e) and names the hold: ' + held.detail);
      disk.freeze = '';
      await p.timers.fire();
      A.eq(line({ state: 'up', detail: '', at: 1 }).state, 'up', '(e) the retry lands and the line clears');
      p.hub.close();
    }
  }

  /* ---- (f) WRITE-AHEAD MARKS: the station dies while its writes fail, and still no tool step runs twice (review round 1) ----
     The run's start and each tool step were marked fire-and-forget: a failed write only left the ledger dirty, the run went
     on and the step was dispatched. A crash before the persist retry landed left the receipt's older attempt on the disk,
     and the next boot replayed the message from the top: its tool step ran twice. Now a run starts, and a step is
     dispatched, only once its mark is on the disk; otherwise the message is held, its receipt pending, until the writes
     work again (a step's mark is taken back, and its run stopped before loop.js dispatches it). On the production wiring:
     the station Telegram hub lifted out of startTelegram over the real store and ledger (test/helpers/channel-station-sim.js),
     its writes failing from the very mark named, then the station dying in the span and booting again from the same disk. */
  {
    const Sim = require('./helpers/channel-station-sim.js');
    const attemptOf = (text, rid) => { try { const r = (JSON.parse(text).receipts || []).find(x => x.id === rid); return r ? r.attempt : null; } catch (_) { return null; } };
    const cases = [
      { label: 'the run\'s start mark', when: (a) => !!(a && a.runId), crash: true },
      { label: 'its first tool step\'s mark', when: (a) => !!(a && a.tools >= 1), crash: true },
      { label: 'its first tool step\'s mark, and nobody restarts', when: (a) => !!(a && a.tools >= 1), crash: false }
    ];
    for (const c of cases) {
      const w = Sim.makeWorld(21, {});
      w.install();
      try {
        w.boot();
        await w.advance(500);
        const tag = String(w.tags + 1);
        w.plans.set(tag, { steps: 2, stepMs: 1500, long: false, question: false });
        w.inbound(Sim.CHATS.tgDm, 'message');                                      // its receipt is durable
        const rid = Sim.CHATS.tgDm + '|' + w.tgMsgId;
        w.refuseCode = 'EBUSY';
        w.refuseWhen = (text) => c.when(attemptOf(text, rid));                     // from that mark on, every write fails
        await w.advance(2500);
        A.ok(w.writeFault === 'EBUSY', '(f) ' + c.label + ': the writes began failing at that mark');
        A.eq(w.journal.get(tag + '#0') || 0, 0, '(f) ' + c.label + ': the step whose mark could not be written was never dispatched (was: it ran)');
        if (c.crash) w.crash('the station dies while its writes fail');
        await w.advance(3000);
        w.writeFault = '';                                                         // the antivirus lets go
        if (c.crash) w.boot();
        await w.advance(65000);                                                    // a recover timer or two
        A.eq([w.journal.get(tag + '#0') || 0, w.journal.get(tag + '#1') || 0], [1, 1], '(f) ' + c.label + ': once the writes work, the message runs, each tool step exactly once (was: step 0 twice after the restart)');
        A.eq(w.wire.filter(m => m.chat === Sim.CHATS.tgDm && /^REPLY /.test(String(m.text).replace(/^⌛[^\n]*\n/, ''))).length, 1, '(f) ' + c.label + ': and its reply lands once');
      } finally { w.uninstall(); }
    }
  }

  A.report('channels.ledger-write-failure.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
