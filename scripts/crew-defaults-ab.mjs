#!/usr/bin/env node
/* scripts/crew-defaults-ab.mjs — the PAID A/B for LEANER CREW DEFAULTS (W3.3 + W3.4, cost audit 2026-11-08).

   The switch (STARNET_CREW_DEFAULTS, frontend/app/crewdefaults.js) ships OFF until this passes on real models. It spends
   real money, so an agent never runs it: Andrew does, with a key of his choosing in ONE environment variable.

     set STARNET_CREW_AB_KEY=<an OpenRouter key>          (PowerShell: $env:STARNET_CREW_AB_KEY = '<key>')
     node scripts/crew-defaults-ab.mjs [--model openai/gpt-5] [--lead-effort medium] [--tasks <id,id>] [--reps 1]
                                       [--cap-usd 5] [--margin-usd 0.75] [--out <dir>]

   WHAT IT COMPARES. The same crew tasks (scripts/lib/crew-ab.mjs: the parity pack's three orchestration scenarios made
   concrete) on two stations that differ in that one switch, each a fresh hermetic sidecar (test/helpers/sidecar-fixture.js:
   a temp workspace and an empty app-data profile, deleted afterwards; never the real station, profile or credential stores):
     arm off   the switch unset: class-high workers and line stages run at high; every recruit copied the lead's model.
     arm lean  STARNET_CREW_DEFAULTS=lean: they run at medium unless pinned, one rung up after a failed check; a balanced
               class was summoned on the family's mid-tier model and a fast class on its small one (the roster the summon card
               preselects, built with the same CrewDefaults.tierPick over the catalog this station's provider lists).
   The arms alternate per task (off first, then lean first, ...) so neither always runs on a warmer provider.

   METRICS, per task and arm: success (a deterministic oracle over the task's own data, crew-ab.mjs grade), verify failures
   (AUDITOR REVISE verdicts, and a worker's runs past its first: the structured-result repairs), and weighted cost from the
   provider's own usage, every call the station made (.usage/calls.jsonl, the usage receipts): USD at the catalog's published
   prices (the verdict's measure), input-eq tokens (uncached + 0.1 x cached reads, the cost audit's rule), output and
   reasoning tokens; beside them the USD OpenRouter reported itself (usage.cost), as booked on the run records (crew and lead
   runs: a station's background one-shots are not run records).

   THE SPEND CAP (hard, $5 at most: --cap-usd can only lower it). A meter reads every arm's usage receipts once a second and
   prices each call on the high side (crew-ab.mjs capCostUsd: catalog prices, reasoning charged on top of output); the
   booked USD of finished runs counts when it is higher. When spent + the margin reaches the cap, it presses the station's
   E-STOP (POST /api/halt), shuts the station down, skips every task left, writes the partial report and exits 3. Before
   anything runs, one station reads the provider's live catalog (free): the model must be listed and priced, and so must every
   model either arm's crew would use, or it refuses having spent nothing. A task's two arms are not started when their worst
   case (8 calls of 35k input and 6k output each, on the lead's model) does not fit what is left. Each run also carries the
   station's own PER RUN spending limit ($2, the same in both arms) as a backstop for one runaway run.

   THE KEY. Read from STARNET_CREW_AB_KEY only, then removed from this process's environment. It reaches each station's own
   process environment (STARNET_OPENROUTER_KEY) and nothing else: never printed, never logged, never written. Every line this
   script prints or writes is scrubbed of it, and the output folder is scanned for it before exit. Every other variable of
   the calling shell (other provider keys, STARNET_/SKYNET_ overrides) is dropped before a station starts.

   EXIT: 0 the A/B ran and lean passed (no task that passed off failed lean, and lean cost less) · 1 it ran and lean did not
   pass · 2 refused (no key, a bad flag, the model missing from the live catalog or unpriced) · 3 the spend cap stopped it ·
   4 a station failed to start or a task broke. The report (report.json + report.md) goes to --out, default
   %TEMP%\starnet-crew-ab\<stamp> (outside the repo). */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as AB from './lib/crew-ab.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_ENV = 'STARNET_CREW_AB_KEY';
