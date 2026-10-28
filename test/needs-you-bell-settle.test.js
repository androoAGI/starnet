'use strict';
/* node test/needs-you-bell-settle.test.js — ONE SETTLE FOR EVERY NEEDS YOU (org live walk 2026-10-14, P01).
   Approving a card cleared the rail's NEEDS YOU at once, but NOTIFICATIONS › NEEDS YOU and the bell kept "1 waiting" for
   ~1.5 s: chat.js answerConsent settles the notice (StationUI.badges) BEFORE Channels.clearPending, so that badges() still
   counted the ask; NeedsYou's permission.response listener re-rendered only the rail, and the bell waited for the rail
   heartbeat. GENUINE (executed): the real needsyou.js wired to a stub host and bus — an answer, an arrival and a STEP-IN
   change each repaint the rail AND call StationUI.badges() on the same tick, after the answering path has cleared the ask. */
const A = require('./_assert.js');

const handlers = {};
global.U = { bus: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: (ev, d) => (handlers[ev] || []).forEach(fn => fn(d)) } };
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
global.localStorage = { getItem: () => null, setItem() {} };
let pending = [{ wsId: 'home', p: { promptId: 'p1', tool: 'fs.write', askedAt: Date.now() - 5000 } }];
global.Channels = { allPending: () => pending.slice() };
global.Workstreams = { get: id => ({ id, title: null, agentId: 'agent' }), list: () => [], unread: () => false, generalId: () => 'home' };
global.App = { agentName: id => id };
global.Chat = { consentPhrase: p => String(p.tool), consentInspect: () => null };
global.fetch = async () => ({ ok: true, json: async () => ({ hooks: [], pending: [], plugins: [] }) });
const seen = [];   // what the bell counted each time it was repainted
global.StationUI = { badges: () => seen.push(NY.items().length), notify() {}, rerender() {}, openTerm() {} };
const host = { hidden: true, innerHTML: '', setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], contains: () => false };
global.document = { getElementById: id => id === 'ws-needs' ? host : null, querySelector: () => null, activeElement: null, hidden: false };
const NY = require('../frontend/app/needsyou.js');
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
  NY.render();   // the rail's first render wires the bus listeners
  await tick(); await tick();
  A.eq(NY.items().length, 1, 'fixture: one approval waits');
  A.ok(handlers['permission.response'] && handlers['permission.prompt'] && handlers['browser.handoff'], 'the rail listens for answers, arrivals and STEP-IN changes');

  // answerConsent's order: the bus event first, then Channels.clearPending in the same synchronous run
  seen.length = 0;
  U.bus.emit('permission.response', { promptId: 'p1', decision: 'once', via: 'desk' });
  pending = [];
  await tick();
  A.ok(host.hidden === true, 'the rail NEEDS YOU clears');
  A.eq(seen, [0], 'the bell and NOTIFICATIONS repaint on the same settle, already counting 0 (never the heartbeat\'s ~1.5 s later)');

  seen.length = 0;
  pending = [{ wsId: 'home', p: { promptId: 'p2', tool: 'fs.write', askedAt: Date.now() } }];
  U.bus.emit('permission.prompt', { promptId: 'p2' });
  await tick();
  A.eq(seen, [1], 'a new ask lights the bell on the same tick as the rail');

  seen.length = 0;
  U.bus.emit('browser.handoff', {});
  await tick();
  A.eq(seen.length, 1, 'a STEP-IN change repaints the bell too');
  A.report('needs-you-bell-settle.test');
})().catch(e => { console.error(e); process.exit(1); });
