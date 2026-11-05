/* node test/workstreams.test.js — the unified session record (frontend/app/workstreams.js).
   Locks the slice-1 promises: v1->v2 migration is lossless (legacy convo becomes General, cost
   seeded from real usage, agent/usage untouched at root — verified here at the slice level),
   the General default always exists, per-stream cost is isolated (no double-count), and lanes are
   hybrid-honest (a real run auto-advances todo->active; 'shipped' is only ever set deliberately). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const W = require('../frontend/app/workstreams.js');

/* ---------- migrateV1: lossless v1 -> v2 workstreams slice ---------- */
const V1 = {
  schema: 'starnet.save', version: 1,
  agent: { id: 'agent', name: 'ULTRON', model: 'anthropic/claude-sonnet-4.5' },
  history: [
    { role: 'user', content: 'what is my purpose?' },
    { role: 'assistant', content: 'to serve, Commander.' }
  ],
  usage: { tokens: 1200, cost: 0.0345, calls: 3 },
  updatedAt: 1700000000000
};
const slice = W.migrateV1(V1);
A.eq(slice.workstreams.length, 1, 'migrate -> exactly one General workstream');
const g0 = slice.workstreams[0];
A.eq(slice.activeId, 'ws_general', 'activeId is the General id');
A.eq(slice.generalId, 'ws_general', 'generalId is the General id');
A.eq(g0.title, null, 'General is untitled (title null)');
A.eq(g0.lane, 'active', 'General lane = active');
A.eq(g0.history, V1.history, 'history carried over identically (by value)');
A.eq(g0.cost, { tokens: 1200, usd: 0.0345, calls: 3 }, 'cost SEEDED from lifetime usage (cost->usd)');
A.eq(g0.roomId, null, 'dormant roomId builder seam present and null');
A.ok(g0.history !== V1.history, 'history is a copy, not aliasing the save doc');
A.ok(!('agent' in slice) && !('usage' in slice), 'slice carries only workstream state; agent/usage stay at root');

/* ---------- init from the migrated slice, then a fresh init ---------- */
A.eq(W.init(slice).id, 'ws_general', 'init returns the active (General) workstream');
A.eq(W.list().length, 1, 'one stream after migrate+init');
A.eq(W.active().history.length, 2, 'active stream has the resumed history');
A.eq(W.generalId(), 'ws_general', 'generalId preserved through init');

W.init(null);
A.eq(W.list().length, 1, 'init(null) mints a fresh General');
A.eq(W.active().title, null, 'fresh General is untitled');
A.ok(W.generalId() === W.activeId(), 'fresh: active === general');

/* ---------- create / switch / auto-title ---------- */
W.reset();
const genId = W.generalId();
const a = W.create('Q3 research');
A.eq(W.activeId(), a.id, 'create makes the new stream active');
A.eq(a.lane, 'todo', 'a brand-new stream starts in to-do (no run yet)');
A.ok(a.id !== genId, 'new stream is distinct from General');
A.eq(W.list().length, 2, 'General + new stream');
A.ok(W.switch(genId).id === genId, 'switch flips the active stream');
A.eq(W.activeId(), genId, 'active is now General again');
const backlog = W.create('backlog item', { activate: false });
A.eq(W.activeId(), genId, 'create({activate:false}) does NOT hijack the active stream');
A.ok(W.list().some(x => x.id === backlog.id), 'the non-activating create still adds the stream');

const b = W.create(null);  // untitled "+ New"
A.ok(W.autoTitle(b.id, 'find the best budget mechanical keyboard under $80') === true, 'untitled stream auto-titles from first msg');
A.eq(b.title, 'find the best budget mechanical keyboard under $80', 'title = first sentence, kept whole under the cap');
A.ok(W.autoTitle(b.id, 'changed my mind') === false, 'already-titled stream is not re-titled');
A.ok(W.autoTitle(genId, 'hello there') === false, 'General never auto-titles (stays the chat home)');
A.eq(W.deriveTitle('  summarize   the\nnews! and more'), 'summarize the news', 'deriveTitle: collapse ws, first sentence');
const longT = W.deriveTitle('research the global semiconductor supply chain and write a detailed quarterly report');
A.ok(longT.length <= 61 && /…$/.test(longT) && !/ …$/.test(longT), 'long title trims at a word boundary with an ellipsis, no mid-word cut');
A.eq(W.deriveTitle('x'.repeat(90)).length, 61, 'an unbroken 90-char token hard-caps to 60 + ellipsis');

/* ---------- title upgrade: retitle replaces the placeholder; a manual rename locks it forever ---------- */
W.reset();
const tg = W.generalId();
const up = W.create(null);
A.eq(up.titleAuto, true, 'a fresh stream starts title-auto (eligible for the summary upgrade)');
A.ok(W.autoTitle(up.id, 'help me find a budget mechanical keyboard') === true, 'instant placeholder set from first message');
A.eq(up.titleAuto, true, 'the auto placeholder keeps the stream eligible for the upgrade');
A.ok(W.retitle(up.id, '  Budget   Keyboard Hunt  ') === true, 'retitle upgrades the auto placeholder');
A.eq(up.title, 'Budget Keyboard Hunt', 'retitle collapses whitespace and applies the summary');
A.eq(up.titleAuto, true, 'still auto after a machine upgrade (a later refine could re-run)');
A.ok(W.rename(up.id, 'My Keyboard Project') === true, 'manual rename applies');
A.eq(up.titleAuto, false, 'a manual rename LOCKS the title (titleAuto=false)');
A.ok(W.retitle(up.id, 'Something Else') === false, 'retitle never stomps a manually-renamed title');
A.eq(up.title, 'My Keyboard Project', 'the human title survives a later upgrade attempt');
A.ok(W.retitle(tg, 'General Summary') === false, 'General is never titled by an upgrade');
A.eq(W.get(tg).title, null, 'General stays untitled (the chat home)');
A.ok(W.retitle(up.id, '   ') === false && up.title === 'My Keyboard Project', 'an empty summary is a no-op');
const dumpedAuto = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedAuto);
A.eq(W.get(up.id).titleAuto, false, 'titleAuto survives a save/load round-trip (the manual lock persists)');

/* ---------- needsModelTitle: a stream still wearing its machine placeholder retries the upgrade ---------- */
W.reset();
const ng = W.generalId();
const nm = W.create(null);
A.eq(W.needsModelTitle(nm.id), false, 'an untitled stream with no history is not yet upgrade-eligible');
nm.history.push({ role: 'user', content: 'help me find a budget mechanical keyboard', ts: 1 });
W.autoTitle(nm.id, 'help me find a budget mechanical keyboard');
A.eq(W.needsModelTitle(nm.id), true, 'placeholder title (deriveTitle of the first user msg) => eligible for the model upgrade');
A.eq(W.needsModelTitle(ng), false, 'General is never upgrade-eligible');
W.retitle(nm.id, 'Budget Keyboard Hunt');
A.eq(W.needsModelTitle(nm.id), false, 'a model-written summary is NOT the placeholder — no further retries');
const nm2 = W.create(null);
nm2.history.push({ role: 'user', content: 'plan a weekend trip to portland with a food focus', ts: 1 });
W.autoTitle(nm2.id, 'plan a weekend trip to portland with a food focus');
W.rename(nm2.id, W.deriveTitle('plan a weekend trip to portland with a food focus'));
A.eq(W.needsModelTitle(nm2.id), false, 'a MANUAL rename to the exact placeholder text still locks it (titleAuto wins)');
A.eq(W.needsModelTitle('ws_no_such'), false, 'unknown id is simply not eligible');

