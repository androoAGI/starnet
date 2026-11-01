/* node test/queued-send-now.test.js — source-lock: a queued follow-up's SEND NOW key steers the LIVE run.

   Andrew 2026-10-14: "user sends prompt, user wants to send new messages that steers the last prompt". Enter
   while busy keeps QUEUEING (type-ahead pills); each pill carries a `send now` key that POSTs its text to the
   run's steer buffer (/api/run/steer → loop.js folds it before the next step). The promise that must hold:
     · the pill leaves the queue while the POST flies, so flushQueued can never ALSO send it as a new turn;
     · every refusal (no confirmed runId, 404/409 run ended, 429 full, network) puts it back at the FRONT of the
       queue with a line saying why — a send-now is never silently dropped;
     · success claims only what a 200 proves (the sidecar holds it), never that the agent already acted on it;
     · the line is on DISK (this browser) from the moment it is posted, under the noteId the POST carries, until the page
       settles it — a reload mid hand-off used to lose it (live walk 2026-10-14; the reload side is stop-truth 1d).

   chat.js is browser-flow (DOM + streaming), not node-loadable — locked by reading the source (the
   steer-idle-honesty mold). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');

const render = /function\s+renderQueued\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(render, 'renderQueued exists in chat.js');
const rb = render ? render[1] : '';
A.ok(/className = 'queued-now'/.test(rb), 'every queued pill gets a queued-now key');
A.ok(/sendQueuedNow\(/.test(rb), 'the key calls sendQueuedNow');
{
  // the pill's tip names what it does now that the key exists: it sends after this run, or send now hands it to the run.
  // Run the tip line for real: the clipped pill's whole message reads in the tip, and the hint survives the 400-char cap.
  const line = rb.slice(rb.indexOf('      const QHINT'), rb.indexOf("const label = document.createElement('span')"));
  A.ok(line.length > 40 && !/pill\.title\s*=/.test(rb), 'the pill tip is a station data-tip (no native title)');
  const tipOf = t => { let tip = null; new Function('pill', 't', line)({ setAttribute: (k, v) => { if (k === 'data-tip') tip = v; } }, t); return tip; };
  A.eq(tipOf('use the blue folder'), '“use the blue folder” · sends after this run · send now hands it to the running task', 'the tip names SEND NOW, not a slash command');
  const ht = tipOf('x'.repeat(2000));
  A.ok(ht.length <= 400 && /…” · sends after this run · send now hands it to the running task$/.test(ht), 'a message past the tip cap gives way, never the hint');
}

const fn = /function\s+sendQueuedNow\s*\(id, i, text\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(fn, 'sendQueuedNow exists in chat.js');
const body = fn ? fn[1] : '';

A.ok(/\/api\/run\/steer/.test(body), 'send now POSTs to the live run steer buffer');
A.ok(/Channels\.runIdOf\(id\)/.test(body), 'it addresses the run by its confirmed runId only');
A.ok(/if \(!rid[^\n]*return back\(/.test(body), 'no confirmed runId → back to the queue, never a blind POST');

// the pill leaves the queue BEFORE the POST (so flushQueued can't double-send it)
const spliceAt = body.indexOf('a.splice(at, 1)');
const fetchAt = body.indexOf("fetch('/api/run/steer'");
A.ok(spliceAt > 0 && fetchAt > spliceAt, 'the pill is taken off the queue before the steer POST');

// every refusal path re-queues at the FRONT and flushes (the run may have ended mid-request)
A.ok(/const requeue = [^\n]*\.unshift\(text\)/.test(body) && /const back = [\s\S]*?requeue\(\);[\s\S]*?flushQueued\(id\)/.test(body), 'refusal: unshift back to the front + flushQueued (run for real below)');
A.ok(/status === 409/.test(body) && /status === 429/.test(body), 'refusal lines name 409 (run ended) and 429 (buffer full)');
A.ok(/\.catch\(\(\) => back\(/.test(body), 'a network failure re-queues too');

// success claims only what a 200 proves — the [steering] transcript row is the proof it landed. No SYSTEM line any more
// (Andrew 10-26): the strip shows the line SENT, with no key, until the run reads it (run for real below).
A.ok(/j && j\.ok/.test(body), 'success is read from the sidecar body, not just the HTTP status');
A.ok(/note\.accepted = true;\s*\n\s*if \(Channels\.runIdOf\(id\) === rid\) return renderQueued\(\);/.test(body), 'an accepted line repaints the strip; it prints no line');
A.ok(/className = 'queued-pill sent'/.test(rb) && /before its next step/.test(rb) && /'read at its next step'/.test(rb), 'the SENT row promises only the next step');

// Enter while busy still QUEUES (Andrew's call: send now is opt-in per pill)
const soq = /function\s+sendOrQueue\s*\(text\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(soq && /if \(isBusy\(\)\) \{\s*enqueue\(value\)/.test(soq[1]), 'Enter while busy still queues');

A.ok(/\.queued-now\s*\{[^}]*border: 1px solid var\(--ph-dim\)/.test(css), 'the key is skinned station hardware (no OS paint)');
A.ok(/now\.setAttribute\('data-tip', /.test(rb) && !/now\.title\s*=/.test(rb), 'the key\'s tip is a station data-tip too, like its pill');

/* ── RUN IT (0.13.5 review): the real sendQueuedNow + its helpers in a sandbox ──
   · a multi-line pill reaches the run as ONE line: the loop echoes the note as '\n[steering] <note>\n' and every reader of
     that echo reads one line, so a second line rendered as the AGENT's prose and the reply doubled on its first reload;
   · a pill past the sidecar's 2,000-char note clamp never posts: the buffer cut it and still said ok, and the rest was gone;
   · a click in the gap after the run ended (its deferred flush still waits on crew joining) goes back without a flush,
     and says the run just finished, never "has not started";
   · an answer for a session that is no longer on screen prints nothing in the log that is. */
