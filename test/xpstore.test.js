/* node test/xpstore.test.js - browser XP wiring for multi-agent level-up ownership.
   Locks the bug where a summoned worker's level-up was credited and animated on the overseer because
   XpStore read the focused agent instead of the event payload's agentId. Also locks the satisfaction-XP
   rule: run completions update counters, but positive user feedback drives XP and levels. */
'use strict';
const A = require('./_assert.js');

global.Xp = require('../frontend/app/xp.js');
const bus = A.makeBus();
global.U = { bus };
global.document = { getElementById: () => null };

const world = { setXp: [], pulse: [] };
global.World = {
  setXp(agentId, xp) { world.setXp.push({ agentId, xp }); },
  pulseLevelUp(agentId, level) { world.pulse.push({ agentId, level }); }
};

const notices = [];
const rosterSnapshots = [];
global.StationUI = {
  notify: (text, kind) => notices.push({ text, kind }),
  setRoster: list => rosterSnapshots.push(list.map(a => ({ id: a.id, level: a.stats && a.stats.level })))
};
// Notification diet (2026-08-18): XP flavor announces over COMMS broadcast only — the bell stays quiet.
const broadcasts = [];
global.Chat = { broadcast: (text, opts) => broadcasts.push({ text, opts }) };
let sfx = 0;
global.SFX = { level: () => { sfx++; } };
global.Tutorial = { onLevelUp: () => {} };

const { XpStore } = require('../frontend/app/xpstore.js');

const overseer = { id: 'agent', name: 'OVERSEER' };
const researcher = { id: 'researcher', name: 'RESEARCHER' };
const agents = new Map([['agent', overseer], ['researcher', researcher]]);
let focused = overseer;
let persists = 0;

XpStore.init({
  getAgent: (id) => agents.get(id || (focused && focused.id) || 'agent') || null,
  agents: () => Array.from(agents.values()),
  station: Xp.fresh(),
  persist: () => { persists++; }
});

function done(agentId, n) {
  bus.emit('agent.run.end', { agentId, runId: agentId + '-' + n, reason: 'done' });
}
function approve(agentId, n) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-fb-' + n, delta: 2, reason: 'kept' });
}
function reject(agentId, n) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-bad-' + n, delta: -1, reason: 'discarded' });
}
function notebookRating(agentId, n, rating, delta) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-note-' + n, delta, reason: rating });
}

for (let i = 1; i <= 4; i++) done('researcher', i);

A.eq(overseer.stats.level, 1, 'researcher runs do not level the overseer');
A.eq(researcher.stats.level, 1, 'run completions alone do not level the researcher');
A.eq(researcher.stats.xp, 0, 'run completions alone award no xp');
A.eq(researcher.stats.counters.tasksDone, 4, 'run completions still update researcher task counters');
A.eq(world.pulse.length, 0, 'no level pulse fires from run completions alone');

approve('researcher', 1);
approve('researcher', 2);
A.eq(rosterSnapshots.length, 0, 'ordinary XP ticks do not rebuild the crew manifest before its displayed level changes');
approve('researcher', 3);

A.eq(overseer.stats.level, 1, 'researcher feedback does not level the overseer');
A.eq(researcher.stats.level, 2, 'researcher owns its feedback-driven level-up stats');
A.eq(researcher.stats.counters.positiveFeedback, 3, 'researcher records positive feedback receipts');
A.eq(world.pulse, [{ agentId: 'researcher', level: 2 }], 'level-up pulse is addressed to the researcher');
A.ok(!world.pulse.some(p => p.agentId === 'agent'), 'no overseer pulse fires for a researcher level-up');
A.eq(notices.length, 0, 'notification diet: a level-up never toasts (COMMS + pulse + sting carry it)');
A.ok(broadcasts.some(b => /RESEARCHER REACHED LEVEL 2/.test(b.text)), 'the COMMS broadcast names the researcher');
A.ok(!broadcasts.some(b => /OVERSEER REACHED LEVEL 2/.test(b.text)), 'the broadcast does not name the overseer');
A.ok(world.setXp.some(x => x.agentId === 'researcher' && x.xp && x.xp.level === 2), 'world XP snapshot is stored under researcher');
A.ok(!world.setXp.some(x => x.agentId === 'agent' && x.xp && x.xp.level === 2), 'researcher XP snapshot is not stored under overseer');
A.ok(rosterSnapshots.some(list => list.some(a => a.id === 'researcher' && a.level === 2)), 'the left crew manifest receives the new researcher level immediately');
A.eq(sfx, 1, 'agent level-up sound fires once');
A.ok(persists >= 1, 'level-up persists the owning agent stats');