const HARD_CAP_USD = 5;
const PROVIDER = 'openrouter';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the key: read once, then gone from this process -------------------------------------------------------------------
const KEY = String(process.env[KEY_ENV] || '').trim();
delete process.env[KEY_ENV];
const scrub = s => {
  let t = String(s == null ? '' : s);
  if (KEY) t = t.split(KEY).join('[KEY]');
  return t.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[KEY]');
};
const say = s => console.log(scrub(s));
const warn = s => console.error(scrub(s));

// ---- flags ---------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
const MODEL = String(arg('--model', 'openai/gpt-5'));
const LEAD_EFFORT = String(arg('--lead-effort', 'medium')).toLowerCase();
const TASKS = String(arg('--tasks', AB.TASK_IDS.join(','))).split(',').map(s => s.trim()).filter(Boolean);
const REPS = Math.floor(Number(arg('--reps', '1')));
const CAP = Math.min(HARD_CAP_USD, Number(arg('--cap-usd', String(HARD_CAP_USD))));
const MARGIN = Number(arg('--margin-usd', '0.75'));
const PER_RUN_USD = 2;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const OUT = resolve(arg('--out', join(tmpdir(), 'starnet-crew-ab', STAMP)));
const TASK_TIMEOUT_MS = 20 * 60 * 1000;

function refuse(why) { warn('[crew-ab] REFUSED: ' + why); process.exit(2); }
if (!KEY) refuse('no provider key in ' + KEY_ENV + '. Nothing was read from any installed station or credential store.');
if (TASKS.some(t => AB.TASK_IDS.indexOf(t) < 0)) refuse('--tasks takes ' + AB.TASK_IDS.join(', '));
if (!(REPS >= 1 && REPS <= 5)) refuse('--reps takes 1 to 5');
if (!(CAP > 0)) refuse('--cap-usd must be above 0 (and is never above ' + HARD_CAP_USD + ')');
if (!(MARGIN >= 0 && MARGIN < CAP)) refuse('--margin-usd must be at least 0 and below the cap');
if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].indexOf(LEAD_EFFORT) < 0) refuse('--lead-effort takes none..max');

// ---- a hermetic environment for every station this script starts -------------------------------------------------------
// what Windows and POSIX need to spawn processes, nothing else (the gate runner's allowlist, scripts/run-test-list.mjs)
const PASS_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ']);
for (const k of Object.keys(process.env)) if (!PASS_ENV.has(k.toUpperCase())) delete process.env[k];
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');
const { seedActiveStation } = require('../test/helpers/station.js');
const { floorOf, publishFloor } = require('../test/helpers/saved-floor.js');
const { geometry } = require('../test/helpers/line-hold-rig.js');
const CrewDefaults = require('../frontend/app/crewdefaults.js');
const Specialties = require('../frontend/app/specialties.js');

