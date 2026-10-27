/* node test/stop-truth.test.js — STOP keeps the Commander's words and lets go of everything the stopped run was waiting on
   (live walk with a real model, 2026-10-14).

   Found on the 0.13.5 candidate:
     · a message queued behind a running turn vanished on STOP: not sent, not in the box, no notice (stopActive dropped the queue);
     · after STOP the bell kept the stopped run's approval under "NEEDS YOU — 2 waiting" (SYSTEM badge 2) while the rail's NEEDS YOU
       said 1, until a reload: the page drops the stream once the station confirms the kill, so the station's own
       permission.response for the run's open prompts never reached the page — and the thrown-abort teardown never settled them;
     · the floor's AWAITING APPROVAL tag and CREW's gold "needs your OK" card waited on that same lost response.
   And once trunk's SEND NOW key joined the queued pill (0.13.5 merge): a line handed to the run but not yet read when STOP
   landed died with the run, and a refusal arriving after the STOP re-queued it and auto-sent it as a new turn.
   And not just STOP (live walk on the 0.13.5 candidate, 2026-10-14): a SEND NOW line accepted mid hand-off was gone after a
   page RELOAD (which also cancels the run) — not in the message box, not in the history — because the sent-now list lived
   in page memory only. Section 1d runs the reload, close, crash and reconnect paths against the station's answer.

   This runs the REAL stopActive (+ its helpers) and the REAL bell settlement listener from chat.js in a sandbox. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const Channels = require('../frontend/app/channels.js');

// a browser's localStorage that outlives a "page": a reload is a NEW rig (fresh memory) on the SAME storage
function memStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, _m: m }; }
const onDisk = (storage, ws) => { const raw = storage.getItem('starnet.sentNow.v1'); return raw ? (JSON.parse(raw)[ws] || []) : []; };

function stopRig(opts) {
  Channels.reset();
  const bus = A.makeBus();
  const emitted = A.collectBus(bus, ['permission.response']);
  const settled = [], notified = [], lines = [], retired = [], aborted = [];
  let cancelResolve;
  const ctx = {
    console, Date, Promise, setTimeout: (opts && opts.setTimeout) || setTimeout, clearTimeout, JSON,
    localStorage: opts && opts.storage, sentNowChecks: new Map(), sentNowRetry: new Map(), log: null,
    U: { bus },
    Channels,
    activeWs: { id: 'ws1', agentId: 'agent', conversationMode: 'chat' },
    isBusy: () => true,
    loopStop: () => false,
    localLine: t => lines.push(t),
    interrupted: new Set(), stopSource: new Map(), queued: new Map(), sentNow: new Map(), heldBack: new Map(),
    flushQueued: () => {},
    status: () => {}, updateControls: () => {},
    retireOpenConsents: (wsId, runId) => retired.push([wsId, runId]),
    aborters: new Map([['ws1', { abort: () => aborted.push('ws1') }]]),
    Harness: (opts && opts.Harness) || { cancel: () => new Promise(r => { cancelResolve = r; }) },
    stopFailed: () => {},
    input: { value: opts && opts.typed || '' },
    autoGrowInput: () => {},
    renderQueued: () => {},
    askerName: () => 'NOVA', actionPhrase: () => 'hand work to copy',
    StationUI: { settleNotifs: k => settled.push(k), notify: (_t, _c, _cat, o) => notified.push(o) }
  };
  vm.createContext(ctx);
  // the bell's one shared settlement path (settlePromptNotice → keepNeeds) and its permission.response listener
  const settleStart = src.indexOf('  const settledPromptNotices = new Set();');
  const settleEnd = src.indexOf('  async function answerConsent(', settleStart);
  const promptStart = src.indexOf('  const promptNeeds = new Map();');
  const promptEnd = src.indexOf('  function backgroundPermissionNotify(', promptStart);
  A.ok(settleStart > 0 && settleEnd > settleStart && promptStart > 0 && promptEnd > promptStart, 'the bell settlement helpers are present');
  const helperNames = ['function restoreQueued', 'function settleStoppedAsks', 'function sendQueuedNow', 'function forgetSentNow',
    'function steerWire', 'function markSentNowLanded', 'function restoreSentNow', 'function settleSentNow', 'function giveBack', 'function returnHeld', 'function stopReportHolding',
    'function sentNowDisk', 'function keepSentNow', 'function sentNowOverdue', 'function dropSentNow', 'function releaseSentNow', 'function reconcileSentNow', 'async function askSentNow',
    'function sentNowVerdict', 'function shownSteer', 'function showSentNowRead'];
  const helperSrc = helperNames.map(h => A.fnBody(src, h));
  A.ok(helperSrc.every(Boolean), 'the STOP / SEND NOW helpers are present: ' + helperNames.filter((h, i) => !helperSrc[i]).join(', '));
  const helpers = helperSrc.join('\n');
  const stop = A.fnBody(src, 'function stopActive');
  A.ok(stop.length > 500 && stop.length < 12000, 'stopActive body located');
  vm.runInContext(src.slice(settleStart, settleEnd) + src.slice(promptStart, promptEnd) + '\n' + helpers + '\n' + stop
    + '\n;this.__stop = stopActive; this.__announced = announcedPrompt; this.__sendNow = sendQueuedNow; this.__landed = markSentNowLanded; this.__settleSentNow = settleSentNow; this.__returnHeld = returnHeld;'
    + ' this.__reconcile = reconcileSentNow; this.__release = releaseSentNow; this.__verdict = sentNowVerdict;', ctx);
  return { ctx, bus, emitted, settled, notified, lines, retired, aborted, confirm: v => cancelResolve(v) };
}

(async () => {
  // ── 1. the queued message survives STOP: back in the composer, unsent, and a line says so ──
  {
    const r = stopRig();
    r.ctx.queued.set('ws1', ['also make one of them funny']);
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.__stop('click');
    A.eq(r.ctx.queued.has('ws1'), false, 'the stopped stream keeps no queue that would auto-send later');
    A.eq(r.ctx.input.value, 'also make one of them funny', 'the queued words are back in the composer, unsent');
    A.ok(r.lines.some(l => /queued message was not sent/i.test(l) && /message box/i.test(l)), 'a short honest line says the queued message was not sent and where it went: ' + JSON.stringify(r.lines));
  }
  {
    // two queued + a half-typed draft: nothing is overwritten, order kept (queue first, then what is in the box)
    const r = stopRig({ typed: 'and shorter' });
    r.ctx.queued.set('ws1', ['first follow-up', 'second follow-up']);
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.__stop('esc');
    A.eq(r.ctx.input.value, 'first follow-up\nsecond follow-up\nand shorter', 'every queued message and the draft already in the box are kept, in order');
    A.ok(r.lines.some(l => /2 queued messages were not sent/i.test(l)), 'the line counts what came back');
  }
  {
    // nothing queued: no line, the box untouched
    const r = stopRig({ typed: 'draft' });
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.__stop('click');
    A.eq(r.ctx.input.value, 'draft', 'with nothing queued the composer is left alone');
    A.ok(!r.lines.some(l => /queued/i.test(l)), 'and no queue line is printed');
  }

  // ── 1b. SEND NOW and STOP (0.13.5 merge): a line handed to the run that the run never read comes back on a CONFIRMED stop,
  //        and an answer arriving after that changes nothing — never a re-queue that would auto-send it behind the stop ──
  const tick = () => new Promise(res => setTimeout(res, 0));
  {
    const r = stopRig({ typed: 'draft' });
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    let answer = null; const flushed = [];
    r.ctx.fetch = () => new Promise(res => { answer = res; });
    r.ctx.flushQueued = id => flushed.push(id);
    r.ctx.queued.set('ws1', ['use the blue folder', 'and skip the tests']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');   // the POST is still in flight
    A.eq(r.ctx.queued.get('ws1'), ['and skip the tests'], 'SEND NOW takes the line off the queue while it flies');
    r.ctx.__stop('click');
    A.eq(r.ctx.input.value, 'and skip the tests\ndraft', 'STOP gives the still-queued line back at once');
    r.confirm({ ok: true });
    await tick();
    A.eq(r.ctx.input.value, 'use the blue folder\nand skip the tests\ndraft', 'once the stop is confirmed the unread send-now line is back too, ahead of the rest');
    A.ok(r.lines.some(l => /stopped before the agent read your send-now message/i.test(l) && /message box/i.test(l)), 'one honest line says the agent never read it: ' + JSON.stringify(r.lines));
    answer({ status: 409, json: () => Promise.resolve({ ok: false }) });
    await tick(); await tick();
    A.eq(r.ctx.queued.has('ws1'), false, 'the late refusal never re-queues it behind the stop');
    A.eq(flushed, [], 'and never auto-sends it as a new turn');
    A.ok(!r.lines.some(l => /stays queued|Sent into the live run/i.test(l)), 'and prints no second claim about it');
  }
  {
    // lines the run DID read stay read: by the [steering] echo seen on the run's tokens, or found in the run's text
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.fetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    r.ctx.queued.set('ws1', ['use the blue folder', 'say hi in French', 'make it short']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder'); r.ctx.__sendNow('ws1', 0, 'say hi in French'); r.ctx.__sendNow('ws1', 0, 'make it short');
    await tick(); await tick();
    A.eq(r.ctx.sentNow.get('ws1').filter(n => n.accepted).length, 3, 'each accepted line is held as SENT (the strip shows it; Andrew 10-26: no SYSTEM line)');
    A.ok(!r.lines.some(l => /Sent into the live run/.test(l)), 'and no line announces it in the transcript');
    r.ctx.__landed('ws1', 'run-1', 'Working.\n[steering] use the blue folder\n');
    Channels.appendToken('ws1', 'Working.\n[steering] say hi in French\n');
    r.ctx.__stop('click');
    A.eq(r.ctx.input.value, '', 'nothing comes back before the stop is confirmed');
    r.confirm({ ok: true });
    await tick();
    A.eq(r.ctx.input.value, 'make it short', 'only the line the run never read comes back');
    A.eq(r.ctx.sentNow.has('ws1'), false, 'and the stopped run keeps no send-now lines');
  }
  {
    // a refused stop gives nothing back: the run may still read it
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.fetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    await tick(); await tick();
    r.ctx.__stop('click');
    r.confirm({ ok: false, error: 'refused' });
    await tick();
    A.eq(r.ctx.input.value, '', 'an unconfirmed stop takes back nothing the run holds');
    A.eq((r.ctx.sentNow.get('ws1') || []).length, 1, 'the line is still the run\'s');
    // the run then ends on its own: what it took is settled with it, one still in flight waits for its answer
    r.ctx.sentNow.get('ws1').push({ text: 'in flight', runId: 'run-1', accepted: false, landed: false });
    r.ctx.__settleSentNow('ws1', 'run-1');
    A.eq(r.ctx.sentNow.get('ws1').map(n => n.text), ['in flight'], 'a normal end settles the accepted line and keeps the one still in flight for its refusal path');
  }
  {
    // the wiring the sandbox injects: the live run's tokens mark echoes, and every teardown settles the run's lines
    // (it also collects every note the run streams, with when it arrived, so the run's end can file it: comms-flow 10-26)
    A.ok(/onToken: d => \{ acc \+= d; Channels\.appendToken\(ws\.id, d\); if \(d && d\.indexOf\('\[steering\] '\) >= 0\) \{ for \(const t of steerEchoesOf\(d\)\) runSteers\.push\(\{ text: t, ts: Date\.now\(\) \}\); if \(thisRunId\) markSentNowLanded\(ws\.id, thisRunId, d\); \}/.test(src),
      'the run\'s own token stream marks a sent-now line read when its [steering] echo arrives');
    A.ok(/\} finally \{[\s\S]{0,600}Channels\.end\(ws\.id\);\s*if \(thisRunId\) \{ if \(streamLost \|\| interruptedStreams\.has\(ws\.id\)\) releaseSentNow\(ws\.id, thisRunId, acc\); else settleSentNow\(ws\.id, thisRunId, acc\); \}/.test(src), 'send()\'s teardown settles the run\'s sent-now lines on every end, against the run\'s own text — unless its stream died (the station decides those)');
    // LIVE (this lane): the station was killed mid-run with a send-now line pending; the page's thrown teardown is not always
    // classified 'network', so the line was re-queued and auto-sent into the dead station. A throw that is not a deliberate
    // STOP never saw its run end: it marks the stream lost, whatever the error's wording.
    const thrown = src.slice(src.indexOf('      const stopped = interrupted.has(ws.id);   // the Commander pressed Stop'), src.indexOf('let engineAlive = null;', src.indexOf('      const stopped = interrupted.has(ws.id);   // the Commander pressed Stop')));
    A.ok(thrown.length > 200 && thrown.length < 4000 && /\} else \{[\s\S]*persistPartial\(ws, acc\);\s*streamLost = true;/.test(thrown), 'a non-STOP throw marks the stream lost (right after it saves what streamed)');
    A.ok(/let runToolsOk = 0, runDeliv = 0, thisRunId = null, streamLost = false;/.test(src), 'each send starts with its stream not lost');
    A.ok(/if \(activeWs\) \{ returnHeld\(activeWs\.id\); flushQueued\(activeWs\.id\); \}/.test(src), 'returning to a session gives back what its confirmed STOP held, before its queue drains');
    A.ok(/queued\.clear\(\); sentNow\.clear\(\);/.test(src), 'a session switch starts with no sent-now lines, like the queue');
  }

  {
    // the run ends some OTHER way (an error, a budget or loop-guard stop, a phone STOP, the window after the loop's last drain):
    // a line the station took that the run never read goes back to the FRONT of the queue as the next message — the
    // teardown's deferred flush sends it, as a refusal would — never dropped while the loop's own line says "send it as a new message"
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.fetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    r.ctx.queued.set('ws1', ['use the blue folder', 'say hi in French', 'make it short', 'later']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder'); r.ctx.__sendNow('ws1', 0, 'say hi in French'); r.ctx.__sendNow('ws1', 0, 'make it short');
    await tick(); await tick();
    r.ctx.__landed('ws1', 'run-1', '\n[steering] use the blue folder\n');
    Channels.end('ws1');
    r.ctx.__settleSentNow('ws1', 'run-1', 'Working.\n[steering] use the blue folder\nHola.\n[steering] say hi in French\n\n[steering] 1 steering note arrived as this run was ending and was NOT applied — send it as a new message.\n');
    A.eq(r.ctx.queued.get('ws1'), ['make it short', 'later'], 'only the line the run never read goes back, ahead of the queue');
    A.ok(r.lines.some(l => /ended before the agent read your send-now message/.test(l) && /next message/.test(l)), 'one line says it goes next: ' + JSON.stringify(r.lines));
    A.eq(r.ctx.sentNow.has('ws1'), false, 'the ended run keeps no send-now lines');
  }
  {
    // the STOP is confirmed while ANOTHER session is on screen: its message box is not the stopped one's
    const r = stopRig({ typed: 'for the other agent' });
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.fetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    await tick(); await tick();
    r.ctx.__stop('click');
    r.ctx.activeWs = { id: 'ws2', agentId: 'mira', conversationMode: 'chat' };
    const before = r.lines.length;
    r.confirm({ ok: true });
    await tick();
    A.eq(r.ctx.input.value, 'for the other agent', 'the other session\'s message box is left alone');
    A.eq(r.lines.length, before, 'and its log gets no line about another session\'s stop');
    A.eq(r.ctx.queued.has('ws1'), false, 'it is never queued either (a return would auto-send it behind the stop)');
    r.ctx.input.value = '';
    r.ctx.activeWs = { id: 'ws1', agentId: 'agent', conversationMode: 'chat' };
    r.ctx.__returnHeld('ws1');
    A.eq(r.ctx.input.value, 'use the blue folder', 'back on the stopped session, the unread line is in its message box, unsent');
    A.ok(r.lines.slice(before).some(l => /stopped before the agent read your send-now message/.test(l)), 'with its line, in its own log');
    r.ctx.__returnHeld('ws1');
    A.eq(r.ctx.input.value, 'use the blue folder', 'given back once');
  }

  // ── 1d. RELOAD / CLOSE / CRASH / RECONNECT (live walk 2026-10-14): the page's memory is gone, the line is not. Every line handed
  //        to a run is on disk (this browser) until the page settles it; whatever is left is decided by the STATION on the
  //        conversation's next load (GET /api/run/steer): read → a steer-echo row; never read → back in the box with one line;
  //        no record → read only if the saved history shows its echo, else back with a line that says the station can't tell;
  //        still running / no answer → asked again later. Never auto-sent, never twice, never a line the agent read. ──
  {
    const say = (storage, notes, extra) => (url, o) => {
      if (/^\/api\/run\/steer\?runId=/.test(url)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Object.assign({ runId: 'run-1', live: false, ended: true, source: 'memory', notes: notes() }, extra && extra())) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, pending: 1 }) });
    };
    // page 1: the line is handed to the run (accepted) — then the page reloads mid hand-off
    const pageOne = (storage, typed) => {
      const r = stopRig({ storage });
      Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
      const posts = [];
      r.ctx.fetch = (url, o) => { posts.push(JSON.parse(o.body)); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, pending: 1, noteId: JSON.parse(o.body).noteId }) }); };
      r.ctx.queued.set('ws1', [typed]);
      r.ctx.__sendNow('ws1', 0, typed);
      return { r, posts };
    };
    // page 2: a fresh page (new memory) on the same browser storage, showing ws1
    const pageTwo = (storage, fetch, history, o) => {
      const r = stopRig({ storage, setTimeout: o && o.setTimeout });
      r.ctx.activeWs = { id: 'ws1', agentId: 'agent', conversationMode: 'chat', history: history || [{ role: 'user', content: 'run the slow job', sourceRunId: 'run-1' }] };
      const asked = [];
      r.ctx.fetch = (url, opt) => { asked.push(url); return fetch(url, opt); };
      return { r, asked, ws: r.ctx.activeWs };
    };
    {
      // (a) the run never read it: back in THIS conversation's message box, unsent, with one honest line — once
      const storage = memStorage();
      const one = pageOne(storage, 'use the blue folder\nand skip the tests');
      await tick(); await tick();
      A.ok(/^sn[a-z0-9]+$/.test(one.posts[0].noteId || ''), 'the steer POST names the line with the page\'s own noteId: ' + JSON.stringify(one.posts[0]));
      const kept = onDisk(storage, 'ws1');
      A.eq(kept.map(e => [e.runId, e.text, e.wire]), [['run-1', 'use the blue folder\nand skip the tests', 'use the blue folder and skip the tests']], 'the accepted line is on disk while its run holds it');
      const id = kept[0].id;
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'unapplied' })));
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.asked, ['/api/run/steer?runId=run-1'], 'the reloaded page asks the station about that run');
      A.eq(two.r.ctx.input.value, 'use the blue folder\nand skip the tests', 'the unread line is back in the message box as typed');
      A.ok(two.r.lines.some(l => /run ended before the agent read your send-now message/.test(l) && /back in the message box/.test(l)), 'one honest line: ' + JSON.stringify(two.r.lines));
      A.eq(two.r.ctx.queued.has('ws1'), false, 'never queued (a queue would auto-send it)');
      A.eq(onDisk(storage, 'ws1'), [], 'and it leaves the disk');
      await two.r.ctx.__reconcile(two.ws);
      A.eq([two.asked.length, two.r.ctx.input.value, two.r.lines.length], [1, 'use the blue folder\nand skip the tests', 1], 'a second load gives nothing back twice');
      const three = pageTwo(storage, say(storage, () => ({ [id]: 'unapplied' })));
      await three.r.ctx.__reconcile(three.ws);
      A.eq([three.asked.length, three.r.ctx.input.value], [0, ''], 'nor does the next reload');
    }
    {
      // (b) the run DID read it (its echo never reached the page before the reload): shown as read, never back in the box
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const id = onDisk(storage, 'ws1')[0].id;
      const hist = [{ role: 'user', content: 'run the slow job', sourceRunId: 'run-1' }, { role: 'assistant', sys: true, error: true, transcriptPending: true, sourceRunId: 'run-1', content: '■ the run ended when this page closed' }];
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'applied' })), hist);
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.r.ctx.input.value, '', 'a line the agent read never comes back');
      const echo = two.ws.history.filter(m => m && m.steerEcho);
      A.eq(echo.map(m => [m.content, m.sourceRunId, m.sys]), [['[steering] use the blue folder', 'run-1', true]], 'it is shown as read: one steer-echo row, a station row (never model context)');
      A.eq(two.ws.history.indexOf(echo[0]), 1, 'placed after that run\'s own dialogue, before the station\'s lines about it');
      A.eq(onDisk(storage, 'ws1'), [], 'and it leaves the disk');
      A.eq(two.r.lines, [], 'no extra line: the echo row is the proof');
      // a saved reply that already shows the echo is never doubled
      const storage2 = memStorage();
      pageOne(storage2, 'use the blue folder');
      await tick(); await tick();
      const id2 = onDisk(storage2, 'ws1')[0].id;
      const saved = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'Looking.\n[steering] use the blue folder\nDone.', sourceRunId: 'run-1' }];
      const four = pageTwo(storage2, say(storage2, () => ({ [id2]: 'applied' })), saved);
      await four.r.ctx.__reconcile(four.ws);
      A.eq(four.ws.history.filter(m => m && m.steerEcho).length, 0, 'a reply already showing the echo gets no second row');
    }
    {
      // (c) the run is still unwinding (the reload's cancel has not reached its loop yet): nothing yet, asked again later
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const id = onDisk(storage, 'ws1')[0].id;
      let state = 'pending', live = true;
      const timers = [];
      const two = pageTwo(storage, say(storage, () => ({ [id]: state }), () => ({ live, ended: false })), null, { setTimeout: (fn, ms) => { timers.push(ms); } });
      await two.r.ctx.__reconcile(two.ws);
      A.eq([two.r.ctx.input.value, onDisk(storage, 'ws1').length, timers.length], ['', 1, 1], 'a run still holding it: nothing yet, it stays on disk, one retry is armed');
      state = 'unapplied'; live = false;
      await two.r.ctx.__reconcile(two.ws, 1);
      A.eq(two.r.ctx.input.value, 'use the blue folder', 'once the run ended without reading it, it is back');
    }
    {
      // (d) the station does not answer: nothing is decided, nothing is lost
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const two = pageTwo(storage, () => Promise.reject(new Error('offline')), null, { setTimeout: () => {} });
      await two.r.ctx.__reconcile(two.ws);
      A.eq([two.r.ctx.input.value, onDisk(storage, 'ws1').length], ['', 1], 'an unreachable station decides nothing (the line stays on disk)');
      const bad = pageTwo(storage, () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'x' }) }), null, { setTimeout: () => {} });
      await bad.r.ctx.__reconcile(bad.ws);
      A.eq([bad.r.ctx.input.value, onDisk(storage, 'ws1').length], ['', 1], 'nor does a 500');
    }
    {
      // (e) a restart lost the run (no ledger, no record): read only if the saved history shows its echo; else back, saying so
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const none = () => ({ source: 'none', ended: false });
      const two = pageTwo(storage, say(storage, () => ({}), none), [{ role: 'user', content: 'go' }, { role: 'assistant', content: '\n[steering] use the blue folder\nOk.', sourceRunId: 'run-1' }]);
      await two.r.ctx.__reconcile(two.ws);
      A.eq([two.r.ctx.input.value, onDisk(storage, 'ws1').length], ['', 0], 'no record, but this run\'s saved reply shows it: read');
      const storage2 = memStorage();
      pageOne(storage2, 'use the blue folder');
      await tick(); await tick();
      const three = pageTwo(storage2, say(storage2, () => ({}), none), [{ role: 'user', content: 'go' }, { role: 'assistant', content: '\n[steering] use the blue folder\nOk.', sourceRunId: 'run-0' }]);
      await three.r.ctx.__reconcile(three.ws);
      A.eq(three.r.ctx.input.value, 'use the blue folder', 'an echo from ANOTHER run proves nothing: it comes back');
      A.ok(three.r.lines.some(l => /station has no record that the agent read your send-now message/.test(l) && /back in the message box/.test(l)), 'with a line that says the station cannot tell: ' + JSON.stringify(three.r.lines));
    }
    {
      // (f) the station never took it (its POST was refused or never arrived; the recorded run has no such note): back
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const two = pageTwo(storage, say(storage, () => ({}), () => ({ source: 'record' })));
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.r.ctx.input.value, 'use the blue folder', 'a line the station never took is back in the box');
    }
    {
      // (g) a line STOP already gave back is never given back again after a reload; one held for another session is, once
      const storage = memStorage();
      const one = pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      one.r.ctx.__stop('click'); one.r.confirm({ ok: true }); await tick();
      A.eq(one.r.ctx.input.value, 'use the blue folder', 'fixture: STOP gave it back');
      A.eq(onDisk(storage, 'ws1'), [], 'the line in the message box is off the disk (an unsent draft from here on)');
      const storage2 = memStorage();
      const held = pageOne(storage2, 'use the blue folder');
      await tick(); await tick();
      held.r.ctx.__stop('click');
      held.r.ctx.activeWs = { id: 'ws2', agentId: 'mira', conversationMode: 'chat' };
      held.r.confirm({ ok: true }); await tick();
      A.eq(onDisk(storage2, 'ws1').length, 1, 'held for its session (another one on screen): still on disk until it lands');
      const id = onDisk(storage2, 'ws1')[0].id;
      const before = held.r.lines.length;
      held.r.ctx.activeWs = { id: 'ws1', agentId: 'agent', conversationMode: 'chat', history: [] };
      held.r.ctx.fetch = say(storage2, () => ({ [id]: 'unapplied' }));
      await held.r.ctx.__reconcile(held.r.ctx.activeWs);
      A.eq([held.r.ctx.input.value, held.r.lines.length], ['', before], 'the load never decides a line this page still holds');
      held.r.ctx.__returnHeld('ws1');
      A.eq([held.r.ctx.input.value, onDisk(storage2, 'ws1').length], ['use the blue folder', 0], 'returning gives it back once and it leaves the disk');
      const two = pageTwo(storage2, say(storage2, () => ({ [id]: 'unapplied' })));
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.r.ctx.input.value, '', 'and a reload after that gives nothing back twice');
    }
    {
      // (h) RECONNECT (DISCONNECT → re-entry) and a dropped stream: the page lets go of the line instead of settling it, so it is
      //     never re-queued into a queue the re-entry wipes (or auto-sent behind the reconnect); the station decides on the next load
      const storage = memStorage();
      const one = pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      one.r.ctx.__release('ws1');                    // Chat.abort(): the teardown lets go of every line it holds
      Channels.end('ws1'); one.r.ctx.__settleSentNow('ws1', 'run-1', 'Working.');   // the aborted run's finally runs after that
      A.eq([one.r.ctx.queued.has('ws1'), one.r.ctx.sentNow.has('ws1'), onDisk(storage, 'ws1').length], [false, false, 1], 'not re-queued, not held: it waits on disk for the station');
      const id = onDisk(storage, 'ws1')[0].id;
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'unapplied' })));
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.r.ctx.input.value, 'use the blue folder', 'after re-entry it is back in the message box');
      // a line whose echo the page DID see before its stream died is read: off the disk at once
      const storage2 = memStorage();
      const seen = pageOne(storage2, 'use the blue folder');
      await tick(); await tick();
      seen.r.ctx.__landed('ws1', 'run-1', '\n[steering] use the blue folder\n');
      seen.r.ctx.__release('ws1', 'run-1', '');
      A.eq(onDisk(storage2, 'ws1'), [], 'a line the page saw land is never asked about (or given back) later');
    }
    {
      // (i) the load never asks about a line its own page still holds for a live run
      const storage = memStorage();
      const one = pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const asked = [];
      one.r.ctx.activeWs = { id: 'ws1', agentId: 'agent', conversationMode: 'chat', history: [] };
      one.r.ctx.fetch = url => { asked.push(url); return Promise.reject(new Error('no')); };
      await one.r.ctx.__reconcile(one.r.ctx.activeWs);
      A.eq([asked, one.r.ctx.input.value], [[], ''], 'a line in this page\'s own hands is not the station\'s to decide');
    }
    // ── 1d POLISH (SEND NOW review, 2026-10-15) ──
    const sendSeveral = async (storage, typed) => {
      const r = stopRig({ storage });
      Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
      r.ctx.fetch = (url, o) => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, pending: 1, noteId: JSON.parse(o.body).noteId }) });
      for (const t of typed) { r.ctx.queued.set('ws1', [t]); r.ctx.__sendNow('ws1', 0, t); }
      await tick(); await tick();
      return onDisk(storage, 'ws1').map(e => e.id);
    };
    {
      // (j) several lines the same run read are filed in the order they were sent — never reversed — as station rows
      const storage = memStorage();
      const ids = await sendSeveral(storage, ['first note', 'second note', 'third note']);
      A.eq(ids.length, 3, 'fixture: three lines on disk');
      const allRead = () => Object.fromEntries(ids.map(k => [k, 'applied']));
      const two = pageTwo(storage, say(storage, allRead), [
        { role: 'user', content: 'go', sourceRunId: 'run-1' }, { role: 'assistant', content: 'Halfway.', sourceRunId: 'run-1' },
        { role: 'user', content: 'next', sourceRunId: 'run-2' }]);
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.ws.history.map(m => m.content), ['go', 'Halfway.', '[steering] first note', '[steering] second note', '[steering] third note', 'next'],
        'three read lines of one run follow its dialogue in the order they were sent');
      const echoes = two.ws.history.filter(m => m && m.steerEcho);
      A.eq(echoes.map(m => [m.role, m.sys]), [['system', true], ['system', true], ['system', true]], 'each is the station-row shape every other station row uses (role system + sys), never an agent turn');
      // a run with no dialogue row of its own: ahead of the station's own line about it, still in send order
      const storage2 = memStorage();
      const ids2 = await sendSeveral(storage2, ['first note', 'second note', 'third note']);
      const three = pageTwo(storage2, say(storage2, () => Object.fromEntries(ids2.map(k => [k, 'applied']))), [
        { role: 'user', content: 'go' },
        { role: 'assistant', sys: true, error: true, transcriptPending: true, sourceRunId: 'run-1', content: '■ the run ended when this page closed' }]);
      await three.r.ctx.__reconcile(three.ws);
      A.eq(three.ws.history.map(m => m.content), ['go', '[steering] first note', '[steering] second note', '[steering] third note', '■ the run ended when this page closed'],
        'with no dialogue row of the run, they go ahead of its station line, in send order');
    }
    {
      // (k) ONE retry chain per line: another load or a run's end while a retry is armed never arms a second one
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const id = onDisk(storage, 'ws1')[0].id;
      const timers = [];
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'pending' }), () => ({ live: true, ended: false })), null, { setTimeout: (fn, ms) => { timers.push(fn); return timers.length; } });
      await two.r.ctx.__reconcile(two.ws);
      await two.r.ctx.__reconcile(two.ws);
      await two.r.ctx.__reconcile(two.ws);
      A.eq(timers.length, 1, 'three asks that find the same line still waiting arm ONE retry, not three chains');
      await timers[0]();
      A.eq(timers.length, 2, 'the retry, when it fires, asks again and arms the next one (still one chain)');
      await two.r.ctx.__reconcile(two.ws);
      A.eq(timers.length, 2, 'and a load meanwhile adds none');
      A.eq([two.r.ctx.input.value, onDisk(storage, 'ws1').length], ['', 1], 'while it waits nothing is decided or lost');
    }
    {
      // (l) 'pending' on a run that is no longer in flight (its loop is gone without draining the line): back in the box
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const id = onDisk(storage, 'ws1')[0].id;
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'pending' }), () => ({ live: false, ended: false, source: 'memory' })), null, { setTimeout: () => { throw new Error('no retry for a decided line'); } });
      await two.r.ctx.__reconcile(two.ws);
      A.eq([two.r.ctx.input.value, onDisk(storage, 'ws1').length], ['use the blue folder', 0], 'a pending line on a run no longer in flight is given back (an aborted loop never drains again)');
      const v = st => two.r.ctx.__verdict({ id: 'snX', runId: 'run-1', wire: 'w' }, st, []);
      A.eq([v({ live: false, ended: false, source: 'memory', notes: { snX: 'pending' } }), v({ live: false, ended: true, source: 'memory', notes: { snX: 'pending' } }),
        v({ live: true, ended: false, source: 'memory', notes: { snX: 'pending' } }), v({ live: true, ended: false, source: 'memory', notes: {} })], ['back', 'back', 'wait', 'wait'],
        'pending: back once the run is not in flight or ended; a live run still holding it (or not yet having it) waits');
    }
    {
      // (m) the per-conversation disk list is BOUNDED — but a line is never dropped unseen: past the cap, the oldest line this
      //     page is not holding goes back in the message box with an honest line
      const storage = memStorage();
      const old = [];
      for (let i = 0; i < 16; i++) old.push({ id: 'snold' + i, runId: 'run-0', text: 'old note ' + i, wire: 'old note ' + i, at: Date.now() - 60000 + i });
      storage.setItem('starnet.sentNow.v1', JSON.stringify({ ws1: old }));
      const one = pageOne(storage, 'use the blue folder');
      const disk = onDisk(storage, 'ws1');
      A.eq(disk.length, 16, 'the list stays at its cap');
      A.ok(disk.some(e => e.id === one.posts[0].noteId) && !disk.some(e => e.id === 'snold0'), 'the new line is kept; the oldest unsettled one left the disk…');
      A.eq(one.r.ctx.input.value, 'old note 0', '…into the message box, never deleted unseen');
      A.ok(one.r.lines.some(l => /never said whether the agent read your send-now message/.test(l) && /back in the message box/.test(l)), 'with an honest line: ' + JSON.stringify(one.r.lines));
      // lines this page still holds for its live run are never pushed out by the cap
      const storage2 = memStorage();
      const many = [];
      for (let i = 0; i < 18; i++) many.push('note ' + i);
      const ids = await sendSeveral(storage2, many);
      A.eq(ids.length, 18, 'every line the page holds for its live run stays on disk, past the cap');
    }
    {
      // (n) a VERY OLD line the station still cannot decide is given back with the honest line, never kept waiting forever
      const storage = memStorage();
      const dayAgo = Date.now() - 25 * 3600 * 1000;
      storage.setItem('starnet.sentNow.v1', JSON.stringify({ ws1: [{ id: 'snstale', runId: 'run-0', text: 'an old note', wire: 'an old note', at: dayAgo }, { id: 'snfresh', runId: 'run-0', text: 'a new note', wire: 'a new note', at: Date.now() }] }));
      const timers = [];
      const two = pageTwo(storage, () => Promise.reject(new Error('offline')), null, { setTimeout: fn => { timers.push(fn); } });
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.r.ctx.input.value, 'an old note', 'the day-old undecided line is back in the message box');
      A.ok(two.r.lines.some(l => /never said whether the agent read your send-now message/.test(l)), 'with the honest line: ' + JSON.stringify(two.r.lines));
      A.eq([onDisk(storage, 'ws1').map(e => e.id), timers.length], [['snfresh'], 1], 'the fresh one keeps waiting (asked again later)');
      // an old line the station CAN decide is decided by the station
      const storage2 = memStorage();
      storage2.setItem('starnet.sentNow.v1', JSON.stringify({ ws1: [{ id: 'snstale', runId: 'run-1', text: 'an old note', wire: 'an old note', at: dayAgo }] }));
      const three = pageTwo(storage2, say(storage2, () => ({ snstale: 'applied' })));
      await three.r.ctx.__reconcile(three.ws);
      A.eq([three.r.ctx.input.value, three.ws.history.filter(m => m && m.steerEcho).length], ['', 1], 'a day-old line the station says was read is shown as read');
    }
    {
      // (o) an echo of the SAME words from a DIFFERENT run never stands in for this line's proof
      const storage = memStorage();
      pageOne(storage, 'use the blue folder');
      await tick(); await tick();
      const id = onDisk(storage, 'ws1')[0].id;
      const hist = [
        { role: 'user', content: 'go', sourceRunId: 'run-0' }, { role: 'assistant', content: 'Done.', sourceRunId: 'run-0' },
        { role: 'system', sys: true, steerEcho: true, content: '[steering] use the blue folder', sourceRunId: 'run-0', ts: 1 },
        { role: 'user', content: 'again', sourceRunId: 'run-1' }];
      const two = pageTwo(storage, say(storage, () => ({ [id]: 'applied' })), hist);
      await two.r.ctx.__reconcile(two.ws);
      A.eq(two.ws.history.filter(m => m && m.steerEcho).map(m => m.sourceRunId), ['run-0', 'run-1'], 'this run gets its own row: run-0\'s echo of the same words is not this line\'s');
      // an assistant reply of another run that shows the same words proves nothing for this line either
      const storage2 = memStorage();
      pageOne(storage2, 'use the blue folder');
      await tick(); await tick();
      const id2 = onDisk(storage2, 'ws1')[0].id;
      const three = pageTwo(storage2, say(storage2, () => ({ [id2]: 'applied' })), [
        { role: 'user', content: 'go', sourceRunId: 'run-0' }, { role: 'assistant', content: 'Ok.\n[steering] use the blue folder\nDone.', sourceRunId: 'run-0' },
        { role: 'user', content: 'again', sourceRunId: 'run-1' }]);
      await three.r.ctx.__reconcile(three.ws);
      A.eq(three.ws.history.filter(m => m && m.steerEcho).map(m => m.sourceRunId), ['run-1'], 'another run\'s saved reply with those words is not this line\'s echo');
    }
    {
      // the wiring: the teardown lets go, a load asks once its history settled, and the run's end asks about what it let go
      const abortFn = A.fnBody(src, '  function abort() {');
      A.ok(abortFn.length > 100 && abortFn.length < 4000 && /for \(const id of Array\.from\(sentNow\.keys\(\)\)\) releaseSentNow\(id\);/.test(abortFn), 'DISCONNECT lets go of every sent-now line before it aborts (no re-queue into the wiped queue)');
      const load = A.fnBody(src, '  function load(ws) {');
      A.ok(/Promise\.resolve\(loadServerHistory\(activeWs, historyPin\)\)[^\n]*reconcileSentNow\(/.test(load), 'a conversation\'s load asks the station about its leftover lines once its history is merged');
      A.ok(/releaseSentNow\(ws\.id, thisRunId, acc\); else settleSentNow\(ws\.id, thisRunId, acc\); \}(?:[ \t]*\/\/[^\n]*)?\s*reconcileSentNow\(ws\);/.test(src), 'a run\'s end asks right away about any line it let go');
    }
  }

  // ── 1c. STOP on a send still waiting for its turn ("connecting": no run id yet) also stops the overseer's automatic
  //        report that holds this conversation (stall report 2026-10-13): the page never started that report, so its STOP
  //        never reached it, and every new message sat on "connecting" until the report finished. ──
  {
    const cancels = [], gets = [];
    const reviews = [
      { id: 'g1:report:1', status: 'reviewing', parentStreamId: 'ws1', reviewRunId: 'review-run-1' },
      { id: 'g2:report:1', status: 'reviewing', parentStreamId: 'ws-other', reviewRunId: 'review-run-2' },   // another conversation's
      { id: 'g3:report:1', status: 'done', parentStreamId: 'ws1', reviewRunId: 'review-run-0' }              // a finished one
    ];
    const r = stopRig({ Harness: { cancel: rid => { cancels.push(rid); return Promise.resolve({ ok: true, stopped: true }); }, api: { get: async p => { gets.push(p); return { reviews }; } } } });
    Channels.begin('ws1', Date.now());   // the send is out, the station has not started it: "connecting"
    A.eq(Channels.runIdOf('ws1'), null, 'fixture: the waiting send has no run id yet');
    r.ctx.__stop('click');
    A.eq(r.aborted, ['ws1'], 'the waiting send itself is let go at once (nothing to kill by id)');
    for (let i = 0; i < 5; i++) await new Promise(res => setTimeout(res, 0));
    A.eq(gets, ['/api/overseer'], 'the station\'s own list of reports is read fresh at STOP time');
    A.eq(cancels, ['review-run-1'], 'STOP reaches exactly the report holding THIS conversation — never another conversation\'s, never a finished one');
    A.eq(r.lines.filter(l => /also ended the report on your delegated work/i.test(l)).length, 1, 'one line says the report was stopped too: ' + JSON.stringify(r.lines));
  }
  {
    // a send that has its run id is stopped by that id alone: no report lookup, no extra stop
    const gets = [], cancels = [];
    const r = stopRig({ Harness: { cancel: rid => { cancels.push(rid); return Promise.resolve({ ok: true }); }, api: { get: async p => { gets.push(p); return { reviews: [{ status: 'reviewing', parentStreamId: 'ws1', reviewRunId: 'review-run-1' }] }; } } } });
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.__stop('click');
    for (let i = 0; i < 5; i++) await new Promise(res => setTimeout(res, 0));
    A.eq([gets.length, cancels], [0, ['run-1']], 'a started run is stopped by its own id only');
  }
  {
    // nothing holds the conversation (or the station refused): no claim that a report was stopped
    const r = stopRig({ Harness: { cancel: () => Promise.resolve({ ok: false, error: 'refused' }), api: { get: async () => ({ reviews: [{ status: 'reviewing', parentStreamId: 'ws1', reviewRunId: 'review-run-1' }] }) } } });
    Channels.begin('ws1', Date.now());
    r.ctx.__stop('click');
    for (let i = 0; i < 5; i++) await new Promise(res => setTimeout(res, 0));
    A.ok(!r.lines.some(l => /report/i.test(l)), 'a refused report stop claims nothing: ' + JSON.stringify(r.lines));
  }
  {
    // the line is said only for a stop the STATION proves (review 2026-10-14): /api/cancel answers 200 for an id it no longer
    // holds, so a report that finished between the read and the stop, or a 'reviewing' row left over from a restart, used to
    // print "STOP also ended the report…" over nothing. { stopped:false }, or an answer that does not say, claims nothing.
    for (const answer of [{ ok: true, stopped: false }, { ok: true }]) {
      const cancels = [];
      const r = stopRig({ Harness: { cancel: rid => { cancels.push(rid); return Promise.resolve(answer); }, api: { get: async () => ({ reviews: [{ status: 'reviewing', parentStreamId: 'ws1', reviewRunId: 'review-run-1' }] }) } } });
      Channels.begin('ws1', Date.now());
      r.ctx.__stop('click');
      for (let i = 0; i < 5; i++) await new Promise(res => setTimeout(res, 0));
      A.eq(cancels, ['review-run-1'], 'the stop is still asked for (' + JSON.stringify(answer) + ')');
      A.ok(!r.lines.some(l => /report/i.test(l)), 'a stop the station did not prove claims nothing (' + JSON.stringify(answer) + '): ' + JSON.stringify(r.lines));
    }
  }
  {
    // THE STATION HALF OF THE CONTRACT (review 2026-10-14). The page finds the report by reading GET /api/overseer for a row
    // { status:'reviewing', parentStreamId:<this conversation>, reviewRunId } and stops it by that id through /api/cancel.
    // Nothing above can see the station, so these pins break the moment either side stops matching.
    const idx = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
    const ovs = fs.readFileSync(path.join(__dirname, '../sidecar/overseer.js'), 'utf8');
    const tick = A.fnBody(idx, 'async function tickOverseer');
    A.ok(tick.length > 1000, 'tickOverseer located');
    const thread = tick.indexOf('await overseer.withThread(parent.id, async () => {');
    const patch = tick.indexOf("overseer.patchReview(review.id, { status: 'reviewing', reviewRunId: runId");
    const reg = tick.indexOf('runs.set(runId, reviewAbort);');
    const run = tick.indexOf('signal: reviewAbort.signal, streamId: parent.id, runId,');
    A.ok(thread > 0 && patch > thread && reg > patch && run > reg, 'inside the conversation\'s turn, the report row reads reviewing + its run id, then that run id is registered in runs (what /api/cancel stops), then the report runs on that signal for that conversation');
    A.ok(!/await/.test(tick.slice(patch, reg)), 'nothing awaits between the row naming the run and the run becoming stoppable');
    A.ok(tick.slice(reg).includes('finally { runs.delete(runId);'), 'and it leaves runs when it ends (a stop after that proves nothing)');
    const routeAt = idx.indexOf("{ m: 'GET', exact: '/api/overseer', h:");
    A.ok(routeAt > 0 && idx.slice(routeAt, routeAt + 300).includes('respondJson(res, 200, { ...overseer.snapshot(),'), 'GET /api/overseer hands the page overseer.snapshot() as is (reviews included)');
    A.ok(A.fnBody(ovs, 'function snapshot').includes('reviews: copy(state.reviews)'), 'the snapshot lists every review row unchanged');
    A.ok(A.fnBody(ovs, 'function freshReviews').includes('parentStreamId: lead.parentStreamId,'), 'a report row carries the conversation it reports into');
    // and /api/cancel says whether it stopped anything: run the REAL handler against the real respond.js helpers
    const respond = require('../sidecar/respond.js');
    const cancelSrc = A.fnBody(idx, 'async function handleCancel');
    A.ok(cancelSrc.length > 100, 'handleCancel located');
    const call = async (body, runs, handles) => {
      const out = { code: 0, headers: null, body: '' };
      const res = { headersSent: false, writeHead(c, h) { out.code = c; out.headers = h || null; this.headersSent = true; }, end(b) { out.body = String(b == null ? '' : b); } };
      const readBody = async () => body;
      const fn = new Function('readJsonBody', 'readBody', 'respondJson', 'runs', 'runStopHandles', cancelSrc + ';return handleCancel;')(respond.readJsonBody, readBody, respond.json, runs, handles);
      await fn({}, res);
      return out;
    };
    const bodyOf = o => { try { return JSON.parse(o.body); } catch (e) { return 'not json: ' + o.body; } };
    const aborted = [];
    const live = new Map([['review-run-1', { abort: () => aborted.push('review-run-1') }]]);
    const hop = new Map([['hop-1', { abort: () => aborted.push('hop-1') }]]);
    let o = await call(JSON.stringify({ runId: 'review-run-1' }), live, new Map());
    A.eq([o.code, bodyOf(o), aborted], [200, { ok: true, stopped: true }, ['review-run-1']], 'a live run is aborted and the answer says it was stopped');
    o = await call(JSON.stringify({ runId: 'hop-1' }), new Map(), hop);
    A.eq([o.code, bodyOf(o)], [200, { ok: true, stopped: true }], 'a routine/line run reached by its stop handle is stopped too');
    o = await call(JSON.stringify({ runId: 'gone' }), live, hop);
    A.eq([o.code, bodyOf(o)], [200, { ok: true, stopped: false }], 'an id the station no longer holds still answers 200 (nothing to stop is not an error) but says nothing was stopped');
    o = await call('{not json', live, hop);
    A.eq(o.code, 400, 'bad json is still a 400');
  }

  // ── 2. the stopped run's open asks settle everywhere once the station CONFIRMS the stop ──
  {
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    Channels.setPending('ws1', { promptId: 'p-lead', tool: 'team.dispatch', runId: 'run-1' }, Date.now());
    Channels.setPending('ws1', { promptId: 'p-bg', tool: 'fs.write', runId: 'run-0', background: true }, Date.now());
    A.eq(r.ctx.__announced('p-lead', { id: 'ws1' }), false, 'fixture: the lead ask was filed under the conversation\'s bell key');
    r.ctx.__stop('click');
    A.eq(r.emitted.length, 0, 'nothing is announced before the station confirms the kill');
    r.confirm({ ok: true });
    await new Promise(res => setTimeout(res, 0));
    A.eq(r.retired.length, 1, 'the run\'s open cards retire on the confirmed stop');
    A.eq(r.aborted, ['ws1'], 'the stream is torn down after the confirm');
    A.eq(r.emitted.map(e => e.payload), [{ promptId: 'p-lead', decision: 'deny', stopped: true }],
      'the run\'s own ask is announced settled as STOPPED (nothing approved) — never the background worker\'s');
    A.eq(r.notified.map(o => o && o.prompt), ['p-bg'], 'the conversation\'s one bell entry moves to the background worker\'s ask still waiting — the stopped one is gone from it');
    A.eq(Channels.pendingAllOf('ws1').map(p => p.promptId), ['p-bg'], 'a background worker\'s ask stays filed — it outlives its lead\'s turn');
  }
  {
    // the walk's case: only the stopped run's own ask waited — the bell settles outright (NEEDS YOU and the bell agree on 0)
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    Channels.setPending('ws1', { promptId: 'p-lead', tool: 'team.dispatch', runId: 'run-1' }, Date.now());
    r.ctx.__announced('p-lead', { id: 'ws1' });
    r.ctx.__stop('click');
    r.confirm({ ok: true });
    await new Promise(res => setTimeout(res, 0));
    A.eq(r.settled, ['needs:ws1'], 'the stopped run\'s bell entry settles: ' + JSON.stringify(r.settled));
    A.eq(Channels.allPending().length, 0, 'and NEEDS YOU (Channels) holds nothing for it either');
  }
  {
    // a refused stop announces nothing: the run may still be waiting on that ask
    const r = stopRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    Channels.setPending('ws1', { promptId: 'p-lead', tool: 'team.dispatch', runId: 'run-1' }, Date.now());
    r.ctx.__stop('click');
    r.confirm({ ok: false, error: 'refused' });
    await new Promise(res => setTimeout(res, 0));
    A.eq(r.emitted.length, 0, 'an unconfirmed stop claims no settlement');
  }

  // ── 3. the thrown-abort teardown (STOP drops the stream) settles the run's own waits like every other end ──
  {
    const catchBody = /\} catch \(e\) \{\s*const aborted = e && \(e\.name === 'AbortError'[\s\S]*?\n    \} finally \{/.exec(src);
    A.ok(catchBody, 'send() has its thrown-teardown catch');
    A.ok(catchBody && /settleRunNeeds\(ws\.id\);/.test(catchBody[0]), 'a thrown teardown (STOP, a dropped stream) settles the run\'s own bell waits — a background worker\'s ask keeps its entry');
  }

  // ── 4. the floor and CREW listen for that same response; the tutorial never reads a stop as the Commander's "no" ──
  {
    const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
    A.ok(/U\.bus\.on\('permission\.response', p => \{\s*if \(p && awaitPrompt && \(!p\.promptId \|\| p\.promptId === awaitPrompt\.promptId\)\) clearAwait\(\);/.test(world), 'the hero\'s AWAITING tag clears on the response');
    const tut = fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8');
    A.ok(/p\.decision === 'deny' && !p\.stopped\) sawDeny = true/.test(tut), 'a stopped ask is not counted as the Commander denying it');
  }

  // ── 5. the queued pill never hides the live line: a strip that grows while the log shows its end keeps that end in view ──
  {
    const rq = A.fnBody(src, 'function renderQueued');
    A.ok(rq.length > 200 && rq.length < 4000, 'renderQueued located');
    const strip = { children: [], innerHTML: '', offsetHeight: 0, appendChild(n) { this.children.push(n); this.offsetHeight = 30; } };
    const log = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400, contains: () => false };
    const doc = { createElement: () => ({ appendChild() {}, setAttribute() {}, set textContent(v) {}, className: '' }), createTextNode: () => ({}) };
    const ctx = vm.createContext({ document: doc, el: id => id === 'chat-queued' ? strip : null, log, heldCard: null, activeWs: { id: 'ws1' },
      queued: new Map([['ws1', ['also make one of them funny']]]),
      nearBottom: () => log.scrollHeight - log.scrollTop - log.clientHeight < 40,
      topInLog: () => 0 });
    vm.runInContext(rq + '\n;renderQueued();', ctx);
    A.eq(log.scrollTop, 630, 'the log follows its end up by the strip\'s height, so the presence line under the card is not cut off');
    log.scrollTop = 100; strip.offsetHeight = 0; strip.children = [];
    vm.runInContext('renderQueued();', ctx);
    A.eq(log.scrollTop, 100, 'a reader scrolled up into history is left where they are');
  }

  A.report('stop-truth.test');
})().catch(e => { console.error(e); process.exit(1); });
