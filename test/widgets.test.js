/* node test/widgets.test.js — the PURE folds behind the widget rails (frontend/app/widgets.js).

   The rails are a read-only projection (truthful telemetry): RUNS·24H sums the real insights
   overTime buckets, TOKENS prefers the fold's own total and falls back to a byModel sum, and a
   persisted layout is sanitized (known ids only, no cross-rail dupes) so a corrupt/stale store
   can never render a widget the catalog doesn't back. Pure, node-loaded, no DOM. */
'use strict';
const A = require('./_assert.js');
const { Widgets } = require('../frontend/app/widgets.js');

/* ============================ 1. foldRuns (the 24h window) ============================ */

let f = Widgets._foldRuns({ overTime: [{ runs: 2 }, { runs: 0 }, { runs: 5 }] });
A.eq(f.runs, 7, 'runs = the sum of the bucket counts');
A.eq(f.series.join(','), '2,0,5', 'the spark series mirrors the buckets in order');

A.eq(Widgets._foldRuns(null).runs, 0, 'no fold yet → 0, never a throw');
A.eq(Widgets._foldRuns({}).runs, 0, 'missing overTime → 0');
A.eq(Widgets._foldRuns({ overTime: [{ runs: 'x' }, {}, null] }).runs, 0, 'garbage buckets fold to 0, never NaN');

/* ============================ 2. foldTokens (prefer the fold's own total) ============================ */

A.eq(Widgets._foldTokens({ totalTokens: 1234 }), 1234, 'the fold total wins when present');
A.eq(Widgets._foldTokens({ byModel: [{ tokens: 100 }, { tokens: 250 }] }), 350, 'no total → byModel sum');
A.eq(Widgets._foldTokens({ totalTokens: 'nope', byModel: [{ tokens: 7 }] }), 7, 'a non-numeric total falls back to the sum');
A.eq(Widgets._foldTokens(null), 0, 'no insights → 0, never a throw');
A.eq(Widgets._foldTokens({ byModel: [{ tokens: 'x' }, null] }), 0, 'garbage byModel folds to 0, never NaN');

/* ============================ 3. fmtCount (compact, no locale surprises) ============================ */

A.eq(Widgets._fmtCount(950), '950', 'sub-thousand stays whole');
A.eq(Widgets._fmtCount(12400), '12.4K', 'thousands → K with one decimal');
A.eq(Widgets._fmtCount(3200000), '3.2M', 'millions → M with one decimal');
A.eq(Widgets._fmtCount('junk'), '0', 'garbage → 0, never NaN');

/* ============================ 3b. routines state (arm intent != runnable) ============================ */

A.eq(Widgets._cronStateLabel({ enabled: true, halted: true }), 'stopped · E-STOP',
  'the routines widget never reports armed while the durable E-STOP is engaged');
A.eq(Widgets._cronStateLabel({ enabled: true, halted: false }), 'armed', 'a genuinely runnable scheduler reports armed');
A.eq(Widgets._cronStateLabel({ enabled: false, halted: false }), 'disarmed', 'a disabled scheduler reports disarmed');

/* ============================ 4. sanitizeLayout (a corrupt store never renders) ============================ */

const KNOWN = ['runs24', 'queue', 'cron', 'tokens'];

let s = Widgets._sanitizeLayout({ top: ['runs24', 'bogus'], bot: ['queue'] }, KNOWN);
A.eq(s.top.join(','), 'runs24', 'unknown ids are dropped');
A.eq(s.bot.join(','), 'queue', 'known ids survive on their rail');

s = Widgets._sanitizeLayout({ top: ['queue'], bot: ['queue', 'cron'] }, KNOWN);
A.eq(s.top.join(',') + '|' + s.bot.join(','), 'queue|cron', 'a cross-rail dupe keeps its FIRST placement only');

s = Widgets._sanitizeLayout(null, KNOWN);
A.eq(s.top.length + s.bot.length, 0, 'a null store → empty rails, never a throw');
s = Widgets._sanitizeLayout({ top: 'nope', bot: 42 }, KNOWN);
A.eq(s.top.length + s.bot.length, 0, 'non-array rails → empty rails');

/* ============================ 5. feed:* layout ids (agent-fed pins survive) ============================ */

s = Widgets._sanitizeLayout({ top: ['feed:app-revenue', 'runs24'], bot: ['feed:Bad Id', 'feed:'] }, KNOWN);
A.eq(s.top.join(','), 'feed:app-revenue,runs24', 'a well-formed feed pin survives sanitize (its record may poll in later)');
A.eq(s.bot.length, 0, 'malformed feed ids are dropped');

/* ============================ 6. sanitizeFeedRecord (trust nothing off the wire) ============================ */

