'use strict';
const { readSidecarSource, sidecarFunctionSource } = require('./helpers/source');
/* settings-p1-backend.test.js — source-lock that the P1 settings rows are wired in the SIDECAR to the REAL code
   paths they claim to control (the honesty law — a knob that does nothing is a bug). Grep-guards over
   sidecar/index.js covering the endpoints + the precedence + the live seams:
     P1-6 runOnce honors the per-agent roster model/provider when a run carries none
     P1-7 config export/import/reset endpoints wired to the durable stores; secrets never collected
     P1-9 the ADVANCED knobs resolve env > saved > default (resolveKnob) + the /api/runtime/knobs routes
     P1-10 the reflect gate reads the live memoryConfig (on/off + cooldown) + the /api/memory/config routes */
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const src = readSidecarSource({ except: ['sidecar/tools/builtin/station-control.js'] });   // the host; station-control.js names the same routes as a client
const importStart = src.indexOf('async function handleConfigImport');
const importEnd = src.indexOf('/* POST /api/config/reset', importStart);
const importBody = importStart >= 0 && importEnd > importStart ? src.slice(importStart, importEnd) : '';

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- P1-6 per-agent model override honored at run time ----
ok(/rosterIdent = agentRoster\.get\(/.test(src), 'P1-6: runOnce looks up the per-agent roster identity');
// (run-wire-resolver lane) the fallback is the ONE resolution (runWireFor): the run's own pair, else the agent's roster pin,
// else the station default — as a pair, never the roster's provider beside another level's model (behaviour: run-wire.invariant)
ok(/const runWire = runWireOfRun\(o\);/.test(src) && /let model = String\(runWire\.model \|\| ''\)\.trim\(\)/.test(src), 'P1-6: the roster model is used as a fallback for a run with no explicit model');
ok(/agent: agentRoster\.get\(id\) \|\| null, hero: agentRoster\.get\('agent'\) \|\| null/.test(src) && /const providerId = normalizeProvider\(runWire\.provider \|\| ''\);/.test(src), 'P1-6: the roster provider is used when the run carries none');

// ---- P1-7 config export/import/reset ----
ok(/require\('\.\/configexport\.js'\)/.test(src), 'P1-7: the configexport module is required');
ok(/'\/api\/config\/export'/.test(src) && /'\/api\/config\/import'/.test(src) && /'\/api\/config\/reset'/.test(src), 'P1-7: export/import/reset routes are registered');
ok(/function collectExportSnapshot\(/.test(src), 'P1-7: a collector gathers the live server-side stores');
// SECURITY: the collector must NOT read secrets into the snapshot — no channelSecrets / provider keys / codex tokens.
ok(!/collectExportSnapshot[\s\S]{0,900}channelSecrets/.test(src), 'P1-7: the export collector never reads channelSecrets (no bot tokens)');
// (credential-store lane, S1) provider keys live in the credential store, so the lock names the store's surface: credStore,
// a secretValues() reader, providerRuntimeKey, and engineKeys (the page copy). The surface it names must exist, or the lock
// passes vacuously, as the old `runtimeKeys` one would have once those maps left index.js.
const collector = sidecarFunctionSource('collectExportSnapshot');
ok(collector.length > 200 && /const credStore = credentialStore\.makeCredentialStore\(/.test(src) && /function providerRuntimeKey\(/.test(src) && /\bcredStore\.secretValues\(/.test(src),
  'P1-7: fixture: the collector and the provider-key surface the next lock names both exist');
ok(!/\b(?:credStore|secretValues|providerRuntimeKey|engineKeys|runtimeKeys)\b/.test(collector)
  && !/collectExportSnapshot[\s\S]{0,900}(?:credStore|secretValues|providerRuntimeKey|engineKeys|runtimeKeys)/.test(src), 'P1-7: the export collector never reads provider keys');
// import writes through the SAME durable stores (not a bypass)
ok(importBody.length > 0 && importBody.length < src.length, 'P1-7: import source-lock resolves the complete function body');
ok(/saveBudgetOverrides\(v\)/.test(importBody), 'P1-7: import persists validated budget overrides through its durable store before publishing them');
ok(/saveAgentRoster\(\)/.test(importBody), 'P1-7: import persists roster through its durable store');
ok(/persistConnectorState\(nextState\.configs, nextState\.oauth\)/.test(importBody), 'P1-7: import transactionally persists connector config and OAuth state');
ok(sidecarFunctionSource('handleConfigReset').includes('unknown or non-resettable section'), 'P1-7: the complete reset owner rejects an unknown section');

// ---- P1-9 advanced runtime knobs: env > saved > default ----
ok(/function resolveKnob\(/.test(src), 'P1-9: resolveKnob implements the precedence');
const limits = require('../sidecar/limits-registry.js');
ok(/const CAPS = limitsRegistry\.caps\(ENV, runtimeKnobs\)/.test(src) && limits.caps(() => undefined, {}).maxIters === 0, 'P1-9: maxIters defaults to unlimited through the runtime registry');
ok(/const MAX_CONCURRENT_AGENTS = resolveKnob\('maxConcurrentAgents'\)/.test(src) && limits.resolve('maxConcurrentAgents', () => undefined, {}) === 0, 'P1-9: maxConcurrentAgents defaults to unlimited through the same runtime registry');
// 2026-09-17: the four caps read their defaults from ONE shipped table (budgetcaps.SHIPPED_DEFAULTS) so the
// runaway-loop day rail and the still-off per-run ceiling cannot drift apart. Per-run stays off — asserted on
// the table itself, not on a literal the source no longer carries.
ok(/const BUDGET_CAPS = Object\.fromEntries\(limitsRegistry\.definitions\('spending'\)\.map\(d => \[d\.key, num\(ENV\(d\.env\), d\.def\)\]\)\)/.test(src) && limits.BY_KEY.perRun.env === 'BUDGET_PER_RUN' && limits.BY_KEY.perRun.def === require('../sidecar/budgetcaps.js').shippedDefaults().perRun, 'P1-9: the per-run spend ceiling resolves env > shipped default through the spending registry');
ok(require('../sidecar/budgetcaps.js').shippedDefaults().perRun === 0, 'P1-9: the per-run spend ceiling defaults off');
ok(require('../sidecar/budgetcaps.js').shippedDefaults().perDay === 25, 'the per-day rail ships ON at $25 (the 2026-09-17 runaway-loop incident)');
ok(/ORCH_PER_WORKER\s*=\s*num\(ENV\('BUDGET_PER_WORKER'\), 0\)/.test(src), 'P1-9: the delegated-worker spend ceiling defaults off');
ok(/ORCH_WORKER_MAX_ITERS\s*=\s*num\(ENV\('WORKER_MAX_ITERS'\), 0\)/.test(src), 'P1-9: the delegated-worker iteration ceiling defaults off');
ok(/maxConcurrent:\s*\(\)\s*=>\s*num\(ENV\('V1_MAX_CONCURRENT'\), 0\)/.test(src), 'P1-9: the external API concurrency ceiling defaults off');
ok(/CRON_MAX_PARALLEL\s*=\s*num\(ENV\('CRON_MAX_PARALLEL'\), 0\)/.test(src), 'P1-9: scheduled-work concurrency defaults to unlimited');
ok(/LOOP_MAX_PARALLEL\s*=\s*num\(ENV\('LOOP_MAX_PARALLEL'\), 0\)/.test(src), 'P1-9: standing-loop concurrency defaults to unlimited');
// ---- managed credits stay functional with no opt-in cap: an uncapped run reserves min(managed default, wallet),
// never refuses a funded wallet — and never the WHOLE wallet (issue #53: one prompt drained a $10 top-up) ----
ok(/runCapUsd = budgetCaps\.managedRunCapUsd\(\(runCapUsd > 0 && isFinite\(runCapUsd\)\) \? runCapUsd : 0, avail, MANAGED_PER_RUN_DEFAULT\);/.test(src),'managed credits: an uncapped run reserves the managed per-run default, clamped to the available balance');
ok(require('../sidecar/budgetcaps.js').managedRunCapUsd(0, 0.5, 2) === 0.5, 'managed credits: a wallet below the default still runs (clamped, not refused)');
ok(!/Managed credits need a per-run budget cap/.test(src), 'managed credits: the set-an-env-var refusal is gone — no cap is required to run');
ok(/if \(!\(runCapUsd > 0\)\) \{[\s\S]{0,1200}return;[\s\S]{0,300}const adm = credits\.beginRun\(\{ runId, agentId, capUsd: runCapUsd \}\);/.test(src), 'managed credits: an unknown/empty balance still fails CLOSED before any reservation (never spends against an unknown wallet)');
ok(/resolveKnob\('consentTimeoutMs'\)/.test(src) && limits.BY_KEY.consentTimeoutMs.env === 'CONSENT_TIMEOUT_MS' && limits.resolve('consentTimeoutMs', () => undefined, {}) === 120000, 'P1-9: consent timeout is env>saved>default');
ok(/resolveKnob\('cronTickMs'\)/.test(src) && limits.BY_KEY.cronTickMs.env === 'CRON_TICK_MS' && limits.resolve('cronTickMs', () => undefined, {}) === 60000, 'P1-9: cron tick resolves via resolveKnob');
ok(/return limitsRegistry\.runtimeStatus\(ENV, runtimeKnobs, activeRuntimeKnobs\(\), CONSENT_ACK_EXTEND_MS\)/.test(sidecarFunctionSource('runtimeKnobsStatus')) && limits.runtimeStatus(k => k === 'MAX_ITERS' ? '7' : undefined, {}, {}, 0).fields.maxIters.envLocked === true && limits.runtimeStatus(() => undefined, {}, {}, 0).fields.maxIters.envLocked === false, 'P1-9: the actual status owner reports which knobs are env-locked');
ok(/'\/api\/runtime\/knobs'/.test(src), 'P1-9: the runtime-knobs routes are registered');
// an env-locked knob can't be overwritten from the UI
ok(/if \(knobEnvLocked\(d\.env\)\) continue/.test(src), 'P1-9: a POST cannot override an env-locked knob');

// ---- P1-10 memory controls wire to the reflect gate ----
ok(/let memoryConfig = /.test(src), 'P1-10: a persisted memoryConfig exists');
ok(/memoryConfig\.reflectEnabled/.test(src) && /memoryConfig\.reflectCooldownMs/.test(src), 'P1-10: the reflect gate reads the live memoryConfig');
ok(/o\.reflect && memoryConfig\.reflectEnabled && isTask/.test(src), 'P1-10: reflection off actually stops the turn-in loop at the gate');
ok(/Date\.now\(\) - \(lastReflectAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.reflectCooldownMs/.test(src), 'P1-10: the cooldown gate uses the configured value');
ok(/'\/api\/memory\/config'/.test(src), 'P1-10: the memory-config routes are registered');
ok(/function saveMemoryConfig\(/.test(src), 'P1-10: memoryConfig persists durably');

console.log('settings-p1-backend.test.js OK —', n, 'assertions');