const vm = require('vm');
const Channels = require('../frontend/app/channels.js');
function memStorage(broken) {
  const m = new Map();
  return { getItem: k => { if (broken) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { if (broken) throw new Error('blocked'); m.set(k, String(v)); } };
}
const onDisk = (storage, ws) => { const raw = storage.getItem('starnet.sentNow.v1'); return raw ? (JSON.parse(raw)[ws] || []) : []; };
function sendRig(opts) {
  Channels.reset();
  const lines = [], flushed = [], posts = [];
  let answer = null;
  const ctx = {
    console, Promise, JSON, setTimeout, Channels, Date, Math,
    localStorage: memStorage(opts && opts.brokenStorage),
    activeWs: { id: 'ws1' }, queued: new Map(), sentNow: new Map(), heldBack: new Map(),
    localLine: t => lines.push(t), renderQueued: () => {}, flushQueued: id => flushed.push(id),
    input: { value: '' }, autoGrowInput: () => {},
    fetch: (url, o) => { posts.push(JSON.parse(o.body)); return new Promise(res => { answer = res; }); }
  };
  vm.createContext(ctx);
  const names = ['function sendQueuedNow', 'function forgetSentNow', 'function steerWire', 'function markSentNowLanded', 'function restoreSentNow',
    'function settleSentNow', 'function giveBack', 'function returnHeld', 'function sentNowDisk', 'function keepSentNow', 'function sentNowOverdue', 'function dropSentNow'];
  const bodies = names.map(h => A.fnBody(src, h));
  A.ok(bodies.every(b => b.length > 20 && b.length < 6000), 'the SEND NOW helpers are present: ' + names.filter((h, i) => !(bodies[i].length > 20 && bodies[i].length < 6000)).join(', '));
  vm.runInContext(bodies.join('\n') + '\n;this.__sendNow = sendQueuedNow; this.__landed = markSentNowLanded; this.__restore = restoreSentNow; this.__settle = settleSentNow; this.__return = returnHeld;', ctx);
  return { ctx, lines, flushed, posts, answer: v => answer(v) };
}
const tick = () => new Promise(res => setTimeout(res, 0));
const ok200 = { status: 200, json: () => Promise.resolve({ ok: true }) };
(async () => {
  {
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    const typed = 'use the blue folder\n  and skip the tests\r\n';
    r.ctx.queued.set('ws1', [typed]);
    r.ctx.__sendNow('ws1', 0, typed);
    A.eq(r.posts.length, 1, 'the multi-line pill is handed to the run');
    A.eq(r.posts[0].text, 'use the blue folder and skip the tests', 'on ONE line: the steer body carries no line break');
    // the loop's echo of that body (foldSteerNotes) is one steering line: renderHistory's split and the merges' steerless read it whole
    const echo = '\n[steering] ' + r.posts[0].text.trim() + '\n' + 'Done.';
    const split = echo.split(/(?:^|\n)\[steering\] ([^\n]*)\n?/);
    A.eq(split, ['', 'use the blue folder and skip the tests', 'Done.'], 'renderHistory\'s split gives the note one row and the agent only its own prose');
    A.eq(echo.replace(/(?:^|\n)\[steering\] [^\n]*\n?/g, ''), 'Done.', 'the merges\' steerless key is the agent\'s own text');
    r.answer(ok200); await tick(); await tick();
    r.ctx.__landed('ws1', 'run-1', echo);
    A.eq(r.ctx.sentNow.get('ws1')[0].landed, true, 'its echo marks it read');
  }
  {
    // a STOP gives back exactly what was typed, line breaks and all
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    const typed = 'use the blue folder\nand skip the tests';
    r.ctx.queued.set('ws1', [typed]);
    r.ctx.__sendNow('ws1', 0, typed);
    r.answer(ok200); await tick(); await tick();
    r.ctx.__restore('ws1', 'run-1');
    A.eq(r.ctx.input.value, typed, 'an unread multi-line send-now comes back as typed');
  }
  {
    // past the steering note's 2,000 characters: never posted, never cut — it stays queued as the next message
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    const log = 'Error: boom\n' + 'at frame\n'.repeat(400);
    r.ctx.queued.set('ws1', [log, 'later']);
    r.ctx.__sendNow('ws1', 0, log);
    A.eq(r.posts.length, 0, 'a pill longer than a steering note is never posted (the buffer would cut it and still say ok)');
    A.eq(r.ctx.queued.get('ws1'), [log, 'later'], 'it stays at the front of the queue, whole');
    A.ok(r.lines.some(l => /2,000 characters/.test(l) && /stays queued as your next message/.test(l)), 'and a line says why: ' + JSON.stringify(r.lines));
  }
  {
    // the run just ended (its teardown's deferred flush is pending, maybe waiting on crew joining): back, no flush here
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now()); Channels.end('ws1');
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    A.eq(r.posts.length, 0, 'nothing to steer: nothing is posted');
    A.eq(r.ctx.queued.get('ws1'), ['use the blue folder'], 'the pill is back at the front');
    A.eq(r.flushed, [], 'and it does not flush ahead of the teardown\'s own (which waits for joining crew)');
    A.ok(r.lines.some(l => /run just finished/i.test(l) && /next message/.test(l)) && !r.lines.some(l => /not started/.test(l)), 'the line says the run just finished: ' + JSON.stringify(r.lines));
  }
  {
    // connecting (busy, no run id yet): the old honest line, and the flush is harmless while busy
    const r = sendRig();
    Channels.begin('ws1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    A.ok(r.lines.some(l => /has not started yet/.test(l)), 'connecting says the run has not started');
    A.eq(r.ctx.queued.get('ws1'), ['use the blue folder'], 'and the pill is back');
  }
  {
    // a refusal (the loop closed its buffer): back at the FRONT, a line says why, and the queue drains
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder', 'later']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    A.eq(r.ctx.queued.get('ws1'), ['later'], 'the pill leaves the queue while the POST flies');
    r.answer({ status: 409, json: () => Promise.resolve({ ok: false }) }); await tick(); await tick();
    A.eq(r.ctx.queued.get('ws1'), ['use the blue folder', 'later'], 'a 409 puts it back at the front');
    A.eq(r.flushed, ['ws1'], 'and the queue drains (the run may have ended while we asked)');
    A.ok(r.lines.some(l => /already finished its work — it stays queued as your next message/.test(l)), 'with the reason: ' + JSON.stringify(r.lines));
  }
  {
    // the answer lands while another session is on screen: no line in that session's log
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    r.ctx.activeWs = { id: 'ws2' };
    r.answer(ok200); await tick(); await tick();
    A.eq(r.lines, [], 'an accepted note prints nothing into another session\'s log');
  }
  {
    // the answer is ok but its run ended meanwhile, and the run never showed it landing: it goes as the next message
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    Channels.end('ws1'); r.ctx.__settle('ws1', 'run-1', 'Done.');   // the run's teardown: the line was still in flight
    r.answer(ok200); await tick(); await tick();
    A.eq(r.ctx.queued.get('ws1'), ['use the blue folder'], 'a late ok for an ended run that never read it re-queues it');
    A.ok(r.lines.some(l => /ended before the agent read your send-now message/.test(l)), 'with one line: ' + JSON.stringify(r.lines));
    A.eq(r.ctx.sentNow.has('ws1'), false, 'and the ended run keeps no send-now lines');
  }
  // ── ON DISK UNTIL SETTLED (live walk 2026-10-14): a reload mid hand-off lost an accepted line ──
  {
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder\nplease']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder\nplease');
    const disk = onDisk(r.ctx.localStorage, 'ws1');
    A.ok(/^sn[a-z0-9]+$/.test(r.posts[0].noteId || ''), 'the POST names the line with the page\'s own noteId: ' + JSON.stringify(r.posts[0]));
    A.eq(disk.map(e => [e.id, e.runId, e.text, e.wire]), [[r.posts[0].noteId, 'run-1', 'use the blue folder\nplease', 'use the blue folder please']],
      'it is on disk BEFORE the station answers (a reload mid-POST still finds it): the typed words, the wire, its run');
    r.answer(ok200); await tick(); await tick();
    A.eq(onDisk(r.ctx.localStorage, 'ws1').length, 1, 'accepted: it stays on disk while the run holds it');
    A.eq(r.ctx.sentNow.get('ws1')[0].id, r.posts[0].noteId, 'memory and disk name the same line');
  }
  {
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    r.answer({ status: 409, json: () => Promise.resolve({ ok: false }) }); await tick(); await tick();
    A.eq(onDisk(r.ctx.localStorage, 'ws1'), [], 'a refused line is a queued pill again: off the disk');
  }
  {
    const r = sendRig();
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    r.answer(ok200); await tick(); await tick();
    Channels.end('ws1'); r.ctx.__settle('ws1', 'run-1', '\n[steering] use the blue folder\nDone.');
    A.eq(onDisk(r.ctx.localStorage, 'ws1'), [], 'a run that ended in this page settles its lines: off the disk');
  }
  {
    // a browser that blocks storage (private window, cleared site data) still sends now: memory works as before
    const r = sendRig({ brokenStorage: true });
    Channels.begin('ws1', Date.now()); Channels.setRunId('ws1', 'run-1', Date.now());
    r.ctx.queued.set('ws1', ['use the blue folder']);
    r.ctx.__sendNow('ws1', 0, 'use the blue folder');
    r.answer(ok200); await tick(); await tick();
    A.eq([r.posts.length, (r.ctx.sentNow.get('ws1') || []).length], [1, 1], 'blocked storage never stops the steer');
    A.ok(r.ctx.sentNow.get('ws1')[0].accepted === true && !r.lines.length, 'the run holds it (the strip shows it SENT) and no SYSTEM line says so');
  }
  {
    /* THE STRIP, RUN FOR REAL (Andrew 10-26): a queued line is a NEXT row with a SEND NOW key; once the run holds it, a SENT
       row with no key; once the run's echo shows it read, no row (the transcript shows it as the Commander's MID-RUN line). */
    const rq = A.fnBody(src, 'function renderQueued');
    A.ok(rq.length > 200 && rq.length < 6000, 'renderQueued located');
    const mk = tag => ({ tag, className: '', children: [], attrs: {}, text: '', appendChild(n) { this.children.push(n); return n; },
      setAttribute(k, v) { this.attrs[k] = v; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; } });
    const strip = Object.assign(mk('div'), { innerHTML: '', offsetHeight: 0 });
    Object.defineProperty(strip, 'innerHTML', { set() { strip.children = []; }, get() { return ''; } });
    const sentNow = new Map();
    const ctx = vm.createContext({ document: { createElement: mk, createTextNode: t => ({ text: t }) }, el: id => id === 'chat-queued' ? strip : null,
      log: { scrollTop: 0, contains: () => false }, heldCard: null, activeWs: { id: 'ws1' }, queued: new Map([['ws1', ['use the blue folder']]]), sentNow,
      nearBottom: () => false, topInLog: () => 0, sendQueuedNow: () => {} });
    vm.runInContext(rq + '\n;this.__rq = renderQueued;', ctx);
    const rows = () => strip.children.map(p => [p.className, p.children.map(c => c.className + ':' + c.text).join(' ')]);
    ctx.__rq();
    A.eq(rows(), [['queued-pill', 'queued-tag:next queued-text:use the blue folder queued-now:send now queued-x:✕']], 'a queued line: NEXT, its words, a SEND NOW key, a cancel key');
    ctx.queued.delete('ws1'); sentNow.set('ws1', [{ id: 'sn1', text: 'use the blue folder', accepted: true, landed: false }]);
    ctx.__rq();
    A.eq(rows(), [['queued-pill sent', 'queued-tag:sent queued-text:use the blue folder queued-when:read at its next step']], 'held by the run: SENT, no key — it says only what the 200 proves');
    sentNow.get('ws1')[0].landed = true;
    ctx.__rq();
    A.eq(rows(), [], 'read: the row leaves (the transcript shows it now)');
    sentNow.set('ws1', [{ id: 'sn2', text: 'x', accepted: false, landed: false }]);
    ctx.__rq();
    A.eq(rows(), [], 'still in flight (not accepted yet): no SENT claim');
  }
})().then(() => {
  // with the speaker on, the voice never reads the Commander's own steering note as the agent's words
  const ss = A.fnBody(src, 'const speakSafe = (s) =>');
  A.ok(ss.length > 50 && ss.length < 2000, 'speakSafe located');
  const m = /const SPEAK_MARKER = [^\n]*\n/.exec(src), st = /const SPEAK_STEER = [^\n]*\n/.exec(src);
  A.ok(m && st, 'speakSafe\'s marker and steering patterns are present');
  const speakSafe = m && st ? new Function(m[0] + st[0] + ss + '; return speakSafe;')() : (s => s);
  A.eq(speakSafe('Looking now.\n[steering] use the blue folder\nDone.'), 'Looking now.\nDone.', 'a steering line is never spoken');
  A.eq(speakSafe('\n[steering] use the blue folder\n'), '\n', 'an echo alone speaks nothing');
  A.eq(speakSafe('Looking now.'), 'Looking now.', 'plain prose is untouched');
  A.report('queued-send-now.test');
}).catch(e => { console.error(e); process.exit(1); });
