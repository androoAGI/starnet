/* node test/notifications-useful.test.js — NOTIFICATIONS THAT MEAN SOMETHING (Andrew 10-02: "keep the
   notifications, but actually make it more useful instead of meaningless").

   The bell keeps only what you'd want after the moment: an agent WAITING on you (needs), work that FINISHED
   while you were elsewhere (result), and something that STOPPED or BROKE (alert). Every kept entry is a door
   (a session or a window), a repeat of one condition is one entry, an answered wait leaves NEEDS YOU, and
   opening a session reads what pointed at it. Everything else is a toast and nothing more.

   The notify core is executed in a vm (not grepped); the call sites are pinned by source. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ui = read('frontend/app/stationui.js');
const chat = read('frontend/app/chat.js');
const world = read('frontend/app/world.js');
const app = read('frontend/app/app.js');

/* ---- the core, executed ---- */
const from = ui.indexOf('  function notifyPrefOf(category) {');
const to = ui.indexOf('  // A caller that leads with an ALL-CAPS token');
A.ok(from > 0 && to > from, 'notify core located');
const toasts = [], opened = [];
const ctx = {
  store: { notifs: [], settings: {} }, open: {}, saved: 0,
  notifyDefaults: () => ({}), uid: (() => { let i = 0; return () => 'n' + (++i); })(),
  save() { ctx.saved++; }, badges() {}, rerender() {}, invalidate() {},
  toast: (txt, cls, sound, opts) => toasts.push({ txt, opts }),
  openTerm: (k, s) => opened.push(['term', k, s]),
  App: { openWorkstream: id => opened.push(['ws', id]) }
};
vm.runInNewContext(ui.slice(from, to) + '\nthis.api = { notify, settleNotifs, seenSession, openNotif };', ctx);
const N = ctx.api;

N.notify('✓ routine saved', 'good');
N.notify('pick a schedule first', 'warn');
A.eq(ctx.store.notifs.length, 0, 'a confirmation or a local error is a toast only — never unread history');
A.eq(toasts.length, 2, '…but it still shows as a toast');

N.notify('NOVA needs approval to write report.md', 'warn', 'needsApproval', { kind: 'needs', go: { ws: 's1' }, key: 'needs:s1' });
N.notify('NOVA finished — Weekly brief', 'good', 'runComplete', { kind: 'result', go: { ws: 's2' } });
N.notify('drafted while you were away: x', 'gold', 'cronDigest');
A.eq(ctx.store.notifs.map(n => n.kind), ['needs', 'result', 'result'], 'kept: needs + results (a category implies its kind)');
A.eq(ctx.store.notifs[0].go, { ws: 's1' }, 'a kept entry carries its door');

N.notify('budget warning 80%', 'warn', undefined, { kind: 'alert', key: 'budget:day', go: { term: 'settings', section: 'budget' } });
N.notify('budget cap hit', 'warn', undefined, { kind: 'alert', key: 'budget:day', go: { term: 'settings', section: 'budget' } });
A.eq(ctx.store.notifs.filter(n => n.key === 'budget:day').length, 1, 'a repeat of the same live condition is ONE entry');
A.eq(ctx.store.notifs.find(n => n.key === 'budget:day').txt, 'budget cap hit', '…carrying the newest text');

toasts[toasts.length - 1].opts.onClick();
A.eq(opened[opened.length - 1], ['term', 'settings', 'budget'], 'the toast of a door entry opens the same place');
A.eq(ctx.store.notifs.find(n => n.key === 'budget:day').read, true, 'following it reads it');

N.seenSession('s2');
A.eq(ctx.store.notifs.find(n => n.go && n.go.ws === 's2').read, true, 'opening a session reads every entry that pointed at it');
A.eq(!!ctx.store.notifs[0].done, false, 'opening a session does NOT answer its approval');