/* ---------- isLowSignal + titleBasis: small talk never becomes a title ---------- */
A.eq(W.isLowSignal('hey'), true, 'a bare greeting is low-signal');
A.eq(W.isLowSignal('  Hi!!  '), true, 'punctuation/case around a greeting does not add signal');
A.eq(W.isLowSignal('good morning, how are you doing'), true, 'a whole sentence of pleasantries is still low-signal');
A.eq(W.isLowSignal('heyyy'), true, 'stretched greetings ("heyyy") are still greetings');
A.eq(W.isLowSignal('ok thanks'), true, 'pure acks are low-signal');
A.eq(W.isLowSignal('hey go do research on business ideas'), false, 'one content word flips the message substantive');
A.eq(W.isLowSignal('summarize the news'), false, 'a terse directive is substantive');
A.eq(W.isLowSignal(''), true, 'empty is low-signal');
A.eq(W.isLowSignal('???'), true, 'punctuation-only is low-signal');

W.reset();
const tb = W.create(null);
tb.history.push({ role: 'user', content: 'hey', ts: 1 });
A.eq(W.titleBasis(tb.id), null, 'an all-small-talk session has NO title basis (no model call to make)');
A.eq(W.titleBasis(tb.id, 'hi there'), null, 'a low-signal fallback text does not manufacture a basis');
A.eq(W.titleBasis(tb.id, 'check why starnessos.com does not resolve'), 'check why starnessos.com does not resolve',
  'a substantive fallback (this turn, not yet in history) becomes the basis');
tb.history.push({ role: 'user', content: 'check why starnessos.com does not resolve', ts: 2 });
tb.history.push({ role: 'user', content: 'thanks', ts: 3 });
tb.history.push({ role: 'user', content: 'now check the www subdomain too', ts: 4 });
const basis = W.titleBasis(tb.id);
A.ok(basis.indexOf('starnessos.com') >= 0 && basis.indexOf('www subdomain') >= 0, 'basis = founding directive + latest substantive turns');
A.ok(basis.indexOf('hey') !== 0 && basis.indexOf('thanks\n') < 0, 'small-talk turns are skipped from the basis');

/* ---------- a /goal session is named from its GOAL, never the station's continuation prompt (org P29-sys x P26) ---------- */
{
  const GL = require('../frontend/app/goalloop.js');
  W.reset();
  const gs = W.create(null);
  const step = GL.continuationPrompt(GL.create('ship the landing page', { now: 1 }));
  gs.history.push({ role: 'user', content: step, ts: 1 });
  A.eq(W.titleBasis(gs.id), 'ship the landing page', 'a goal step feeds the model title its goal, not the marker prompt');
  A.eq(W.titleBasis(W.create(null).id, step), 'ship the landing page', '…also as the not-yet-stored fallback turn');
  A.ok(W.autoTitle(gs.id, 'ship the landing page') && W.titleOf(gs) === 'ship the landing page', 'the instant placeholder is the goal');
  A.eq(W.needsModelTitle(gs.id), true, '…and it is still the placeholder, so the model upgrade still runs on it');
  const legacy = W.create(null);
  legacy.history.push({ role: 'user', content: '[Continuing toward your standing goal]\nGoal: fix the build\n\nContinue working toward this goal. ', ts: 1 });
  A.eq(W.titleBasis(legacy.id), 'fix the build', 'a pre-org-pass step counts as its goal too');
  const brief = W.create(null);
  brief.history.push({ role: 'user', content: step, from: 'nova', ts: 1 });
  A.eq(W.titleBasis(brief.id), step.replace(/\s+/g, ' ').trim().slice(0, 300), 'a delegated brief keeps its own words');
}

/* ---------- healing: a weak model title (minted from a small-talk opener) upgrades ONCE real work appears ---------- */
W.reset();
const hw = W.create(null);
hw.history.push({ role: 'user', content: 'hey', ts: 1 });
W.autoTitle(hw.id, 'hey');
A.eq(W.needsModelTitle(hw.id), true, 'the machine placeholder is always upgrade-eligible');
W.retitle(hw.id, 'Casual Greeting Exchange');   // what a pre-upgrade build minted from "hey"
A.eq(W.needsModelTitle(hw.id), false, 'a greeting-only session does NOT churn retries on its weak title');
hw.history.push({ role: 'user', content: 'research the best budget mechanical keyboards', ts: 2 });
A.eq(W.needsModelTitle(hw.id), true, 'once real work lands, the weak small-talk title earns a healing upgrade');
A.ok(W.retitle(hw.id, 'Budget Keyboard Research', true) === true, 'the healing upgrade applies (strong)');
A.eq(hw.titleStrong, true, 'a strong retitle marks the terminal rung');
A.eq(W.needsModelTitle(hw.id), false, 'a strong title never re-enters the upgrade ladder');
hw.history.push({ role: 'user', content: 'also compare switch types in depth', ts: 3 });
A.eq(W.needsModelTitle(hw.id), false, 'later substantive turns do not churn a strong title');
const dumpedStrong = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedStrong);
A.eq(W.get(hw.id).titleStrong, true, 'titleStrong survives a save/load round-trip');
A.eq(W.needsModelTitle(hw.id), false, 'the strong lock still holds after reload');

/* ---------- hybrid-honest lanes: a real run auto-advances todo->active ---------- */
W.reset();
const c = W.create('write a report');
A.eq(c.lane, 'todo', 'pre-run lane is to-do');
A.ok(W.appendRun(c.id, 'run_1') === true, 'appendRun files the runId');
A.eq(c.lane, 'active', 'first real run auto-advances to active');
A.ok(W.appendRun(c.id, 'run_1') === true, 'duplicate runId tolerated');
A.eq(c.runIds.length, 1, 'runIds deduped');
A.ok(W.appendRun(c.id, 'run_2') && c.runIds.length === 2, 'second distinct run appended');
A.eq(c.lane, 'active', 'further runs leave it active (not auto-shipped)');
A.ok(W.setLane(c.id, 'shipped') === true, "'shipped' is set deliberately");
A.eq(c.lane, 'shipped', 'lane is now shipped');
A.ok(W.setLane(c.id, 'bogus') === false, 'invalid lane rejected');

/* ---------- per-stream cost isolation (truthful telemetry, no double-count) ---------- */
W.reset();
const x = W.create('stream X'); const y = W.create('stream Y');
W.addCost(x.id, { tokens: 100, usd: 0.01, calls: 1 });
W.addCost(x.id, { tokens: 50, usd: 0.005, calls: 1 });
W.addCost(y.id, { tokens: 7, usd: 0.001, calls: 1 });
A.eq(W.costOf(x.id), { tokens: 150, usd: 0.015, calls: 2 }, 'X cost sums only X deltas');
A.eq(W.costOf(y.id), { tokens: 7, usd: 0.001, calls: 1 }, 'Y cost is isolated from X');

/* ---------- deliverables filed onto the stream ---------- */
W.recordDeliverable(x.id, { title: 'report.md', kind: 'file', runId: 'run_9', t: 1700000001000 });
A.eq(x.deliverables.length, 1, 'deliverable recorded');
A.eq(x.deliverables[0].title, 'report.md', 'deliverable title kept');
A.eq(x.deliverables[0].runId, 'run_9', 'deliverable runId synthesized by caller is stored');

/* ---------- pin / archive / delete protect General; active falls back ---------- */
W.reset();
const gen = W.generalId();
const m = W.create('mission');
A.ok(W.pin(m.id, true) && W.get(m.id).pinned, 'pin works');
A.ok(W.archive(gen, true) === false, 'General cannot be archived');
A.ok(W.del(gen) === false, 'General cannot be deleted');
W.switch(m.id);
A.ok(W.archive(m.id, true) === true, 'archive a normal stream');
A.eq(W.activeId(), gen, 'archiving the active stream falls back to General');
A.ok(W.list().every(w => w.id !== m.id), 'archived hidden from default list');
A.ok(W.list({ includeArchived: true }).some(w => w.id === m.id), 'archived findable with includeArchived');
const n = W.create('to-delete'); W.switch(n.id);
A.ok(W.del(n.id) === true && W.activeId() === gen, 'delete removes and falls back to General');