// the background passes are not crew and run the same in both arms: off, so the A/B prices the crew alone
const QUIET = { STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0',
  STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '',
  STARNET_CRON_ARMED: '0', SKYNET_CRON_ARMED: '0', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0' };

// ---- one long request, with no client timeout (a line or a delegating lead can be quiet for minutes) ---------------------
function longRequest(f, method, route, body, onLine) {
  return new Promise((resolveP, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(f.baseUrl + route);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ Origin: f.baseUrl, 'Content-Type': 'application/json' }, f.token ? { 'X-StarNet-Token': f.token } : {},
        data ? { 'Content-Length': data.length } : {}) }, res => {
      let buf = '', all = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        all += chunk; buf += chunk;
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line && onLine) onLine(line); }
      });
      res.on('end', () => resolveP({ status: res.statusCode, text: all }));
      res.on('error', reject);
    });
    req.setTimeout(TASK_TIMEOUT_MS, () => req.destroy(new Error('no answer in ' + Math.round(TASK_TIMEOUT_MS / 60000) + ' min')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- receipts and runs ---------------------------------------------------------------------------------------------------
function receiptsOf(f) {
  const out = [];
  for (const name of ['calls.jsonl.1', 'calls.jsonl']) {
    const p = join(f.workspace, '.usage', name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) {} }
  }
  return out;
}
async function runsOf(f) {
  const r = await f.json('GET', '/api/runs?agent=*&limit=500');
  return ((r.body && r.body.runs) || []).slice().sort((a, b) => (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
}

// ---- the meter -----------------------------------------------------------------------------------------------------------
const meter = { closed: 0, live: null, liveBooked: 0, liveLast: 0, prices: new Map(), capHit: false, halted: null };
const priceFor = model => meter.prices.get(model) || null;
// the running task-arm's spend so far, on the high side: its receipts priced by the cap meter, or its booked USD when higher
function liveCost(f) {
  let est = 0;
  if (existsSync(f.workspace)) for (const r of receiptsOf(f)) est += AB.capCostUsd(r, priceFor(r.model) || priceFor(MODEL), 60000);
  meter.liveLast = Math.max(meter.liveLast, est, meter.liveBooked);
  return meter.liveLast;
}
const spent = () => meter.closed + (meter.live ? liveCost(meter.live) : 0);
async function watch(f, stopAt) {
  meter.live = f; meter.liveBooked = 0; meter.liveLast = 0;
  while (meter.live === f) {
    try { meter.liveBooked = (await runsOf(f)).reduce((s, r) => s + (Number(r.usd) || 0), 0); } catch (_) {}
    if (spent() + MARGIN >= stopAt && !meter.capHit) {
      meter.capHit = true;
      warn('[crew-ab] SPEND CAP: about $' + spent().toFixed(2) + ' spent (cap $' + CAP.toFixed(2) + ', margin $' + MARGIN.toFixed(2) + ') - E-STOP');
      try { meter.halted = (await f.json('POST', '/api/halt', {})).status; } catch (_) { meter.halted = 'unreachable'; }
      try { await f.dispose(); } catch (_) {}
      return;
    }
    await sleep(1000);
  }
}

// ---- one task on one arm ---------------------------------------------------------------------------------------------------
async function runArm(task, arm) {
  const env = Object.assign({}, QUIET, { STARNET_OPENROUTER_KEY: KEY, STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEFAULT_MODEL: MODEL,
    SKYNET_BUDGET_PER_RUN: String(PER_RUN_USD) }, arm === 'lean' ? { STARNET_CREW_DEFAULTS: CrewDefaults.ON } : {});
  const f = SidecarFixture.create({ prefix: 'starnet-crew-ab-' + arm + '-', timeoutMs: 90000, env });
  // the home folder too: a station here never finds a sign-in of the real user's (~/.codex, ~/.claude)
  Object.assign(f.env, { USERPROFILE: f.profile, HOME: f.profile, HOMEDRIVE: '', HOMEPATH: f.profile });
  // error: why the task failed (a quality result: it counts as not ok) · broken: the harness failed (the pair is not compared)
  const result = { task, arm, ok: false, checks: [], verifyFailures: 0, revise: 0, repairs: 0, usd: 0, usdList: 0, unpricedCalls: 0, capUsd: 0, receipts: null, agents: {}, error: '', broken: false };
  let watcher = null, started = false;
  try {
    seedActiveStation(f.workspace);
    await f.start();
    started = true;
    await f.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const providers = await f.json('GET', '/api/providers');
    if ((providers.body && providers.body.crewDefaults) !== (arm === 'lean' ? CrewDefaults.ON : undefined)) throw new Error('the station does not report the switch as ' + arm);
    const models = (await f.json('GET', '/api/models/' + PROVIDER)).body || {};
    const live = (models.models || []).filter(m => m && m.id && !m.fallback);
    const lead = live.find(m => m.id === MODEL);
    if (!lead) { result.error = 'REFUSED: ' + MODEL + ' is not in the live ' + PROVIDER + ' catalog' + (models.error ? ' (' + models.error + ')' : ''); return result; }
    for (const m of live) { const p = AB.priceOf(m); if (p) meter.prices.set(m.id, p); }
    const { rows, picks } = AB.rosterFor(arm, { provider: PROVIDER, leadModel: MODEL, leadEffort: LEAD_EFFORT, catalogIds: live.map(m => m.id), Specialties, CrewDefaults });
    for (const id of new Set(rows.map(r => r.model))) if (!priceFor(id)) { result.error = 'REFUSED: ' + id + ' has no price in the catalog'; return result; }
    result.picks = picks;
    const pushed = await f.json('POST', '/api/roster', { agents: rows, updatedAt: Date.now() });
    if (pushed.status !== 200) throw new Error('the roster push answered ' + pushed.status);
    watcher = watch(f, CAP);

    let leadText = '', sampleBody = {};
    if (task === 'parity-orch-synthesis') {
      const geo = geometry({ maxIter: 3 }, 'esc unwired');
      const published = await publishFloor({ json: (m, u, b) => f.json(m, u, b) }, floorOf(geo), { label: 'crew-ab line' });
      const sample = await longRequest(f, 'POST', '/api/routing/sample', { line: published.plan.lineOfProp.p1, text: AB.taskPrompt(task), name: 'Release note' });
      try { sampleBody = JSON.parse(sample.text) || {}; } catch (_) {}
      // 200 = delivered, 502 = the line ran and did not deliver (held, failed: a quality result); anything else = it never ran
      if (sample.status !== 200 && !(sample.status === 502 && sampleBody.stoppedBy !== 'fault')) {
        result.broken = true; result.error = 'the line was refused (' + sample.status + '): ' + String(sampleBody.error || '').slice(0, 200);
      } else if (sample.status === 502) result.error = 'the line did not deliver: ' + String(sampleBody.error || JSON.stringify(sampleBody.stop || '')).slice(0, 200);
    } else {
      // the lead's own words, from its stream (the record keeps a reply only for a page's session run)
      const res = await longRequest(f, 'POST', '/api/run', { agentId: 'agent', provider: PROVIDER, model: MODEL, reasoningEffort: LEAD_EFFORT, isTask: true,
        system: AB.LEAD_SYSTEM, placed: [], messages: [{ role: 'user', content: AB.taskPrompt(task) }] }, line => {
        try {
          const e = JSON.parse(line), p = (e && e.payload) || {};
          if (e && e.name === 'agent.token' && typeof p.delta === 'string' && (!p.agentId || p.agentId === 'agent')) leadText += p.delta;
        } catch (_) {}
      });
      if (res.status !== 200) { result.broken = true; result.error = 'the lead run was refused (' + res.status + '): ' + res.text.slice(0, 200); }
    }
    // settle: the crew's calls stop (no new receipt for 8 s), at most 3 minutes after the task's own request returned
    for (let last = -1, since = Date.now(), until = Date.now() + 180000; Date.now() < until && !meter.capHit;) {
      const n = receiptsOf(f).length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= 8000) break;
      await sleep(1000);
    }
    if (meter.capHit) { result.broken = true; result.error = 'stopped by the spend cap'; return result; }

    const runs = await runsOf(f);
    const receipts = receiptsOf(f);
    result.usd = runs.reduce((s, r) => s + (Number(r.usd) || 0), 0);
    result.capUsd = receipts.reduce((s, r) => s + AB.capCostUsd(r, priceFor(r.model) || priceFor(MODEL), 60000), 0);
    for (const r of receipts) { const c = AB.listCostUsd(r, priceFor(r.model)); if (c == null) result.unpricedCalls++; else result.usdList += c; }
    result.receipts = AB.sumReceipts(receipts);
    // per agent: its runs (effort as it ran, and why: the record's effortRule while the switch is on) and its calls' tokens
    // (a receipt names the run it belongs to; one without a run is a station call, under '(station)')
    const ownerOf = new Map(runs.map(r => [r.runId, r.agentId]));
    for (const r of runs) {
      const a = result.agents[r.agentId] || (result.agents[r.agentId] = { runs: 0, usd: 0, models: [], efforts: [], rules: [] });
      a.runs++; a.usd += Number(r.usd) || 0; a.efforts.push(r.reasoningEffort || '');
      if (a.models.indexOf(r.model || '') < 0) a.models.push(r.model || '');
      if (r.effortRule) a.rules.push(r.effortRule.why);
    }
    const byOwner = {};
    for (const x of receipts) { const id = ownerOf.get(x.runId) || '(station)'; (byOwner[id] = byOwner[id] || []).push(x); }
    for (const [id, list] of Object.entries(byOwner)) (result.agents[id] = result.agents[id] || { runs: 0, usd: 0, models: [], efforts: [], rules: [] }).receipts = AB.sumReceipts(list);
    // a worker is dispatched once per task: its runs past the first are the host check's structured-result repairs
    for (const [id, a] of Object.entries(result.agents)) if (['engineer', 'analyst', 'researcher'].indexOf(id) >= 0 && a.runs > 1) result.repairs += a.runs - 1;
    const byAgent = id => runs.filter(r => r.agentId === id);
    if (task === 'parity-orch-synthesis') {
      // every pass the review sent back is one more WRITER run: the drafts past the first are its REVISE verdicts
      result.revise = Math.max(0, byAgent('drafter').length - 1);
      result.output = AB.releaseNoteOf((sampleBody.replies || []).join('\n')).slice(0, 2000);
      const g = AB.grade(task, { delivered: !!sampleBody.delivered, unapproved: !!sampleBody.unapproved, output: (sampleBody.replies || []).join('\n') });
      result.ok = !result.broken && g.ok; result.checks = g.checks;
    } else {
      result.output = leadText.slice(-2000);
      const g = AB.grade(task, { leadText });
      const named = task === 'parity-orch-named-delegation' ? ['engineer'] : ['analyst', 'researcher'];
      for (const id of named) g.checks.push(['delegated to ' + id, byAgent(id).length > 0, byAgent(id).length, '>0']);
      result.ok = !result.broken && g.checks.every(c => c[1]); result.checks = g.checks;
    }
    result.verifyFailures = result.revise + result.repairs;
    return result;
  } catch (e) {
    result.broken = true;
    result.error = meter.capHit ? 'stopped by the spend cap' : String((e && e.message) || e);
    if (!started && typeof f.output === 'function') result.error += ' | station output tail: ' + f.output().slice(-1500);
    return result;
  } finally {
    const liveNow = meter.live === f ? liveCost(f) : meter.liveLast;
    meter.live = null;
    if (watcher) { try { await watcher; } catch (_) {} }
    meter.closed += Math.max(liveNow, result.usd || 0, result.usdList || 0, result.capUsd || 0);
    meter.liveLast = 0;
    try { await f.dispose(); } catch (_) {}
  }
}

// ---- the plan, the run, the report ---------------------------------------------------------------------------------------
// the provider's live catalog, read once before anything runs (a model list is free): the lead's model must be in it and
// priced, and so must every model either arm's roster would use, or nothing is spent at all
async function readCatalog() {
  const f = SidecarFixture.create({ prefix: 'starnet-crew-ab-catalog-', timeoutMs: 90000,
    env: Object.assign({}, QUIET, { STARNET_OPENROUTER_KEY: KEY, STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEFAULT_MODEL: MODEL }) });
  Object.assign(f.env, { USERPROFILE: f.profile, HOME: f.profile, HOMEDRIVE: '', HOMEPATH: f.profile });
  try {
    seedActiveStation(f.workspace);
    await f.start();
    const models = (await f.json('GET', '/api/models/' + PROVIDER)).body || {};
    const live = (models.models || []).filter(m => m && m.id && !m.fallback);
    for (const m of live) { const p = AB.priceOf(m); if (p) meter.prices.set(m.id, p); }
    return { ids: live.map(m => m.id), error: String(models.error || '') };
  } finally { await f.dispose(); }
}
function worstCase(model) {
  // a task-arm before it starts, on the high side: 8 calls of 35k input at the uncached price and 6k output (reasoning
  // included) on the lead's model. Only the guard that a task is worth starting: the meter is the cap.
  const p = priceFor(model);
  return p ? 8 * (35000 * p.input + 6000 * p.output) : Infinity;
}
function table(results) {
  const rows = ['| task | arm | ok | verify failures | USD (list, every call) | USD (booked runs) | USD (cap meter) | input-eq | output | reasoning | calls |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    const t = r.receipts || {};
    rows.push('| ' + [r.task + ' #' + (r.rep || 1), r.arm, r.broken ? 'BROKEN' : r.ok ? 'yes' : 'no', r.verifyFailures, r.usdList.toFixed(4) + (r.unpricedCalls ? ' (+' + r.unpricedCalls + ' unknown)' : ''),
      r.usd.toFixed(4), r.capUsd.toFixed(4), t.inputEq || 0, t.out || 0, t.reasoning || 0, t.calls || 0].join(' | ') + ' |');
  }
  return rows.join('\n');
}
function verdictOf(results) {
  const done = results.filter(r => !r.broken);   // a broken arm (the harness failed, or the cap stopped it) has no quality result
  const sum = (arm, k) => done.filter(r => r.arm === arm).reduce((s, r) => s + (k === 'inputEq' ? ((r.receipts || {}).inputEq || 0) : r[k]), 0);
  const pairs = [];
  for (const r of done.filter(x => x.arm === 'off')) {
    const twin = done.find(x => x.arm === 'lean' && x.task === r.task && x.rep === r.rep);
    if (twin) pairs.push([r, twin]);
  }
  const regressions = pairs.filter(([o, l]) => o.ok && !l.ok).map(([o]) => o.task + ' #' + o.rep);
  const offUsd = pairs.reduce((s, [o]) => s + o.usdList, 0), leanUsd = pairs.reduce((s, [, l]) => s + l.usdList, 0);
  const offBooked = pairs.reduce((s, [o]) => s + o.usd, 0), leanBooked = pairs.reduce((s, [, l]) => s + l.usd, 0);
  const offEq = pairs.reduce((s, [o]) => s + ((o.receipts || {}).inputEq || 0), 0), leanEq = pairs.reduce((s, [, l]) => s + ((l.receipts || {}).inputEq || 0), 0);
  const saving = offUsd > 0 ? (1 - leanUsd / offUsd) : null;
  return { pairs: pairs.length, regressions, offUsd, leanUsd, offBooked, leanBooked, saving, offInputEq: offEq, leanInputEq: leanEq,
    successOff: pairs.filter(([o]) => o.ok).length, successLean: pairs.filter(([, l]) => l.ok).length,
    verifyOff: pairs.reduce((s, [o]) => s + o.verifyFailures, 0), verifyLean: pairs.reduce((s, [, l]) => s + l.verifyFailures, 0),
    pass: pairs.length > 0 && regressions.length === 0 && saving != null && saving > 0, comparedSpendUsd: sum('off', 'usdList') + sum('lean', 'usdList') };
}
function writeReport(results, extra) {
  mkdirSync(OUT, { recursive: true });
  const v = verdictOf(results);
  const doc = { schema: 'starnet.crew-defaults-ab.v1', generatedAt: new Date().toISOString(), model: MODEL, provider: PROVIDER, leadEffort: LEAD_EFFORT,
    tasks: TASKS, reps: REPS, capUsd: CAP, marginUsd: MARGIN, perRunUsd: PER_RUN_USD, spentUsd: Number(spent().toFixed(4)), capHit: meter.capHit,
    verdict: v, results, note: extra || '' };
  writeFileSync(join(OUT, 'report.json'), scrub(JSON.stringify(doc, null, 2)) + '\n');
  const md = ['# LEANER CREW DEFAULTS A/B', '', 'Model ' + MODEL + ' on ' + PROVIDER + ', lead effort ' + LEAD_EFFORT + ', ' + REPS + ' rep(s), cap $' + CAP.toFixed(2) + '.', '',
    table(results), '', 'Pairs compared: ' + v.pairs + '. Success off ' + v.successOff + ' / lean ' + v.successLean + '. Verify failures off ' + v.verifyOff + ' / lean ' + v.verifyLean + '.',
    'USD at list price, every call: off $' + v.offUsd.toFixed(4) + ' / lean $' + v.leanUsd.toFixed(4) + (v.saving == null ? '' : ' (lean ' + (v.saving >= 0 ? 'saves ' : 'costs ') + Math.abs(v.saving * 100).toFixed(1) + '%)') +
    '. Booked by the runs (OpenRouter usage.cost): off $' + v.offBooked.toFixed(4) + ' / lean $' + v.leanBooked.toFixed(4) +
    '. Input-eq off ' + v.offInputEq + ' / lean ' + v.leanInputEq + '.', 'Regressions (passed off, failed lean): ' + (v.regressions.join(', ') || 'none') + '.',
    'VERDICT: ' + (meter.capHit ? 'INCOMPLETE (spend cap)' : v.pass ? 'PASS' : 'FAIL') + '. One rep per task is a small sample: read the rows, not only the verdict.', extra ? '\n' + extra : ''];
  writeFileSync(join(OUT, 'report.md'), scrub(md.join('\n')) + '\n');
  // the key must not be anywhere in what was written
  if (KEY) for (const name of readdirSync(OUT)) {
    const p = join(OUT, name);
    try { if (readFileSync(p, 'utf8').indexOf(KEY) >= 0) { rmSync(p, { force: true }); warn('[crew-ab] removed ' + name + ': it held the key'); } } catch (_) {}
  }
  return v;
}

async function main() {
  say('[crew-ab] LEANER CREW DEFAULTS A/B - ' + MODEL + ' on ' + PROVIDER + ', tasks ' + TASKS.join(', ') + ', ' + REPS + ' rep(s), hard cap $' + CAP.toFixed(2));
  say('[crew-ab] report: ' + OUT);
  const cat = await readCatalog();
  if (cat.ids.indexOf(MODEL) < 0) refuse(MODEL + ' is not in the live ' + PROVIDER + ' catalog' + (cat.error ? ' (' + cat.error + ')' : '') + '. Nothing was spent.');
  for (const arm of ['off', 'lean']) {
    const { rows, picks } = AB.rosterFor(arm, { provider: PROVIDER, leadModel: MODEL, leadEffort: LEAD_EFFORT, catalogIds: cat.ids, Specialties, CrewDefaults });
    for (const id of new Set(rows.map(r => r.model))) if (!priceFor(id)) refuse(id + ' has no price in the catalog. Nothing was spent.');
    say('[crew-ab] arm ' + arm + ' crew: ' + Object.entries(picks).map(([id, x]) => id + ' ' + x.model + ' @' + x.effort).join(', '));
  }
  const results = [];
  let flip = false, broke = '';
  outer: for (let rep = 1; rep <= REPS; rep++) {
    for (const task of TASKS) {
      const order = flip ? ['lean', 'off'] : ['off', 'lean'];
      flip = !flip;
      // both arms of a task, or neither: an unpaired arm compares nothing
      const left = CAP - MARGIN - spent();
      if (2 * worstCase(MODEL) > left) {
        say('[crew-ab] stopped before ' + task + ' #' + rep + ': its two arms at their worst ($' + (2 * worstCase(MODEL)).toFixed(2) + ') do not fit the $' + Math.max(0, left).toFixed(2) + ' left');
        broke = broke || 'budget'; break outer;
      }
      for (const arm of order) {
        if (meter.capHit) break outer;
        say('[crew-ab] ' + task + ' #' + rep + ' - arm ' + arm + ' ...');
        const r = Object.assign(await runArm(task, arm), { rep });
        results.push(r);
        say('[crew-ab]   ' + (r.ok ? 'ok' : 'NOT ok') + ' | verify failures ' + r.verifyFailures + ' | $' + r.usdList.toFixed(4) + ' at list price, $' + r.usd.toFixed(4) + ' booked, $' + r.capUsd.toFixed(4) + ' by the meter' +
          (r.error ? ' | ' + r.error : '') + ' | spent so far about $' + spent().toFixed(2));
        if (/^REFUSED/.test(r.error)) { writeReport(results, r.error); warn('[crew-ab] ' + r.error); process.exit(2); }
        if (r.broken && !meter.capHit) broke = broke || 'error';
      }
    }
  }
  const v = writeReport(results, meter.capHit ? 'Stopped by the spend cap; E-STOP answered ' + meter.halted + '.' : broke === 'budget' ? 'Stopped before a task whose worst case did not fit the cap.' : '');
  say('');
  say(table(results));
  say('');
  say('[crew-ab] spent about $' + spent().toFixed(2) + ' of the $' + CAP.toFixed(2) + ' cap. ' + (v.saving == null ? '' : 'Lean ' + (v.saving >= 0 ? 'saves ' : 'costs ') + Math.abs(v.saving * 100).toFixed(1) + '% USD over ' + v.pairs + ' pair(s); ') +
    'success off ' + v.successOff + ' / lean ' + v.successLean + '; regressions: ' + (v.regressions.join(', ') || 'none'));
  if (meter.capHit) { say('[crew-ab] INCOMPLETE: the spend cap stopped the A/B.'); process.exit(3); }
  if (broke === 'error') { say('[crew-ab] a station or a task broke: see report.json'); process.exit(4); }
  say('[crew-ab] VERDICT: ' + (v.pass ? 'PASS' : 'FAIL'));
  process.exit(v.pass ? 0 : 1);
}
main().catch(e => { warn('[crew-ab] ' + ((e && e.stack) || e)); process.exit(4); });