let r = Widgets._sanitizeFeedRecord({ id: 'app-revenue', label: 'App Revenue', value: '$1,240', sub: 'today', agentId: 'nova', updatedAt: 777 });
A.eq(r.slug + '|' + r.label + '|' + r.value + '|' + r.sub + '|' + r.agentId + '|' + r.updatedAt,
  'app-revenue|App Revenue|$1,240|today|nova|777', 'a clean record round-trips');

A.eq(Widgets._sanitizeFeedRecord({ id: 'Bad Id!', value: 'x' }), null, 'a malformed id → null (never rendered)');
A.eq(Widgets._sanitizeFeedRecord({ id: 'empty' }), null, 'no value AND no list → null (never an empty gauge)');
A.eq(Widgets._sanitizeFeedRecord(null), null, 'garbage → null, never a throw');

r = Widgets._sanitizeFeedRecord({ id: 'news', list: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], agentId: 'scout' });
A.eq(r.list.length, 5, 'a ticker keeps at most 5 lines');
A.eq(r.value, null, 'a pure ticker has no big value');

r = Widgets._sanitizeFeedRecord({ id: 'long', value: 'V'.repeat(99), label: 'L'.repeat(99) });
A.ok(r.value.length <= 24 && r.label.length <= 28, 'over-long strings truncate defensively');

r = Widgets._sanitizeFeedRecord({ id: 'noname', value: '1' });
A.eq(r.label, 'NONAME', 'a missing label falls back to the slug');
A.eq(r.agentId, 'agent', 'a missing agentId falls back honestly');

/* ============ 6b. sanitizeFeedRecord — expressive dressing (tone/spark/progress) ============ */

r = Widgets._sanitizeFeedRecord({ id: 'mrr', value: '$1,240', tone: 'ok', spark: [3, 5, 4, 9], progress: 62.5 });
A.eq(r.tone, 'ok', 'a whitelisted tone survives');
A.eq(r.spark.join(','), '3,5,4,9', 'a spark series survives');
A.eq(r.progress, 62.5, 'progress survives');

r = Widgets._sanitizeFeedRecord({ id: 'junk', value: 'x', tone: '<i>', spark: [1], progress: 'nope' });
A.eq(r.tone, null, 'an unknown tone → null (whitelist, never trusted)');
A.eq(r.spark, null, 'a 1-point spark → null (cannot draw a line)');
A.eq(r.progress, null, 'non-numeric progress → null');

r = Widgets._sanitizeFeedRecord({ id: 'clamp', value: 'x', spark: [1, 'x', 2, Infinity, 3], progress: 250 });
A.eq(r.spark.join(','), '1,2,3', 'non-finite spark points are dropped');
A.eq(r.progress, 100, 'progress clamps into 0-100');
A.eq(Widgets._sanitizeFeedRecord({ id: 'neg', value: 'x', progress: -4 }).progress, 0, 'negative progress clamps to 0');

/* ============ 6c. sparkSvg — range-normalized, safe on flat series ============ */

let svg = Widgets._sparkSvg([1200, 1210, 1240]);
A.ok(svg.indexOf('<polyline') >= 0 && svg.indexOf('<polygon') >= 0 && svg.indexOf('<circle') >= 0,
  'a spark renders line + area + endpoint dot');
A.ok(svg.indexOf('NaN') < 0, 'no NaN coordinates');
svg = Widgets._sparkSvg([5, 5, 5]);
A.ok(svg.indexOf('NaN') < 0, 'a flat series never divides to NaN');
A.eq(Widgets._sparkSvg([7]), '', 'a 1-point series draws nothing');

/* ============================ 7. fmtAge (a trust cue, coarse on purpose) ============================ */

A.eq(Widgets._fmtAge(10000, 0), 'now', 'under 45s reads "now"');
A.eq(Widgets._fmtAge(3 * 60000, 0), '3m', 'minutes');
A.eq(Widgets._fmtAge(2 * 3600000, 0), '2h', 'hours');
A.eq(Widgets._fmtAge(4 * 86400000, 0), '4d', 'days');
A.eq(Widgets._fmtAge(0, 999999), 'now', 'a future timestamp clamps to "now", never negative');

