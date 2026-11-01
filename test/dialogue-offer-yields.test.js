/* node test/dialogue-offer-yields.test.js — a mid-game OFFER panel never stands over what needs the Commander (soak 2026-10-15).

   The overnight soak (night-1015, user station) caught the goal-path confirm — "i think i see the path to that goal… / 1. confirm
   the path / 2. not now" — opened over COMMS mid-conversation:
   (a) a team.dispatch approval landed UNDER it: the Approve once key's hit-test landed on .fnv-line, so 19 approve clicks did
       nothing, and Esc did not close it;
   (b) in a NEW conversation the same panel (inset:0 over #chat-panel) sat over the message box: the click at the box's centre
       landed on .fnv-opts ("fnv-dialogue show fnv-wait (fully)" while it was still narrating).
   The law, executed here with a small DOM (dialogue.js and chat.js's offerArc run for real):
   A. an offer panel (Dialogue.open({ offer })) ends ABOVE the message box and the queued-message pills, refits when they grow,
      and honours the TEXT SIZE body zoom (rects are visual px, its own style px are layout px); the awakening / tour panels
      (no offer) still own the whole of COMMS, exactly as before (the first-task hand-off is an offer since gh#158 — see
      test/first-task-handoff-yields.test.js; who yields to what is test/comms-owner-rules.test.js);
   B. Esc answers an offer the way its own "not now" key does — never from a station field, never an Esc the message box used
      (stop a run, close the / menu), never an Esc inside another surface; a panel with no offer keeps Esc off (the awakening);
   C. Dialogue.stepAside(why) hands the moment back to the offer's caller and is a no-op otherwise;
   D. the goal-path panel: an approval/question landing steps it aside unanswered (asked-for or not), the Commander's own turn
      too, Esc is a real NOT NOW (a decline, like its key), and it is never offered while an ask waits;
   E. chat.js calls the step-aside wherever an ask reaches the Commander and where the Commander's own turn begins. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const dialogueSrc = read('frontend/app/dialogue.js');
const chat = read('frontend/app/chat.js');

/* ---------- a small DOM: boxes are set by hand (visual px), offsetHeight/clientHeight are layout px ---------- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null; this.style = {}; this.attrs = {}; this.dataset = {}; this.listeners = {}; this._cls = new Set(); this._text = ''; this.box = null; this.offsetHeight = 0; this.clientHeight = 0; this.clientTop = 0; const self = this;
    this.classList = { add: (...c) => c.forEach(x => self._cls.add(x)), remove: (...c) => c.forEach(x => self._cls.delete(x)), contains: c => self._cls.has(c), toggle: (c, on) => { const v = on === undefined ? !self._cls.has(c) : !!on; if (v) self._cls.add(c); else self._cls.delete(c); return v; } }; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); } set textContent(v) { this.innerHTML = ''; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); return n; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter(f => f !== fn); }
  getBoundingClientRect() { const b = this.box || { top: 0, height: 0 }; return { top: b.top, bottom: b.top + b.height, height: b.height, left: 0, right: 360, width: 360 }; }
  focus() {}
}
const all = e => [e, ...e.children.flatMap(all)];
function station(opts) {
  opts = opts || {};
  const k = opts.zoom || 1;   // TEXT SIZE: a body zoom — every visual box is k × its layout size
  const body = new El('body'), html = new El('html');
  const host = new El('aside'); host.id = 'chat-panel';
  host.box = { top: 0, height: 800 }; host.offsetHeight = 800 / k; host.clientHeight = 800 / k;
  const logEl = new El('div'); logEl.id = 'chat-log'; logEl.box = { top: 120, height: 470 };
  const queued = new El('div'); queued.id = 'chat-queued'; queued.box = { top: 640, height: 0 };   // empty: no pills
  const row = new El('div'); row.id = 'chat-inputrow'; row.box = { top: 640, height: 160 };
  const input = new El('textarea'); input.id = 'chat-input'; input.box = { top: 660, height: 60 };
  row.appendChild(input);
  for (const n of [logEl, queued, row]) host.appendChild(n);
  body.appendChild(host);
  const elsewhere = new El('input'); elsewhere.id = 'station-search'; body.appendChild(elsewhere);   // a field in another surface
  const menuKey = new El('button'); menuKey.id = 'dock-menu-key'; body.appendChild(menuKey);         // a key in another surface
  const winKeys = [], docKeys = [];   // a keydown bubbles through document (its listeners first), then window
  const observers = [];
  class RO { constructor(fn) { this.fn = fn; this.targets = []; this.live = true; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.live = false; } }
  const ctx = vm.createContext({
    console, Promise, setTimeout, clearTimeout,
    document: { body, documentElement: html, createElement: t => new El(t), getElementById: id => all(body).find(e => e.id === id) || null, dispatchEvent() {},
      addEventListener: (k2, fn) => { if (k2 === 'keydown') docKeys.push(fn); } },
    window: { addEventListener: (k2, fn) => { if (k2 === 'keydown') winKeys.push(fn); }, removeEventListener: (k2, fn) => { if (k2 === 'keydown') { const i = winKeys.indexOf(fn); if (i >= 0) winKeys.splice(i, 1); } } },
    CustomEvent: function CustomEvent(t) { this.type = t; },
    matchMedia: () => ({ matches: true }),   // reduced motion: a beat types out at once
    ResizeObserver: opts.noRO ? undefined : RO
  });
  vm.runInContext(dialogueSrc + '\nthis.Dialogue = Dialogue;', ctx);
  const key = (name, target, pre) => {
    const ev = { key: name, target: target || body, defaultPrevented: !!pre, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of docKeys.slice()) fn(ev);
    for (const fn of winKeys.slice()) fn(ev);
    return ev;
  };
  const panel = () => all(host).find(e => e._cls.has('fnv-dialogue')) || null;
  // what a click at a point lands on: the panel when the point is inside its box (visual px), else what is under it
  const covers = y => { const p = panel(); if (!p) return false; const top = parseFloat(p.style.top || '0') * k, bottom = 800 - parseFloat(p.style.bottom || '0') * k; return y >= top && y < bottom; };
  const inputCentre = () => input.box.top + input.box.height / 2;
  return { ctx, D: ctx.Dialogue, host, logEl, input, queued, row, elsewhere, menuKey, body, key, panel, covers, inputCentre, observers, docKeys };
}
const step = (D, why) => (typeof D.stepAside === 'function' ? D.stepAside(why) : 'stepAside missing');
/* the REAL one-line document Esc owners of the composer row (the model dock, Local Live, hands-free voice), lifted out of their
   files and run against a state object: `document.addEventListener('keydown', <this handler>)` on the line naming `marker`. */