/* ---------- search over title + body ---------- */
W.reset();
const s = W.create('candle market');
s.history.push({ role: 'user', content: 'research the 2026 candle market and write candles.md' });
const hits = W.search('candles.md');
A.ok(hits.length === 1 && hits[0].id === s.id, 'search matches a message body');
A.ok(/candles\.md/.test(hits[0].snippet), 'search returns a snippet around the match');
A.ok(W.search('CANDLE MARKET').length === 1, 'search matches title, case-insensitive');
A.eq(W.search('   ').length, 0, 'blank query -> no hits');

/* ---------- importTasks: station kanban col -> lane, empty history ---------- */
W.reset();
const made = W.importTasks([
  { id: 't1', title: 'todo card', col: 'todo', t: 1 },
  { id: 't2', title: 'doing card', col: 'doing', t: 2 },
  { id: 't3', title: 'done card', col: 'done', t: 3 },
  { id: 't4', title: 'weird card', col: 'mystery', t: 4 }
]);
A.eq(made.map(w => w.lane), ['todo', 'active', 'shipped', 'todo'], 'col->lane map (unknown col -> todo)');
A.ok(made.every(w => w.history.length === 0), 'imported cards start with empty history');
A.ok(W.list().some(w => w.title === 'doing card'), 'imported cards become real workstreams in the store');
// every legacy kanban card was a BOARD card — without an explicit kind, make()'s lane inference read
// the 'doing' (active-lane) card as a chat and silently dropped it off the board it was imported onto.
A.ok(made.every(w => w.kind === 'task'), 'ALL imported kanban cards are kind:task (a doing card must not vanish from the board)');

/* ---------- ensureGeneral never adopts a board task as the chat home ---------- */
const gBefore = W.generalId();
W.init({
  workstreams: [{ id: 'orphan_task', title: null, lane: 'todo', kind: 'task' }],
  activeId: null, generalId: null   // no General in the slice — ensureGeneral must MINT one
});
A.ok(W.generalId() !== 'orphan_task', 'an untitled board task is never adopted as General');
A.eq(W.get(W.generalId()).kind, 'chat', 'the minted General is a chat');
A.ok(W.get('orphan_task') && W.get('orphan_task').kind === 'task', 'the orphan task survives as a normal task');
void gBefore;

/* ---------- serialize round-trips ---------- */
W.reset(); W.create('round trip');
const dumped = W.serialize();
A.ok(Array.isArray(dumped.workstreams) && dumped.activeId && dumped.generalId, 'serialize shape');
const reactiveId = W.init(JSON.parse(JSON.stringify(dumped))).id;
A.eq(reactiveId, dumped.activeId, 'init(serialize()) preserves the active stream');
A.eq(W.list().length, 2, 'round-trip preserves both streams');

/* ---------- multi-agent: create({agentId}) binds, setAgent re-binds, both reject a bad id ---------- */
W.reset();
const def = W.create('hero stream');
A.eq(def.agentId, 'agent', 'a stream defaults to the hero agentId');
const sum = W.create('researcher stream', { agentId: 'researcher-2' });
A.eq(sum.agentId, 'researcher-2', 'create({agentId}) binds the stream to a summoned agent');
const activeBeforeScout = W.activeId();
const scout = W.create('scout stream', { agentId: 'scout-3', activate: false });
A.eq(scout.agentId, 'scout-3', 'create({agentId, activate:false}) binds the inactive specialist stream');
A.eq(W.activeId(), activeBeforeScout, 'creating an inactive specialist stream does NOT hijack active COMMS');
A.ok(W.setAgent(def.id, 'analyst_7') === true, 'setAgent re-binds a stream to another agent');
A.eq(W.get(def.id).agentId, 'analyst_7', 'the new binding is stored');
A.ok(W.setAgent(def.id, '../evil') === false, 'setAgent rejects a non-conforming agentId (path-safety)');
A.eq(W.get(def.id).agentId, 'analyst_7', 'a rejected setAgent leaves the prior binding intact');
A.ok(W.setAgent('nope', 'researcher-2') === false, 'setAgent on an unknown stream -> false');

/* ---------- adopt(id): caller-chosen id, idempotent, never hijacks active (the cron-session seam) ---------- */
W.reset();
const activeBeforeAdopt = W.activeId();
const cronId = 'cron-2f1a9c00-1111-4222-8333-444455556666';
const ad = W.adopt({ id: cronId, title: 'Daily digest', agentId: 'cron_daily', lane: 'active', history: [{ role: 'user', content: 'summarize the day' }] });
A.eq(ad.id, cronId, 'adopt uses the caller-chosen id verbatim');
A.eq(ad.title, 'Daily digest', 'adopt carries the title');
A.eq(ad.agentId, 'cron_daily', 'adopt binds the routine agent');
A.eq(ad.lane, 'active', 'adopt honors the lane');
A.eq(ad.history.length, 1, 'adopt seeds history');
A.eq(W.activeId(), activeBeforeAdopt, 'adopt does NOT hijack the active stream (appears without stealing focus)');
A.ok(W.list().some(x => x.id === cronId), 'the adopted stream is listed');
const ad2 = W.adopt({ id: cronId, title: 'different title' });
A.ok(ad2 === ad, 'adopt is idempotent — re-adopting the same id returns the existing record untouched');
A.eq(W.get(cronId).title, 'Daily digest', 'a re-adopt never stomps the existing title/history');

/* ---------- deleted-session tombstones: adopt() can never resurrect a deleted id ---------- */
W.reset();
const shopId = 'workshop-abc123';
W.adopt({ id: shopId, title: '⚒ built while you were away', lane: 'active' });
A.ok(W.del(shopId) === true, 'delete the adopted deliverable session');
A.ok(W.isDeleted(shopId) === true, 'the deleted id is tombstoned');
A.eq(W.adopt({ id: shopId, title: 're-mint attempt' }), null, 'adopt REFUSES a tombstoned id (the restart-resurrection bug)');
A.ok(!W.list({ includeArchived: true }).some(w => w.id === shopId), 'the deleted session did not re-form');
// the tombstone survives a save/load round-trip — "deleted forever" must outlive a restart.
const tombDump = W.serialize();
A.ok(Array.isArray(tombDump.deletedIds) && tombDump.deletedIds.indexOf(shopId) >= 0, 'serialize carries deletedIds');
W.init(JSON.parse(JSON.stringify(tombDump)));
A.ok(W.isDeleted(shopId) === true, 'tombstone survives init(serialize()) — a restart cannot resurrect');
A.eq(W.adopt({ id: shopId, title: 'post-restart re-mint' }), null, 'post-restart adopt still refused');
// revive:true is the ONE deliberate re-open path (the Commander clicked "review the work").
const revived = W.adopt({ id: shopId, title: 'revived on purpose', revive: true });
A.ok(revived && revived.id === shopId, 'adopt({revive:true}) deliberately brings the session back');
A.ok(W.isDeleted(shopId) === false, 'revive clears the tombstone (the session behaves normally again)');
// reset (NEW AGENT) clears tombstones with everything else.
W.del(shopId); A.ok(W.isDeleted(shopId), 're-deleted before reset');
W.reset();
A.ok(W.isDeleted(shopId) === false, 'reset clears tombstones (a fresh Commander inherits none)');