N.settleNotifs('needs:s1');
A.ok(ctx.store.notifs[0].done && ctx.store.notifs[0].read, 'an answered wait is handled (leaves NEEDS YOU, stays in history)');

N.notify('NOVA has a question', 'warn', 'needsApproval', { kind: 'needs', go: { ws: 's1' }, key: 'needs:s1' });
A.eq(ctx.store.notifs.filter(n => n.key === 'needs:s1').length, 2, 'a NEW wait after a handled one is its own entry (history keeps the handled one)');

ctx.store.settings.notifyPrefs = { runComplete: false };
const before = ctx.store.notifs.length, tBefore = toasts.length;
N.notify('muted finish', 'good', 'runComplete', { kind: 'result' });
A.ok(ctx.store.notifs.length === before && toasts.length === tBefore, 'a muted category is still dropped at the emit point');

/* ---- the window: NEEDS YOU first, every entry a door, legacy noise gone, badge = what's worth a look ---- */
const win = ui.slice(ui.indexOf('  function buildNotifs(body) {'), ui.indexOf('  /* ============== periodic + save dot'));
A.ok(/NEEDS YOU/.test(win) && /isWaiting/.test(win), 'the window leads with NEEDS YOU');
A.ok(/nf-door/.test(win) && /openNotif\(n\)/.test(win), 'an entry with a destination is clickable and goes there');
A.ok(/pruneLegacyNotifs\(\)/.test(win), 'pre-10-02 toast-shaped history is cleared out');
A.ok(/function badges\(\)[\s\S]{0,200}isWaiting\(x\) \|\| !x\.read/.test(win), 'the badge counts everyone waiting on you + anything new');

