/* node test/queststatestore.test.js — the live wiring around the pure quest-memory engine
   (frontend/app/queststatestore.js). Verifies the G1a celebration + anti-nag contract end to end:
     • resume baseline is silent (no celebration storm on init, even for already-done quests);
     • an open→done edge celebrates EXACTLY ONCE — one SFX.quest sting, one COMMS broadcast,
       one quest-log rerender, a bounded row flourish, and NO StationUI.notify (notification diet,
       2026-08-18: the bell is reserved for things that need the Commander) — and repeat syncs stay silent;
     • dismissal takes only for dossier quests, hides the quest, stops the curiosity nudge for that
       dimension, and SURVIVES A RELOAD (self-persisted localStorage key);
     • THE LAW: quests never mint XP and the store never emits on U.bus — both locked with tripwire stubs
       that throw if touched. Plus source-level locks on the stationui/app wiring (browser-flow files). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- stubs: storage, engine, projection, celebration probes, tripwires ---------- */
global.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};
global.QuestState = require('../frontend/app/queststate.js');

let quests = [];
global.QuestStore = { view: () => ({ meter: null, quests, summary: { open: 0, done: 0, total: 0 } }) };

let stings = 0;
global.SFX = { quest: () => { stings++; }, level: () => { throw new Error('quest completion must use the quest sting, not the level-up fanfare'); } };
const toasts = [], rerenders = [], casts = [];
global.StationUI = { notify: (t, c) => toasts.push({ t: String(t), c }), invalidate: k => rerenders.push(k) };   // the render contract's background door
global.Chat = { broadcast: (t, o) => casts.push({ t: String(t), o }) };

// THE LAW tripwires: a quest completing must never mint XP and the store must never emit on the bus.
global.Xp = { applyEvent: () => { throw new Error('LAW VIOLATION: quests must never mint XP'); }, compute: () => { throw new Error('LAW VIOLATION: quests must never touch XP'); } };
global.XpStore = { onEvent: () => { throw new Error('LAW VIOLATION: quests must never feed the XP engine'); } };
global.U = { bus: { emit: () => { throw new Error('LAW VIOLATION: queststatestore must never emit on U.bus'); }, on: () => {} } };

const waved = [];
global.CuriosityStore = { markDismissed: d => waved.push(d) };

const { QuestStateStore } = require('../frontend/app/queststatestore.js');
const dq = (key, status) => ({ id: 'dim:' + key, kind: 'dossier', status, title: 'Tell the station your ' + key, reward: 'sharper agents' });
const mq = (id, status) => ({ id: 'ms:' + id, kind: 'milestone', status, title: id.toUpperCase(), reward: 'recognition' });

/* ---------- resume baseline: already-done quests are backfilled silently ---------- */
quests = [dq('goals', 'open'), mq('first_light', 'done')];
QuestStateStore.init();
A.eq(stings, 0, 'init never celebrates — a resumed done quest is baseline, not news');
A.eq(toasts.length, 0, '…and raises no toast');
A.eq(casts.length, 0, '…and no COMMS broadcast');
A.ok(QuestStateStore.stateOf('ms:first_light').completedAt > 0, 'a done-at-first-sight quest still gets completedAt (trophy-case backfill)');
A.ok(QuestStateStore.stateOf('dim:goals').firstSeenAt > 0, 'an open quest records firstSeenAt');
A.eq(QuestStateStore.stateOf('dim:goals').completedAt, null, '…but no completedAt while open');

/* ---------- open→done: exactly one celebration ---------- */
quests = [dq('goals', 'done'), mq('first_light', 'done')];
let comps = QuestStateStore.sync();
A.eq(comps.length, 1, 'sync reports the one completed quest');
A.eq(stings, 1, 'exactly one quest sting');
A.eq(toasts.length, 0, 'notification diet: a quest completion never toasts (sting + flourish + COMMS carry it)');
A.eq(casts.length, 1, 'exactly one COMMS broadcast');
A.ok(casts[0].t.indexOf('QUEST COMPLETE · ') === 0 && casts[0].t.indexOf('GOALS') > 0, 'the broadcast is "QUEST COMPLETE · <TITLE>"');
A.ok(rerenders.indexOf('quests') >= 0, 'the quest-log panel is asked to rerender so the row can flash');
A.ok(QuestStateStore.isCelebrating('dim:goals'), 'the completed row flourishes');
A.eq(QuestStateStore.isCelebrating('ms:first_light'), false, 'the baseline quest does not flourish');
A.ok(QuestStateStore.stateOf('dim:goals').completedAt > 0, 'completedAt is stamped and durable');

comps = QuestStateStore.sync();
A.eq(comps.length, 0, 'the same projection synced again is silent');
A.eq(stings, 1, '…no second sting (exactly once per completion)');
A.eq(casts.length, 1, '…no second broadcast');
A.eq(toasts.length, 0, '…and still no toast, ever');