/* ---------- TASK-BOARD TRUTH: kind field ('task' = board card, 'chat' = rail-only session) ---------- */
W.reset();
// create() defaults to 'chat' — a plain new stream (summon/newWorkstream) is a session, not a board task.
const chatWs = W.create('plain session');
A.eq(chatWs.kind, 'chat', 'create() defaults kind to chat (a session is not a board task)');
// create({kind:'task'}) mints a board card (addTask / recipe mission / goal milestone / /background).
const taskWs = W.create('board directive', { kind: 'task', activate: false });
A.eq(taskWs.kind, 'task', 'create({kind:task}) mints a board task');
A.eq(taskWs.lane, 'todo', 'a new task still starts in to-do');
// appendRun advances a task todo->active but the kind is unchanged (still a board card while running).
A.ok(W.appendRun(taskWs.id, 'run_t1') === true, 'appendRun files the run on the task');
A.eq(taskWs.lane, 'active', 'appendRun still advances todo->active');
A.eq(taskWs.kind, 'task', 'a run does NOT change kind — a task stays a task while in progress');
// a chat that gets a run auto-advances to active too, but must NEVER become a board task.
A.ok(W.appendRun(chatWs.id, 'run_c1') === true, 'appendRun files the run on the chat');
A.eq(chatWs.lane, 'active', 'a chat with a real run auto-advances todo->active (rail state)');
A.eq(chatWs.kind, 'chat', 'a run does NOT promote a chat to a task (it stays off the board)');

/* ---------- init() upgrade inference for PRE-UPGRADE saves (no kind field) ---------- */
// A saved slice from before this change carries no `kind`. Infer: the two lanes only a deliberate board action
// can produce (todo/shipped) => task; everything else (active sessions, General) => chat.
W.init({
  workstreams: [
    { id: 'ws_general', title: null, lane: 'active' },      // General (no kind) -> chat
    { id: 'old_todo', title: 'queued task', lane: 'todo' },   // a board card that never ran -> task
    { id: 'old_shipped', title: 'finished task', lane: 'shipped' }, // a shipped card -> task
    { id: 'old_active', title: 'ran session', lane: 'active' }       // an auto-advanced session -> chat
  ],
  activeId: 'ws_general', generalId: 'ws_general'
});
A.eq(W.get('ws_general').kind, 'chat', 'upgrade infer: General (active, no kind) -> chat');
A.eq(W.get('old_todo').kind, 'task', 'upgrade infer: a todo card with no kind -> task');
A.eq(W.get('old_shipped').kind, 'task', 'upgrade infer: a shipped card with no kind -> task');
A.eq(W.get('old_active').kind, 'chat', 'upgrade infer: an active (auto-advanced) session with no kind -> chat');

/* ---------- kind is preserved verbatim through serialize/init (no re-inference on a saved kind) ---------- */
// a chat card that was manually pushed to a board lane (todo/shipped) still round-trips as chat — the saved
// kind wins over the lane inference, so init never re-classifies a record that already declared its kind.
W.init({
  workstreams: [
    { id: 'ws_general', title: null, lane: 'active', kind: 'chat' },
    { id: 'kept_task', title: 'a task in active', lane: 'active', kind: 'task' },   // task in active lane, kept
    { id: 'kept_chat', title: 'a chat in todo', lane: 'todo', kind: 'chat' }         // chat in todo lane, kept
  ],
  activeId: 'ws_general', generalId: 'ws_general'
});
A.eq(W.get('kept_task').kind, 'task', 'a saved kind:task in the active lane is kept (not re-inferred to chat)');
A.eq(W.get('kept_chat').kind, 'chat', 'a saved kind:chat in the todo lane is kept (not re-inferred to task)');
const dumpedKind = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedKind);
A.eq(W.get('kept_task').kind, 'task', 'kind survives a serialize/init round-trip (task)');
A.eq(W.get('kept_chat').kind, 'chat', 'kind survives a serialize/init round-trip (chat)');

/* ---------- projectRoot: the Projects-rail session anchor (additive; round-trips; setProjectRoot) ---------- */
{
  const anchored = W.create('repo work', { activate: false, projectRoot: 'C:\\proj\\repo' });
  A.eq(anchored.projectRoot, 'C:\\proj\\repo', 'create() stores the projectRoot anchor');
  const plain = W.create('plain chat', { activate: false });
  A.eq(plain.projectRoot, null, 'a session created without a project reads null (never a guessed root)');
  A.eq(W.setProjectRoot(plain.id, 'C:\\proj\\repo'), true, 'setProjectRoot stamps a live session');
  A.eq(W.get(plain.id).projectRoot, 'C:\\proj\\repo', 'stamp landed');
  A.eq(W.setProjectRoot(plain.id, null), true, 'null clears the anchor');
  A.eq(W.get(plain.id).projectRoot, null, 'anchor cleared');
  A.eq(W.setProjectRoot('nope', '/x'), false, 'unknown id refused');
  const dumpedRoot = JSON.parse(JSON.stringify(W.serialize()));
  W.init(dumpedRoot);
  A.eq(W.get(anchored.id).projectRoot, 'C:\\proj\\repo', 'projectRoot survives a serialize/init round-trip');
}

/* ---------- lastRunOk: a run that DIED can never read as DONE on the board (truthful telemetry) ---------- */
W.reset();
const fr = W.create('failing task', { kind: 'task' });
A.eq(fr.lastRunOk, null, 'a fresh stream has no run outcome (null = unknown)');
W.appendRun(fr.id, 'run_f1');
A.eq(fr.lastRunOk, null, 'a run in flight has no outcome yet');
A.ok(W.noteRunEnd(fr.id, 'run_f1', false) === true, 'noteRunEnd settles the failure');
A.eq(fr.lastRunOk, false, 'the failed outcome is stored');
W.appendRun(fr.id, 'run_f2');
A.eq(fr.lastRunOk, null, 'a NEW run resets the outcome to unknown (a retry must not inherit the old failure)');
A.ok(W.noteRunEnd(fr.id, 'run_f1', true) === false, 'a STALE runId cannot settle the current run');
A.eq(fr.lastRunOk, null, 'the stale callback was refused — outcome still unknown');
A.ok(W.noteRunEnd(fr.id, 'run_f2', true) === true, 'the current run settles ok');
A.eq(fr.lastRunOk, true, 'the success outcome is stored');
A.ok(W.appendRun(fr.id, 'run_f2') === true && fr.lastRunOk === true, 'a dup re-file of the SAME run does not erase a settled outcome');
A.ok(W.noteRunEnd(fr.id, 'run_never', false) === false, 'a runId that was never filed is refused (unanchored outcome)');
A.ok(W.noteRunEnd('ws_no_such', 'run_f2', false) === false, 'unknown stream refused');
const noRun = W.create('never ran', { kind: 'task', activate: false });
A.ok(W.noteRunEnd(noRun.id, 'run_x', true) === false, 'a stream with NO filed runs cannot take an outcome');
W.noteRunEnd(fr.id, 'run_f2', false);   // flip to failed, then prove it survives persistence
const dumpedRun = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedRun);
A.eq(W.get(fr.id).lastRunOk, false, 'lastRunOk survives a serialize/init round-trip');
A.eq(W.get(noRun.id).lastRunOk, null, 'a never-ran stream round-trips as unknown (null), never invented');

/* ---------- deleting a live stream fails closed at the destructive operation ---------- */
const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const deleteWorkstreamSource = A.fnBody(appSource, 'function deleteWorkstream(id, groupDeleted)');
A.ok(deleteWorkstreamSource && deleteWorkstreamSource.length < 5000, 'deleteWorkstream source is extracted exactly');