/* ---- the call sites that matter carry a kind and a door ---- */
A.ok(/ wants to ' \+ actionPhrase\(p\)[^\n]*kind: 'needs', go: \{ ws: ws\.id \}, key: 'needs:' \+ ws\.id/.test(chat), 'an approval (open session) is a NEEDS YOU door to its session');
A.ok(/function backgroundPermissionNotify[\s\S]{0,900}kind: 'needs', go: \{ ws: ws\.id \}, key: 'needs:' \+ ws\.id/.test(chat), 'an approval (background session) is a NEEDS YOU door');
A.ok(/' finished'\) \+ sessionNote\(ws\)/.test(chat) && /kind: 'result', go: \{ ws: ws\.id \}/.test(chat), 'a background session that finished says so and opens it');
// (2026-10-14) through settleRunNeeds: the run's own waits end with it; a background worker's ask filed on the same
// conversation keeps the entry (test/background-asks-ui.test.js executes it)
A.ok(/settleRunNeeds\(ws\.id\);   \/\/ the run is over/.test(chat) && /function settleRunNeeds\(wsId\)[\s\S]{0,400}keepNeeds\(wsId,/.test(chat), 'a run that ends clears what it was waiting on');
A.ok(/StationUI\.seenSession\(id\)/.test(app.slice(app.indexOf('function switchWorkstream'), app.indexOf('function switchWorkstream') + 300)), 'switching to a session reads its entries');
A.ok(/budget cap hit[^\n]*kind: 'alert'[^\n]*go: \{ term: 'settings', section: 'budget' \}/.test(world), 'budget alerts open SPENDING LIMITS');
A.ok(/settleNotifs\(toastKey\)/.test(world), 'a channel that reconnects settles its outage entry');
A.ok(!/hudNote\('◈ recalled[^\n]*kind:/.test(world) && !/hudNote\('✎ memory saved'[^\n]*kind:/.test(world), 'memory telemetry stays a toast (never history)');

// Exercise both real submission functions with real notification state and Channels.
// A failed or in-flight HTTP answer must never clear the bell or a sibling prompt.
(async () => {
  const Channels = require('../frontend/app/channels.js');
  const settlement = chat.slice(chat.indexOf('  const settledPromptNotices = new Set();'), chat.indexOf('  async function answerConsent('));
  for (const mode of ['question', 'approval']) {
    Channels.reset(); ctx.store.notifs = []; ctx.store.settings = {};
    const ws = { id: mode, agentId: 'lead' };
    const p = { promptId: mode + '-first', runId: 'run-' + mode, tool: mode === 'question' ? 'brief.ask' : 'fs.write' };
    const sibling = { promptId: mode + '-second', tool: 'fs.write', workerAgentId: 'rook' };
    Channels.setPending(ws.id, p); Channels.setPending(ws.id, sibling);
    N.notify('Waiting for first answer', 'warn', 'needsApproval', { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id, prompt: p.promptId });
    let reply = { ok: false, error: 'offline' }, calls = 0;
    const buttons = [{ disabled: false }], events = [], tags = [];
    const c = vm.createContext({ p, ws, decided: false, submitting: false, received: null, applyElsewhere: null,
      btns: { querySelectorAll: () => buttons, remove: () => tags.push('removed') }, hint: { remove() {} }, howTo: 'Tap an answer.', why: null, releaseCard() {}, keepFocus() {},
      r: { body: { appendChild: tag => tags.push(tag) } }, document: { createElement: () => ({}) },
      Harness: { consent: async () => { calls++; return reply; }, consentAnswer: async () => { calls++; return reply; } },
      Channels, StationUI: N, askerName: row => row.workerAgentId || 'lead', actionPhrase: () => 'write a file',
      U: { bus: { emit: (name, data) => events.push([name, data.promptId]) } }, isActiveWs: () => false, renderPresence() {}, syncStatus() {},
      askAnswerers: new Map() /* chat.js: open questions the composer may answer (answer() retires its own entry) */ });
    const handler = mode === 'question' ? 'async function answer(text, doneLabel, key)' : 'async function decide(decision, doneLabel, isDeny)';
    const body = A.fnBody(chat, handler);
    A.ok(body.length > 200 && body.length < 4000, mode + ' submission function is bounded');
    vm.runInContext(settlement + '\n' + A.fnBody(chat, 'async function answerConsent(p, ws, decision, via)') + '\n' + body, c);
    const invoke = () => mode === 'question' ? c.answer('my answer', 'answered') : c.decide('once', 'approved', false);
    await invoke();
    A.eq(Channels.pendingAllOf(ws.id).map(x => x.promptId), [p.promptId, sibling.promptId], mode + ' failed response preserves both pending prompts');
    A.eq(ctx.store.notifs.filter(n => n.key === 'needs:' + ws.id && !n.done).length, 1, mode + ' failure retains NEEDS YOU');
    A.eq([buttons[0].disabled, events.length, tags.length], [false, 0, 0], mode + ' failure restores controls and emits no success');
    let confirm; reply = new Promise(resolve => { confirm = resolve; });
    const pending = invoke(); await Promise.resolve();
    A.eq(Channels.pendingAllOf(ws.id).length, 2, mode + ' in-flight answer remains pending until confirmed');
    A.eq(buttons[0].disabled, true, mode + ' prevents duplicate clicks while awaiting confirmation');
    await invoke(); A.eq(calls, 2, mode + ' repeated submit cannot issue a second in-flight request');
    confirm({ ok: true, decision: 'once' }); await pending;
    A.eq(Channels.pendingAllOf(ws.id).map(x => x.promptId), [sibling.promptId], mode + ' confirmation clears only the answered prompt');
    const waiting = ctx.store.notifs.filter(n => n.key === 'needs:' + ws.id && !n.done);
    A.eq(waiting.map(n => n.prompt), [sibling.promptId], mode + ' confirmation keeps the remaining worker in NEEDS YOU');
    A.eq(events, [['permission.response', p.promptId]], mode + ' emits one confirmed response with the exact prompt');
  }
  A.report('notifications-useful.test');
})().catch(error => { A.ok(false, error.stack); A.report('notifications-useful.test'); });