const beforeRejectXp = researcher.stats.xp;
const beforeRejectPersists = persists;
reject('researcher', 1);
A.eq(researcher.stats.xp, beforeRejectXp, 'negative feedback does not subtract xp');
A.eq(researcher.stats.counters.negativeFeedback, 1, 'negative feedback is recorded on the owning agent');
A.ok(persists > beforeRejectPersists, 'negative feedback persists even without a level-up');

const beforeNotebook = {
  xp: researcher.stats.xp,
  samples: researcher.stats.samples,
  positive: researcher.stats.counters.positiveFeedback,
  negative: researcher.stats.counters.negativeFeedback,
  persists,
};
notebookRating('researcher', 1, 'helpful', 2);
notebookRating('researcher', 2, 'unhelpful', -1);
A.eq(researcher.stats.xp, beforeNotebook.xp, 'notebook ratings do not award or subtract XP');
A.eq(researcher.stats.samples, beforeNotebook.samples, 'notebook ratings do not calibrate satisfaction');
A.eq(researcher.stats.counters.positiveFeedback, beforeNotebook.positive, 'notebook helpful is not a user approval receipt');
A.eq(researcher.stats.counters.negativeFeedback, beforeNotebook.negative, 'notebook unhelpful is not a user rejection receipt');
A.eq(persists, beforeNotebook.persists, 'notebook ratings do not persist unchanged XP stats');

focused = researcher;
for (let i = 1; i <= 4; i++) done('agent', i);
for (let i = 1; i <= 3; i++) approve('agent', i);

A.eq(overseer.stats.level, 2, 'overseer still levels from overseer feedback events');
A.eq(researcher.stats.level, 2, 'overseer events do not mutate researcher');
A.ok(world.pulse.some(p => p.agentId === 'agent' && p.level === 2), 'overseer pulse still works when addressed');
A.eq((XpStore.stationStats().counters || {}).tasksDone, 8, 'station rollup still includes all agents tasks');
A.eq((XpStore.stationStats().counters || {}).positiveFeedback, 6, 'station rollup includes all agents positive feedback');

/* ---- S4: the boot-time TROPHY RECONCILE + honest announce copy ----
   A save written before a badge existed holds the record that earns it and none of the credit. Without the
   reconcile the trophy case renders that badge LOCKED, with an unlock hint the dossier above it has visibly
   already met — the app contradicting its own state. It must run for EVERY agent (a specialist's case is not
   the hero's), it must reach the station rollup, and it must stay SILENT: these are past facts being
   recognized, not moments happening now. */
// two mid-curve saves that predate S4's badges: 8 shipped tasks + 30 successful tool calls, nothing lit.
const mkLegacy = (id, name) => ({ id, name, stats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: { tasksDone: 8, runs: 9, toolsOk: 30 }, milestones: [] } });
const oldHero = mkLegacy('agent', 'OVERSEER');
const oldSpec = mkLegacy('scribe', 'SCRIBE');
const oldRoster = new Map([['agent', oldHero], ['scribe', oldSpec]]);
const noticesBefore = notices.length, broadcastsBefore = broadcasts.length, sfxBefore = sfx;

XpStore.init({
  getAgent: (id) => oldRoster.get(id || 'agent') || null,
  agents: () => Array.from(oldRoster.values()),
  station: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: { tasksDone: 40, runs: 42, toolsOk: 120 }, milestones: [] },
  persist: () => { persists++; }
});

A.ok(oldHero.stats.milestones.indexOf('still_here') !== -1, 'boot lights the badge the hero had already earned (8 tasks)');
A.ok(oldHero.stats.milestones.indexOf('hands_on') !== -1, 'boot lights HANDS ON off the tool-call record it already had');
A.eq(oldHero.stats.milestones.indexOf('workhorse'), -1, 'boot lights only what was EARNED — 8 tasks is not 25');
A.ok(oldSpec.stats.milestones.indexOf('still_here') !== -1, 'a SPECIALIST case is reconciled too, not just the hero');
A.ok((XpStore.stationStats().milestones || []).indexOf('workhorse') !== -1, 'the station rollup is reconciled off its own record (40 tasks)');
A.eq(oldHero.stats.xp, 0, 'the backfill mints no XP');
A.eq(notices.length, noticesBefore, 'the backfill is SILENT — no gold toast for work done weeks ago');
A.eq(broadcasts.length, broadcastsBefore, '…and no TROPHY EARNED broadcast burst at boot');
A.eq(sfx, sfxBefore, '…and no sting');

