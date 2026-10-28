/* node test/quest-clip-surrogates.test.js — a quest/goal text cap never ends on half an emoji.

   Found live (2026-10-21, sibling of qa/bugs/d1d77332): a goal whose 280-unit cap, or a step whose 140-unit cap, landed
   inside an emoji was stored with a lone surrogate ("…\ud83c") — the QUEST LOG drew a broken glyph and the same bytes were
   written to the station's _commander.goals.json and _station.journey.json. Every clip on this surface counted UTF-16
   units with a bare slice. Locked here: each cap still bounds the length, never leaves a lone surrogate, and a save
   written before the rule heals on load. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const lone = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));
const pad = (s, n) => { let t = s; while (t.length < n) t += ' and keep going'; return t.slice(0, n); };   // n units of plain words
const at = (n, emoji, tail) => pad('Ship the new quest log to the members', n - 1) + emoji + (tail || ' and celebrate');   // emoji starts at unit n-1 → a cap of n splits it
const ok = (label, s, cap) => { A.ok(!lone(s), label + ' has no lone surrogate: ' + JSON.stringify(String(s).slice(-3))); if (cap) A.ok(String(s).length <= cap, label + ' stays within its cap (' + String(s).length + ' <= ' + cap + ')'); };

(async () => {
  // ---- goals.js: the goal node + its milestones (the root of the live repro) ----
  const G = require('../frontend/app/goals.js');
  const g = G.makeGoal(at(280, '\u{1F3AF}'), [at(140, '\u{1F680}'), 'Write the second step for the launch', 'Write the third step for the launch'], null, 1000, { userAuthored: true });
  A.ok(g && g.milestones.length === 3, 'makeGoal built the goal');
  ok('goal text (280 cap)', g.text, 280);
  ok('milestone text (140 cap)', g.milestones[0].text, 140);
  A.ok(g.text.endsWith('going') || /\w$/.test(g.text), 'the cut drops the half emoji, not the words before it: ' + JSON.stringify(g.text.slice(-6)));

  // ---- goalloop.js ----
  const L = require('../frontend/app/goalloop.js');
  const loop = L.create(at(2000, '\u{1F525}'), { now: 1 });
  ok('goal-loop goal (2000 cap)', loop && loop.goal, 2000);

  // ---- workquests.js: a build quest's title and step labels ----
  const W = require('../frontend/app/workquests.js');
  const ws = W.hydrate({ seq: 1, quests: { 'wq:1': { firstSeenAt: 1, title: at(80, '\u{1F680}'), credit: at(160, '\u{1F389}'), steps: [{ key: 'k', label: at(80, '\u{1F680}') }] } } });
  const wq = ws.quests['wq:1'];
  A.ok(!!wq, 'workquests hydrated the quest');
  if (wq) { ok('work quest title (80 cap)', wq.title, 80); ok('work quest credit (160 cap)', wq.credit, 160); ok('work quest step label (80 cap)', wq.steps[0].label, 80); }

  // ---- stationquests.js / maintquests.js: labels that carry an agent's chosen name ----
  const SQ = require('../frontend/app/stationquests.js');
  const sq = SQ.hydrate({ gaps: { 'sq:a:web': { firstSeenAt: 1, agentId: 'a', cap: 'web', agentLabel: at(40, '\u{1F916}'), capLabel: at(24, '\u{1F310}'), propLabel: at(24, '\u{1F4E1}'), completedAt: null, dismissedAt: null } } });
  const gap = Object.values(sq.gaps)[0];
  A.ok(!!gap, 'stationquests hydrated the gap');
  if (gap) { ok('station quest agent label (40 cap)', gap.agentLabel, 40); ok('station quest capability label (24 cap)', gap.capLabel, 24); ok('station quest prop label (24 cap)', gap.propLabel, 24); }
  const MQ = require('../frontend/app/maintquests.js');
  const mq = MQ.hydrate({ quests: { 'mq:x': { firstSeenAt: 1, cause: 'x', title: at(80, '\u{1F527}'), fix: at(320, '\u{1F6E0}'), completedAt: null, dismissedAt: null } } });
  const mrow = Object.values(mq.quests)[0];
  A.ok(!!mrow, 'maintquests hydrated the quest');
  if (mrow) { ok('maintenance quest title (80 cap)', mrow.title, 80); ok('maintenance quest fix (320 cap)', mrow.fix, 320); }

  // ---- goalstore.js: hydrate HEALS a save written before the rule; addStep caps safely ----
  const mem = {};
  global.localStorage = { getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  global.Goals = G;
  global.DossierStore = { beliefs: () => [] };
  global.WorkQuestStore = { accept: () => null, quests: () => [] };
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const broken = at(280, '\u{1F3AF}').slice(0, 280);            // exactly what the old clip stored: ends on a lone high surrogate
  A.ok(lone(broken), 'fixture: the pre-rule save really ends on a lone surrogate');
  mem['starnet.goals.v1'] = JSON.stringify({ v: 1, goals: [{ id: 'goal_1', text: broken, createdAt: 1, status: 'active', successCondition: at(500, '\u{1F680}').slice(0, 500),
    milestones: [{ id: 'goal_1:m1', text: at(140, '\u{1F680}').slice(0, 140), status: 'open' }] }], ideas: [], offered: {}, offeredOrder: [] });
  const { GoalStore } = require('../frontend/app/goalstore.js');
  GoalStore.init({ now: () => 5000, getSystem: () => '' });
  const loaded = GoalStore.listGoals()[0];
  A.ok(!!loaded, 'goalstore loaded the saved goal');
  if (loaded) {
    ok('healed goal text on load', loaded.text, 280);
    ok('healed milestone text on load', loaded.milestones[0].text, 140);
    ok('healed success condition on load', loaded.successCondition, 500);
    const added = GoalStore.addStep(loaded.id, pad('Record a short walkthrough video for the members', 139) + '\u{1F3AC} and share it');
    A.ok(added, 'addStep accepted a long step');
    const step = GoalStore.listGoals()[0].milestones.slice(-1)[0];
    ok('added step (140 cap)', step && step.text, 140);
    const stored = JSON.parse(mem['starnet.goals.v1']);
    A.ok(!lone(JSON.stringify(stored.goals[0].text)) && !/\\ud8[0-9a-f]{2}(?!\\ud[c-f])/i.test(JSON.stringify(stored)), 'the re-saved localStorage copy carries no lone-surrogate escape');
  }

  // ---- sidecar/quest-store.js: a quest the model or a tool writes ----
  const QS = require('../sidecar/quest-store.js');
  const qn = QS.normalize({ seq: 1, quests: [{ id: 'q1', title: at(120, '\u{1F680}'), contract: { type: 'attest', key: '' }, steps: [{ key: 'k', label: at(80, '\u{1F680}'), note: at(240, '\u{1F4DD}') }] }] });
  const q = qn.quests[0];
  A.ok(!!q, 'quest-store normalized the quest');
  if (q) { ok('sidecar quest title', q.title); ok('sidecar quest step label (80 cap)', q.steps[0].label, 80); ok('sidecar quest step note (240 cap)', q.steps[0].note, 240); }

  // ---- sidecar/journey-store.js: the station's own record of the goal (where the live repro landed on disk) ----
  const { makeJourneyStore } = require('../sidecar/journey-store.js');
  const files = new Map();
  const memFs = {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, d) { files.set(String(f), String(d)); }, renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); }, openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
  const js = makeJourneyStore({ fs: memFs, path, workspaces: '/ws', writeDurable: ({ fs: f }, file, data) => f.writeFileSync(file, data) });
  const reg = await js.registerGoal({ id: 'goal:launch', text: at(280, '\u{1F3AF}'), successCondition: at(1000, '\u{1F680}') }, 1);
  A.ok(reg && reg.ok, 'journey registered the goal: ' + JSON.stringify(reg && reg.error));
  const onDisk = [...files.values()].join('\n');
  A.ok(onDisk.length > 0, 'journey wrote its file');
  A.ok(!/\\ud8[0-9a-f]{2}(?!\\ud[c-f])/i.test(onDisk) && !lone(onDisk), 'the station journey file carries no lone surrogate');

  // ---- sidecar/index.js commanderGoals.set (not node-loadable): its caps carry the same guard ----
  const idx = readSidecarSource();
  const setBlock = idx.slice(idx.indexOf('const commanderGoals = {'), idx.indexOf('const commanderGoals = {') + 2000);
  A.ok(/text: String\(goal\.text \|\| ''\)\.slice\(0, 280\)\.replace\(\/\[\\uD800-\\uDBFF\]\$\//.test(setBlock), 'commanderGoals.set caps the goal text without leaving half an emoji');
  A.ok(/next: goal\.next == null \? null : String\(goal\.next\)\.slice\(0, 200\)\.replace\(\/\[\\uD800-\\uDBFF\]\$\//.test(setBlock), 'commanderGoals.set caps the next step without leaving half an emoji');

  A.report('quest-clip-surrogates');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