function deletionHarness(busy) {
  const events = [];
  const streams = new Map([['work-1', { id: 'work-1', title: 'Long task', agentId: 'scout' }]]);
  const ctx = { events, streams, busy };
  const remove = new Function('CTX', `
    const Workstreams = {
      get: id => CTX.streams.get(id),
      titleOf: w => (w && w.title) || 'New session',
      activeId: () => 'work-1',
      runIdsOf: id => { CTX.events.push('runs:' + id); return ['run_w1']; },
      attachmentRefs: id => [{ path: '.attachments/own.txt', agent: 'scout' }, { path: '.attachments/shared.txt', agent: 'scout' }],
      attachmentInUse: (path, agent) => path === '.attachments/shared.txt',
      del: id => { CTX.events.push('del:' + id); return CTX.streams.delete(id); }
    };
    const DossierStore = { purgeRuns: runIds => { CTX.events.push('dossier.purge:' + runIds.join(',')); return 0; } };
    const Chat = { forgetSession: (id, o) => { CTX.events.push('chat.forget:' + id + ':' + o.runIds.join(',') + ':' + o.files.map(f => f.path).join(',')); return {}; } };
    const Channels = { isBusy: id => { CTX.events.push('busy:' + id); return CTX.busy; } };
    const SFX = { bad: () => CTX.events.push('sfx.bad') };
    const StationUI = { notify: (message, tone) => CTX.events.push('notify:' + tone + ':' + message) };
    function loadActiveStream() { CTX.events.push('loadActiveStream'); }
    function renderRail() { CTX.events.push('rail'); }
    function persist() { CTX.events.push('persist'); }
    ${deleteWorkstreamSource}
    return deleteWorkstream;
  `)(ctx);
  return { remove, streams, events };
}

const busyDeletion = deletionHarness(true);
A.eq(busyDeletion.remove('work-1'), false, 'busy workstream deletion is refused');
A.ok(busyDeletion.streams.has('work-1'), 'busy workstream remains in the rail store');
A.eq(busyDeletion.events.filter(e => e.startsWith('del:')).length, 0, 'busy refusal never calls the destructive store operation');
A.eq(busyDeletion.events.filter(e => e === 'persist').length, 0, 'busy refusal does not persist a tombstone');
A.eq(busyDeletion.events.filter(e => e === 'loadActiveStream').length, 0, 'busy refusal does not change the active stream');
A.ok(busyDeletion.events.some(e => e.includes('stop this session before deleting it')), 'busy refusal explains the required stop');

const idleDeletion = deletionHarness(false);
A.eq(idleDeletion.remove('work-1'), true, 'idle workstream deletion succeeds');
A.ok(!idleDeletion.streams.has('work-1'), 'idle workstream is removed');
A.eq(idleDeletion.events.filter(e => e === 'del:work-1').length, 1, 'idle path deletes exactly once');
A.eq(idleDeletion.events.filter(e => e === 'persist').length, 1, 'idle deletion persists exactly once');
A.ok(idleDeletion.events.indexOf('runs:work-1') < idleDeletion.events.indexOf('del:work-1'), 'the runs of the session are read BEFORE the delete takes them');
A.eq(idleDeletion.events.filter(e => e.startsWith('dossier.purge:')), ['dossier.purge:run_w1'], 'the dossier drops the beliefs learned from the runs of the deleted session (commit 16)');
A.eq(idleDeletion.events.filter(e => e.startsWith('chat.forget:')), ['chat.forget:work-1:run_w1:.attachments/own.txt'], 'the page drops its run records and send-now lines, and deletes only the uploads no other session names');
A.eq(busyDeletion.events.filter(e => e.startsWith('dossier.purge:') || e.startsWith('chat.forget:')).length, 0, 'a refused delete purges nothing');
A.eq(idleDeletion.events.filter(e => e === 'loadActiveStream').length, 1, 'deleting the open idle stream reloads General');

/* A terminal reason is durable and belongs only to the most recent actual run. */
W.init({}); W.adopt({ id: 'outcome', agentId: 'nova' });
W.appendRun('outcome', 'run1'); W.noteRunEnd('outcome', 'run1', true, 'budget');
A.eq(W.get('outcome').lastRunReason, 'budget', 'completed transport retains the actual budget outcome');
W.appendRun('outcome', 'run1'); W.noteRunEnd('outcome', 'run1', true);
A.eq(W.get('outcome').lastRunReason, 'budget', 'duplicate filing and old callers cannot erase a measured reason');
W.init(JSON.parse(JSON.stringify(W.serialize())));
A.eq(W.get('outcome').lastRunReason, 'budget', 'reason survives reload');
W.appendRun('outcome', 'run2');
A.eq(W.get('outcome').lastRunReason, '', 'a new run starts without a stale reason');
A.ok(!W.noteRunEnd('outcome', 'run1', false, 'error'), 'an old run cannot settle a newer run');
A.eq(W.get('outcome').lastRunReason, '', 'stale outcome left current reason unknown');
W.noteRunEnd('outcome', 'run2', false, ' error ');
A.eq(W.get('outcome').lastRunReason, 'error', 'reason is normalized');
W.noteRunEnd('outcome', 'run2', false, 'x'.repeat(200));
A.eq(W.get('outcome').lastRunReason.length, 80, 'saved reasons are bounded');
W.adopt({ id: 'legacy' });
A.eq(W.get('legacy').lastRunReason, '', 'old saves default to unknown');

/* Backfilling old work never supplants an already-known newer run's truth or activity. */
W.init({ activeId: 'recovery-order', generalId: 'general', workstreams: [
  { id: 'general', title: null },
  { id: 'recovery-order', title: 'Recovered work', kind: 'task', lane: 'shipped', runIds: ['newer'], lastRunOk: true, lastRunReason: 'done', lastActiveAt: 9000, lastReadAt: 9000 }
] });
const recoveredOrder = W.get('recovery-order');
A.ok(W.appendRun(recoveredOrder.id, 'older', 1000, 'newer'), 'recovery inserts previously missing older work');
A.eq(recoveredOrder.runIds, ['older', 'newer'], 'known server ordering keeps the newer run last');
A.eq([recoveredOrder.lastRunOk, recoveredOrder.lastRunReason], [true, 'done'], 'older history preserves the latest successful outcome');
A.eq([recoveredOrder.lastActiveAt, recoveredOrder.lastReadAt, recoveredOrder.lane], [9000, 9000, 'shipped'], 'history insertion never changes current activity, reading, or task state');
A.ok(!W.noteRunEnd(recoveredOrder.id, 'older', false, 'error'), 'an older recovered failure cannot settle the newer run');
W.init(JSON.parse(JSON.stringify(W.serialize())));
A.eq(W.get(recoveredOrder.id).runIds, ['older', 'newer'], 'the restored ordering survives save and reload');
W.appendRun(recoveredOrder.id, 'latest', 10000, 'unknown-anchor');
A.eq(W.get(recoveredOrder.id).runIds, ['older', 'newer', 'latest'], 'an unknown anchor retains ordinary append behavior');
A.eq([W.get(recoveredOrder.id).lastRunOk, W.get(recoveredOrder.id).lastRunReason, W.get(recoveredOrder.id).lastActiveAt], [null, '', 10000], 'ordinary appends still reset outcome and advance the event time');
W.noteRunEnd(recoveredOrder.id, 'latest', true, 'done'); W.appendRun(recoveredOrder.id, 'older', 1000, 'newer');
A.eq(W.get(recoveredOrder.id).runIds, ['older', 'newer', 'latest'], 'a duplicate recovery neither inserts twice nor changes ordering');
A.eq([W.get(recoveredOrder.id).lastRunOk, W.get(recoveredOrder.id).lastRunReason], [true, 'done'], 'duplicate recovery preserves the latest outcome');

