/* node test/comms-flow.test.js — COMMS reads as a conversation while an agent works (Andrew 10-26: "SO many tool calls
   clutter up the chat and they never disappear … five QUEST COMPLETE rows … the send now is TERRIBLE").

     · ONE LINE PER BURST: a rail of two or more tool calls shows ONE summary row (chat.js syncRail) — the call it is on
       while it runs, what it used once done — and lists every chip on a click. A single call keeps its own row. The run-end
       fold counts chips only, never the summary row.
     · ONE QUEST LINE PER MOMENT: QUEST COMPLETE lines landing together fold into one line, like trophies; and a station line
       that lands while the live working card is pinned joins the block ABOVE the card, never a new row under it.

   GENUINE (executed): the real chip, rail and broadcast code is sliced out of chat.js and run over a small fake DOM. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const slice = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); A.ok(a > 0 && b > a, 'chat.js region: ' + from.trim().slice(0, 40)); return src.slice(a, b); };

/* ── a fake DOM: enough for the chip, rail and broadcast code (class/id selectors, :not(), ':scope > ') ── */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.id = ''; this.children = []; this.parentElement = null; this.dataset = {}; this.attrs = {}; this.hidden = false; this.listeners = {}; this.nodeType = 1; }
  get classList() {
    const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
    const set = (c, on) => { const l = list().filter(x => x !== c); if (on) l.push(c); el.className = l.join(' '); return on; };
    return { add: (...cs) => cs.forEach(c => set(c, true)), remove: (...cs) => cs.forEach(c => set(c, false)), contains: c => list().includes(c),
      toggle: (c, force) => set(c, force === undefined ? !list().includes(c) : !!force) };
  }
  appendChild(n) { if (n.parentElement) n.remove(); n.parentElement = this; this.children.push(n); return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); if (n.parentElement) n.remove(); n.parentElement = this; this.children.splice(this.children.indexOf(ref), 0, n); return n; }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  get firstChild() { return this.children[0] || null; }
  get lastElementChild() { const e = this.children.filter(c => c.nodeType === 1); return e[e.length - 1] || null; }
  get previousElementSibling() { const p = this.parentElement; if (!p) return null; const e = p.children.filter(c => c.nodeType === 1); return e[e.indexOf(this) - 1] || null; }
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return n === ROOT; }
  get textContent() { return this.children.map(c => c.nodeType === 3 ? c.text : c.textContent).join(''); }
  set textContent(v) { this.children = []; if (v !== '' && v != null) this.children.push({ nodeType: 3, text: String(v) }); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); }
  matches(sel) {
    return sel.split(',').some(one => {
      const m = one.trim(); const nots = [...m.matchAll(/:not\(([^)]*)\)/g)].map(x => x[1]); const base = m.replace(/:not\([^)]*\)/g, '');
      const ok = s => { const id = /#([\w-]+)/.exec(s); const cls = [...s.matchAll(/\.([\w-]+)/g)].map(x => x[1]); return (!id || this.id === id[1]) && cls.every(c => this.classList.contains(c)); };
      return ok(base) && !nots.some(n => n && ok(n));
    });
  }
  all() { return this.children.filter(c => c.nodeType === 1).flatMap(c => [c].concat(c.all())); }
  querySelectorAll(sel) { const direct = /^:scope > /.test(sel); const s = sel.replace(/^:scope > /, ''); return (direct ? this.children.filter(c => c.nodeType === 1) : this.all()).filter(n => n.matches(s)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const ROOT = new El('body');
const document = { createElement: t => new El(t), createTextNode: t => ({ nodeType: 3, text: String(t) }) };
const reset = () => { ROOT.children = []; const log = new El('div'); log.id = 'chat-log'; ROOT.appendChild(log); return log; };

/* ── 1. ONE LINE PER BURST ── */
{
  const log = reset();
  const ctx = vm.createContext({ document, log, JSON, Array, Map, Set, Math, Number, String, Object, autoscroll() {}, clearEmptyState() {}, activeWs: { id: 'ws1' }, App: { agentName: () => '' } });
  const code = A.fnBody(src, 'function brief(s)') + '\n' + A.fnBody(src, 'function fmtMs(ms)') + '\n'
    + slice('  let toolRail = null;', '  // a clickable COMMS row for a file the agent produced')
    + '\n;this.__t = { toolChip, resolveChip, toolRailOf, syncRail, railChips, endToolRail, runRails: () => runRails };';
  vm.runInContext(code, ctx);
  const T = ctx.__t;
  const sumOf = rail => rail.querySelector(':scope > .tr-sum');
  const read = rail => { const s = sumOf(rail); return s && !s.hidden ? ['.tr-glyph', '.tr-count', '.tr-names', '.tr-stat'].map(k => s.querySelector(k).textContent) : null; };

  const c1 = T.toolChip({ callId: 'c1', name: 'fs_read', argsSummary: '{"path":"notes.md"}' });
  const rail = c1.parentElement;
  A.eq([rail.className, read(rail)], ['tool-rail', null], 'one call keeps its own row: no summary');
  T.toolChip({ callId: 'c2', name: 'fs_list', argsSummary: '{"path":"src"}' });
  A.ok(rail.classList.contains('tr-multi') && !rail.classList.contains('open'), 'a second call folds the rail (CSS hides its chips until opened)');
  A.ok(rail.children[0] === sumOf(rail), 'the summary row leads the rail');
  A.eq(read(rail), ['▸', '2 steps', 'fs.list src', ''], 'while it runs, the summary names the call it is on');
  T.resolveChip({ callId: 'c1', summary: 'ok', isError: false, ms: 30 });
  A.eq(read(rail), ['▸', '2 steps', 'fs.list src', ''], 'one call still running: still the running call');
  T.resolveChip({ callId: 'c2', summary: 'ENOENT', isError: true, ms: 12 });
  A.eq(read(rail), ['✓', '2 steps', 'fs.read, fs.list', '1 failed'], 'done with a failed step: a plain check, and the stat says how many failed');
  A.ok(sumOf(rail).classList.contains('mixed') && !sumOf(rail).classList.contains('err'), 'a partly failed burst is not an alarm');
  sumOf(rail).click();
  A.ok(rail.classList.contains('open') && sumOf(rail).getAttribute('aria-expanded') === 'true', 'a click lists every chip');
  A.eq(T.railChips(rail).length, 2, 'the rail still holds both chips, unchanged');

  T.endToolRail();
  T.toolChip({ callId: 'c3', name: 'fs_read', argsSummary: '{"path":"a.md"}' });
  const rail2 = log.lastElementChild;
  T.toolChip({ callId: 'c4', name: 'fs_read', argsSummary: '{"path":"b.md"}' });
  T.toolChip({ callId: 'c5', name: 'fs_search', argsSummary: '{"pattern":"x"}' });
  ['c3', 'c4', 'c5'].forEach((id, i) => T.resolveChip({ callId: id, summary: 'ok', isError: false, ms: 20 + i * 10 }));
  A.ok(rail2 !== rail && rail2.classList.contains('tool-rail'), 'a break starts a new rail');
  A.eq(read(rail2), ['✓', '3 steps', 'fs.read, fs.search', '90ms'], 'all done: a check, each tool named once, the summed time');
  T.endToolRail();
  T.toolChip({ callId: 'c6', name: 'fs_read', argsSummary: '{"path":"c.md"}' });
  T.toolChip({ callId: 'c7', name: 'fs_read', argsSummary: '{"path":"d.md"}' });
  T.resolveChip({ callId: 'c6', summary: 'nope', isError: true, ms: 5 });
  T.resolveChip({ callId: 'c7', summary: 'nope', isError: true, ms: 5 });
  const rail3 = log.lastElementChild;
  A.eq(read(rail3), ['✗', '2 steps', 'fs.read', '2 failed'], 'every step failed: the red ✗');
  A.eq(T.runRails().map(r => T.railChips(r).length), [2, 3, 2], 'the run-end fold counts chips, never the summary rows');

  const group = T.toolRailOf([{ name: 'fs_list', args: '{"path":"."}', done: true, ms: 10, callId: 'g1' }, { name: 'fs_read', args: '{"path":"x"}', done: false, callId: 'g2' }]);
  A.eq(read(group), ['▸', '2 steps', 'fs.read x', ''], 'the group chat folds a burst the same way');
  A.eq(read(T.toolRailOf([{ name: 'fs_list', args: '{}', done: true }])), null, 'and keeps a single call as its own row');

  const rp = A.fnBody(src, 'function resolvePresence(ws, opts)');
  A.ok(/runRails\.filter\(r => r && r\.isConnected && railChips\(r\)\.length > 0\)/.test(rp) && /n \+ railChips\(r\)\.length/.test(rp), 'resolvePresence folds rails by their chips');
}

/* ── 2. ONE QUEST LINE PER MOMENT, ABOVE THE LIVE CARD ── */
{
  const log = reset();
  const game = new El('section'); game.id = 'screen-game'; game.classList.add('active'); ROOT.appendChild(game);
  let now = 1000000; const timers = [];
  const ctx = vm.createContext({ document, log, JSON, Array, Math, String, Object,
    Date: { now: () => now }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    el: id => (id === 'screen-game' ? game : null), autoscroll() {}, clearEmptyState() {} });
  vm.runInContext(slice('  const BROADCAST_COALESCE_MS', '  // a compact tool-activity line in COMMS') + '\n;this.__b = { broadcast };', ctx);
  const card = new El('div'); card.id = 'comms-presence'; card.className = 'comms-presence'; log.appendChild(new El('div')); log.appendChild(card);
  const B = ctx.__b;
  const lines = () => log.querySelectorAll('.bc-line').map(l => l.textContent);
  B.broadcast('QUEST COMPLETE · NOVA CAN REACH WEB NOW', { highlight: 'NOVA CAN REACH WEB NOW' });
  A.ok(log.lastElementChild === card, 'the live working card stays pinned at the bottom');
  A.ok(card.previousElementSibling.classList.contains('broadcast'), 'the station line lands above it');
  now += 400; B.broadcast('QUEST COMPLETE · SAM ALTMAN CAN REACH WEB NOW', { highlight: 'SAM ALTMAN CAN REACH WEB NOW' });
  now += 400; B.broadcast('QUEST COMPLETE · NOVA CAN REACH IMAGES NOW', { highlight: 'NOVA CAN REACH IMAGES NOW' });
  now += 400; B.broadcast('QUEST COMPLETE · TERMINATOR CAN REACH FILES NOW', {});
  A.eq(lines(), ['▸ 4 QUESTS COMPLETE · NOVA CAN REACH WEB NOW · SAM ALTMAN CAN REACH WEB NOW +2 (see QUEST LOG)'], 'quests completing together fold into ONE line: two named, the rest counted');
  A.eq(log.querySelectorAll('.cmsg.broadcast').length, 1, 'one block, not four rows');
  A.eq(timers.length, 0, 'a folded quest never waits in the rate-limit queue');
  now += 20000; B.broadcast('QUEST COMPLETE · A NEW MOMENT', {});
  A.eq(lines().length, 2, 'a quest from a later moment is its own line');
  A.eq(log.querySelectorAll('.cmsg.broadcast').length, 1, 'and it joins the block above the live card, never a new row under it');
  A.ok(log.lastElementChild === card, 'the card is still the last row');
}

/* ── 3. A NOTE SENT MID-RUN SURVIVES A RELOAD, WHERE THE AGENT READ IT ──
   The page saves only the reply's last stretch (every tool call starts it over) and the station's transcript never holds
   the note, so a reload dropped it (reproduced on trunk e1bfd6dda). The run's end files each note it streamed as a station
   row unless the saved reply shows it; reading the conversation back puts the note after the turn it followed, by time. */
{
  const fns = A.fnBody(src, 'function steerEchoesOf(delta)') + '\n' + A.fnBody(src, 'function fileRunSteers(ws, notes, runId, savedText)') + '\n'
    + A.fnBody(src, 'function placeSteerNotes(rows)') + '\n;this.__s = { steerEchoesOf, fileRunSteers, placeSteerNotes };';
  const ctx = vm.createContext({ String, Number, Array, Object });
  vm.runInContext(fns, ctx);
  const S = ctx.__s;
  A.eq(S.steerEchoesOf('Looking.\n[steering] use the blue folder\nOk.\n[steering] and skip tests\n'), ['use the blue folder', 'and skip tests'], 'every steering line in a delta is read');

  // filing: a note the last stretch shows stays in it; a note an earlier tool call wiped is filed once
  const ws = { history: [{ role: 'user', content: 'redesign the station', sourceRunId: 'r1', ts: 100 }] };
  const notes = [{ text: 'everything should change', ts: 400 }, { text: 'keep the command room', ts: 900 }];
  A.eq(S.fileRunSteers(ws, notes, 'r1', 'Done.\n[steering] keep the command room\nKept it.'), 1, 'only the note the saved reply does not show is filed');
  A.eq(ws.history[1], { role: 'system', sys: true, steerEcho: true, content: '[steering] everything should change', sourceRunId: 'r1', ts: 400 },
    'filed as the station row a reload already knows (sys: never model context), stamped when it arrived');
  A.eq(S.fileRunSteers(ws, notes, 'r1', 'Done.\n[steering] keep the command room\nKept it.'), 0, 'and never twice');
  A.eq(S.fileRunSteers(ws, notes, null, ''), 0, 'a run with no id files nothing');

  // reading back: the station inserts the run's middle turns AHEAD of the filed note; the note returns after the turn it followed
  const merged = [
    { role: 'user', content: 'redesign the station', sourceRunId: 'r1', ts: 100 },
    { role: 'assistant', content: 'Clearing the old rooms.', sourceRunId: 'r1', ts: 200 },
    { role: 'assistant', content: 'Checking the room list.', sourceRunId: 'r1', ts: 350 },
    { role: 'assistant', content: 'Got your note: replacing the whole layout.', sourceRunId: 'r1', ts: 600 },
    { role: 'system', sys: true, steerEcho: true, content: '[steering] everything should change', sourceRunId: 'r1', ts: 400 },
    { role: 'assistant', content: 'Done.', sourceRunId: 'r1', ts: 1000 },
    { role: 'user', content: 'next task', sourceRunId: 'r2', ts: 1100 }
  ];
  const placed = S.placeSteerNotes(merged);
  A.eq(placed.map(r => r.content), ['redesign the station', 'Clearing the old rooms.', 'Checking the room list.', '[steering] everything should change',
    'Got your note: replacing the whole layout.', 'Done.', 'next task'], 'the note sits after the turn it followed, before the reply to it');
  A.eq(S.placeSteerNotes(placed).map(r => r.content), placed.map(r => r.content), 'placing again changes nothing (the next load reads the saved order)');
  A.ok(merged[4].steerEcho, 'the input is not mutated');
  const unstamped = [{ role: 'user', content: 'go', sourceRunId: 'rA' }, { role: 'assistant', content: 'Halfway.', sourceRunId: 'rA' },
    { role: 'system', sys: true, steerEcho: true, content: '[steering] use the blue folder', sourceRunId: 'rA', ts: 4 }, { role: 'user', content: 'again', sourceRunId: 'rB' }];
  A.eq(S.placeSteerNotes(unstamped).map(r => r.content), unstamped.map(r => r.content), 'a run with no stamped rows keeps the note where the merge put it');

  // the wiring: the stream collects, the run's end files before branching, the read-back places
  A.ok(/fileRunSteers\(ws, runSteers, thisRunId, error \? '' : \(reply \|\| acc\)\);\s*\n\s*if \(error\) \{/.test(src), 'the run files its notes the moment it ends, before its reply is saved');
  A.ok(/const next = placeSteerNotes\(mergeCanonicalHistory\(ws\.history, turns\)\);/.test(src), 'reading the conversation back places the notes');
}

A.report('comms-flow.test');