/* ---------- dismissal: dossier only, hides, stops the curiosity nudge ---------- */
quests = [dq('goals', 'done'), mq('first_light', 'done'), dq('stack', 'open')];
QuestStateStore.sync();
// GB-24 — dismiss everywhere: milestones/station are now QuestState-owned dismissible; the SuggestStore-owned
// idea (and the coupled goal-arc rows) stay non-dismissible. We assert the refusal on the idea kind so
// ms:first_light is left untouched for the visibility check below.
A.eq(QuestStateStore.dismissible({ id: 'idea', kind: 'idea', status: 'open', title: 'X', reward: 'r' }), false, 'the SuggestStore-owned idea quest is not dismissible here');
A.eq(QuestStateStore.dismiss({ id: 'idea', kind: 'idea', status: 'open', title: 'X', reward: 'r' }), false, 'dismissing the idea quest is refused');
A.eq(QuestStateStore.dismissible(mq('pack_rat', 'open')), true, 'GB-24: milestones are now dismissible (QuestState is their denylist)');
A.eq(QuestStateStore.dismiss(quests[2]), true, 'dismissing an open dossier quest takes');
A.eq(waved, ['stack'], 'the curiosity nudge for that dimension is stopped too (one anti-nag law)');
A.eq(QuestStateStore.visible(quests).map(x => x.id), ['dim:goals', 'ms:first_light'], 'a dismissed quest never re-renders');
A.eq(QuestStateStore.isDismissed('dim:stack'), true, 'isDismissed reads back');

/* ---------- dismissal is permanent across reload (self-persisted key) ---------- */
QuestStateStore.init();   // simulated app reload: re-hydrates from localStorage
A.eq(QuestStateStore.isDismissed('dim:stack'), true, 'dismissal survives a reload');
A.eq(QuestStateStore.visible(quests).some(x => x.id === 'dim:stack'), false, '…and stays hidden');
quests = [dq('goals', 'done'), mq('first_light', 'done'), dq('stack', 'done')];
comps = QuestStateStore.sync();
A.eq(comps.length, 0, 'a dismissed quest completing after reload NEVER re-fires (stop forever)');
A.eq(stings, 1, '…no sting for it');

/* ---------- completion state survives reload too ---------- */
A.ok(QuestStateStore.stateOf('dim:goals').completedAt > 0, 'completedAt survives a reload');

/* ---------- reset: the new-hero clean slate drops the key ---------- */
QuestStateStore.reset();
A.eq(global.localStorage.getItem('starnet.queststate.v1'), null, 'reset removes the self-persisted key');
A.eq(QuestStateStore.sync(), [], 'a reset store degrades to no-ops until the next init');
QuestStateStore.init();
A.eq(QuestStateStore.isDismissed('dim:stack'), false, 'after reset+init, no prior Commander history remains');

/* ---------- source-level locks: the browser wiring (stationui/app/index.html are not node-loadable) ---------- */
const stSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
A.ok(/\b(QuestStateStore|QSS)\.visible\(/.test(stSrc), 'buildQuests filters the projection through QuestStateStore.visible (dismissed never re-renders)');
A.ok(/QuestStateStore\.sync\(\)/.test(stSrc), 'the station keeps the quest memory synced (completion detection is driven, not render-only)');
A.ok(/q-dismiss/.test(stSrc), 'the quest log offers a dismiss affordance');
A.ok(/\b(QuestStateStore|QSS)\.dismiss\(/.test(stSrc), '…that routes through QuestStateStore.dismiss (kind-gated by the engine)');
A.ok(/isCelebrating/.test(stSrc) && /q-celebrate/.test(stSrc), 'a freshly-completed row renders the gold q-celebrate flourish');
A.ok(/typeof QuestStateStore\s*[!=]==\s*'undefined'/.test(stSrc), 'stationui guards on the store being present (degrades, never throws)');

const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/QuestStateStore\.init\(\)/.test(appSrc), 'app.js initializes the quest memory on enterGame');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.ok(/app\/queststate\.js/.test(html) && /app\/queststatestore\.js/.test(html), 'index.html loads the engine and the store');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');
A.ok(/q-celebrate/.test(css) && /q-dismiss/.test(css), 'app.css styles the flourish and the dismiss affordance');

/* ---------- a MILESTONE quest mirrors its trophy: flash only, no second sting or COMMS line (first-hour walk 2026-09-28) ---------- */
{
  quests = [mq('pack_rat', 'open')];
  QuestStateStore.sync();
  const stingsBefore = stings, castsBefore = casts.length, rerBefore = rerenders.length;
  quests = [mq('pack_rat', 'done')];
  const done = QuestStateStore.sync();
  A.eq(done.length, 1, 'the milestone quest still completes (durable completedAt)');
  A.eq(stings, stingsBefore, 'no quest sting — the trophy already stung');
  A.eq(casts.length, castsBefore, 'no QUEST COMPLETE line — the trophy already announced PACK RAT');
  A.ok(rerenders.length > rerBefore && QuestStateStore.isCelebrating('ms:pack_rat'), 'the quest log row still flashes');
}
A.report('queststatestore.test');