/* ---- comms-threads-ui-03: WHEN a session joined its project (projectRootAt). chat.js resolves an unstamped own reply's
   relative links at the project root only when the reply is newer than that moment, else in the agent's workspace ---- */
{
  const realNow = Date.now;
  let clock = 5000; Date.now = () => clock;
  const born = W.create(null, { projectRoot: 'C:/proj', activate: false });
  A.eq([born.projectRoot, born.projectRootAt], ['C:/proj', born.createdAt], 'a session born in a project joined it when it was created');
  const plain = W.create(null, { activate: false });
  A.eq(plain.projectRootAt, null, 'a session with no project has no join time');
  clock = 9000; W.setProjectRoot(plain.id, 'C:/proj');
  A.eq(W.get(plain.id).projectRootAt, 9000, 'a session that joins a project later is stamped at that moment');
  clock = 12000; W.setProjectRoot(plain.id, 'C:/proj');
  A.eq(W.get(plain.id).projectRootAt, 9000, 'naming the same root again does not move the stamp');
  W.setProjectRoot(plain.id, 'C:/other');
  A.eq(W.get(plain.id).projectRootAt, 12000, 'moving to another project re-stamps it');
  W.setProjectRoot(plain.id, null);
  A.eq([W.get(plain.id).projectRoot, W.get(plain.id).projectRootAt], [null, null], 'leaving the project clears both');
  clock = 15000;
  const fresh = W.adopt({ id: 'adopt-rooted', projectRoot: 'C:/proj', createdAt: 14000 });
  A.eq(fresh.projectRootAt, 14000, 'an adopted thread born in a project joined it when it was created');
  const late = W.adopt({ id: 'adopt-late' });
  A.eq(late.projectRootAt, null, '(an adopted thread with no project has no join time)');
  clock = 16000; W.adopt({ id: 'adopt-late', projectRoot: 'C:/proj' });
  A.eq([W.get('adopt-late').projectRoot, W.get('adopt-late').projectRootAt], ['C:/proj', 16000], 'a thread that adopts its root later is stamped at that moment');
  W.init({ workstreams: [{ id: 'saved-old', title: 'old', projectRoot: 'C:/proj', createdAt: 100 }, { id: 'saved-new', title: 'new', projectRoot: 'C:/proj', createdAt: 100, projectRootAt: 300 }] });
  A.eq(W.get('saved-old').projectRootAt, null, 'a session saved before the stamp existed is never given an invented one');
  A.eq(W.get('saved-new').projectRootAt, 300, 'a saved stamp survives the reload');
  W.init(JSON.parse(JSON.stringify(W.serialize())));
  A.eq([W.get('saved-old').projectRootAt, W.get('saved-new').projectRootAt], [null, 300], 'and survives a save and reload round trip');
  Date.now = realNow;
}

/* ---------- a delivery session's name is its title alone (Andrew 10-27: the ⚒ prefix pushed it off the rail's title column) ---------- */
{
  W.reset();
  W.adopt({ id: 'workshop-old1', title: '⚒ Pricing page v2', lane: 'active' });
  W.adopt({ id: 's-forge', title: '⚒ my forge notes', lane: 'active' });
  A.eq(W.titleOf('workshop-old1'), 'Pricing page v2', 'a delivery session stored as "⚒ <title>" before 10-27 is named by its title alone');
  A.eq(W.get('workshop-old1').title, '⚒ Pricing page v2', 'the stored title is untouched (only the name it is shown by)');
  A.eq(W.titleOf('s-forge'), '⚒ my forge notes', 'a session someone named with a hammer keeps it: only delivery sessions carried the mark');
}
/* ---------- a saved history that NAMES rows the station holds (save v7, history by reference): the record keeps it whole, tells the rail the truth, hands it back as it was ---------- */
{
  const unreadHistory = () => [{ $ref: '1,1,1', res: { '1': { typedText: 'typed' } } }];   // rows 1..3 named, none held
  const record = (id, history, at, titled) => ({ id, title: titled ? 'roadmap talk' : null, kind: 'chat', history, runIds: [], createdAt: at, lastActiveAt: at, lastReadAt: at });
  const note = { role: 'system', sys: true, content: '— a note the page wrote —', ts: 20 };
  const ask = { role: 'user', content: 'a question typed after the last read', ts: 30 };
  const answered = { role: 'assistant', content: 'the newest answer', ts: 40 };
  const doc = () => ({ workstreams: [
    record('titled', unreadHistory(), 50, true),
    record('all', unreadHistory(), 100),
    record('tail', unreadHistory().concat([note, answered]), 200),
    record('head', [ask].concat(unreadHistory()), 300),
    record('plain', [ask, answered], 400),
    record('blank', [], 500)
  ], activeId: 'plain', generalId: 'plain' });
  W.init(doc());
  const all = W.get('all'), tail = W.get('tail'), head = W.get('head');

  A.eq([W.needsHydration('all'), W.needsHydration('tail'), W.needsHydration('plain'), W.needsHydration('blank')], [true, true, false, false], 'a session whose saved history names rows needs them read back');
  A.eq(W.pendingHydration(), ['head', 'tail', 'all', 'titled'], 'and they are read the most recently active first');
  A.eq(all.history, [], 'a record holds only the rows the page keeps itself: here none');
  A.eq(tail.history, [note, answered], '…in order, the very same objects it was given (inline rows)');
  A.ok(!Object.keys(all).includes('historyRef') && !JSON.stringify(all).includes('$ref'), 'the packed form is never an enumerable field: a record can not be stringified carrying a second copy of its history');

  A.eq([W.isUntouched(all), W.isUntouched(W.get('blank'))], [false, true], 'a packed history is messages, not a blank line');
  A.eq([W.turnCount(all), W.turnCount(tail), W.turnCount(W.get('plain')), W.turnCount('all')], [3, 5, 2, 3], 'the count names every row, packed ones included (by record or by id)');
  A.eq([W.hasHistory(all), W.hasHistory(W.get('blank')), W.hasUserTurn(all), W.hasUserTurn(W.get('blank'))], [true, false, true, false], 'it has a history, and a Commander turn');
  A.eq(W.latestVisibleMessage(all), null, 'a fully packed session names no newest message: it cannot know it');
  A.eq(W.latestVisibleMessage(tail), answered, 'an inline tail after the packed run IS provably the newest message');
  A.eq(W.latestVisibleMessage(head), null, 'an inline row BEFORE a packed run is never taken for the newest: a stale line is worse than none');
  tail.history.splice(tail.history.indexOf(answered), 1);
  A.eq(W.latestVisibleMessage(tail), null, 'a newest row the page has since dropped is not shown as the newest');
  tail.history.push(answered);
  A.eq(W.latestVisibleMessage(tail), answered, '(the same row put back is the newest again)');
  A.eq(W.latestVisibleMessage(W.get('plain')), answered, '(control) an ordinary session reads as it always did');
  all.history.push(ask);
  A.eq(W.latestVisibleMessage(all), ask, 'a row pushed since boot is after every packed row, so it is the newest');
  all.history.length = 0;
  A.eq([W.titleBasis('titled', 'a substantive first message about the roadmap'), W.needsModelTitle('titled')], [null, false], 'no title is made of half a conversation');
  A.eq(W.exportConversation('all', 'json'), null, 'and no export');
  A.eq(W.previewArchive({ empty: true }).ids, ['blank'], 'archive-empty takes only the really blank session');

  // what a persist writes: the packed form as it was read, then whatever was pushed since; a copy only for such a session
  const saved = () => W.serialize().workstreams;
  A.eq(saved().find(w => w.id === 'all').history, unreadHistory(), 'a session nobody opened is written back exactly as it was read');
  A.eq(saved().find(w => w.id === 'tail').history, unreadHistory().concat([note, answered]), 'with its inline rows in place');
  A.ok(saved().find(w => w.id === 'plain') === W.get('plain') && saved().find(w => w.id === 'all') !== all, 'a session with all its rows is the live record, as before; the other is a copy that carries its packed form');
  tail.history.push(ask);
  A.eq(saved().find(w => w.id === 'tail').history, unreadHistory().concat([note, answered, ask]), 'a row pushed since follows the packed form');
  tail.history.splice(tail.history.indexOf(note), 1);
  A.eq(saved().find(w => w.id === 'tail').history, unreadHistory().concat([answered, ask]), 'an inline row the page dropped stays dropped, the packed run is untouched');
  tail.history.length = 0; tail.history.push(note, answered);
  W.init(JSON.parse(JSON.stringify(W.serialize())));
  A.eq(W.get('all').history, [], 'a save and a reload keep the packed form (nothing was read in between)');
  A.eq(W.serialize().workstreams.find(w => w.id === 'all').history, unreadHistory(), '…and writes it again');

  // reading the rows back: in place, once, and never over what the Commander removed meanwhile
  W.init(doc());
  const held = W.get('tail'), ref = held.historyRef;
  const rows = [{ rowId: 1, role: 'user', content: 'one' }, { rowId: 2, role: 'assistant', content: 'two', typedText: 'typed' }, { rowId: 3, role: 'user', content: 'three' }];
  held.history.push(ask);
  A.eq(W.hydrate('tail', rows.concat([note, answered]), { ref: {} }), false, 'a read of a packed form the session no longer holds puts nothing back');
  A.eq(held.history, [note, answered, ask], '…and changes nothing');
  A.eq(W.hydrate('tail', rows.concat([note, answered]), { ref }), true);
  A.eq(held.history, rows.concat([note, answered, ask]), 'the rows come back in place, the inline rows where they were, a row pushed meanwhile after them');
  A.eq([W.needsHydration('tail'), W.pendingHydration().includes('tail'), W.serialize().workstreams.includes(held)], [false, false, true], 'it is whole: no longer pending, handed out as the live record');
  W.init(doc());
  const dropper = W.get('tail'), dropperRef = dropper.historyRef;
  dropper.history.splice(dropper.history.indexOf(note), 1);
  W.hydrate('tail', rows.concat([note, answered]), { ref: dropperRef });
  A.eq(dropper.history, rows.concat([answered]), 'an inline row the page dropped while the rows were out is not brought back by the read');
  W.init(doc());
  const part = W.get('all'), partRef = part.historyRef;
  W.hydrate('all', [rows[0], rows[1], { $ref: '3' }], { ref: partRef });
  A.eq([part.history, W.needsHydration('all')], [[rows[0], rows[1]], true], 'a run the station could not return stays packed beside the rows that came back');
  A.eq(W.serialize().workstreams.find(w => w.id === 'all').history, [rows[0], rows[1], { $ref: '3' }], '…and a persist writes the proven rows and the reference');
  A.eq(W.latestVisibleMessage(part), null, 'a partly read session still names no newest message it cannot prove');

  // a clear or a replace takes the packed form with it; an undo puts it back as it was
  W.init(doc());
  const cleared = W.get('all'), clearedRef = cleared.historyRef;
  A.ok(W.clearConversation('all', { at: 5 }), 'a packed conversation can be cleared');
  A.eq([cleared.history, W.needsHydration('all'), W.turnCount(cleared)], [[], false, 0], 'nothing is left of it, packed or not');
  A.eq(W.hydrate('all', rows, { ref: clearedRef }), false, 'a read that was out when it was cleared brings nothing back');
  A.eq(cleared.history, [], 'nothing is resurrected');
  A.eq(W.undoLast(), true);
  A.eq([W.needsHydration('all'), W.serialize().workstreams.find(w => w.id === 'all').history], [true, unreadHistory()], 'undo puts the packed history back exactly as it was cleared');
  A.ok(W.setHistory('all', [ask, answered]) && !W.needsHydration('all') && W.get('all').history.length === 2, 'a history put in whole replaces what the packed form named');
  W.init(doc());
  W.reset();
  A.eq(W.all().some(w => w.historyRef), false, 'a reset leaves no packed form behind');

  // an element the page cannot read is kept whole and counted, never dropped
  W.init({ workstreams: [record('odd', [{ $ref: 'not a run' }, ask], 600)], activeId: 'odd', generalId: 'odd' });
  A.eq([W.needsHydration('odd'), W.get('odd').history, W.serialize().workstreams.find(w => w.id === 'odd').history], [true, [ask], [{ $ref: 'not a run' }, ask]], 'an unreadable element stays in the saved history as it was');
  W.reset();
}

