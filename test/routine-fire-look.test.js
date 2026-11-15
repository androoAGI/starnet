/* node test/routine-fire-look.test.js -- ONE verdict per routine on the four record readers (lane T6, ops 2026-11-15).

   A routine fire has two verdicts. A work line that stopped at stage 2 (stage_failed, partial, unapproved, blocked, halted) leaves
   lastStatus 'ok' by design (cron-store markRun, the line law), and no page read `lastLine`: the ROUTINES card drew "✓ ok" for it,
   /routine list said "last ok", the agent's routines tool said lastStatus 'ok' and the phone row said 'ok'. A fire the unattended
   hold refused (job.lastHold, written by the scheduler lane T1) had no display at all. fireLook(job) is the one
   projection: { tone, word, why, at } with tone never | held | running | stopped | failed | problem | ok. The card, /routine list,
   routine.list and the phone host's row read it.

   RED at 45e7ee302: RunOutcome has no fireLook / recordOutcome, and the line-stopped fixture reads ok on every surface.
   LIVENESS: records from older writers (v0.14.2: no lastLine / lastHold at all; v0.15.0: lastLine null; a pre-lane 'error' beside
   lastReason 'cancelled') render EXACTLY as before — the LEGACY table below was captured from the base tree. The two slicing
   tests (outcome-roundtrip.table, outcome-family.census) run unedited as the control. PLANTED: remove the lastLine branch of
   fireLook and the line-stopped fixture fails on every surface.

   FIRE_LOOK_ROOT=<tree> runs the same cases against another tree (the red proof against the base);
   FIRE_LOOK_DUMP=1 prints the legacy surfaces as JSON (how the LEGACY table was captured). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { functionSourceIn } = require('./helpers/source.js');

const ROOT = process.env.FIRE_LOOK_ROOT || path.join(__dirname, '..');
const req = rel => require(path.join(ROOT, rel));
const RunOutcome = req('frontend/app/runoutcome.js');
const cronStore = req('sidecar/cron-store.js');
const cron = req('sidecar/cron.js');
const { makeSlashActions } = req('sidecar/slash-actions.js');
const { makeRoutineTools } = req('sidecar/tools/builtin/routines.js');
const { makeRemoteHost } = req('sidecar/remote/host.js');

const T0 = 1700000000000;
const RAN = '2023-11-14T22:14:20.000Z';        // lastRunAt
const HELD_AT = '2023-11-14T23:00:00.000Z';    // after RAN
const mk = (id, extra) => Object.assign(cronStore.makeJob({ id, name: 'job ' + id, agentId: 'agent', prompt: 'do it',
  schedule: cron.parseSchedule('every 1h', T0) }, { id, now: T0 }), extra || {});

// the six fixtures the plan names, built with makeJob + Object.assign
const F = {
  ok: mk('ok', { lastRunAt: RAN, lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded' }),
  line: mk('line', { lastRunAt: RAN, lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded',
    lastLine: { stopped: 'Writer failed: the provider answered 429', stopCode: 'stage_failed' } }),
  spend: mk('spend', { lastRunAt: RAN, lastStatus: 'error', lastReason: 'error', lastOutcome: 'failed', lastFailureCode: 'spend_history_unavailable',
    lastError: 'StarNet paused this unattended run: its spend history is incomplete' }),
  stopped: mk('stopped', { lastRunAt: RAN, lastStatus: 'stopped', lastReason: 'cancelled', lastOutcome: 'stopped', lastError: 'stopped by you' }),
  held: mk('held', { lastRunAt: RAN, lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded',
    lastHold: { at: HELD_AT, binding: 'window-reserve', say: 'held: the 5-hour window is reserved for you' } }),
  never: mk('never', {})
};
const WANT = { ok: 'ok', line: 'problem', spend: 'failed', stopped: 'stopped', held: 'held', never: 'never' };

// records from older writers: no lastLine / lastHold keys at all (v0.14.2), lastLine null (v0.15.0), and pre-lane 'error' beside an end word
const bare = (id, extra) => Object.assign({ id, name: 'job ' + id, agentId: 'agent', enabled: true, state: 'scheduled', scheduleDisplay: 'every 1h',
  nextRunAt: '2023-11-14T23:14:20.000Z', lastRunAt: RAN }, extra);
const LEGACY_JOBS = {
  v0142_ok: bare('v0142-ok', { lastStatus: 'ok', lastReason: 'done', lastError: null }),
  v0150_ok: bare('v0150-ok', { lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded', lastLine: null, lastFire: { runId: 'r1', outcome: 'succeeded', failureCode: null, reason: 'done' } }),
  v0150_cancelled: bare('v0150-cancel', { lastStatus: 'error', lastReason: 'cancelled', lastError: 'run ended without completion — it was cancelled before it finished [cancelled]' }),
  v0150_budget: bare('v0150-budget', { lastStatus: 'error', lastReason: 'budget', lastError: 'run ended without completion [budget]' }),
  v0150_failed: bare('v0150-failed', { lastStatus: 'error', lastReason: 'error', lastOutcome: 'failed', lastFailureCode: 'rate_limit', lastError: 'rate limited (429)' }),
  stopped: Object.assign({}, F.stopped, { id: 'l-stopped' }),
  spend: Object.assign({}, F.spend, { id: 'l-spend' }),
  never: bare('l-never', { lastRunAt: null, lastStatus: null })
};

/* what the BASE tree (45e7ee302) rendered for the records above, captured with FIRE_LOOK_DUMP=1 against it */
const LEGACY = {
  v0142_ok: {
    card: "<span class=\"pos\">✓ ok</span> <span class=\"dim\">just now</span>",
    slash: "1. job v0142-ok — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]; last ok",
    tool: {"id":"v0142-ok","name":"job v0142-ok","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"ok","lastError":null,"lastReason":"done","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"v0142-ok","name":"job v0142-ok","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"ok","prompt":""},
  },
  v0150_ok: {
    card: "<span class=\"pos\">✓ ok</span> <span class=\"dim\">just now</span>",
    slash: "1. job v0150-ok — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]; last ok",
    tool: {"id":"v0150-ok","name":"job v0150-ok","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"ok","lastError":null,"lastReason":"done","lastOutcome":"succeeded","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"v0150-ok","name":"job v0150-ok","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"ok","prompt":""},
  },
  v0150_cancelled: {
    card: "<span class=\"dim\">■ stopped before it finished</span> <span class=\"dim\">just now</span>",
    slash: "1. job v0150-cancel — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]; last run stopped before it finished",
    tool: {"id":"v0150-cancel","name":"job v0150-cancel","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"stopped","lastError":"run ended without completion — it was cancelled before it finished [cancelled]","lastReason":"cancelled","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"v0150-cancel","name":"job v0150-cancel","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","prompt":""},
  },
  v0150_budget: {
    card: "<span style=\"color:var(--warn)\">⚠ hit a spending limit</span> <span class=\"dim\">just now</span>",
    slash: "1. job v0150-budget — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]; last run did not finish (hit a spending limit)",
    tool: {"id":"v0150-budget","name":"job v0150-budget","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","lastError":"run ended without completion [budget]","lastReason":"budget","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"v0150-budget","name":"job v0150-budget","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","prompt":""},
  },
  v0150_failed: {
    card: "<span style=\"color:var(--bad)\">✕ failed (rate_limit)</span> <span class=\"dim\">just now</span>",
    slash: "1. job v0150-failed — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]; last error (rate limited (429))",
    tool: {"id":"v0150-failed","name":"job v0150-failed","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","lastError":"rate limited (429)","lastReason":"error","lastOutcome":"failed","lastFailureCode":"rate_limit","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"v0150-failed","name":"job v0150-failed","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","prompt":""},
  },
  stopped: {
    card: "<span class=\"dim\">■ stopped before it finished</span> <span class=\"dim\">just now</span>",
    slash: "1. job stopped — every 1h [scheduled, next 2023-11-14T23:13:20.000Z]; last run stopped before it finished",
    tool: {"id":"l-stopped","name":"job stopped","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"stopped","lastError":"stopped by you","lastReason":"cancelled","lastOutcome":"stopped","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"l-stopped","name":"job stopped","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:13:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"stopped","prompt":"do it"},
  },
  spend: {
    card: "<span style=\"color:var(--bad)\">✕ failed (spend_history_unavailable)</span> <span class=\"dim\">just now</span>",
    slash: "1. job spend — every 1h [scheduled, next 2023-11-14T23:13:20.000Z]; last error (StarNet paused this unattended run: its spend history is inc)",
    tool: {"id":"l-spend","name":"job spend","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","lastError":"StarNet paused this unattended run: its spend history is incomplete","lastReason":"error","lastOutcome":"failed","lastFailureCode":"spend_history_unavailable","lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"l-spend","name":"job spend","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:13:20.000Z","lastRunAt":"2023-11-14T22:14:20.000Z","lastStatus":"error","prompt":"do it"},
  },
  never: {
    card: "<span class=\"dim\">never run</span>",
    slash: "1. job l-never — every 1h [scheduled, next 2023-11-14T23:14:20.000Z]",
    tool: {"id":"l-never","name":"job l-never","agentId":"agent","scheduleDisplay":"every 1h","nextRunLocal":null,"enabled":true,"state":"scheduled","nextRunAt":null,"nextFireAt":null,"held":"off","lastRunAt":null,"lastStatus":null,"lastError":null,"lastReason":null,"lastLine":null,"deliver":"local","completedRuns":0,"provider":null,"model":null},
    host: {"id":"l-never","name":"job l-never","agentId":"agent","enabled":true,"inFlight":false,"schedule":"every 1h","nextRunAt":"2023-11-14T23:14:20.000Z","lastRunAt":null,"lastStatus":null,"prompt":""},
  }
};

/* ---- the four readers, each the real module ---- */
const CARD_SRC = fs.readFileSync(path.join(ROOT, 'frontend/app/windows/routines.js'), 'utf8');
const WINDOW_NAMES = ['failedAs', 'endMark', 'recordOutcome', 'lastResult'];
function cardOf(job, src) {   // the card's last-result cell: functions sliced by name with ONLY esc, fmtRel and RunOutcome in scope
  const text = src || CARD_SRC;
  const fns = WINDOW_NAMES.map(n => functionSourceIn(text, n)).filter(Boolean);
  const lastResult = new Function('esc', 'fmtRel', 'RunOutcome', fns.join('\n') + '\nreturn lastResult;')(v => String(v == null ? '' : v), () => 'just now', RunOutcome);
  return lastResult(job);
}
async function slashOf(job) {
  const out = await makeSlashActions({ cron: { jobs: () => [job], armed: () => true } }).run('routine', 'list', { agentId: 'agent' });
  return ((out && out.lines) || [])[0] || '';
}
async function toolOf(job) {
  const tools = makeRoutineTools({ listJobs: () => [job] });
  const out = await tools.listTool.run({}, { agentId: 'agent' });
  return (JSON.parse(out.content).jobs || [])[0] || {};
}
async function hostOf(job) {
  const host = makeRemoteHost({ now: () => 1, newId: () => 'x', broadcast: () => {}, roster: () => [], liveRuns: () => [], routines: () => [job] });
  return (await host.routines())[0] || {};
}
const plain = html => String(html).replace(/<[^>]+>/g, '');

/* what verdict does each surface SAY? (one reader per surface, written from the surface's own words) */
const cardVerdict = h => { const t = plain(h); return /never run/.test(t) ? 'never' : /held/.test(t) ? 'held' : /line stopped/.test(t) ? 'problem' : /✓ ok/.test(t) ? 'ok' : /■/.test(t) ? 'stopped' : /✕/.test(t) ? 'failed' : '?'; };
const slashVerdict = l => { const t = (/\]; (last .*)$/.exec(l) || [])[1] || ''; return !t ? 'never' : /^last held/.test(t) ? 'held' : /^last line stopped/.test(t) ? 'problem' : /^last ok/.test(t) ? 'ok' : /^last run stopped/.test(t) ? 'stopped' : /^last error/.test(t) ? 'failed' : '?'; };
const toolVerdict = j => (j.look && j.look.tone) || (!j.lastRunAt ? 'never' : j.lastStatus === 'ok' ? 'ok' : j.lastStatus === 'stopped' ? 'stopped' : 'failed');
const hostVerdict = r => (r.look && r.look.tone) || '(no look)';

(async () => {
  /* ---- LEGACY capture mode (run against the base tree) ---- */
  if (process.env.FIRE_LOOK_DUMP) {
    const dump = {};
    for (const [k, j] of Object.entries(LEGACY_JOBS)) {
      const tool = await toolOf(j), host = await hostOf(j);
      delete tool.look; delete host.look;
      dump[k] = { card: cardOf(j), slash: await slashOf(j), tool, host };
    }
    console.log(JSON.stringify(dump));
    return;
  }

  /* ---- 1. fireLook: one verdict per fixture ---- */
  A.ok(typeof RunOutcome.fireLook === 'function' && typeof RunOutcome.recordOutcome === 'function', 'RunOutcome exports fireLook and recordOutcome');
  const fireLook = j => (typeof RunOutcome.fireLook === 'function' ? RunOutcome.fireLook(j) : { tone: '(missing)', word: '', why: '' });
  const look = {};
  for (const k of Object.keys(F)) {
    look[k] = typeof RunOutcome.fireLook === 'function' ? fireLook(F[k]) : { tone: '(missing)' };
    A.eq(look[k].tone, WANT[k], 'fireLook tone of the ' + k + ' fixture');
  }
  A.eq(look.ok.word, 'ok', 'ok: the word every surface prints today');
  A.eq(look.never.word, 'never run', 'never: the card\'s word');
  A.eq(look.held.word, 'held', 'held: the word');
  A.eq(look.held.why, F.held.lastHold.say, 'held: why is the hold\'s own sentence');
  A.eq(look.held.at, HELD_AT, 'held: at is the hold\'s time');
  A.eq(look.line.word, 'line stopped', 'problem: the word');
  A.ok(/Writer failed: the provider answered 429/.test(look.line.why || '') && /^the work line stopped/.test(look.line.why || ''), 'problem: why names the line stop (got ' + look.line.why + ')');
  A.eq(look.line.at, RAN, 'problem: at is the fire\'s time');
  A.eq(look.stopped.word, 'stopped before it finished', 'stopped: the stop\'s own words (RunOutcome.line)');
  A.eq(look.spend.word, 'failed (spend_history_unavailable)', 'failed: the outcome\'s words with the code');
  A.ok(/spend history is incomplete/.test(look.spend.why || ''), 'failed (spend): why is the record\'s own spend sentence (got ' + look.spend.why + ')');
  A.eq(fireLook(Object.assign({}, F.spend, { lastError: null })).why.indexOf('COUNT AS') >= 0, true, 'failed (spend) with no stored sentence still says how to settle it');
  A.eq(fireLook(Object.assign({}, F.ok, { inFlight: true })).tone, 'running', 'an in-flight fire is running');
  A.eq(fireLook(Object.assign({}, F.held, { inFlight: true })).tone, 'running', 'a hold older than the fire now running is not the verdict');
  // held vs lastRunAt: only a hold NEWER than the last fire is the verdict; one with no fire at all is held
  A.eq(fireLook(Object.assign({}, F.held, { lastHold: { at: '2023-11-14T20:00:00.000Z', binding: 'b', say: 's' } })).tone, 'ok', 'a hold older than the last fire is history');
  A.eq(fireLook(Object.assign({}, F.never, { lastHold: { at: HELD_AT, binding: 'b', say: 's' } })).tone, 'held', 'a routine that never ran but was held reads held');
  // every kind of line stop is a problem; a clean line is not
  for (const facts of [{ stopped: 'x' }, { unapproved: 'x' }, { partial: 'x' }, { blocked: 'x' }, { halted: true }]) {
    A.eq(fireLook(Object.assign({}, F.ok, { lastLine: facts })).tone, 'problem', 'ok + lastLine ' + JSON.stringify(facts) + ' is a problem');
  }
  for (const clean of [null, undefined, {}, 'text', { stopCode: 'stage_failed' }]) {
    A.eq(fireLook(Object.assign({}, F.ok, { lastLine: clean })).tone, 'ok', 'ok + lastLine ' + JSON.stringify(clean) + ' stays ok');
  }
  // never throws on a hostile record
  for (const bad of [null, undefined, {}, { lastHold: 'x' }, { lastHold: { at: 5 }, lastRunAt: RAN }, { lastRunAt: RAN, lastLine: 5 }]) {
    let r = null; try { r = fireLook(bad); } catch (e) { r = { threw: String(e) }; }
    A.ok(r && !r.threw && typeof r.tone === 'string', 'fireLook never throws on ' + JSON.stringify(bad));
  }

  /* ---- 2. the four surfaces agree with it ---- */
  for (const k of Object.keys(F)) {
    const want = WANT[k];
    A.eq(cardVerdict(cardOf(F[k])), want, 'the ROUTINES card says the ' + k + ' fixture as ' + want + ' (got ' + plain(cardOf(F[k])) + ')');
    A.eq(slashVerdict(await slashOf(F[k])), want, '/routine list says the ' + k + ' fixture as ' + want + ' (got ' + (await slashOf(F[k])) + ')');
    A.eq(toolVerdict(await toolOf(F[k])), want, 'the routines tool says the ' + k + ' fixture as ' + want);
    A.eq(hostVerdict(await hostOf(F[k])), want, 'the phone host row says the ' + k + ' fixture as ' + want);
  }
  // the words each surface adds for a held fire and a stopped line
  A.ok(/held/.test(plain(cardOf(F.held))) && /line stopped/.test(plain(cardOf(F.line))), 'the card names a hold and a line stop in words');
  A.ok(/reserved for you/.test(await slashOf(F.held)) && /Writer failed/.test(await slashOf(F.line)), '/routine list carries why for a hold and a line stop');
  { const t = await toolOf(F.line), h = await toolOf(F.held);
    A.ok(t.look && t.look.word === 'line stopped' && /Writer failed/.test(t.look.why) && h.look && h.look.word === 'held' && /reserved for you/.test(h.look.why), 'the routines tool lists word and why for a hold and a line stop');
    A.eq(t.lastStatus, 'ok', 'the tool keeps lastStatus as stored (the stop rides beside it)'); }
  { const r = await hostOf(F.line);
    A.eq(r.lastStatus, 'ok', 'the phone row keeps lastStatus as stored');
    A.eq(Object.keys(r.look).sort().join(','), 'tone,why,word', 'the phone row\'s look is { tone, word, why }'); }
  // the website mirror's card reads the same
  if (fs.existsSync(path.join(ROOT, 'website/app/app/windows/routines.js'))) {
    const mirror = fs.readFileSync(path.join(ROOT, 'website/app/app/windows/routines.js'), 'utf8');
    for (const k of Object.keys(F)) A.eq(cardVerdict(cardOf(F[k], mirror)), WANT[k], 'the website mirror\'s card says the ' + k + ' fixture as ' + WANT[k]);
  }

  /* ---- 3. LIVENESS: older writers' records render exactly as at the base ---- */
  for (const [k, j] of Object.entries(LEGACY_JOBS)) {
    const tool = await toolOf(j), host = await hostOf(j);
    A.ok(!tool.look, k + ': the routines tool adds no look to a record with nothing to flag');
    delete tool.look;
    const had = host.look; delete host.look;
    A.ok(had && typeof had.tone === 'string', k + ': the phone row carries its look');
    const want = LEGACY[k];
    A.eq(cardOf(j), want.card, k + ': the ROUTINES card renders byte-identically');
    A.eq(await slashOf(j), want.slash, k + ': /routine list renders byte-identically');
    A.eq(tool, want.tool, k + ': the routines tool lists the same record');
    A.eq(host, want.host, k + ': the phone row is the same record (plus look)');
    A.ok(!('lastHold' in j) || k === 'stopped' || k === 'spend', k + ': fixture has no lastHold');
  }
  A.eq(fireLook(LEGACY_JOBS.v0142_ok).tone, 'ok', 'v0.14.2 record reads ok');
  A.eq(fireLook(LEGACY_JOBS.v0150_cancelled).tone, 'stopped', 'a pre-lane error beside lastReason cancelled reads stopped');
  A.eq(fireLook(LEGACY_JOBS.v0150_failed).tone, 'failed', 'a stamped failure reads failed');

  A.report('routine-fire-look');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
