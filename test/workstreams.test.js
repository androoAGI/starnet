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
A.ok(deleteWorkstreamSource && deleteWorkstreamSource.length < 3000, 'deleteWorkstream source is extracted exactly');

function deletionHarness(busy) {
  const events = [];
  const streams = new Map([['work-1', { id: 'work-1', title: 'Long task', agentId: 'scout' }]]);
  const ctx = { events, streams, busy };
  const remove = new Function('CTX', `
    const Workstreams = {
      get: id => CTX.streams.get(id),
      titleOf: w => (w && w.title) || 'New session',
      activeId: () => 'work-1',
      del: id => { CTX.events.push('del:' + id); return CTX.streams.delete(id); }
    };
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
A.report('workstreams.test');