// a badge earned LIVE still announces — over COMMS only (notification diet: no bell entry), with its real
// trophy-case label, never a raw slug.
bus.emit('workitem.delivered', { agentId: 'agent', workitemId: 'w1', finalQueueId: 'q1' });
A.ok(oldHero.stats.milestones.indexOf('night_shift') !== -1, 'a real delivery still earns NIGHT SHIFT live');
A.eq(notices.length, noticesBefore, 'notification diet: a live milestone never toasts (sting + broadcast carry it)');
A.ok(broadcasts.some(b => b.text === 'TROPHY EARNED · NIGHT SHIFT'), 'the broadcast shouts the trophy-case label');
A.ok(!broadcasts.some(b => /night_shift/.test(b.text)), 'no raw slug reaches the Commander');
// the label comes from the xp.js catalogue, so a badge added there can never announce as an id.
A.ok(Xp.MILESTONES.every(m => broadcasts.every(b => !b.text.includes('_'))), 'every announced name is a real label');

/* ---- LONGEVITY: runs completed while the webview was closed catch up silently from durable history ---- */
const catchHero = { id: 'agent', name: 'OVERSEER', stats: Xp.fresh() };
const catchSpec = { id: 'scribe', name: 'SCRIBE', stats: Xp.fresh() };
const catchRoster = new Map([['agent', catchHero], ['scribe', catchSpec]]);
const catchStation = Xp.fresh();
let catchPersists = 0, catchCredentialPushes = 0;
const noticesBeforeCatchup = notices.length, broadcastsBeforeCatchup = broadcasts.length, sfxBeforeCatchup = sfx;

const catchup = XpStore.init({
  getAgent: id => catchRoster.get(id || 'agent') || null,
  agents: () => Array.from(catchRoster.values()),
  station: catchStation,
  syncSince: 100,
  loadRuns: async since => {
    A.eq(since, 100, 'catch-up starts at the last persisted browser save, not genesis');
    return { snapshotAt: 900, runs: [
      { runId: 'closed-1', agentId: 'scribe', reason: 'done', toolsOk: 4, ts: 200 },
      { runId: 'closed-2', agentId: 'scribe', reason: 'max_iters', toolsOk: 2, ts: 300 },
      { runId: 'closed-3', agentId: 'scribe', reason: 'error', toolsOk: 0, ts: 400 },
      { runId: 'closed-4', agentId: 'scribe', reason: 'done', clarifying: true, toolsOk: 0, ts: 500 },
      { runId: 'closed-internal', agentId: 'scribe', reason: 'done', toolsOk: 9, internal: true, ts: 600 },
      { runId: 'closed-legacy-internal', agentId: 'scribe', reason: 'done', toolsOk: 9, streamId: 'cron-old-row', ts: 700 },
      { runId: 'closed-1', agentId: 'scribe', reason: 'done', toolsOk: 4, ts: 200 }
    ] };
  },
  persist: () => { catchPersists++; },
  onCredential: () => { catchCredentialPushes++; }
});
A.eq(XpStore.stationStats().runSyncAt, 100, 'the legacy save floor is checkpointed immediately, before async catch-up can race a migration save');

