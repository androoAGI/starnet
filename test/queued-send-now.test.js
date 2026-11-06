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
A.ok(!/className = 'queued-now'/.test(rb), 'ordinary sends need no separate steering key');
A.ok(/steerQueued\(id\)/.test(A.fnBody(src, 'function enqueue')), 'ordinary enqueue automatically attempts live delivery');
{
  // the pill's tip names what it does now that the key exists: it sends after this run, or send now hands it to the run.
  // Run the tip line for real: the clipped pill's whole message reads in the tip, and the hint survives the 400-char cap.
  const line = rb.slice(rb.indexOf('      const QHINT'), rb.indexOf("const label = document.createElement('span')"));
  A.ok(line.length > 40 && !/pill\.title\s*=/.test(rb), 'the pill tip is a station data-tip (no native title)');
  const tipOf = t => { let tip = null; new Function('pill', 't', line)({ setAttribute: (k, v) => { if (k === 'data-tip') tip = v; } }, t); return tip; };
  A.eq(tipOf('use the blue folder'), '“use the blue folder” · waiting for delivery · joins the running task at its next step', 'the tip names SEND NOW, not a slash command');
  const ht = tipOf('x'.repeat(2000));
  A.ok(ht.length <= 400 && /…” · waiting for delivery · joins the running task at its next step$/.test(ht), 'a message past the tip cap gives way, never the hint');
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
A.ok(/className = 'queued-pill sent'/.test(rb) && /waiting for its next step/.test(rb) && /'read at its next step'/.test(rb), 'the SENT row promises only the next step');

// Enter while busy still QUEUES (Andrew's call: send now is opt-in per pill)
const soq = /function\s+sendOrQueue\s*\(text\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(soq && /if \(isBusy\(\)\) \{\s*enqueue\(value\)/.test(soq[1]), 'Enter while busy still queues');

A.ok(/\.queued-now\s*\{[^}]*border: 1px solid var\(--ph-dim\)/.test(css), 'the key is skinned station hardware (no OS paint)');
A.ok(!/now\.title\s*=/.test(rb), 'no native tooltip is added');

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
    const ctx = vm.createContext({ autoSteerBusy: new Set(), steerQueued: () => {},  document: { createElement: mk, createTextNode: t => ({ text: t }) }, el: id => id === 'chat-queued' ? strip : null,
      log: { scrollTop: 0, contains: () => false }, heldCard: null, activeWs: { id: 'ws1' }, queued: new Map([['ws1', ['use the blue folder']]]), sentNow,
      nearBottom: () => false, topInLog: () => 0, sendQueuedNow: () => {}, SVG_IMAGE: '<svg/>', SVG_FILE: '<svg/>', pruneUpload: () => {} });
    vm.runInContext(rq + '\n' + A.fnBody(src, 'function qText') + '\n' + A.fnBody(src, 'function qAtts') + '\n' + A.fnBody(src, 'function qFiles') + '\n;this.__rq = renderQueued;', ctx);
    const rows = () => strip.children.map(p => [p.className, p.children.map(c => c.className + ':' + c.text).join(' ')]);
    ctx.__rq();
    A.eq(rows(), [['queued-pill', 'queued-tag:waiting queued-text:use the blue folder queued-x:✕']], 'a queued line: NEXT, its words, a SEND NOW key, a cancel key');
    ctx.queued.delete('ws1'); sentNow.set('ws1', [{ id: 'sn1', text: 'use the blue folder', accepted: true, landed: false }]);
    ctx.__rq();
    A.eq(rows(), [['queued-pill sent', 'queued-tag:received queued-text:use the blue folder queued-when:read at its next step']], 'held by the run: SENT, no key — it says only what the 200 proves');
    sentNow.get('ws1')[0].landed = true;
    ctx.__rq();
    A.eq(rows(), [], 'read: the row leaves (the transcript shows it now)');
    sentNow.set('ws1', [{ id: 'sn2', text: 'x', accepted: false, landed: false }]);
    ctx.__rq();
    A.eq(rows(), [['queued-pill sent', 'queued-tag:sending queued-text:x queued-when:awaiting receipt']], 'in flight shows sending, not received');
    /* QUEUED WITH PHOTOS (Andrew 10-31): the photos ride the queued message — the pill counts them and has no SEND NOW key
       (a steering note is one line of text: it could never carry them), and its tip says they send after this run. */
    sentNow.delete('ws1');
    const img = n => ({ id: 'a' + n, name: 'shot' + n + '.png', path: 'attachments/shot' + n + '.png', mediaType: 'image/png', kind: 'image' });
    ctx.queued.set('ws1', [{ text: 'what is wrong here', atts: [img(1), img(2)] }, 'plain one']);
    ctx.__rq();
    A.eq(rows(), [['queued-pill', 'queued-tag:waiting queued-text:what is wrong here queued-files: queued-x:✕'],
      ['queued-pill', 'queued-tag:waiting queued-text:plain one queued-x:✕']], 'a message queued with photos: NEXT, its words, its photos, a cancel key — no SEND NOW');
    const fp = strip.children[0].children[2];
    A.eq(fp.children.map(c => c.className || c.text), ['glyph', '2 photos'], 'the pill counts the photos it carries');
    A.eq(strip.children[0].attrs['data-tip'], '“what is wrong here” · joins the running task with its 2 photos', 'its tip says the photos send with it after this run');
    ctx.queued.set('ws1', [{ text: '', atts: [Object.assign(img(3), { kind: 'file', name: 'log.txt' })] }]);
    ctx.__rq();
    A.eq(strip.children[0].attrs['data-tip'], 'joins the running task with its 1 file', 'a files-only queued message names the file, with no empty quote');
  }
  {
    // the queue drains a queued-with-photos message as ONE turn carrying its photos — never the words now and the photos later
    const fq = A.fnBody(src, 'function flushQueued');
    const sent = [];
    const ctx = vm.createContext({ autoSteerBusy: new Set(), steerQueued: () => {},  activeWs: { id: 'ws1' }, crewJoining: new Set(), isBusy: () => false, renderQueued: () => {}, send: (...a) => sent.push(a),
      queued: new Map([['ws1', [{ text: 'look at these', atts: [{ id: 'a1', kind: 'image' }] }, 'then this']]]) });
    vm.runInContext(fq + '\n' + A.fnBody(src, 'function qText') + '\n' + A.fnBody(src, 'function qAtts') + '\n;this.__fq = flushQueued;', ctx);
    ctx.__fq('ws1');
    A.eq(JSON.stringify(sent), JSON.stringify([['look at these', { attachments: [{ id: 'a1', kind: 'image' }] }]]), 'the next turn carries its words and its photos together');
    ctx.__fq('ws1');
    A.eq(JSON.stringify(sent[1]), JSON.stringify(['then this']), 'a plain queued line still sends exactly as before');
  }
  {
    // a send the group path refuses (false) started no turn: the entry has left the queue, so it must come back, never vanish
    const fq = A.fnBody(src, 'function flushQueued');
    const load = (activeId, result) => {
      const calls = { restored: [], rendered: 0 };
      const ctx = vm.createContext({ autoSteerBusy: new Set(), steerQueued: () => {},  activeWs: { id: activeId }, crewJoining: new Set(), isBusy: () => false, send: () => result, queued: new Map([['ws1', [{ text: 'look', atts: [{ id: 'a1' }] }, 'then this']]]),
        renderQueued: () => { calls.rendered++; }, restoreQueued: id => calls.restored.push(id) });
      vm.runInContext(fq + '\n' + A.fnBody(src, 'function qText') + '\n' + A.fnBody(src, 'function qAtts') + '\n;this.__fq = flushQueued;', ctx);
      return { ctx, calls };
    };
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const refused = load('ws1', Promise.resolve(false));
    refused.ctx.__fq('ws1'); await tick();
    A.eq(JSON.stringify(refused.ctx.queued.get('ws1')), JSON.stringify([{ text: 'look', atts: [{ id: 'a1' }] }, 'then this']), 'a refused send puts the entry back at the front, photos included');
    A.eq(refused.calls.restored, ['ws1'], 'and the queue returns to the composer of the chat on screen');
    const sentOk = load('ws1', Promise.resolve(undefined));
    sentOk.ctx.__fq('ws1'); await tick();
    A.eq(JSON.stringify(sentOk.ctx.queued.get('ws1')), JSON.stringify(['then this']), 'a plain send (undefined) stays off the queue');
    A.eq(sentOk.calls.restored, [], 'and restores nothing');
    const sync = load('ws1', 3);
    sync.ctx.__fq('ws1'); await tick();
    A.eq(sync.calls.restored, [], 'a send that returns anything but false is not a refusal');
    const away = load('ws2', Promise.resolve(false));
    away.ctx.__fq('ws1');
    A.eq(away.calls.restored, [], 'off screen the guard stops the drain before any send');
    A.eq(JSON.stringify(away.ctx.queued.get('ws1')), JSON.stringify([{ text: 'look', atts: [{ id: 'a1' }] }, 'then this']), 'and the queue is untouched');
    const left = load('ws1', new Promise(resolve => setTimeout(() => resolve(false), 0)));
    left.ctx.__fq('ws1');
    left.ctx.activeWs = { id: 'ws2' };
    await new Promise(resolve => setTimeout(resolve, 5));
    A.eq(left.calls.restored, [], 'a refusal that lands after you left never fills the other chat\'s box');
    A.eq(JSON.stringify(left.ctx.queued.get('ws1')), JSON.stringify([{ text: 'look', atts: [{ id: 'a1' }] }, 'then this']), 'the entry waits in its own queue');
    A.eq(left.calls.rendered > 0, true, 'and the pills are redrawn');
  }
  {
    // Enter, executed: the real submit, queue, take-back and drain together, with each upload and each run ending under the test's control.
    // Every scenario below is a way two messages, a Stop or a switch could once take or lose words and files held in the shared box and strip.
    const code = ['async function submitComposer', 'function enqueue', 'function qText', 'function qAtts', 'function qFiles', 'function holdForUploads',
      'function uploadsSettled', 'function afterQueueMove', 'function restoreQueued', 'function flushQueued', 'function takeAttachments', 'function clearAttachments', 'function removePending'].map(name => A.fnBody(src, name)).join('\n');
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const rig = (opts = {}) => {
      const h = { queued: new Map(), sent: [], handoffs: [], lines: [], pruned: [], revoked: [], kicks: [], busy: opts.busy !== false, input: { value: '' } };
      h.ws1 = { id: 'ws1' }; h.ws2 = { id: 'ws2' };
      const ctx = vm.createContext({ autoSteerBusy: new Set(), steerQueued: () => {},  input: h.input, activeWs: h.ws1, focusVersion: 0, queued: h.queued, crewJoining: new Set(), GoalLoop: {}, kickGoal: ws => h.kicks.push(ws.id), console, pendingAtts: [],
        URL: { revokeObjectURL: url => h.revoked.push(url) }, isBusy: () => h.busy,
        recordSent() {}, closeSlash() {}, autoGrowInput() {}, renderQueued() {}, renderAttachStrip() {}, stepOfferAside() {}, composerContextIssue: () => null, pendingAskFor: () => false,
        pruneUpload: ref => h.pruned.push(ref), localLine: line => h.lines.push(line),
        typedTaskCompletesHandoff: t => h.handoffs.push(t),
        send: (text, o) => { h.sent.push(o && o.attachments && o.attachments.length ? [text, o.attachments.map(r => r.id)] : [text]); if (opts.sendStartsRun) h.busy = true; } });
      vm.runInContext(code + '\n;this.__submit = submitComposer; this.__flush = flushQueued; this.__restore = restoreQueued; this.__remove = removePending; this.__after = afterQueueMove;', ctx);
      h.ctx = ctx;
      h.file = (id, status) => {
        const f = { name: id, kind: 'file', localUrl: '', status: status || 'uploading', ref: status === 'ready' ? { id, name: id, kind: 'file' } : null };
        f.p = new Promise(resolve => { f.finish = ok => { f.status = ok === false ? 'error' : 'ready'; if (ok !== false) f.ref = { id, name: id, kind: 'file' }; resolve(); }; });
        ctx.pendingAtts.push(f);
        return f;
      };
      h.enter = async words => { if (words !== undefined) h.input.value = words; await ctx.__submit(); };
      h.line = id => (h.queued.get(id || 'ws1') || []).map(e => typeof e === 'string' ? e : [e.text, e.uploads ? 'uploading' : e.atts.map(r => r.id)]);
      h.runEnds = async () => { h.busy = false; ctx.__flush(ctx.activeWs.id); await tick(); };
      return h;
    };

    let h = rig();
    await h.enter('look at this');
    A.eq(h.line(), ['look at this'], 'busy Enter with no files queues the plain words');
    A.eq(h.handoffs, ['look at this'], 'a task typed while busy completes a pending hand-off');
    A.eq(h.input.value, '', 'and the box is cleared');

    h = rig();
    h.file('r1', 'ready');
    await h.enter('with a ready file');
    A.eq(h.line(), [['with a ready file', ['r1']]], 'busy Enter with a finished upload queues the words with the file');
    A.eq(h.ctx.pendingAtts.length, 0, 'and the strip is clear');

    // the message takes its words and files at Enter, and Enter again has nothing left to send
    h = rig({ sendStartsRun: true });
    let f1 = h.file('f1');
    await h.enter('look at this');
    A.eq(h.line(), [['look at this', 'uploading']], 'busy Enter with an upload in flight queues at once, holding it');
    A.eq([h.input.value, h.ctx.pendingAtts.length], ['', 0], 'the words and the file left the box and the strip');
    A.eq(h.handoffs, [], 'a pending hand-off is not spent yet: it could still be taken back, or lost to a reload');
    await h.enter();
    A.eq(h.line().length, 1, 'Enter again is one message');
    await h.runEnds();
    A.eq([h.sent, h.line().length], [[], 1], 'a run ending does not send it while its file uploads');
    f1.finish(); await tick();
    A.eq(h.sent, [['look at this', ['f1']]], 'and the moment the file is ready it goes, with the file');
    A.eq(h.handoffs, ['look at this'], 'completing a pending hand-off then');
    A.eq(h.kicks, [], 'and a standing goal waits for that run');
    A.eq(h.line(), [], 'once');

    h = rig();
    f1 = h.file('f1');
    f1.localUrl = 'blob:f1';
    await h.enter('look');
    f1.finish(); await tick();
    A.eq(h.revoked, ['blob:f1'], 'a queued message frees its preview once its file is uploaded');
    A.eq(h.line(), [['look', ['f1']]], 'with the run still working it waits in the queue, file ready');
    await h.runEnds();
    A.eq(h.sent, [['look', ['f1']]], 'and goes when the run ends');

    // a session re-entry clears the queue around a held message: it is gone, so when its file lands nothing goes and no hand-off is spent
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('look');
    A.eq(h.line(), [['look', 'uploading']], 'held, its file still uploading');
    h.queued.clear();
    f1.finish(); await tick();
    A.eq([h.sent, h.handoffs, h.kicks], [[], [], []], 'a held message the queue no longer has sends nothing, spends no hand-off and starts no goal turn');

    // two messages, two files, either upload first: each keeps its own, in the order typed
    for (const order of [[0, 1], [1, 0]]) {
      h = rig();
      const files = [h.file('f1')];
      await h.enter('A');
      files.push(h.file('f2'));
      await h.enter('B');
      A.eq(h.line(), [['A', 'uploading'], ['B', 'uploading']], 'two messages stand in the order typed');
      for (const n of order) { files[n].finish(); await tick(); }
      A.eq(h.line(), [['A', ['f1']], ['B', ['f2']]], 'each holds its own file, whichever upload ended first (' + order + ')');
    }

    // idle: the second message never jumps the first, and never takes its files
    h = rig({ busy: false, sendStartsRun: true });
    f1 = h.file('f1');
    await h.enter('A');
    A.eq(h.sent, [], 'idle: a message with an upload in flight does not go yet');
    await h.enter('B');
    A.eq(h.sent, [], 'and plain words typed after it do not jump it');
    A.eq(h.line(), [['A', 'uploading'], 'B'], 'they stand behind it');
    f1.finish(); await tick();
    A.eq(h.sent, [['A', ['f1']]], 'the first goes with its file');
    A.eq(h.line(), ['B'], 'the second stays queued');
    await h.runEnds();
    A.eq(h.sent, [['A', ['f1']], ['B']], 'and follows when that run ends');

    // idle with something still queued (a run just ended, its deferred drain has not run): the queue goes first
    h = rig({ busy: false, sendStartsRun: true });
    h.queued.set('ws1', ['X']);
    await h.enter('A');
    A.eq(h.sent, [['X']], 'what was already queued goes first');
    A.eq(h.line(), ['A'], 'and the new message stands behind it');

    // a Stop gives back what was queued, including a file still uploading, and nothing fires behind it
    h = rig();
    f1 = h.file('f1');
    f1.localUrl = 'blob:f1';
    await h.enter('keep me');
    h.ctx.__restore('ws1');
    A.eq([h.input.value, h.line()], ['keep me', []], 'Stop: the words are back in the box and the queue is empty');
    A.eq(h.ctx.pendingAtts.map(f => [f.name, f.status]), [['f1', 'uploading']], 'and the file is back in the strip, still uploading');
    f1.finish(); await tick();
    A.eq([h.sent, h.line()], [[], []], 'its upload ending sends nothing and queues nothing');
    A.eq(h.ctx.pendingAtts.map(f => f.status), ['ready'], 'and the chip is ready');
    A.eq(h.revoked, [], 'with its preview still there');
    A.eq(h.lines.length, 1, 'and it is told once');
    await h.runEnds(); await h.enter();
    A.eq(h.sent, [['keep me', ['f1']]], 'Enter then sends it, with the file');

    h = rig();
    f1 = h.file('f1');
    await h.enter('A');
    const f2 = h.file('f2');
    await h.enter('B');
    h.ctx.__restore('ws1');
    A.eq(h.input.value, 'A\nB', 'Stop with two messages waiting: both sets of words come back, neither is lost');
    A.eq(h.ctx.pendingAtts.map(f => f.name), ['f1', 'f2'], 'and both files');
    f2.finish(); f1.finish();

    // a switch: the message stays in its own chat, with its own file
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('look at this');
    h.ctx.activeWs = h.ws2;
    await h.enter('over here');
    A.eq(h.sent, [['over here']], 'the other chat\'s message goes, without this chat\'s file');
    h.busy = false;
    f1.finish(); await tick();
    A.eq(h.sent.length, 1, 'the upload ending off screen sends nothing into the chat on screen');
    A.eq(h.line('ws1'), [['look at this', ['f1']]], 'it waits in its own queue, holding its file');
    h.ctx.activeWs = h.ws1;
    h.ctx.__flush('ws1'); await tick();
    A.eq(h.sent[1], ['look at this', ['f1']], 'and goes on return');

    // an upload that never ends locks nothing: the next message queues behind it, and ✕ takes it back
    h = rig({ busy: false, sendStartsRun: true });
    const hung = h.file('hung');
    await h.enter('stuck');
    await h.enter('still typing');
    h.input.value = 'more words';
    A.eq(h.line(), [['stuck', 'uploading'], 'still typing'], 'a stalled upload holds its own message, not the box');
    const stuck = h.queued.get('ws1')[0];
    h.ctx.__restore('ws1', stuck); h.ctx.__flush('ws1'); await tick();
    A.eq(h.input.value, 'stuck\nmore words', 'taking it back puts its words in the box, with what was being typed');
    A.eq(h.ctx.pendingAtts.map(f => f.name), ['hung'], 'its file in the strip');
    A.eq(h.sent, [['still typing']], 'and what stood behind it goes now');
    A.eq(h.lines.length, 1, 'with one line saying so');
    A.eq(h.handoffs, ['still typing'], 'a message taken back never spent a hand-off (only the one that went did)');
    h.ctx.__remove(0);
    h.busy = false;
    await h.enter();
    A.eq(h.sent[1], ['stuck\nmore words'], 'its chip removed, the words go alone');
    hung.finish(); await tick();
    A.eq(h.sent.length, 2, 'and a very late upload changes nothing');

    // a file staged after Enter belongs to the next message
    h = rig();
    f1 = h.file('f1');
    await h.enter('A');
    const later = h.file('later');
    A.eq(h.ctx.pendingAtts.map(f => f.name), ['later'], 'a file staged after Enter stays in the strip');
    f1.finish(); later.finish(); await tick();
    A.eq(h.line(), [['A', ['f1']]], 'the earlier message does not take it');

    // uploads that fail
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('words');
    f1.finish(false); await tick();
    A.eq(h.sent, [['words']], 'words whose only file failed still go (the failure already said so)');
    h = rig();
    f1 = h.file('f1');
    await h.enter('words');
    f1.finish(false); await tick();
    A.eq(h.line(), ['words'], 'with a run working they are plain queued words again, so the send now key works');
    h = rig();
    f1 = h.file('f1');
    await h.enter('');
    h.queued.get('ws1').push('next');
    f1.finish(false); await tick();
    A.eq(h.line(), ['next'], 'files only, all failed: the empty message leaves the queue');
    A.eq(h.sent, [], 'and sends nothing');

    // a standing goal is not left waiting on a message that will not go
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('');
    f1.finish(false); await tick();
    A.eq(h.kicks, ['ws1'], 'files only, all failed, nothing queued: a standing goal continues');
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('take me back');
    h.ctx.__restore('ws1', h.queued.get('ws1')[0]); h.ctx.__after('ws1');
    A.eq(h.kicks, ['ws1'], 'taken back, nothing queued: so does it here');

    // the chat became a group while it waited: the words and files come back, so nothing strands behind the group's own turns
    h = rig({ busy: false });
    f1 = h.file('f1');
    await h.enter('for the crew');
    h.ws1.conversationMode = 'group';
    h.busy = true;   // a kickoff keeps the group busy
    f1.finish(); await tick();
    A.eq([h.sent, h.line(), h.input.value], [[], [], 'for the crew'], 'its upload ending in a group sends nothing, and the words are back in the box');
    A.eq(h.ctx.pendingAtts.map(f => f.ref && f.ref.id), ['f1'], 'with the file, ready');
    A.eq(h.lines.length, 1, 'and it is told');
    h = rig();
    f1 = h.file('f1');
    await h.enter('one');
    const f3 = h.file('f3');
    await h.enter('two');
    f1.finish(); f3.finish(); await tick();
    h.ws1.conversationMode = 'group';
    h.ctx.__flush('ws1');
    A.eq(h.input.value, 'one\ntwo', 'files already ready when it became a group: both come back, in the order typed');
    A.eq(h.ctx.pendingAtts.map(f => f.ref.id), ['f1', 'f3'], 'with their files in that order');

    // crew joining: nothing leaves the queue under the change
    h = rig({ busy: false });
    h.ctx.crewJoining.add('ws1');
    f1 = h.file('f1');
    await h.enter('wait for them');
    f1.finish(); await tick();
    A.eq(h.sent, [], 'an upload ending while crew join sends nothing');
    h.ctx.crewJoining.delete('ws1');
    h.ctx.__flush('ws1');
    A.eq(h.sent, [['wait for them', ['f1']]], 'and it goes when they have');

    // holding nothing back from the group path, which stays where it was
    A.ok(/crewJoining\.add\(ws\.id\);\s*setTimeout\(\(\) => \{ Promise\.resolve\(joining\)\.catch\(\(\) => null\)\.then\(\(\) => \{ crewJoining\.delete\(ws\.id\); flushQueued\(ws\.id\); \}\); \}, 0\);/.test(src), 'the run\'s teardown holds the queue until the crew have joined, then drains it');
    const sc = A.fnBody(src, 'async function submitComposer');
    A.ok(!/\bawait\b/.test(sc.slice(sc.indexOf('A MESSAGE OWNS ITS WORDS'))), 'after the Enter decision begins, nothing waits');
    const pill = A.fnBody(src, 'function renderQueued');
    A.ok(/const t = qText\(e\), atts = qFiles\(e\), uploading = !!\(e && e\.uploads\);/.test(pill) && /if \(atts\.length\) \{/.test(pill), 'a message still uploading gets the files pill, so it never offers send now (a steering line cannot carry files)');
    A.ok(/if \(uploading\) \{[^\n]*restoreQueued\(id, e\); afterQueueMove\(id\);/.test(pill), 'its ✕ takes it back rather than discarding the words');
  }
  {
    const body = A.fnBody(src, 'function sendQueuedNow');
    const held = { text: 'first', atts: [], uploads: [{ status: 'uploading' }] };
    const lines = [], q = new Map([['ws1', [held, 'behind it']]]);
    const ctx = vm.createContext({ autoSteerBusy: new Set(), steerQueued: () => {},  activeWs: { id: 'ws1' }, queued: q, localLine: l => lines.push(l), renderQueued() {}, flushQueued() {}, steerWire: t => t, forgetSentNow: () => true,
      Channels: { isBusy: () => false, runIdOf: () => null } });
    vm.runInContext(body + '\n;this.__now = sendQueuedNow;', ctx);
    ctx.__now('ws1', 1, 'behind it');
    A.eq(q.get('ws1')[1], 'behind it', 'send now with no run keeps its place behind a message still uploading');
    A.eq(q.get('ws1')[0], held, 'and does not jump it');
    A.ok(/goes after the message ahead of it/.test(lines[0] || ''), 'and says when it goes');
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
