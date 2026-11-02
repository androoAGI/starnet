/* node test/comms-system-run-end.test.js — a SYSTEM card's last row is marked by chat.js, never found with a sibling :has (0.14.3 lag).

   comms-convo.css found the run's last row with .cmsg.system:not(:has(+ .cmsg.system)):not(:has(+ .choice-row)). That was the app's
   only sibling :has, and a trace of 0.14.2's warm reload shows 25,205 restyles of SYSTEM rows marked "Affected by :has()": every row
   added to the log restyled SYSTEM rows before it. What it locks:
   1. no stylesheet carries a sibling :has again, or a bare [class] attribute selector (every class change would pay for it);
   2. the card keeps its look: only a row with no station line or choice row after it wears the bottom edge;
   3. markSysRuns gives each row the same answer the :has gave, for every way a row reaches or leaves the log, reading only the rows
      beside a change; and Chat.init watches the log's own children, not its subtree, so a streamed token costs nothing.
   chat.js is browser-flow, so the function is lifted out of the source and run against a small DOM (the house pattern). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chat = fs.readFileSync(path.join(root, 'frontend/app/chat.js'), 'utf8');
const convo = fs.readFileSync(path.join(root, 'frontend/css/comms-convo.css'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/app/stationui.js'), 'utf8');

/* ---------- 1. the selectors that cost every insert and every class change ---------- */
const cssDir = path.join(root, 'frontend/css');
for (const f of fs.readdirSync(cssDir).filter(n => n.endsWith('.css'))) {
  const src = fs.readFileSync(path.join(cssDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  A.ok(!/:has\(\s*[+~]/.test(src), f + ': no sibling :has');
  A.ok(!/\[class(?:[\]~^$*|=])/.test(src), f + ': no [class] attribute selector');
}
A.ok(/<details class="ag-tune-fold"><summary>Fine-tune personality/.test(ui), 'the one fold that was found by having no class has one');

/* ---------- 2. the look ---------- */
const SYS = 'body #chat-panel :is(#chat-log, #gc-log) > .cmsg.system';
const at = convo.indexOf(SYS + ':not(.sys-more) {');
const end = convo.slice(at, convo.indexOf('}', at));
A.ok(at > 0 && end.includes('margin-bottom: 12px') && end.includes('padding-bottom: 12px') && end.includes('border-bottom-width: 1px') && end.includes('border-bottom-left-radius: 10px') && end.includes('border-bottom-right-radius: 10px'), 'the last row keeps the bottom edge and the room below it');

/* ---------- 3. markSysRuns ---------- */
class ClassList {
  constructor(s) { this.s = new Set(s); this.toggles = 0; }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { this.toggles++; if (on) this.s.add(c); else this.s.delete(c); }
}
let reads = 0;
class El {
  constructor(cls) { this.nodeType = 1; this.classList = new ClassList(cls.split(' ')); this.parent = null; }
  get nextElementSibling() {
    reads++;
    const k = this.parent.kids; for (let i = k.indexOf(this) + 1; i < k.length; i++) if (k[i].nodeType === 1) return k[i];
    return null;
  }
  get previousSibling() { const k = this.parent.kids; return k[k.indexOf(this) - 1] || null; }
}
class Text { constructor() { this.nodeType = 3; this.parent = null; } get previousSibling() { const k = this.parent.kids; return k[k.indexOf(this) - 1] || null; } }
// a log that records what a childList MutationObserver would, delivered by flush()
class Log {
  constructor(mark) { this.kids = []; this.q = []; this.mark = mark; }
  insert(n, before) {
    n.parent = this;
    const i = before ? this.kids.indexOf(before) : this.kids.length;
    this.q.push({ previousSibling: this.kids[i - 1] || null, addedNodes: [n], removedNodes: [] });
    this.kids.splice(i, 0, n);
    return n;
  }
  // one record with many nodes (replaceChildren, a fragment)
  insertMany(nodes) {
    for (const n of nodes) n.parent = this;
    this.q.push({ previousSibling: this.kids[this.kids.length - 1] || null, addedNodes: nodes, removedNodes: [] });
    this.kids.push(...nodes);
  }
  remove(n) {
    const i = this.kids.indexOf(n);
    this.q.push({ previousSibling: this.kids[i - 1] || null, addedNodes: [], removedNodes: [n] });
    this.kids.splice(i, 1);
  }
  flush() { const q = this.q; this.q = []; if (q.length) this.mark(q); }
  // what the sibling :has said for this row
  hasSaysLast(n) {
    const k = this.kids.filter(x => x.nodeType === 1), next = k[k.indexOf(n) + 1];
    return !(next && (next.classList.contains('choice-row') || (next.classList.contains('cmsg') && next.classList.contains('system'))));
  }
  check(label) {
    for (const n of this.kids) {
      if (n.nodeType !== 1 || !n.classList.contains('system') || !n.classList.contains('cmsg')) continue;
      A.eq(!n.classList.contains('sys-more'), this.hasSaysLast(n), label);
    }
  }
}
const src = A.fnBody(chat, 'function markSysRuns(');
const markSysRuns = new Function(src + '\nreturn markSysRuns;')();
const sys = () => new El('cmsg system');
const agent = () => new El('cmsg agent');
const choice = () => new El('choice-row');

{
  const log = new Log(markSysRuns);
  const a = log.insert(sys()); log.flush(); log.check('one line is its own run\'s end');
  A.ok(!a.classList.contains('sys-more'), 'a new row at the end of the log shows the card\'s end');
  const b = log.insert(sys()); log.flush(); log.check('a second line moves the end');
  A.ok(a.classList.contains('sys-more') && !b.classList.contains('sys-more'), 'the first line continues, the second ends the card');
  const c = log.insert(choice()); log.flush(); log.check('a choice row closes the card as its footer');
  A.ok(b.classList.contains('sys-more'), 'the last line runs on into its choice row');
  log.remove(c); log.flush(); log.check('the choice row answered and left');
  A.ok(!b.classList.contains('sys-more'), 'the card ends on its last line again');
  const d = log.insert(agent()); log.flush(); log.check('an agent row ends the run');
  A.ok(!b.classList.contains('sys-more'), 'an agent row after a run leaves the run\'s end in place');
  const e = log.insert(sys(), d); log.flush(); log.check('a tool line inserted above the live reply');
  A.ok(b.classList.contains('sys-more') && !e.classList.contains('sys-more'), 'a line inserted before the agent row extends the run');
  log.remove(b); log.flush(); log.check('a middle line removed');
  A.ok(a.classList.contains('sys-more'), 'the row before it now runs on into the next line');
  log.remove(e); log.flush(); log.check('the last line removed');
  A.ok(!a.classList.contains('sys-more'), 'the row before it ends the run again');
  log.remove(a); log.flush(); log.check('the first row pruned (nothing before it)');
}
{
  // a whole replay in one batch, then a clear (renderHistory): one answer per row, and only one pass
  const log = new Log(markSysRuns);
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(log.insert(i % 3 ? sys() : agent()));
  reads = 0;
  log.flush();
  log.check('a replayed log');
  A.ok(reads <= 300, 'a batch of 300 rows reads each row\'s neighbour at most once (' + reads + ')');
  for (const n of rows.slice()) log.remove(n);
  log.flush();
  A.eq(log.kids.length, 0, 'the log cleared without a throw');
}
{
  // the cost this replaces: adding a row to a long run reads and restyles only the row before it, however long the run is
  const log = new Log(markSysRuns);
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(log.insert(sys()));
  log.flush();
  const toggles = () => rows.reduce((t, n) => t + n.classList.toggles, 0);
  const before = toggles();
  reads = 0;
  rows.push(log.insert(sys()));
  log.flush();
  log.check('a long run grows by one');
  A.ok(reads <= 2, 'one more row reads two rows at most, not the run (' + reads + ')');
  A.eq(toggles() - before, 1, 'and changes exactly one class, on the row before it');
}
{
  // a text node between rows is not a row, for the :has or for this
  const log = new Log(markSysRuns);
  const a = log.insert(sys());
  log.insert(new Text());
  log.flush();
  const b = log.insert(sys()); log.flush(); log.check('a text node between lines');
  A.ok(a.classList.contains('sys-more') && !b.classList.contains('sys-more'), 'the run reads across a text node');
}
{
  // a move in one batch
  const log = new Log(markSysRuns);
  const a = log.insert(sys()), b = log.insert(agent()), c = log.insert(sys());
  log.flush();
  log.remove(c); log.insert(c, b);
  log.flush(); log.check('a row moved up in one batch');
  A.ok(a.classList.contains('sys-more') && !c.classList.contains('sys-more'), 'the move is read from the log as it stands');
}

{
  // many nodes in ONE record: every one of them is read, not only the first
  const log = new Log(markSysRuns);
  const a = log.insert(sys()); log.flush();
  const b = sys(), c = sys(), d = sys(), e = agent();
  log.insertMany([b, c, d, e]);
  log.flush(); log.check('a batch of rows in one record');
  A.ok(a.classList.contains('sys-more') && b.classList.contains('sys-more') && c.classList.contains('sys-more') && !d.classList.contains('sys-more'), 'each row of one record gets its own answer');
}

/* ---------- whoever measures the log marks first ---------- */
{
  const flush = A.fnBody(chat, 'function flushSysRuns(');
  const got = [];
  const run = new Function('sysRunWatch', 'markSysRuns', flush + '\nreturn flushSysRuns;');
  run({ takeRecords: () => [{ r: 1 }] }, r => got.push(r))();
  A.eq(got, [[{ r: 1 }]], 'the records the observer has not delivered yet are marked now');
  got.length = 0;
  run({ takeRecords: () => [] }, r => got.push(r))();
  A.eq(got, [], 'nothing waiting: nothing to mark');
  A.notThrows(() => run(null, () => {})(), 'no watch (a log that never rendered): nothing to do');
  A.ok(chat.includes('function holdCard(el) { flushSysRuns();'), 'holdCard marks before it measures');
  const reveal = A.fnBody(chat, 'function revealCard(');
  A.ok(reveal.indexOf('flushSysRuns()') >= 0 && reveal.indexOf('flushSysRuns()') < reveal.indexOf('log.scrollHeight'), 'revealCard marks before it measures');
  const revealH = A.fnBody(chat, 'function revealHistory(');
  A.ok(revealH.indexOf('flushSysRuns()') >= 0 && revealH.indexOf('flushSysRuns()') < revealH.indexOf('topInLog(target)'), 'revealHistory marks before it measures');
  const deliver = A.fnBody(chat, 'function deliverTurns(');
  A.ok(deliver.indexOf('flushSysRuns()') >= 0 && deliver.indexOf('flushSysRuns()') < deliver.indexOf('anchor.getBoundingClientRect().top - anchorTop'), 'deliverTurns marks before it restores the reader\'s place');
}

/* ---------- the watch ---------- */
const watch = A.fnBody(chat, 'function watchSysRuns(');
A.ok(watch.includes('observe(target, { childList: true })') && !/subtree/.test(watch), 'the watch is the log\'s own children: a streamed token inside a row never reaches it');
A.ok(/log = el\('chat-log'\);[^\n]*\n\s*watchSysRuns\(log\);/.test(chat), 'Chat.init watches the log');
{
  // re-init on the same log never stacks a second observer; a new log moves the one watch
  const made = [];
  class MO { constructor(fn) { this.fn = fn; this.on = null; this.off = false; made.push(this); } observe(t, o) { this.on = t; this.opts = o; } disconnect() { this.off = true; } }
  const w = new Function('MutationObserver', 'markSysRuns', 'let sysRunWatch = null, sysRunLog = null;\n' + watch + '\nreturn watchSysRuns;')(MO, () => {});
  const l1 = {}, l2 = {};
  w(l1); w(l1);
  A.eq(made.length, 1, 'a second Chat.init on the same log adds no second observer');
  w(l2);
  A.ok(made.length === 2 && made[0].off && made[1].on === l2, 'a new log moves the watch');
  w(null);
  A.eq(made.length, 2, 'no log: nothing to watch');
}

A.report('comms-system-run-end.test');