Promise.resolve(catchup).then(async summary => {
  A.eq(summary.applied, 4, 'four external missed runs fold; the internal and duplicate rows do not');
  A.eq(catchSpec.stats.counters.tasksDone, 1, 'only the genuinely completed closed-window run ships a task');
  A.eq(catchSpec.stats.counters.runsOwned, 2, 'done + max_iters are the two attributable reliability runs');
  A.eq(catchSpec.stats.counters.runsWon, 1, 'only done wins the reliability numerator');
  A.eq(catchSpec.stats.counters.runsFaulted, 1, 'provider error is recorded but excluded from reliability');
  A.eq(catchSpec.stats.counters.runsNeutral, 1, 'clarifying is recorded as neutral, never a success');
  A.eq(catchSpec.stats.counters.toolsOk, 6, 'durable per-run successful-tool totals catch up too');
  A.eq(Xp.reliability(catchSpec.stats).pct, null, 'two attributable runs remain honestly calibrating');
  A.eq(XpStore.stationStats().counters.tasksDone, 1, 'station progression catches up from the same exact rows');
  A.eq(XpStore.stationStats().runSyncAt, 900, 'successful catch-up advances the dedicated server snapshot watermark');
  A.eq(catchPersists, 1, 'the whole catch-up commits once, not once per historical row');
  A.ok(catchCredentialPushes <= 1, 'coarse roster credentials republish at most once for a catch-up batch');
  A.eq(notices.length, noticesBeforeCatchup, 'historical catch-up is silent — no delayed trophy/level toast burst');
  A.eq(broadcasts.length, broadcastsBeforeCatchup, 'historical catch-up emits no COMMS celebration burst');
  A.eq(sfx, sfxBeforeCatchup, 'historical catch-up emits no celebration sound');

  const urls = [];
  const paged = await XpStore.loadRunHistory(100, async url => {
    urls.push(url);
    return { ok: true, json: async () => urls.length === 1
      ? { snapshotAt: 1000, nextCursor: 'page-1-tail', runs: [{ runId: 'newer' }] }
      : { snapshotAt: 1000, nextCursor: '', runs: [{ runId: 'older' }] } };
  });
  A.eq(paged.runs.map(r => r.runId), ['newer', 'older'], 'durable catch-up follows every history page');
  A.ok(/beforeRunId=page-1-tail/.test(urls[1]) && /through=1000/.test(urls[1]), 'later pages use the cursor and frozen snapshot horizon');

  const watermarkBeforeFailure = XpStore.stationStats().runSyncAt, persistsBeforeFailure = catchPersists;
  const oldWarn = console.warn; console.warn = () => {};
  const failed = await XpStore.syncRunHistory(watermarkBeforeFailure, async () => { throw new Error('offline'); });
  console.warn = oldWarn;
  A.eq(failed.failed, true, 'a failed history read is reported, never treated as an empty successful sync');
  A.eq(XpStore.stationStats().runSyncAt, watermarkBeforeFailure, 'a failed catch-up never advances the watermark');
  A.eq(catchPersists, persistsBeforeFailure, 'a failed catch-up does not persist a false checkpoint');

  const canonical = { runId: 'rated-1', verdict: 'great', ts: 1100, entries: [
    { agentId: 'scribe', id: 'work:rated-1', runId: 'rated-1', delta: 4, reason: 'work_great', size: 'large' }
  ] };
  const beforeRatedXp = catchSpec.stats.xp;
  const recorded = await XpStore.recordWorkRating({ runId: 'rated-1', verdict: 'great', entries: canonical.entries }, async () => ({
    ok: true, json: async () => ({ ok: true, duplicate: false, rating: canonical })
  }));
  A.ok(recorded.ok && recorded.applied, 'live XP folds only after the durable rating endpoint acknowledges it');
  A.eq(catchSpec.stats.xp - beforeRatedXp, 40, 'server-canonical verdict ignores the legacy size bucket');
  A.eq(XpStore.stationStats().ratingSyncAt, 1100, 'live rating advances the dedicated ledger watermark');
  const replayed = await XpStore.recordWorkRating({ runId: 'rated-1', verdict: 'miss', entries: canonical.entries }, async () => ({
    ok: true, json: async () => ({ ok: true, duplicate: true, rating: canonical })
  }));
  A.eq(replayed.applied, false, 'same-tab canonical duplicate cannot mint XP twice');

  const rejectedXp = catchSpec.stats.xp;
  for (const [status, error, expected] of [
    [409, 'station generation changed; reload before rating', 'Station changed'],
    [404, 'rateable run not found', 'saved run history'],
    [409, 'run did not produce rateable agent work', 'did not finish'],
    [403, 'forbidden', 'connection was rejected'],
    [503, 'rating history unavailable', 'history is unavailable'],
    [500, 'C:/private/storage/path', 'could not save']
  ]) {
    const rejected = await XpStore.recordWorkRating({ runId: 'rejected', verdict: 'great' }, async () => ({
      ok: false, status, json: async () => ({ ok: false, error })
    }));
    A.ok(!rejected.ok && rejected.status === status && rejected.error.includes(expected), 'rejected HTTP ' + status + ' preserves the actionable failure');
    A.ok(!rejected.error.includes('private'), 'rating UI does not expose raw storage errors');
  }
  const offline = await XpStore.recordWorkRating({ runId: 'offline', verdict: 'great' }, async () => { throw new Error('offline'); });
  A.ok(!offline.ok && offline.error.includes('Cannot reach'), 'transport failure is distinguished from run rejection');
  const malformed = await XpStore.recordWorkRating({ runId: 'bad-body', verdict: 'great' }, async () => ({ok:true,status:200,json:async()=>{throw new Error('not JSON');}}));
  A.ok(!malformed.ok, 'an invalid acknowledgement cannot mint XP');
  A.eq(catchSpec.stats.xp, rejectedXp, 'rejected ratings never change XP');

  const rollbackHero = { id: 'agent', name: 'OVERSEER', stats: Xp.fresh() };
  const rollbackSpec = { id: 'scribe', name: 'SCRIBE', stats: Xp.fresh() };
  const rollbackRoster = new Map([['agent', rollbackHero], ['scribe', rollbackSpec]]);
  await XpStore.init({
    getAgent: id => rollbackRoster.get(id || 'agent') || null,
    agents: () => Array.from(rollbackRoster.values()),
    station: Xp.fresh(), syncRatingsSince: 100,
    loadRatings: async since => ({ snapshotAt: 1200, ratings: [canonical] }),
    persist: () => { catchPersists++; }
  });
  A.eq(rollbackSpec.stats.xp, 40, 'boot replay repairs XP lost from a stale or rolled-back browser save');
  A.eq(XpStore.stationStats().ratingSyncAt, 1200, 'successful rating replay checkpoints the server snapshot');
  A.report('xpstore.test');
}).catch(err => { console.error(err); process.exitCode = 1; });