function docEscOwner(file, marker, state) {
  const head = "document.addEventListener('keydown', ";
  const line = read(file).split('\n').find(l => l.includes(head) && l.includes("'Escape'") && l.includes(marker));
  if (!line) return null;
  const from = line.indexOf(head) + head.length;
  let depth = 0, end = -1;
  for (let n = from; n < line.length && end < 0; n++) {
    const c = line[n];
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) { if (depth === 0) end = n; else depth--; }
  }
  return end > from ? vm.runInContext('(' + line.slice(from, end) + ')', vm.createContext(state)) : null;
}
const settle = async () => { for (let n = 0; n < 40; n++) await new Promise(r => setImmediate(r)); };

(async () => {
  /* ---------- A. an offer ends above the message box ---------- */
  {
    const s = station();
    A.ok(typeof s.D.stepAside === 'function', 'Dialogue.stepAside is exported (an offer can be handed back)');
    s.D.open({ name: 'NOVA', offer: { notNow() {}, stepAside() {} } });
    void s.D.say('i think i see the path to that goal — here’s how i’d break it down. does this look right?');
    A.ok(s.panel() && s.panel().classList.contains('fnv-offer'), 'an offer panel is marked as an offer');
    A.ok(!s.covers(s.inputCentre()), 'the message box is NOT under an offer panel (a click at its centre reaches it) — soak: "fnv-dialogue show fnv-wait (fully)"');
    A.eq(s.panel().style.bottom, '160px', 'the panel ends exactly at the composer stack top (800 − 640)');
    A.ok(s.covers(300), 'the panel still covers the transcript above it');
    // the composer grows (a long draft): the observer refits the panel above it
    s.row.box = { top: 600, height: 200 }; s.input.box = { top: 620, height: 140 };
    for (const o of s.observers) if (o.live) o.fn([]);
    A.eq(s.panel().style.bottom, '200px', 'a grown message box pushes the panel up (refit on resize)');
    A.ok(!s.covers(s.inputCentre()), 'and it is still uncovered');
    // queued-message pills (SEND NOW) sit above the box: they are live keys too
    s.queued.box = { top: 550, height: 50 };
    for (const o of s.observers) if (o.live) o.fn([]);
    A.eq(s.panel().style.bottom, '250px', 'queued-message pills stay uncovered too (the panel ends above them)');
    // a group chat's @ menu sits in the flow above the box: it is part of the composer stack
    const at = new El('div'); at.id = 'gc-mentions'; at.box = { top: 500, height: 50 }; s.host.children.splice(s.host.children.indexOf(s.row), 0, at); at.parentNode = s.host;
    for (const o of s.observers) if (o.live) o.fn([]);
    A.eq(s.panel().style.bottom, '300px', 'the @ menu above the message box stays uncovered too');
    A.ok(s.host.classList.contains('fnv-offer-host'), 'COMMS is marked while an offer is up (app.css lifts the message box over the panel)');
    s.D.close();
    A.ok(s.observers.length > 0 && s.observers.every(o => !o.live), 'closing the panel disconnects its layout watcher');
    A.ok(!s.host.classList.contains('fnv-offer-host'), 'and COMMS is unmarked');
  }
  {
    // the message box rides above an offer panel, so what opens UPWARD from it (the / menu z30, the model dock z80 — both
    // inside the box's own stacking context, z4) is never drawn under the panel (z30)
    const css = read('frontend/css/app.css');
    const z = rule => { const m = new RegExp('(?:^|\\n)' + rule.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{[^}]*z-index:\\s*(\\d+)').exec(css); return m ? Number(m[1]) : null; };
    A.ok(z('#chat-panel.fnv-offer-host #chat-inputrow') > z('.fnv-dialogue'), 'while an offer is up the message box (and its / menu, model dock) sits above the panel: ' + z('#chat-panel.fnv-offer-host #chat-inputrow') + ' > ' + z('.fnv-dialogue'));
    A.ok(z('#chat-inputrow') < z('.fnv-dialogue'), 'and only then — the awakening still covers the whole of COMMS');
  }
  {
    // TEXT SIZE at 125%: rects are visual px, the panel's own style px are layout px — divide once
    const s = station({ zoom: 1.25 });
    s.D.open({ name: 'NOVA', offer: { notNow() {}, stepAside() {} } });
    A.eq(s.panel().style.bottom, '128px', 'under a 125% TEXT SIZE the bottom is set in layout px (160 visual / 1.25)');
    A.ok(!s.covers(s.inputCentre()), 'so the zoomed message box is uncovered as well');
    s.D.close();
  }
  {
    // the awakening / tour pass no offer: they still own the whole of COMMS (unchanged)
    const s = station();
    s.D.open({ name: 'NOVA' });
    void s.D.say('wake up.');
    A.ok(!s.panel().classList.contains('fnv-offer'), 'a ceremony panel is not an offer');
    A.eq(s.panel().style.bottom || '', '', 'and keeps its inset:0 (no bottom override)');
    A.eq(step(s.D, 'ask'), false, 'stepAside is a no-op on a panel with no offer (the awakening is never yanked)');
    const ev = s.key('Escape');
    A.eq(ev.defaultPrevented, false, 'and Esc is not taken over on it (no accidental exit from the birth)');
    s.D.close();
  }

  /* ---------- B. Esc answers an offer like its own "not now" ---------- */
  {
    const s = station();
    let notNow = 0;
    s.D.open({ name: 'NOVA', offer: { notNow: () => { notNow++; }, stepAside() {} } });
    void s.D.say('does this look right?');
    s.key('Escape', s.elsewhere);
    A.eq(notNow, 0, 'an Esc typed in a station field (another surface) is that field’s');
    s.key('Escape', s.menuKey);
    A.eq(notNow, 0, 'an Esc on a key in another surface (a dock menu) belongs to that surface');
    s.key('Escape', s.input, true);
    A.eq(notNow, 0, 'an Esc the message box already used (it stopped a run / closed the / menu) is never answered twice');
    const ev = s.key('Escape', s.input);
    A.eq(notNow, 1, 'an unused Esc in the COMMS message box answers NOT NOW');
    A.eq(ev.defaultPrevented, true, 'and is marked used');
    s.key('Escape', s.panel());
    A.eq(notNow, 2, 'an Esc on the panel itself (or with nothing focused) answers NOT NOW');
    s.D.close();
    s.key('Escape');
    A.eq(notNow, 2, 'a closed panel leaves no Esc listener behind');
  }
  /* ---------- B2. ONE Esc, ONE owner (review 10-15). The offer lifts the composer row (the model dock, the voice keys) above the
     panel, and those keys' Esc handlers sit on document without marking the Esc used: an Esc that closed the model dock or ended
     Local Live ALSO answered the offer NOT NOW — a false decline (declineDecomposition + recDecline) that holds the offer back
     until the belief changes. The offer answers only an Esc aimed at it: nothing focused, its own keys, or the message box. ---------- */
  {
    const s = station();
    let notNow = 0;
    s.D.open({ name: 'NOVA', offer: { notNow: () => { notNow++; }, stepAside() {} } });
    void s.D.say('does this look right?');
    const chip = new El('button'); chip.id = 'model-dock-effort-chip'; s.row.appendChild(chip);   // a model-dock key (focus stays on it)
    const liveKey = new El('button'); liveKey.id = 'voice-live'; s.row.appendChild(liveKey);      // the Local Live key
    const cardKey = new El('button'); cardKey.className = 'cmsg-act'; s.logEl.appendChild(cardKey); // a key on a transcript card
    s.key('Escape', chip);
    A.eq(notNow, 0, 'an Esc on a model-dock key in the composer row is the dock’s, never the offer’s NOT NOW');
    s.key('Escape', liveKey);
    A.eq(notNow, 0, 'an Esc on the Local Live key is Local Live’s');
    s.key('Escape', cardKey);
    A.eq(notNow, 0, 'an Esc on a key in the transcript is not aimed at the offer either');
    // the composer row's own document-level Esc owners, executed from their files: each marks the Esc it used
    const dock = { open: true, closed: 0 }; dock.closeDock = () => { dock.open = false; dock.closed++; };
    const live = { active: false, ended: 0 }; live.end = () => { live.active = false; live.ended++; };
    const talk = { convoMode: false, stopped: 0, LS_CONVO: 'convo', savePref() {} }; talk.stopConvo = () => { talk.convoMode = false; talk.stopped++; };
    const owners = [['frontend/app/modeldock.js', 'closeDock', dock], ['frontend/app/voice-live.js', 'end()', live], ['frontend/app/voice.js', 'convoMode', talk]].map(([f, m, st]) => [f, docEscOwner(f, m, st)]);
    for (const [f, fn] of owners) { A.ok(typeof fn === 'function', f + ' has its document Esc handler'); if (fn) s.docKeys.push(fn); }
    s.key('Escape', s.input);
    A.eq(dock.closed, 1, 'Esc closes the open model dock');
    A.eq(notNow, 0, 'and that Esc was the dock’s alone: the offer is not answered NOT NOW');
    live.active = true;
    s.key('Escape');
    A.eq(live.ended, 1, 'Esc ends Local Live');
    A.eq(notNow, 0, 'and does not also decline the offer');
    talk.convoMode = true;
    s.key('Escape');
    A.eq(talk.stopped, 1, 'Esc drops out of hands-free');
    A.eq(notNow, 0, 'and does not also decline the offer');
    s.key('Escape');
    A.eq(notNow, 1, 'with nothing else to close, Esc is the offer’s NOT NOW again');
    s.D.close();
  }
  /* ---------- B3. the same law for a dismissable proposal (autojobstore's routines): an Esc another owner used is not a dismiss */
  {
    const s = station();
    s.D.open({ name: 'NOVA' });
    let res = null;
    s.D.node({ lines: 'a routine worth running for you', options: [{ label: 'yes', value: 'yes' }], dismissable: true }).then(r => { res = r; });
    await settle();
    s.key('Escape', s.body, true);
    await settle();
    A.eq(res, null, 'an Esc the model dock / Local Live already used never also dismisses a proposal');
    s.key('Escape');
    await settle();
    A.ok(res && res.dismissed === true, 'an unused Esc still dismisses it');
    s.D.close();
  }

  /* ---------- C. stepAside hands the moment back ---------- */
  {
    const s = station();
    const why = [];
    s.D.open({ name: 'NOVA', offer: { notNow() {}, stepAside: w => why.push(w) } });
    A.eq(step(s.D, 'ask'), true, 'stepAside reports that an open offer stepped aside');
    A.eq(why.join(), 'ask', 'and tells the caller why');
    s.D.close();
    A.eq(step(s.D, 'ask'), false, 'with nothing open it is a no-op');
    // re-opened WITHOUT an offer (the next beat of a ceremony): the earlier offer's answers are dropped
    s.D.open({ name: 'NOVA', offer: { notNow() {}, stepAside: w => why.push(w) } });
    s.D.open({ name: 'NOVA' });
    A.eq(step(s.D, 'ask'), false, 'a re-open without an offer drops the earlier offer');
    A.eq(s.panel().style.bottom || '', '', 'and gives the whole of COMMS back to the panel');
    s.D.close();
  }

  /* ---------- D. the goal-path panel (chat.js offerArc, executed with the REAL Dialogue above) ---------- */
  const i = chat.indexOf('  function arcBlocked() {'), j = chat.indexOf('  function planGoalPath()', i);
  A.ok(i > 0 && j > i, 'chat.js has arcBlocked … offerArc');
  const arc = (o) => {
    o = o || {};
    const s = station();
    const log = { decline: 0, recDecline: 0, confirm: 0, finished: 0, firing: [] };
    Object.assign(s.ctx, {
      GoalStore: { willOfferDecomposition: () => true, isFiring: () => false, setFiring: v => log.firing.push(v),
        proposeDecomposition: async () => ({ belief: { text: 'ship it' }, texts: ['scope it', 'build it', 'ship it'] }),
        confirm: () => { log.confirm++; return {}; }, declineDecomposition: () => { log.decline++; } },
      Goals: { resolveConfirmChoice: (c, p) => ({ action: c && c.value === 'confirm' ? 'confirm' : 'decline', path: p }) },
      slotCanArc: () => 'free', studyBlocked: () => false, isBusy: () => false, interview: null, clearNudge() {}, turninQueue: [], activeTurnin: null, showNextTurnin() {},
      beatCards: { generation: () => 1, claim: () => ({ decide() {}, finish() { log.finished++; } }) },
      name: 'NOVA', recAccept() {}, recDecline: () => { log.recDecline++; },
      taskQuestionLive: () => !!o.taskQuestion,
      log: { querySelector: sel => (o.liveCard && sel === '[data-live-ask]') ? {} : null },
      Channels: { allPending: () => (o.pending ? [{ wsId: 'ws_b', p: { promptId: 'p9' } }] : []) }
    });
    vm.runInContext(chat.slice(i, j) + '\nthis.offerArc = offerArc; this.noteDeliveryLanding = noteDeliveryLanding; this.noteAskLanding = typeof noteAskLanding === "function" ? noteAskLanding : null;', s.ctx);
    return { s, log, ctx: s.ctx };
  };
  // (1) unasked: an approval lands while the panel narrates (soak (a)) → it steps aside, unanswered
  {
    const t = arc();
    const p = t.ctx.offerArc('run-1');
    await settle();
    A.ok(t.s.D.isOpen() && t.s.panel(), 'the goal-path panel opens over COMMS at a quiet run end');
    A.ok(!t.s.covers(t.s.inputCentre()), 'and leaves the message box usable');
    A.ok(typeof t.ctx.noteAskLanding === 'function', 'chat.js has noteAskLanding (an approval or question reaching the Commander)');
    if (t.ctx.noteAskLanding) t.ctx.noteAskLanding();
    await Promise.race([p, settle()]);
    A.eq(t.s.D.isOpen(), false, 'an approval landing sends the open panel aside, so its keys are clickable');
    A.eq(t.log.decline + t.log.recDecline, 0, 'stepping aside is not a decline (it is offered again at a later run end)');
    A.eq(t.log.finished, 1, 'the beat slot is released');
    A.eq(t.log.firing.at(-1), false, 'and the arc lane is released');
  }
  // (2) the Commander asked for it (PLAN A PATH): a delivery does not yank it, but an approval does — its run is paused on them
  {
    const t = arc();
    const p = t.ctx.offerArc('manual:1');
    await settle();
    t.ctx.noteDeliveryLanding(); await settle();
    A.eq(t.s.D.isOpen(), true, 'a delivery leaves a panel the Commander opened themselves (unchanged)');
    if (t.ctx.noteAskLanding) t.ctx.noteAskLanding();
    await Promise.race([p, settle()]);
    A.eq(t.s.D.isOpen(), false, 'an approval landing steps even an asked-for panel aside: a waiting ask is never covered');
    A.eq(t.log.decline, 0, 'unanswered, not declined');
  }
  // (3) Esc during the narration = NOT NOW (a decline, exactly like the key)
  {
    const t = arc();
    const p = t.ctx.offerArc('run-3');
    await settle();
    t.s.key('Escape');
    await Promise.race([p, settle()]);
    A.eq(t.s.D.isOpen(), false, 'Esc closes the goal-path panel while it is still narrating');
    A.eq(t.log.decline, 1, 'as a NOT NOW: the decomposition is declined (re-offered only when the belief changes)');
    A.eq(t.log.recDecline, 1, 'and the arc channel records the not-now like its key does');
    A.eq(t.log.confirm, 0, 'nothing is confirmed');
  }
  // (4) Esc on the milestones (the options are up) = NOT NOW too
  {
    const t = arc();
    const p = t.ctx.offerArc('run-4');
    await settle();
    t.s.key(' ');   // the read gate: the Commander reads on
    await settle();
    const opts = all(t.s.host).filter(e => e._cls.has('fnv-opt')).map(e => e.textContent);
    A.ok(opts.some(x => /confirm the path/.test(x)) && opts.some(x => /not now/.test(x)), 'the milestones show their confirm / not now keys: ' + opts.join(' | '));
    A.eq(opts.length, 3, 'and no new key was added (confirm · not now · edit the milestones)');
    t.s.key('Escape');
    await Promise.race([p, settle()]);
    A.eq(t.s.D.isOpen(), false, 'Esc closes the panel on the milestones as well');
    A.eq(t.log.decline, 1, 'as the same NOT NOW');
  }
  // (5) the Commander's own turn steps it aside (a reply streaming under the panel would be hidden)
  {
    const t = arc();
    const p = t.ctx.offerArc('run-5');
    await settle();
    A.eq(step(t.s.D, 'turn'), true, 'the Commander sending a turn hands the moment back');
    await Promise.race([p, settle()]);
    A.eq(t.s.D.isOpen(), false, 'the panel steps aside for the Commander’s own turn');
    A.eq(t.log.decline, 0, 'unanswered, not declined');
  }
  // (6) never offered while an ask waits: a card on screen, a run's question, or any ask the station holds open
  for (const [label, o] of [['an approval card on screen', { liveCard: true }], ['a run’s question', { taskQuestion: true }], ['a background worker’s approval in another conversation', { pending: true }]]) {
    const t = arc(o);
    await Promise.race([t.ctx.offerArc('run-6'), settle()]);
    A.eq(t.s.D.isOpen(), false, 'the goal-path panel is not offered while ' + label + ' waits');
    A.eq(t.log.decline, 0, 'and that is not a decline (' + label + ')');
  }

  /* ---------- E. chat.js hands the moment back wherever an ask reaches the Commander, and on their own turn ---------- */
  A.ok(/U\.bus\.on\('permission\.prompt', noteAskLanding\)/.test(chat), 'every approval / question the station raises (permission.prompt, a worker’s and a group’s too) steps an offer aside');
  A.ok(/function revealCard\(el\) \{\s*\n\s*noteAskLanding\(\);/.test(chat), 'a live approval / question card shown in COMMS (incl. a session re-opened on one) steps an offer aside');
  A.ok(/function revealAsk\(promptId\) \{[\s\S]{0,900}?if \(!card\) return false;\s*\n\s*noteAskLanding\(\);/.test(chat), 'NEEDS YOU › Review / Answer steps an offer aside before it shows the card');
  A.ok(/function offerTaskQuestion\(tq\) \{[\s\S]{0,400}?noteAskLanding\(\);/.test(chat), 'a run that ends on a question steps an offer aside');
  A.ok(/stepOfferAside\('turn'\);[^\n]*\n\s*stick = true;/.test(chat), 'the Commander’s own turn (send) steps an offer aside');
  A.ok(/Dialogue\.open\(\{ name: \(name \|\| 'AGENT'\), offer: \{/.test(chat), 'the goal-path panel opens as an offer');

  A.report('dialogue-offer-yields.test');
})().catch(e => { console.error(e); process.exit(1); });
