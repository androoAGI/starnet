/* node test/aux-env-knobs.test.js — every aux-pass env knob reads through ENV() (GitHub #105, quick win 32).

   ENV(suffix) is the sidecar's one env reader: STARNET_<suffix> when it is set, else the legacy SKYNET_<suffix>. The
   post-run aux passes (thread-mine, skill review, the skill curator, scout) and their joint budget read process.env.SKYNET_*
   directly, so the documented STARNET_ spelling did nothing — STARNET_AUX_BUDGET / STARNET_SKILL_REVIEW=0 were silently
   ignored. The dev hub resolved its default model SKYNET_ first, the inverse of ENV(). And CAPS carried a dead
   maxCostUsd: 1.00 nothing reads (the per-run cap is the Balanced perRun / o.maxCostUsd), which read as a live $1 cap.

   Locks (auxbudget.e2e.test.js proves STARNET_AUX_BUDGET live on a booted sidecar):
   1. no sidecar file reads any of these knobs as process.env.SKYNET_* (a negative over every file);
   2. each gate and constant reads ENV('<knob>'), sliced from the code it lives in;
   3. ENV() itself prefers STARNET_ and falls back to SKYNET_;
   4. the dev hub's default model goes through ENV(); CAPS has no maxCostUsd. */
'use strict';
const A = require('./_assert.js');
const { readSidecarSource, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

const KNOBS = ['THREAD_MINE', 'THREAD_MINE_TIMEOUT_MS', 'THREAD_MINE_COOLDOWN_MS', 'SKILL_REVIEW', 'SKILL_REVIEW_TIMEOUT_MS', 'SKILL_REVIEW_MAX_USD',
  'SKILL_REVIEW_EVERY', 'SKILL_CURATOR', 'SKILL_CURATOR_INTERVAL_MS', 'SKILL_CURATOR_MAX_USD', 'SKILL_CURATOR_LLM', 'SCOUT', 'AUX_BUDGET', 'DEFAULT_MODEL'];
const all = readSidecarSource();

// ---- 1. no direct SKYNET_ read of an aux knob anywhere in the sidecar ----
for (const k of KNOBS) {
  const re = new RegExp('process\\.env\\.(?:SKYNET|STARNET)_' + k + '(?![A-Z_])');
  A.ok(!re.test(all), k + ' is never read straight off process.env (ENV() honours both spellings)');
}

// ---- 2. each one reads ENV('<knob>') where it is used ----
const core = sidecarTopLevelFunction('runOnceCore');
for (const k of ['THREAD_MINE', 'SKILL_REVIEW', 'SKILL_CURATOR', 'SCOUT', 'AUX_BUDGET']) {
  A.ok(core.includes("ENV('" + k + "')"), 'the run-end aux gate reads ENV(\'' + k + '\')');
}
A.ok(sidecarFunctionSource('runSkillCurator').includes("ENV('SKILL_CURATOR_LLM') !== '1'"), 'the curator\'s LLM switch reads ENV()');
// the boot-time constants live at index.js's top level: slice each declaration line
const decl = name => { const i = all.indexOf('const ' + name + ' = '); return i < 0 ? '' : all.slice(i, all.indexOf('\n', i)); };
for (const [name, k] of [['THREAD_MINE_TIMEOUT_MS', 'THREAD_MINE_TIMEOUT_MS'], ['THREAD_MINE_COOLDOWN_MS', 'THREAD_MINE_COOLDOWN_MS'],
  ['SKILL_REVIEW_TIMEOUT_MS', 'SKILL_REVIEW_TIMEOUT_MS'], ['SKILL_REVIEW_MAX_COST_USD', 'SKILL_REVIEW_MAX_USD'], ['SKILL_REVIEW_EVERY', 'SKILL_REVIEW_EVERY'],
  ['SKILL_CURATOR_INTERVAL_MS', 'SKILL_CURATOR_INTERVAL_MS'], ['SKILL_CURATOR_MAX_COST_USD', 'SKILL_CURATOR_MAX_USD']]) {
  A.ok(decl(name).includes("ENV('" + k + "')"), name + ' reads ENV(\'' + k + '\'): ' + decl(name).slice(0, 120));
}

// ---- 3. ENV(): STARNET_ first, SKYNET_ as the fallback ----
const ENVsrc = sidecarFunctionSource('ENV');
A.ok(ENVsrc.length > 20 && ENVsrc.length < 400, 'one bounded ENV');
const envWith = vars => new Function('process', ENVsrc + '\nreturn ENV;')({ env: vars });
A.eq(envWith({ STARNET_AUX_BUDGET: '0', SKYNET_AUX_BUDGET: '2' })('AUX_BUDGET'), '0', 'STARNET_ wins over SKYNET_');
A.eq(envWith({ SKYNET_AUX_BUDGET: '2' })('AUX_BUDGET'), '2', 'the legacy SKYNET_ spelling still works alone');

// ---- 4. the dev hub's default model, and the dead CAPS field ----
const dev = sidecarFunctionSource('devHubSecrets');
A.ok(dev.includes("ENV('DEFAULT_MODEL')") && !/SKYNET_DEFAULT_MODEL/.test(dev), 'the dev hub resolves its default model through ENV(), STARNET_ first: ' + dev.slice(0, 300));
const caps = decl('CAPS');
A.ok(caps.startsWith('const CAPS = {') && caps.includes('maxIters') && !caps.includes('maxCostUsd'), 'CAPS carries no dead maxCostUsd');
A.ok(!/CAPS\.maxCostUsd/.test(all), 'and nothing reads one');

A.report('aux-env-knobs.test');
