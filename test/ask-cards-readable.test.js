/* node test/ask-cards-readable.test.js — the question / approval cards READ AT A GLANCE and stay FLUID (Andrew 2026-10-13:
   "tiny cards with tiny little letters … unorganized and long and not even summarized" / "easy to comprehend and fluid").
   A. the GROUP chat's question card + turn rows (frontend/app/group-chat.js, executed with a small DOM and a hand-fired
      900 ms poll): who asks · the question · answer keys · one hint · the reason and draft folded; the SAME card node is
      kept while the transcript streams (focus, hover and a press survive the poll); one tap answers and every key waits
      ("Sending your answer…"), a refusal frees them; pick-several keys toggle with a ✓ and follow the message box; the
      agent's suggestion is the lit ★ key; Approve once / Deny wait too; the box says whom it answers; an answer keeps its
      question ("NOVA asked: …") in the transcript.
   B. the ONE-ON-ONE choice card (chat.js clarifyRow, executed): who asks on its own line, the question at reading size,
      the reason folded, a hint that says what ★ means, the suggested answer as the lit key, the hint gone once answered.
   C. the presence line names the request in the card's words, never a raw tool id; the header never shows the pause;
      LET'S SHAPE THIS folds its reason and draft; the CSS keeps the sizes, the 5px matte card and the 45% strip.
   D. the glass layer's Pip-Boy register (pipglass.css, Andrew 10-18): every COMMS card a 2px box, a waiting card framed in
      gold until answered, one terminal key (bright phosphor, the lit one gold), the working line at 15px on a calm meter. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.events = {}; this.value = ''; this.style = { setProperty() {} }; this._cls = new Set(); const self = this; this.classList = { add: c => self._cls.add(c), remove: c => self._cls.delete(c), toggle: (c, on) => (on === undefined ? (self._cls.has(c) ? self._cls.delete(c) : self._cls.add(c)) : (on ? self._cls.add(c) : self._cls.delete(c))), contains: c => self._cls.has(c) }; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get isConnected() { return true; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; if (k === 'class') this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelectorAll(sel) { return sel === 'button' ? all(this).slice(1).filter(e => e.tagName === 'button') : []; } querySelector() { return null; }
  addEventListener(k, fn) { (this.events[k] = this.events[k] || []).push(fn); }
  fire(k, e) { if (k === 'click' && this.disabled) return; for (const fn of this.events[k] || []) fn(e || {}); if (this['on' + k]) this['on' + k](e || {}); }   // a browser never clicks a disabled button
  focus() {}
  append(...n) { for (const e of n) { const x = typeof e === 'string' ? Object.assign(new El('#text'), { textContent: e }) : e; if (x.parentElement) x.remove(); x.parentElement = this; this.children.push(x); } }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...n) { for (const c of this.children) c.parentElement = null; this.children = []; this.append(...n); }
  before(n) { this.parentElement && this.parentElement.append(n); }
  insertBefore(n, ref) { if (n.parentElement) n.remove(); const i = ref ? this.children.indexOf(ref) : -1; n.parentElement = this; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; } }
  get textContent() { return this._text != null ? this._text : this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
}
const settle = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const all = e => [e, ...e.children.flatMap(all)];
const byClass = (root, c) => all(root).filter(e => e._cls && e._cls.has(c));

(async () => {
  /* ---- A. the group chat ---- */
  const Q = { id: 'q1', state: 'pending', agentId: 'agent', mode: 'choice', multiSelect: false, turnId: '', question: 'What should the conveyor deliver first?', options: ['Validate', 'Prototype', 'Fulfill'], recommended: 'Prototype', ordinal: 1, total: 2, reason: 'These need different gates.', sample: 'One GO / TEST / NO-GO brief per job.' };
  const M = { id: 'q2', state: 'pending', agentId: 'agent', mode: 'choice', multiSelect: true, turnId: '', question: 'Which sources?', options: ['Reddit', 'Pricing pages', 'Reviews'], reason: '', sample: '' };
  let tick = 0, answerReply = null, posts = [], questions = [Q, M], approval = true, messages = [];
  const group = () => ({ id: 'g1', title: 'War room', members: ['agent', 'nova'], leadId: 'agent', revision: 3 + tick, paused: false, messages: messages.slice(), artifacts: [],
    turns: [{ id: 't-run', agentId: 'nova', state: 'running', draft: 'drafting… ' + tick }].concat(approval ? [{ id: 't-ok', agentId: 'nova', state: 'waiting for approval', approval: { promptId: 'p1', tool: 'fs.write', argsSummary: '{"path":"brief.md"}' } }] : []),
    questions: questions.slice() });
  const body = new El('body'), head = new El('head');
  for (const id of ['comms-idbar', 'chat-input', 'chat-log', 'chat-queued', 'chat-inputrow']) { const e = new El('div'); e.id = id; body.append(e); }
  let pollFn = null;
  const ws = { id: 'g1', agentId: 'agent', title: 'War room', conversationMode: 'group', history: [] };
  const ctx = vm.createContext({
    document: { body, head, createElement: t => new El(t), createTextNode: t => Object.assign(new El('#text'), { textContent: t }), getElementById: id => all(body).find(e => e.id === id) },
    console, crypto: { randomUUID: () => 'u' }, clearTimeout() {}, setTimeout: fn => { pollFn = fn; return 1; }, queueMicrotask,
    fetch: async (url, init) => {
      const b = init && init.body ? JSON.parse(init.body) : null;
      if (b) { posts.push(b); const r = await (answerReply || Promise.resolve({ ok: true })); if (!r.ok) return { status: 409, ok: false, json: async () => ({ ok: false, error: r.error }) }; if (b.op === 'answerQuestion') { questions = questions.map(q => (q.id === b.questionId ? Object.assign({}, q, { state: 'answered' }) : q)); messages.push({ id: 'm' + messages.length, seq: messages.length + 1, author: 'user', content: b.text, at: 1, questionId: b.questionId }); } if (b.op === 'answer') approval = false; }
      if (!/\?id=/.test(String(url)) && !b) return { status: 200, ok: true, json: async () => ({ ok: true, result: { roster: [{ id: 'agent', name: 'NOVA' }, { id: 'nova', name: 'MIRA' }], groups: [group()] } }) };
      return { status: 200, ok: true, json: async () => ({ ok: true, result: group() }) };
    },
    Chat: { consentPhrase: p => 'change ' + JSON.parse(p.argsSummary).path, consentInspect: () => null, clockLabel: () => '', breakLabel: () => '' },
    App: { pushRoster: async () => {}, agents: () => [{ id: 'agent', name: 'NOVA' }, { id: 'nova', name: 'MIRA' }], persist() {}, refreshRail() {}, openWorkstream() {} },
    StationUI: { notify() {}, toggleTerm() {}, closeTerm() {} },
    Workstreams: { get: id => (id === 'g1' ? ws : null), list: () => [ws], activeId: () => 'g1', adopt: o => Object.assign(ws, o), generalId: () => 'home' }
  });
  vm.runInContext(read('frontend/app/group-chat.js') + '\nglobalThis.GroupChat = GroupChat;', ctx);
  ctx.GroupChat.bind(ws); await settle();
  const noticeEl = ctx.document.getElementById('gc-notice'); if (noticeEl && noticeEl.textContent) console.error('NOTICE: ' + noticeEl.textContent);
  const strip = () => ctx.document.getElementById('gc-questions');
  const cards = () => byClass(strip(), 'gc-question');
  A.eq(cards().length, 2, 'both pending questions show');
  const card = cards()[0];
  A.eq(byClass(card, 'gc-q-who')[0].textContent, 'NOVA asks (1 of 2) · 2 more waiting below', 'who asks, its place in the batch, and what else waits below (a question + an approval), on its own line');
  A.eq(byClass(card, 'gc-q-text')[0].textContent, Q.question, 'the question, whole');
  A.eq(byClass(card, 'gc-q-choice').map(k => k.textContent + (k._cls.has('lit') ? '[lit]' : '')).join('|'), 'Validate|★ Prototype[lit]|Fulfill', 'the answers are keys; the agent\'s suggestion is the lit ★ key');
  A.eq(byClass(card, 'gc-q-hint')[0].textContent, 'Tap an answer, or type your own below. ★ is NOVA\'s suggestion.', 'one plain line on how to answer, and what ★ means');
  A.eq(card.children.map(c => c.className.split(' ')[0]).join(' '), 'gc-q-who gc-q-text gc-q-whole gc-question-choices gc-q-hint gc-q-folds', 'reading order: who · question · (whole question) · answers · hint · folds');
  A.eq(byClass(card, 'gc-q-whole')[0].getAttribute('hidden'), null, 'a question that cannot be measured yet (no layout) keeps its "whole question" key — never clamped without one');
  A.eq(ctx.document.getElementById('chat-input').placeholder, 'Answer NOVA · @name messages someone else', 'the message box says whom it answers while a question waits');
  const folds = byClass(card, 'gc-q-more');
  A.eq(folds.map(f => f.children[0].textContent).join('|'), 'Why NOVA is asking|See the draft NOVA suggests', 'the reason and the draft are folded under labelled lines (kept, never removed)');
  A.ok(!folds.some(f => f.open), 'folds start closed');
  // the poll fires while MIRA streams: the transcript changes, the question does not — the SAME card is kept
  const keyNode = byClass(card, 'gc-q-choice')[1];
  tick++; await pollFn(); await settle();
  tick++; await pollFn(); await settle();
  A.ok(cards()[0] === card && byClass(cards()[0], 'gc-q-choice')[1] === keyNode, 'the card and its keys are the same nodes across polls (focus, hover and a press survive)');
  const rowsBefore = byClass(ctx.document.getElementById('gc-states'), 'gc-state').find(r => /Approve once/.test(r.textContent));
  tick++; await pollFn(); await settle();
  A.ok(byClass(ctx.document.getElementById('gc-states'), 'gc-state').find(r => /Approve once/.test(r.textContent)) === rowsBefore, 'the approval row is kept too');
  A.ok(/^●NOVA|MIRAwants to change brief\.md/.test(rowsBefore.textContent) && byClass(rowsBefore, 'gc-asks')[0].textContent === 'wants to change brief.md', 'the approval reads like the desk card: "MIRA wants to change brief.md"');
  A.ok(byClass(rowsBefore, 'gc-ok-row').length === 1 && !byClass(rowsBefore, 'gc-inspect').length, 'its keys sit on their own row under it; no INSPECT where the desk card has none');
  // one tap answers: every key waits and the hint says so; a refusal frees them and restores the hint
  let refuse; answerReply = new Promise(r => { refuse = r; });
  byClass(card, 'gc-q-choice')[0].fire('click'); await settle();
  A.ok(byClass(card, 'gc-q-choice').every(k => k.disabled) && byClass(card, 'gc-q-choice')[0]._cls.has('chosen'), 'one tap: every key waits, the chosen one is marked');
  A.eq(byClass(card, 'gc-q-hint')[0].textContent, 'Sending your answer…', 'the hint says it is on its way');
  byClass(card, 'gc-q-choice')[1].fire('click'); await settle();
  refuse({ ok: false, error: 'offline' }); await settle();
  A.eq(posts.filter(p => p.op === 'answerQuestion').length, 1, 'a second tap while it was on its way sent nothing');
  A.ok(byClass(card, 'gc-q-choice').every(k => !k.disabled) && !byClass(card, 'gc-q-choice')[0]._cls.has('chosen'), 'a refused answer frees the keys');
  A.eq(byClass(card, 'gc-q-hint')[0].textContent, 'Tap an answer, or type your own below. ★ is NOVA\'s suggestion.', '…and restores the hint');
  answerReply = null;
  byClass(card, 'gc-q-choice')[0].fire('click'); await settle();
  A.ok(posts.filter(p => p.op === 'answerQuestion').map(p => p.text).join() === 'Validate,Validate', 'the retry answers once more');
  A.ok(!cards().includes(card), 'an answered question leaves the strip');
  const answerRow = byClass(body, 'gc-message').find(r => r.attrs['data-message-id'] === 'm0');
  A.ok(answerRow && byClass(answerRow, 'gc-asked')[0] && byClass(answerRow, 'gc-asked')[0].textContent === 'NOVA asked: ' + Q.question, 'the answer keeps its question in the transcript');
  // pick several: each tap toggles, marked with ✓ and aria-pressed, mirrored in the message box
  const many = cards()[0], keys = byClass(many, 'gc-q-choice'), box = ctx.document.getElementById('chat-input');
  box.value = '';
  keys[0].fire('click'); await settle(); keys[2].fire('click'); await settle();
  A.eq(keys.map(k => k.getAttribute('aria-pressed') + ':' + k.textContent).join('|'), 'true:✓ Reddit|false:Pricing pages|true:✓ Reviews', 'picked keys read as ON (a ✓, not only a shade)');
  A.eq(box.value, 'Reddit; Reviews', 'the picks are in the message box');
  keys[0].fire('click'); await settle();
  A.eq(keys[0].getAttribute('aria-pressed') + ':' + keys[0].textContent + ':' + box.value, 'false:Reddit:Reviews', 'a second tap un-picks');
  tick++; await pollFn(); await settle();
  A.eq(keys.map(k => k.getAttribute('aria-pressed')).join(), 'false,false,true', 'a poll keeps the picks as they are');
  box.value = 'Reviews; Pricing pages'; box.fire('input'); await settle();
  A.eq(keys.map(k => k.getAttribute('aria-pressed')).join(), 'false,true,true', 'the keys follow what is in the message box (it is the truth)');
  box.value = ''; box.fire('input'); await settle();
  // Approve once / Deny: the words every approval uses, the lit key first, and both wait while the answer is on its way
  let allow; answerReply = new Promise(r => { allow = r; });
  const row = byClass(ctx.document.getElementById('gc-states'), 'gc-state').find(r => /Approve once/.test(r.textContent));
  const ak = byClass(row, 'gc-ok');
  A.eq(ak.map(k => k.textContent + (k._cls.has('lit') ? '[lit]' : '') + (k._cls.has('deny') ? '[deny]' : '')).join('|'), 'Approve once[lit]|Deny[deny]', 'the approval keys');
  ak[0].fire('click'); await settle();
  A.ok(ak.every(k => k.disabled) && ak[0].textContent === 'Sending…', 'Approve once / Deny both wait, and the pressed key says what it is doing');
  allow({ ok: true }); await settle();
  A.eq(posts.filter(p => p.op === 'answer').length, 1, 'one answer sent');

  /* ---- B. the one-on-one choice card ---- */
  const chat = read('frontend/app/chat.js');
  const part = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('slice ' + a); return s.slice(i, j); };
  let clarifyReply = null;
  function clarify(q) {
    const rows = [];
    const c = vm.createContext({ Channels: { runIdOf: () => 'r1', clearPending() {} }, JSON, Date, name: 'NOVA', input: null, settlePromptNotice() {}, askerName: () => 'NOVA',
      document: { createElement: t => new El(t), createTextNode: t => Object.assign(new El('#text'), { textContent: t }) },
      row: () => { const r = { d: new El('div'), body: new El('div') }; rows.push(r); return r; },
      Harness: { consentAnswer: () => (clarifyReply || Promise.resolve({ ok: true })) }, TaskConversation: null,
      U: { bus: { emit() {}, on() {}, off() {} } }, isActiveWs: () => false, renderPresence() {}, syncStatus() {}, status() {}, autoscroll() {}, revealCard() {}, releaseCard() {}, keepFocus() {}, fitWhole() {}, announcedPrompt: () => true, StationUI: { notify() {} }, askAnswerers: new Map(), glance: (t) => String(t) });
    vm.runInContext(part(chat, '  function settledWhere(resp)', '  async function answerConsent(') + part(chat, '  function clarifyRow(', '  // p = a consent payload'), c);
    c.clarifyRow({ promptId: 'p9', tool: 'brief.ask', argsSummary: JSON.stringify(q) }, { id: 'w1', agentId: 'agent' });
    return rows[0];
  }
  const r1 = clarify({ question: 'Which plan leads?', options: ['Starter', 'Pro'], recommended: 'Pro', reason: 'It decides the layout.' });
  const kids = r1.body.children;
  A.eq(kids.map(k => k.className.split(' ')[0]).join(' '), 'cq-who cq-text cq-whole consent-btns cq-hint cq-why', 'reading order: who · question · (whole question) · answers · hint · the reason folded');
  A.eq(kids[0]._cls.has('cq-who') && kids[0].textContent, 'NOVA asks', 'who asks, on its own line');
  A.eq(kids[1]._cls.has('cq-text') && kids[1].textContent, 'Which plan leads?', 'the question, on its own');
  const why = kids.find(k => k._cls.has('cq-why'));
  A.ok(why && why.tagName === 'details' && why.children[0].textContent === 'Why NOVA is asking' && why.children[1].textContent === 'It decides the layout.', 'the reason is folded under a labelled line, kept whole');
  const hint = kids.find(k => k._cls.has('cq-hint'));
  A.eq(hint && hint.textContent, 'Tap an answer. ★ is NOVA\'s suggestion.', 'the hint says what ★ means');
  const btns = kids.find(k => k._cls.has('consent-btns'));
  A.eq(btns.children.map(b => b.textContent + (b._cls.has('primary') ? '[lit]' : '') + (b._cls.has('quiet') ? '[quiet]' : '')).join('|'), 'Starter|★ Pro[lit]|Use your judgment[quiet]', 'the suggested answer is the lit key; "Use your judgment" is quiet');
  let confirm; clarifyReply = new Promise(r => { confirm = r; });
  const sent = btns.children[1].onclick(); await settle();
  A.ok(btns.children.every(b => b.disabled) && btns.children[1]._cls.has('sel') && hint.textContent === 'Sending your answer…', 'one tap: every key waits, the pressed one stays lit, the hint says it is on its way');
  confirm({ ok: true }); await sent; await settle(); clarifyReply = null;
  A.ok(!r1.body.children.includes(hint) && !r1.body.children.includes(btns) && /✓ Pro/.test(r1.body.textContent), 'answered: the keys and the hint go, the answer stays');
  A.eq(r1.body.children.map(k => k.className.split(' ')[0]).join(' '), 'cq-who cq-text cq-whole consent-result cq-why', 'the answer sits right under the question, the reason still folded under it');
  const r2 = clarify({ question: 'Which?', options: ['A', 'B'], reason: 'x', grounded: { options: ['B'], count: 3 } });
  A.eq(r2.body.children.find(k => k._cls.has('cq-hint')).textContent, 'Tap an answer. ★ is your usual pick (chosen 3 times before).', 'a grounded ★ states its real count in the one hint line, in the same sentence shape as the group card');
  A.ok(r2.body.children.some(k => k._cls.has('cq-why')), 'the reason stays one tap away when the ★ is grounded too');
  A.ok(!r2.body.children.some(k => k._cls.has('tq-reason')), 'no second suggestion line');
  // a card follows the bottom unless that cuts its top off; then it shows from its top until it is answered
  {
    const pills = [];
    // a 300px-tall log over 1000px of rows: like a browser, scrollTop clamps to 0..700
    let top = 0;
    const inLog = new Set();
    const log = { scrollHeight: 1000, clientHeight: 300, offsetHeight: 300, get scrollTop() { return top; }, set scrollTop(v) { top = Math.max(0, Math.min(700, v)); }, getBoundingClientRect: () => ({ top: 100, height: 300 }), contains: el => inLog.has(el) };
    const card = (at, h = 100) => { const c = { offsetHeight: h, dataset: { liveAsk: '1' }, focused: 0, focus() { this.focused++; }, getBoundingClientRect: () => ({ top: 100 + at - log.scrollTop }) }; inLog.add(c); return c; };
    // flushSysRuns (chat.js) marks SYSTEM rows before a measure; this slice has no rows to mark
    const rc = vm.createContext({ log, stick: true, noteAskLanding() {}, flushSysRuns() {}, autoscroll() { if (rc.read().stick) log.scrollTop = log.scrollHeight; else pills.push('new'); }, showNewPill: v => pills.push('show'), hideNewPill: () => pills.push('hide'), document: {} });
    vm.runInContext(part(chat, '  let heldCard = null, heldScrollTop = 0;', '  function jumpToBottom()').replace(/let heldCard/, 'var heldCard') + '\nthis.read = () => ({ stick, heldCard, heldQueue });', rc);
    const tall = card(600); rc.revealCard(tall);   // at the bottom (700) its top would sit 100px above the edge
    A.ok(log.scrollTop === 592 && tall.getBoundingClientRect().top === 108 && rc.read().stick === false && !pills.includes('show'), 'a card whose top the bottom-follow would cut shows from its top (8px under the edge), the follow waits, no pill over it');
    rc.releaseCard(tall);
    A.ok(rc.read().stick === true && log.scrollTop === 700 && rc.read().heldCard === null, 'answered: the transcript follows the run again');
    const short = card(850); log.scrollTop = 0; rc.revealCard(short);
    A.ok(log.scrollTop === 700 && rc.read().stick === true && rc.read().heldCard === null, 'a card that fits under the bottom-follow just follows');
    rc.releaseCard(short);
    const snug = card(760, 240); log.scrollTop = 0; rc.revealCard(snug);   // fits now, but not once the presence line lands under it
    A.ok(log.scrollTop === 700 && snug.getBoundingClientRect().top === 160 && rc.read().stick === false && rc.read().heldCard === snug, 'a card that would lose its top once the presence line lands is held (the follow waits), its top in view');
    // a second card waits its turn: no jump, no focus — and is shown from its top once the first is answered
    const second = card(300, 250); const r2nd = rc.revealCard(second);
    A.ok(r2nd === 'queued' && rc.read().heldCard === snug && log.scrollTop === 700 && second.focused === 0, 'a second card behind a held one waits its turn (no jump, no focus)');
    rc.releaseCard(snug);
    A.ok(rc.read().heldCard === second && second.getBoundingClientRect().top === 108 && second.focused === 1 && !snug.dataset.liveAsk, 'the first answered: the second shows from its top and only now takes the keyboard');
    // the reader scrolled away from the held card: answering it never yanks them
    log.scrollTop = 200; rc.releaseCard(second);
    A.ok(log.scrollTop === 200 && rc.read().heldCard === null, 'a reader who scrolled away is left where they are');
    // a card from ANOTHER session (no longer in this log) settles without moving the transcript being read
    const other = card(600); rc.read(); log.scrollTop = 0; rc.stick = true; vm.runInContext('stick = true', rc); rc.revealCard(other); inLog.delete(other); log.scrollTop = 300; rc.releaseCard(other);
    A.ok(log.scrollTop === 300 && rc.read().heldCard === null, 'answering a card of another session never moves the one on screen');
    // COMMS without layout (behind CREW / ACTIVITY): nothing is held
    const flat = Object.assign({}, log); vm.runInContext('stick = true', rc); log.clientHeight = 0; const tiny = card(900, 40); rc.revealCard(tiny); log.clientHeight = 300;
    A.ok(rc.read().heldCard === null && rc.read().stick === true, 'a log with no layout holds nothing (it just follows)');
    // TEXT SIZE (body zoom 1.25): rect offsets are visual px, scrollTop is layout px
    log.getBoundingClientRect = () => ({ top: 100, height: 375 }); vm.runInContext('stick = true', rc); log.scrollTop = 0;
    const zoomed = { offsetHeight: 260, dataset: { liveAsk: '1' }, focus() {}, getBoundingClientRect: () => ({ top: 100 + (600 - log.scrollTop) * 1.25 }) }; inLog.add(zoomed);
    rc.revealCard(zoomed);
    A.ok(log.scrollTop === 592, 'under a 125% TEXT SIZE the card is still placed 8 layout px under the edge (no overshoot)');
    void flat;
  }
  // group pick-several: an option containing ";" is one pick, free text in the box survives a toggle
  {
    const g = vm.createContext({}); vm.runInContext(part(read('frontend/app/group-chat.js'), '  function pickItems(', '  // a pick-several key shows'), g);
    const O = ['Reddit', 'Reddit; HN', 'Reviews'];
    A.eq([...g.pickedIn('Reddit; HN', O)].join('|'), 'Reddit; HN', 'an option with ";" is one pick and never lights a shorter one inside it');
    A.eq(g.togglePick('Reddit; also check X', 'Reviews', O), 'Reddit; also check X; Reviews', 'a toggle keeps what the Commander typed');
    A.eq(g.togglePick('Reddit; HN; Reddit', 'Reddit', O), 'Reddit; HN', 'un-picking removes exactly that pick');
  }
  const statusEl = new El('span'), sc = vm.createContext({ statusEl, String });
  vm.runInContext(part(chat, '  function status(s) {', '  // derive the DISPLAYED stream'), sc);
  for (const st of ['awaiting your answer…', 'awaiting your context…', 'awaiting your approval…']) { sc.status(st); A.ok(statusEl._cls.has('status-approval'), st + ': hidden in the COMMS header (the card and the presence line say it)'); }

  /* ---- C. the presence line + LET'S SHAPE THIS ---- */
  A.ok(/pend\.tool === 'brief\.ask' \? 'see the question above' : 'to ' \+ glance\(actionPhrase\(pend\), 70\)/.test(chat) && !/waiting for you to approve ' \+ shortName/.test(chat), 'the paused line names the request in the card\'s words, never a raw tool id');
  const tc = read('frontend/app/taskconversation.js');
  A.ok(/fold\('tc-why',q\.asker \? 'Why '\+q\.asker\+' is asking'/.test(tc) && /fold\('tc-draft',q\.asker \? 'See the draft '\+q\.asker\+' suggests'/.test(tc), 'LET\'S SHAPE THIS folds its reason and its draft, named like every other card');
  A.ok(/:is\(\.cmsg\.nudge, \.cmsg\.consent\) \.task-conversation \{/.test(read('frontend/css/comms-layout.css')), 'the conversation card is ONE frame inside the decision card, never a card inside a card');
  const css = read('frontend/app/group-chat.js');
  A.ok(/\.gc-question \.gc-q-text\{[^}]*font-size:var\(--sn-type-prose,18px\)/.test(css) && /\.gc-question \.gc-q-choice\{min-height:36px/.test(css), 'group card: the question at reading size, the answers 36px keys');
  A.ok(/\.gc-state \.gc-ok\{min-width:8em;min-height:36px;[^}]*font-size:var\(--sn-type-control,16px\)/.test(css), 'group approval keys are 16px / 36px (were 11px / 20px) and keep their width while sending');
  A.ok(!/gc-badge/.test(css) && !/'GROUP'/.test(css), 'the group header names its members with no GROUP word in front (no-shrunken-chips law 10-13, walk 10-14 #18)');
  A.ok(/\.gc-people\{[^}]*max-height:18px;overflow:hidden/.test(css), 'the member names sit on ONE line (OPTIMUS no longer drops alone to a second); the rest fold into +N');
  A.ok(/\.gc-more\{[^}]*font-size:var\(--sn-type-control,16px\)/.test(css), 'the +N reads at the size of the names, never a smaller chip');
  A.ok(/\.gc-tray-scroll\.more-below\{[^}]*mask-image/.test(css), 'the strip fades at its edge instead of slicing a line');
  A.ok(/\.gc-question\{[^}]*border-radius:5px;background:var\(--cg-card/.test(css) && /\.gc-question \.gc-q-choice\{[^}]*border-radius:5px/.test(css), 'the group card is the 5px matte decision card (Andrew 10-02)');
  A.ok(/\.gc-question \.gc-q-text\{[^}]*-webkit-line-clamp:3/.test(css), 'a long question shows three lines (the whole of it one tap away)');
  A.ok(/#gc-tray\{flex:0 1 auto;min-height:0;max-height:45%;/.test(css) && /#gc-tray:has\(#gc-questions \.gc-question\)\{max-height:max\(45%,calc\(100% - 170px\)\)\}/.test(css) && !/max-height:80%/.test(css),
    'the strip is 45% (Andrew 10-10); only while a question waits may it grow to fit it, and the conversation always keeps 170px');
  A.ok(/#gc-states \.gc-state \.gc-approval:not\(\.gc-inspect\)\{font-size:var\(--sn-type-control,16px\)!important/.test(css), 'the approval line reads at 16px over the meta-size rule');
  const beat = read('frontend/css/beat-cards.css');
  A.ok(/\[data-clarify-prompt\] \.cq-text \{[^}]*font-size: var\(--sn-type-prose\)[^}]*-webkit-line-clamp: 3/.test(beat), 'one-on-one card: the question at reading size, three lines');
  A.ok(/body #chat-panel \{ font-variant-ligatures: none; \}/.test(beat), 'no broken fi ligature ("frst") in COMMS');
  A.ok(!/\.consent-btn\.danger \{[^}]*border-color/.test(beat), 'Full access never wears the suggested key\'s gold edge');
  /* ---- D. the Pip-Boy card register (Andrew 10-18: "audit and polish the COMMS cards … in the same way") ---- */
  const pip = read('frontend/css/pipglass.css');
  const pipCards = pip.slice(pip.indexOf('PIP-BOY COMMS CARDS'));
  A.ok(pip.indexOf('PIP-BOY COMMS CARDS') > 0, 'pipglass.css carries the COMMS cards section');
  A.ok(/:is\(\.cmsg\.turnin, \.cmsg\.nudge, \.cmsg\.consent, #chat-log > \.dg-line, #gc-questions \.gc-question, #gc-states \.gc-state\) \{ border-radius: 2px; \}/.test(pipCards),
    'every COMMS card is the 2px box (were 5px decision cards, a 10px DELEGATED card, a 4px working line in one transcript)');
  A.ok(/\.cmsg\.consent\[data-live-ask\] \{\s*border-color: rgba\(var\(--gold-rgb\), \.45\);/.test(pipCards) && /function releaseCard\(el\) \{\s*if \(!el\) return;\s*if \(el\.dataset\) delete el\.dataset\.liveAsk;/.test(chat),
    'a card that waits on you is framed in gold all round (a 2px left edge drew one device pixel at TEXT SIZE 90), and the frame leaves with the answer');
  A.ok(/text-transform: uppercase;\s*color: var\(--ph-bright\); border: 1px solid rgba\(var\(--ph-rgb\), \.4\);/.test(pipCards),
    'a plain key reads in the BRIGHT phosphor: in a red theme the phosphor is the fault colour\'s twin and ALWAYS read as a second DENY');
  A.ok(/\.consent-btn:not\(\.thumb\):is\(\.primary, \.ws-openit, \.ws-primary, \.consent-confirm\),[\s\S]{0,400}\{\s*color: var\(--gold\); border-color: rgba\(var\(--gold-rgb\), \.75\);/.test(pipCards), 'the lit key is the NEEDS YOU key\'s gold');
  A.ok(!/\.cmsg\.consent(?:, \.dg-inspect)?\) \.consent-btn(?!:not\(\.thumb\))/.test(pipCards),
    'the RATE row\'s thumbs (a turn-in\'s .consent-btn.thumb.primary) keep their own slim look: no card key rule reaches them');
  A.ok(/\.tc-shortcut\[aria-pressed=true\],\s*body[^{]*\.gc-q-choice:is\(\[aria-pressed=true\], \.chosen\) \{\s*color: var\(--ph-bright\); border-color: var\(--ph\);/.test(pipCards),
    'a picked answer stays visibly pressed over the card key');
  A.ok(/#comms-presence:not\(\.resolved\) \.cp-dot,[\s\S]{0,200}font-size: 0; color: transparent; text-shadow: none; animation: none;/.test(pipCards) && /@keyframes pip-meter-cp /.test(pipCards),
    'the working line drops the blinking block caret for the CREW rail\'s calm meter');
  A.ok(/#comms-presence:not\(\.resolved\) :is\(\.cp-verb, \.cp-tool, \.cp-time\) \{ font-size: var\(--sn-type-meta\);/.test(pipCards), 'the working line reads at the floor, 16px (its tool name and time were 12px and dim, then 15)');
  A.ok(/#comms-presence\.paused:not\(\.resolved\) \.cp-dot::after,[\s\S]{0,140}\{ content: none; \}/.test(pipCards), 'a run waiting on you shows one steady lamp, no meter (the CREW rail hides its meter then too)');
  A.report('ask-cards-readable.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