// report() LAST — it is what calls process.exit(fail?1:0). This file used to end in a bare
// console.log, so every assertion failure printed FAIL and STILL exited 0: the fast gate scored
// it green no matter what broke. Never end an _assert.js test any other way.
// Current scheduler truth: never count down a stopped, paused, or invalid job.
const now = Date.parse('2026-09-06T12:00:00Z');
const scheduled = { enabled: true, jobs: [
  { id: 'paused', enabled: false, nextRunAt: '2026-09-06T12:01:00Z' },
  { id: 'later', enabled: true, nextRunAt: '2026-09-06T13:00:00Z' },
  { id: 'next', name: 'Morning brief', enabled: true, nextRunAt: '2026-09-06T12:05:00Z' },
  { id: 'bad', enabled: true, nextRunAt: 'invalid' }
] };
A.eq(Widgets._nextRoutine(scheduled, now).val, '5m', 'next routine skips paused jobs and sorts actual due times');
A.eq(Widgets._nextRoutine(scheduled, now).sub, 'Morning brief', 'next routine names the scheduled job');
A.eq(Widgets._nextRoutine({ ...scheduled, halted: true }, now).val, null, 'E-STOP suppresses countdown');
A.eq(Widgets._nextRoutine({ ...scheduled, enabled: false }, now).sub, 'disarmed', 'disarmed scheduler is explicit');
A.eq(Widgets._nextRoutine({ enabled: true, jobs: [] }, now).sub, 'nothing scheduled', 'empty scheduler does not invent a time');
A.eq(Widgets._nextRoutine(null, now).val, null, 'missing scheduler stays unknown');
const projected = { ...scheduled, scheduler: { enabled: true, halted: false, degraded: false, held: null }, jobs: scheduled.jobs.map(j => ({ ...j, nextFireAt: null })) };
A.eq(Widgets._nextRoutine(projected, now).val, null, 'server null fire wins over stored schedule data');
A.eq(Widgets._nextRoutine({ ...projected, scheduler: { enabled: true, degraded: true, held: 'degraded' } }, now).sub, 'storage needs recovery', 'storage hold is explicit');
A.eq(Widgets._nextRoutine(scheduled, now + 10 * 60000).val, 'due', 'overdue does not claim running');

// Use the production COMMS state machine without changing its module.
global.Channels = require('../frontend/app/channels.js');
global.Channels.begin('connecting', now);
A.eq(Widgets._commsReadout(false).val, '0', 'unconfirmed request is not a running conversation');
A.eq(Widgets._commsReadout(false).sub, '1 connecting', 'connection state stays distinct');
global.Channels.begin('working', now);
global.Channels.setRunId('working', 'run-1', now);
A.eq(Widgets._commsReadout(false).val, '1', 'confirmed run is counted');
global.Channels.setPending('working', { promptId: 'approval-1' }, now);
A.eq(Widgets._commsReadout(true).val, '1', 'pending approval reflects COMMS state');
global.Channels.end('working');
A.eq(Widgets._commsReadout(true).val, '0', 'completed approval clears');
delete global.Channels;
A.eq(Widgets._commsReadout(false).val, null, 'unavailable COMMS is unknown, not zero');
A.eq(Widgets._sanitizeFeedRecord({ id: 'no-progress', value: '10', progress: null }).progress, null, 'null progress does not hide an actual spark behind a fake zero bar');
A.eq(Widgets._sanitizeFeedRecord({ id: 'zero-progress', value: '10', progress: 0 }).progress, 0, 'explicit zero progress remains valid');

// Attention shortcuts resolve current state at click time, skipping sessions already removed.
const jumps = [];
global.Channels = { pendingIds: () => ['removed', 'waiting'] };
global.Workstreams = { get: id => id === 'waiting' ? { id } : null };
global.App = { openWorkstream: id => jumps.push('conversation:' + id) };
global.StationUI = { openTerm: id => jumps.push('window:' + id), h: { workConversation: () => jumps.push('reveal') } };
A.eq(Widgets._openWidget('approvals'), true, 'waiting conversation shortcut is available');
A.eq(jumps.join(','), 'conversation:waiting,reveal', 'shortcut opens and reveals the existing waiting conversation');
global.Channels.pendingIds = () => [];
A.eq(Widgets._openWidget('approvals'), false, 'resolved attention does not reopen an outdated target');
A.eq(jumps.length, 2, 'resolved attention performs no navigation');
A.eq(Widgets._openWidget('next'), true, 'schedule shortcut opens its real settings');
A.eq(jumps[2], 'window:routines', 'schedule shortcut routes to routines without running a job');
A.eq(Widgets._openWidget('tokens'), false, 'plain counters have no invented action');
delete global.Channels; delete global.Workstreams; delete global.App; delete global.StationUI;
const emptyConfigured = Widgets._sanitizeFeedRecord({ id:'saved', label:'Revenue', value:null, updatedAt:0,
  config:{ source:{kind:'connector',id:'stripe',label:'Stripe'}, request:'This month', display:'metric', version:1 },
  sourceState:'disabled', sourceUrl:'javascript:alert(1)', error:'Could not read app' });
A.ok(!!emptyConfigured, 'a saved definition can exist before a reading is fetched');
A.eq(emptyConfigured.updatedAt, 0, 'a definition does not invent a report timestamp');
A.eq(emptyConfigured.sourceUrl, null, 'unsafe source links never reach the UI');
A.eq(emptyConfigured.sourceState, 'disabled', 'disconnected app state survives the read boundary');
A.eq(emptyConfigured.error, 'Could not read app', 'source errors stay available to the detail view');
A.report('widgets.test');