/* ---------- SEALS AND PACKING AT THE SERIALIZE SEAM (save v7, history by reference, step S5) ----------
   A seal is the turn exactly as a successful station read returned it (Workstreams.sealTurns); serialize() packs a hydrated session's rows
   against the seals: a row the page still holds field for field becomes part of one reference, every other row stays inline where it is. */
{
  const HR = require('../frontend/app/historyref.js');
  const turn = (stream, rowId, role, extra) => Object.assign({ streamId: stream, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: 1000 + rowId, content: role + ' ' + rowId, rowId }, extra || null);
  const rowsOf = (stream, from, n) => Array.from({ length: n }, (_, i) => turn(stream, from + i, (from + i) % 2 ? 'user' : 'assistant'));
  const clone = v => JSON.parse(JSON.stringify(v));
  const rec = (id, history, extra) => Object.assign({ id, title: 'T ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1, lastActiveAt: 10, lastReadAt: 10 }, extra || null);
  const saved = id => W.serialize().workstreams.find(w => w.id === id);
  const refsOf = h => h.filter(el => el && typeof el.$ref === 'string');

  W.init({ workstreams: [rec('a', clone(rowsOf('a', 1, 6))), rec('b', clone(rowsOf('b', 7, 4))), rec('g', clone(rowsOf('g', 20, 2)), { conversationMode: 'group' })], activeId: 'a', generalId: 'a' });
  const live = W.get('a');
  A.eq(W.serialize().workstreams.includes(live), true, 'a page that has proved nothing saves the live records (nothing is packed without a seal)');
  A.eq(W.sealTurns('a', rowsOf('a', 1, 6)), 6, 'sealTurns keeps the six turns of a read');
  A.eq(W.sealed('a', 3), turn('a', 3, 'user'), 'a seal is the turn as it came back');
  A.ok(W.sealed('a', 3) !== rowsOf('a', 1, 6)[2] && W.sealed('a', 3) !== W.get('a').history[2], 'and a private copy: not the turn the read returned, not the row the page holds');
  const packed = saved('a');
  A.eq(refsOf(packed.history).length, 1, 'six sealed rows are one reference');
  A.eq(packed.history.length, 1, '...and nothing else');
  A.ok(packed !== live && W.serialize().workstreams.includes(W.get('b')), 'a session with sealed rows is saved as a copy; one with none is the live record');
  A.eq(live.history.length, 6, 'packing never touches the live rows');
  A.eq(HR.idsOf(packed.history), [1, 2, 3, 4, 5, 6], 'the reference names the six row ids');

  // what the page holds beyond a seal rides as residue; what it changed in a seal's own fields makes the row inline again, on the very next save
  live.history[1].stopNote = 'a note the page wrote';
  A.ok(JSON.stringify(saved('a').history).includes('a note the page wrote') && refsOf(saved('a').history).length === 1, 'a page-only field on a sealed row rides in the reference (residue)');
  live.history[3].content = 'changed after it was proved';
  const drifted = saved('a').history;
  A.ok(drifted.some(el => el && el.rowId === 4 && el.content === 'changed after it was proved'), 'a row changed in a field of its seal is saved inline, as it now is');
  A.eq(HR.idsOf(drifted), [1, 2, 3, 5, 6], '...and the others stay named (the run is cut around it)');
  live.history[3].content = 'assistant 4';
  A.eq(saved('a').history.length, 1, 'put back, it is named again (nothing is remembered about the old answer)');

  // a seal does not alias the page: a nested value changed in place is a change
  W.init({ workstreams: [rec('n', clone([turn('n', 1, 'user', { attachments: [{ id: 'x', name: 'one.png' }] })]))], activeId: 'n', generalId: 'n' });
  W.sealTurns('n', [turn('n', 1, 'user', { attachments: [{ id: 'x', name: 'one.png' }] })]);
  A.eq(saved('n').history.length, 1, '(control) a row equal to its seal, nested value included, is named');
  W.get('n').history[0].attachments[0].name = 'two.png';
  A.ok(saved('n').history[0].rowId === 1 && saved('n').history[0].attachments[0].name === 'two.png', 'a nested value changed in place makes the row inline again');

  // nor does a seal alias what the caller handed it: the read's own objects may be changed after they were kept
  W.init({ workstreams: [rec('al', clone([turn('al', 1, 'user', { attachments: [{ id: 'x', name: 'one.png' }] })]))], activeId: 'al', generalId: 'al' });
  const handed = [turn('al', 1, 'user', { attachments: [{ id: 'x', name: 'one.png' }] })];
  W.sealTurns('al', handed);
  handed[0].content = 'the read changed after it was kept'; handed[0].attachments[0].name = 'two.png';
  A.ok(typeof saved('al').history[0].$ref === 'string', 'what the caller does to a turn after handing it over does not reach its seal (a copy, nested values too): the row is still named');

  // not packed: a collided id, another stream's row, a note, a row with no id, a group chat
  W.init({ workstreams: [rec('c', clone([turn('c', 1, 'user'), { role: 'system', sys: true, content: 'a note', ts: 5 }, { role: 'user', content: 'no id', ts: 6 }, turn('c', 2, 'assistant', { streamId: 'other' }), turn('c', 3, 'user')])), rec('g', clone(rowsOf('g', 20, 2)), { conversationMode: 'group' })], activeId: 'c', generalId: 'c' });
  A.eq(W.sealTurns('c', [turn('c', 1, 'user'), turn('c', 2, 'assistant', { streamId: 'other' }), turn('c', 3, 'user', { idFrom: 'collision' }), { role: 'user', content: 'x' }, null, 'x']), 1, 'only a turn of this stream with a row id, not a collided one, is kept');
  W.sealTurns('g', rowsOf('g', 20, 2));
  const mixed = saved('c').history;
  A.eq([mixed.length, HR.idsOf([mixed[0]]), mixed[1].sys, mixed[2].content], [5, [1], true, 'no id'], 'the one sealed row is a reference of its own; the note, the row with no id, the other stream row and the collided one stay as they are, in place');
  A.eq(saved('g').history, W.get('g').history, 'a group chat has the backend copy of its rows: never packed');

  // what the station says is gone is not kept as proven: unseal drops those rows' seals and only those, and the row (if the page still holds it) is saved inline
  W.init({ workstreams: [rec('un', clone(rowsOf('un', 1, 5)))], activeId: 'un', generalId: 'un' });
  W.sealTurns('un', rowsOf('un', 1, 5));
  A.eq([W.unseal('un', [3, 99]), W.sealed('un', 3), W.sealed('un', 4) !== null, W.unseal('nobody', [1]), W.unseal('un', 'x')], [1, null, true, 0, 0], 'unseal drops the seals of the rows named, of that stream, and nothing else');
  A.eq(HR.idsOf(saved('un').history), [1, 2, 4, 5], '...so the row is saved inline where it is and the run is cut around it');

  // a stream the rows route cannot name keeps no seal: the station's ordinary read answers such an id with the GLOBAL stream (a restored copy's
  // "<id>~restored"), so what came back proves nothing about this session, and a reference the page could never read back would strand its rows
  W.init({ workstreams: [rec('copy~restored', clone(rowsOf('copy~restored', 1, 3))), rec('ok_id-1', clone(rowsOf('ok_id-1', 4, 2)))], activeId: 'ok_id-1', generalId: 'ok_id-1' });
  A.eq([W.sealTurns('copy~restored', rowsOf('copy~restored', 1, 3)), W.sealTurns('a'.repeat(65), rowsOf('x', 1, 1)), W.sealTurns('', rowsOf('x', 1, 1)), W.sealTurns('ok_id-1', rowsOf('ok_id-1', 4, 2))], [0, 0, 0, 2],
    'only a stream id the rows route takes ([A-Za-z0-9_-], 1-64) keeps seals');
  A.eq([saved('copy~restored').history.length, saved('ok_id-1').history.length], [3, 1], '...so the session it cannot name is saved whole, and its neighbour is named');

  // seals belong to this page's reading of the station: a re-init, a reset and a delete drop them
  W.init({ workstreams: [rec('a', clone(rowsOf('a', 1, 6))), rec('b', clone(rowsOf('b', 7, 4)))], activeId: 'a', generalId: 'a' });
  W.sealTurns('a', rowsOf('a', 1, 6)); W.sealTurns('b', rowsOf('b', 7, 4));
  A.eq([saved('a').history.length, saved('b').history.length], [1, 1], '(setup) two sealed sessions');
  W.del('b');
  A.eq([W.sealed('b', 7), W.sealed('a', 1) !== null], [null, true], 'deleting a session drops its seals and only its own');
  W.init({ workstreams: [rec('a', clone(rowsOf('a', 1, 6)))], activeId: 'a', generalId: 'a' });
  A.eq([W.sealed('a', 1), saved('a').history.length], [null, 6], 'a re-init starts from no seals: the rows are saved inline until they are read again');
  W.sealTurns('a', rowsOf('a', 1, 6)); W.reset();
  A.eq(W.sealed('a', 1), null, 'and so does a reset');

  // a session whose rows are not all here is saved as it was read, never packed again
  const run = HR.pack(clone(rowsOf('u', 1, 3)), { streamId: 'u', seal: k => { const id = Number(k.split(':')[1]); return turn('u', id, id % 2 ? 'user' : 'assistant'); } });
  W.init({ workstreams: [rec('u', run.concat([{ role: 'user', content: 'inline tail', ts: 99 }]))], activeId: 'u', generalId: 'u' });
  W.sealTurns('u', rowsOf('u', 1, 3));
  A.eq(saved('u').history, run.concat([{ role: 'user', content: 'inline tail', ts: 99 }]), 'an unhydrated session is saved verbatim even when its ids are sealed');

  // the sweep's list: inline keyed rows with no seal, newest session first, within the request bounds
  W.init({ workstreams: [rec('old', clone(rowsOf('old', 1, 3)), { lastActiveAt: 10 }), rec('new', clone(rowsOf('new', 4, 3)), { lastActiveAt: 90 }), rec('none', clone([{ role: 'user', content: 'legacy', ts: 1 }]), { lastActiveAt: 95 }),
    rec('packed', run.slice(), { lastActiveAt: 99 }), rec('mixed', run.concat([turn('mixed', 50, 'user')]), { lastActiveAt: 96 }), rec('grp', clone(rowsOf('grp', 30, 2)), { conversationMode: 'group', lastActiveAt: 98 })], activeId: 'new', generalId: 'new' });
  A.eq(W.sealCandidates().map(c => [c.streamId, c.rowIds]), [['new', [4, 5, 6]], ['old', [1, 2, 3]]], 'candidates: newest session first; none for a row with no id, a session that still names rows (its inline rows included) or a group chat');
  A.eq(W.sealCandidates({ maxIds: 4 }).map(c => [c.streamId, c.rowIds.length]), [['new', 3], ['old', 1]], 'the batch holds at most maxIds ids');
  A.eq(W.sealCandidates({ maxStreams: 1 }).map(c => c.streamId), ['new'], 'and at most maxStreams sessions');
  A.eq(W.sealCandidates({ any: true }).length, 1, 'any: just whether there is something left');
  W.sealTurns('new', rowsOf('new', 4, 3));
  A.eq(W.sealCandidates().map(c => c.streamId), ['old'], 'a sealed row is no longer a candidate');
  for (let k = 0; k < 2; k++) W.noteSealRead('old', [1, 2, 3], [1]);
  A.eq(W.sealCandidates().map(c => [c.streamId, c.rowIds]), [['old', [2, 3]]], 'an id the station answered is done; one it did not answer is asked again');
  W.noteSealRead('old', [2, 3], []);
  A.eq(W.sealCandidates(), [], 'and after three reads that did not answer it, left alone: nothing is left to ask');
  W.reset();
}
A.report('workstreams.test');
