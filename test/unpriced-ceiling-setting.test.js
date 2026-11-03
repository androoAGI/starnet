/* node test/unpriced-ceiling-setting.test.js — issue #135: a model StarNet has no price for (a custom provider's
   deepseek-ai/deepseek-v4.1-flash-1107) stopped every run at a hardcoded 2,000,000 tokens. The only override was the
   STARNET_MAX_UNPRICED_TOKENS environment variable; the Runtime limits row a user found (CLAUDE CODE TOKEN CEILING, now
   SIGN-IN TOKEN CEILING) is the sign-in plans' ceiling and never touched it, so setting it to 5M or 0 changed nothing.

   GENUINE (the real sidecar/index.js knob code, run in a vm against a temp runtime.knobs.json — never the sidecar):
     • SAVE: POST /api/runtime/knobs { maxUnpricedTokens } persists, reports it, and is bounds-checked like its sibling;
     • LIVE: the save re-resolves BOTH per-run token ceilings into CAPS, and the run seam's own limits expression
       (sliced from runOnceCore) hands the NEXT run the new value — no restart; a restart keeps it too;
     • env still wins: an env-locked ceiling ignores a write and CAPS stays on the env value (never a pretend save);
     • the loop (sidecar/loop.js, real) stops at the saved ceiling, and 0 = no ceiling.
   SOURCE-LOCKED: nothing else reads CAPS.max*Tokens; the Settings rows sit in the existing Runtime limits list with
   the sidecar's bounds; limits.set (station.power) carries every Runtime limits key; every surface's stop message
   names the setting. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const part = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('slice ' + a); return s.slice(i, j); };
const side = readSidecarSource();

// the real knob code: the boot reader + resolver, the CAPS line, the defs/status, and the POST handler
const BOOT = part(side, 'let runtimeKnobs = (function loadRuntimeKnobsAtBoot() {', '\n// maxIters: optional per-run tool-turn ceiling.');
const CAPS_LINE = part(side, 'const CAPS = ', '\n');
const DEFS = part(side, 'const RUNTIME_KNOB_DEFS = ', 'function handleRuntimeKnobsGet(');
const SET = part(side, 'async function handleRuntimeKnobsSet(req, res) {', '\nfunction setProviderRuntimeConfig(');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpriced-ceiling-'));
const FILE = path.join(dir, 'runtime.knobs.json');

// one "sidecar boot": a fresh context reads the knob file and builds CAPS, exactly as index.js does at start
function boot(env) {
  const ctx = vm.createContext({
    fs, console: { warn: () => {} }, Object, Number, String, JSON, Math, isFinite,
    limitsRegistry: require('../sidecar/limits-registry.js'), saveJsonVerified: require('../sidecar/durable-store.js').saveJsonVerified,
    MAX_CONCURRENT_AGENTS: 0, CRON_TICK_MS: 60000,
    RUNTIME_KNOBS_FILE: FILE,
    ENV: suffix => (env || {})[suffix],
    CONSENT_TIMEOUT_MS: 120000, CONSENT_ACK_EXTEND_MS: 600000,
    saveResilient: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    readBody: async req => req.body
  });
  vm.runInContext(BOOT + '\n' + CAPS_LINE + '\n' + DEFS + '\n' + SET +
    '\n;this.CAPS = CAPS; this.status = runtimeKnobsStatus; this.set = handleRuntimeKnobsSet;', ctx);
  return ctx;
}
async function post(ctx, body) {
  let code = 0, out = null;
  const res = { writeHead: c => { code = c; }, end: s => { out = JSON.parse(s); } };
  await ctx.set({ body: JSON.stringify(body) }, res);
  return { code, json: out };
}

// the loop, really run: an unpriced metered model burning `perTurn` tokens a turn until maxIters
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { seq, emit: makeEmitter(bus, () => {}) };
}
const noopTool = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];
function runUnpriced(maxUnpricedTokens, perTurn, maxIters) {
  const s = setup();
  const provider = {
    priceOf: () => null, contextLimit: () => 0,
    stream: async function* () {
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'noop' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { prompt_tokens: perTurn, completion_tokens: 0, total_tokens: perTurn } };
      yield { type: 'done', finishReason: 'tool_calls' };
    }
  };
  return runAgentLoop({
    messages: [{ role: 'user', content: 'x' }], provider, emit: s.emit, cost: makeCostEngine({ priceOf: () => null }),
    dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'deepseek-ai/deepseek-v4.1-flash-1107', agentId: 'a', runId: 'r' + Math.random(),
    limits: { maxCostUsd: 1.00, maxIters, grace: false, maxUnpricedTokens }
  }).then(res => ({ res, end: s.seq.find(e => e.name === 'agent.run.end') }));
}

// the run seam's limits for the two token ceilings, sliced from runOnceCore and evaluated against a context's CAPS. The
// unpriced ceiling follows the run's payer (billing-class.js POLICY): a dollar payer has it, a sign-in plan does not.
const { POLICY } = require('../sidecar/billing-class.js');
const SEAM = part(side, '        maxUnpricedTokens: runBilling.policy.unpricedTokenCeiling', '\n      },');
function nextRunLimits(ctx, exempt) {
  return vm.runInContext('(function (runBilling) { return {' + SEAM + '}; })', ctx)({ policy: POLICY[exempt ? 'subscription' : 'metered'] });
}
// a Claude Code sign-in run: $0 turns marked usage.subscription (fresh input counts in full)
function runSubscription(maxSubscriptionTokens, perTurn, maxIters) {
  const s = setup();
  const provider = {
    priceOf: () => null, contextLimit: () => 0,
    stream: async function* () {
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'noop' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { prompt_tokens: perTurn, completion_tokens: 0, total_tokens: perTurn, prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 }, cost: 0, subscription: true } };
      yield { type: 'done', finishReason: 'tool_calls' };
    }
  };
  return runAgentLoop({
    messages: [{ role: 'user', content: 'x' }], provider, emit: s.emit, cost: makeCostEngine({ priceOf: () => null }),
    dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'claude-opus-5-5', agentId: 'a', runId: 's' + Math.random(),
    limits: { maxCostUsd: 1.00, maxIters, grace: false, maxSubscriptionTokens }
  });
}

(async () => {
  try {
    // ---- the shipped default: 2,000,000, reported as a Runtime limits field ----
    let ctx = boot();
    A.eq(ctx.CAPS.maxUnpricedTokens, 2000000, 'no saved value: the built-in 2,000,000-token ceiling');
    const f0 = ctx.status().fields.maxUnpricedTokens;
    A.ok(!!f0, 'GET /api/runtime/knobs reports maxUnpricedTokens');
    A.eq(f0 && [f0.effective, f0.default, f0.saved, f0.envLocked, f0.min, f0.max], [2000000, 2000000, null, false, 0, 100000000], 'default 2,000,000, nothing saved, editable, the sibling\'s bounds');

    // ---- SAVE 5,000,000 → it persists, is reported, and the NEXT run uses it (no restart) ----
    let r = await post(ctx, { maxUnpricedTokens: 5000000 });
    A.eq(r.code, 200, 'POST maxUnpricedTokens 5,000,000 → 200');
    A.eq(r.json && r.json.fields && r.json.fields.maxUnpricedTokens && [r.json.fields.maxUnpricedTokens.effective, r.json.fields.maxUnpricedTokens.saved], [5000000, 5000000], 'the reply reports it saved and effective');
    A.eq(JSON.parse(fs.readFileSync(FILE, 'utf8')).knobs.maxUnpricedTokens, 5000000, 'runtime.knobs.json holds it');
    A.eq(ctx.CAPS.maxUnpricedTokens, 5000000, 'the RUNNING sidecar\'s CAPS moves on save');
    A.eq(nextRunLimits(ctx).maxUnpricedTokens, 5000000, 'the run seam hands the next run 5,000,000 — no restart');
    A.eq(nextRunLimits(ctx, true).maxUnpricedTokens, Infinity, 'an unmetered/OAuth run stays exempt');
    const five = await runUnpriced(nextRunLimits(ctx).maxUnpricedTokens, 1500000, 10);
    A.eq(five.res.reason, 'budget', 'the run stops on the token ceiling');
    A.eq(five.res.turns, 4, 'not at 2,000,000 — it ran until it crossed 5,000,000 (4 × 1.5M)');
    A.eq(five.end && five.end.payload.unpricedCapTokens, 5000000, 'agent.run.end names the saved ceiling');
    A.ok(/UNPRICED MODEL TOKEN CEILING/.test(five.res.budgetNote) && /Runtime limits/.test(five.res.budgetNote) && !/restart/.test(five.res.budgetNote), 'the loop\'s budget note names the setting: ' + five.res.budgetNote);
    A.eq(boot().CAPS.maxUnpricedTokens, 5000000, 'and a restart keeps it (the boot reader no longer drops it)');

    // ---- 0 = no ceiling, live ----
    r = await post(ctx, { maxUnpricedTokens: 0 });
    A.eq(r.code, 200, 'POST 0 → 200');
    A.eq(ctx.CAPS.maxUnpricedTokens, 0, 'CAPS is 0 right away');
    const off = await runUnpriced(nextRunLimits(ctx).maxUnpricedTokens, 1500000, 4);
    A.eq(off.res.reason, 'max_iters', '0 = no ceiling: 6,000,000 unpriced tokens and no token stop');
    A.eq(boot().CAPS.maxUnpricedTokens, 0, 'a restart keeps the saved 0 (not dropped to the default)');

    // ---- the sign-in ceiling applies live the same way ----
    r = await post(ctx, { maxSubscriptionTokens: 1000000 });
    A.eq(r.code, 200, 'POST maxSubscriptionTokens 1,000,000 → 200');
    A.eq(nextRunLimits(ctx).maxSubscriptionTokens, 1000000, 'the next run gets the new sign-in ceiling — no restart');
    const sub = await runSubscription(nextRunLimits(ctx).maxSubscriptionTokens, 400000, 10);
    A.eq([sub.reason, sub.turns, sub.subscriptionCapTokens], ['budget', 3, 1000000], 'it stops at 1,000,000 (3 × 400k)');
    await post(ctx, { maxSubscriptionTokens: 0 });
    A.eq((await runSubscription(nextRunLimits(ctx).maxSubscriptionTokens, 400000, 4)).reason, 'max_iters', 'and 0 lifts it for the next run');

    // ---- bounds + clear, same style as the sibling ----
    A.eq((await post(ctx, { maxUnpricedTokens: -1 })).code, 400, 'a negative ceiling → 400');
    A.eq((await post(ctx, { maxUnpricedTokens: 100000001 })).code, 400, 'above 100,000,000 → 400');
    A.eq(ctx.CAPS.maxUnpricedTokens, 0, 'a refused save leaves the live ceiling alone');
    r = await post(ctx, { maxUnpricedTokens: null, maxSubscriptionTokens: null });
    A.eq(r.json && r.json.fields && r.json.fields.maxUnpricedTokens ? r.json.fields.maxUnpricedTokens.saved : 'missing', null, 'null clears the override');
    A.eq([ctx.CAPS.maxUnpricedTokens, ctx.CAPS.maxSubscriptionTokens], [2000000, 2000000], 'RESET puts the next run back on the defaults, live');

    // ---- an environment variable still wins, and a save never pretends to move it ----
    await post(ctx, { maxUnpricedTokens: 3000000, maxSubscriptionTokens: 3000000 });
    const envCtx = boot({ MAX_UNPRICED_TOKENS: '7000000', MAX_SUBSCRIPTION_TOKENS: '8000000' });
    A.eq([envCtx.CAPS.maxUnpricedTokens, envCtx.CAPS.maxSubscriptionTokens], [7000000, 8000000], 'the env values beat the saved ones at boot');
    r = await post(envCtx, { maxUnpricedTokens: 9000000, maxSubscriptionTokens: 9000000 });
    A.eq(r.code, 200, 'the save itself is accepted (other rows may have changed)');
    const fu = (r.json && r.json.fields && r.json.fields.maxUnpricedTokens) || {}, fsub = (r.json && r.json.fields && r.json.fields.maxSubscriptionTokens) || {};
    A.eq([fu.envLocked, fu.effective, fu.saved, fsub.envLocked, fsub.effective, fsub.saved], [true, 7000000, 3000000, true, 8000000, 3000000], 'the reply says env-locked at the env value — not 9,000,000');
    A.eq([envCtx.CAPS.maxUnpricedTokens, envCtx.CAPS.maxSubscriptionTokens], [7000000, 8000000], 'the live ceilings stay on the env values');
    A.eq([nextRunLimits(envCtx).maxUnpricedTokens, nextRunLimits(envCtx).maxSubscriptionTokens], [7000000, 8000000], 'and so does the next run');
    A.eq(JSON.parse(fs.readFileSync(FILE, 'utf8')).knobs.maxUnpricedTokens, 3000000, 'an env-locked knob ignores the write on disk too');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

  // ---- every reader of the token ceilings reads CAPS at run time (runOnceCore), so the live update reaches them ----
  {
    const lines = side.split('\n');
    const lineOf = idx => side.slice(0, idx).split('\n').length - 1;
    const core = side.indexOf('async function runOnceCore(o) {');
    const coreEnd = side.indexOf('\nasync function ', core + 10);
    const from = lineOf(core), to = coreEnd > 0 ? lineOf(coreEnd) : lines.length;
    const readers = lines.map((l, i) => [i, l]).filter(([, l]) => /CAPS\.max(Unpriced|Subscription)Tokens/.test(l) && !/^\s*\/\//.test(l));
    const activeStart = lineOf(side.indexOf('function activeRuntimeKnobs() {'));
    const activeEnd = lineOf(side.indexOf('\n}', side.indexOf('function activeRuntimeKnobs() {')));
    const effectiveAt = side.indexOf('function effectiveLimitsStatus() {');
    A.ok(effectiveAt > 0, 'effective payer readback is a runtime getter');
    const effectiveStart = lineOf(effectiveAt), effectiveEnd = lineOf(side.indexOf('\n}', effectiveAt));
    const outside = readers.filter(([i, l]) => !/^const CAPS = /.test(l) && !(i > from && i < to) && !(i > activeStart && i <= activeEnd) && !(i > effectiveStart && i <= effectiveEnd));
    A.eq(outside.map(([i, l]) => (i + 1) + ': ' + l.trim().slice(0, 80)), [], 'no boot-time copy of CAPS.max*Tokens outside runOnceCore and the two live-status getters');
    A.ok(readers.length >= 3, 'the run seam reads them (' + readers.length + ' lines)');
    A.ok(/for \(const d of RUNTIME_KNOB_DEFS\) if \(d\.applies === 'next-run'\) CAPS\[d\.key\] = resolveKnob\(d\.key\);/.test(side), 'the save re-resolves live knobs through resolveKnob (env > saved > default)');
    A.eq(require('../sidecar/limits-registry.js').definitions('runtime').filter(d => d.applies === 'next-run').map(d => d.key), ['maxSubscriptionTokens', 'maxUnpricedTokens'], 'only the two per-run token ceilings are live');
  }

  // ---- the Settings row: in the existing Runtime limits list, the sidecar's bounds, says 0 and restart ----
  const ui = read('frontend/app/stationui.js');
  const uc = { F: require('../sidecar/limits-registry.js').definitions('runtime') };
  A.ok(!/const ADV_FIELDS\s*=/.test(ui) && /definitions\.map\(f =>/.test(ui), 'Settings renders the server-owned definitions instead of a copied list');
  const row = uc.F.find(f => f.key === 'maxUnpricedTokens');
  const sib = uc.F.find(f => f.key === 'maxSubscriptionTokens');
  A.ok(!!row, 'Runtime limits has a maxUnpricedTokens row');
  A.eq(row && row.label, 'UNPRICED MODEL TOKEN CEILING', 'labelled for what it is');
  A.eq(row && [row.min, row.max, row.step], sib && [sib.min, sib.max, sib.step], 'same bounds and step as SIGN-IN TOKEN CEILING');
  // spend-governor S1: the seatbelt covers every sign-in plan (ChatGPT, Grok, Kimi, a Claude subscription), and its row says so
  A.ok(sib && sib.label === 'SIGN-IN TOKEN CEILING' && /ChatGPT, Grok, Kimi or a Claude subscription/.test(sib.hint), 'the sign-in ceiling is named for every sign-in it covers: ' + (sib && sib.label));
  A.ok(row && /0 = no ceiling/.test(row.hint) && row.applies === 'next-run' && /price/.test(row.hint), 'the hint says what it governs, 0 = no ceiling, and when it applies: ' + (row && row.hint));
  A.ok(sib && sib.applies === 'next-run', 'and so does SIGN-IN TOKEN CEILING: ' + (sib && sib.hint));
  A.eq(uc.F.length, 6, 'one new row, nothing else added');

  // ---- limits.set (station.power) carries every Runtime limits key ----
  const { makeStationControlTools, cardFor } = require('../sidecar/tools/builtin/station-control.js');
  const routes = [];
  const tools = makeStationControlTools({ station: { request: async () => ({ ok: true }) }, route: async (m, u, b) => { routes.push({ m, u, b }); return { status: 200, json: { ok: true } }; }, surface: 'interactive', later: () => {} });
  const args = {}; uc.F.forEach((f, i) => { args[f.key] = f.min + i; });
  const done = await tools.powerTool.run({ action: 'limits.set', args });
  A.ok(!/^REFUSED/.test(done.content), 'limits.set runs');
  A.eq(routes.length && Object.keys(routes[0].b).sort(), Object.keys(args).sort(), 'limits.set sends every Runtime limits key the Settings list has');
  A.ok(/maxUnpricedTokens UNLIMITED/.test(cardFor({ action: 'limits.set', args: { maxUnpricedTokens: 0 } })), 'its card names 0 as UNLIMITED');

  // ---- every stop message names the setting ----
  const x = { unpricedModel: 'deepseek-ai/deepseek-v4.1-flash-1107', unpricedCapTokens: 2000000 };
  const sentence = require('../sidecar/stop-reason.js').stopSentence('budget', x);
  A.ok(/UNPRICED MODEL TOKEN CEILING/.test(sentence) && /SETTINGS › APP & BACKUP › Runtime limits/.test(sentence) && !/restart/.test(sentence), 'routines/loops/channels: ' + sentence);
  const note = require('../sidecar/channels/hub.js').endNote('budget', Object.assign({ budgetScope: 'run' }, x));
  A.ok(/UNPRICED MODEL TOKEN CEILING/.test(note), 'channel reply note: ' + note);
  const chat = read('frontend/app/chat.js');
  const cc = vm.createContext({ Number, isFinite });
  vm.runInContext(part(chat, '  function budgetStopLine(', '  // the budget stop\'s door') + '\n;this.line = budgetStopLine;', cc);
  const line = cc.line('run', null, false, { model: x.unpricedModel, capTokens: 2000000 });
  A.ok(/UNPRICED MODEL TOKEN CEILING/.test(line) && /SETTINGS › APP & BACKUP › Runtime limits/.test(line) && !/restart/.test(line), 'COMMS: ' + line);

  A.report('unpriced-ceiling-setting.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
