/* node test/cron.run-now.test.js - source-locks manual routine Run Now visibility.

   The reference harness had this exact class of bug: a manual cron run reported success but did
   not actually fire through the same observable path. In StarNet the important
   contract is that /api/cron/run is not only a panel-local NDJSON stream: it
   must also place a cron work item and mirror lifecycle over SSE so the floor
   moves immediately when the user presses Run Now. */
'use strict';
const { readSidecarSource } = require('./helpers/source');

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = readSidecarSource();

function sliceBetween(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(endPattern);
  return end < 0 ? rest : rest.slice(0, end);
}

const driverBlock = sliceBetween(src, /const cronDriver = makeCronDriver\(/, /let cronTimer = null;/);
const runNowBlock = sliceBetween(src, /async function handleCronRun\(/, /\/\* POST \/api\/checkpoint\/restore/);
const runOnceBlock = sliceBetween(src, /async function runOnce\(/, /\/\/ ---- concurrency admission/);

A.ok(/function placeCronWorkitem\s*\(/.test(src), 'shared cron workitem helper exists');
A.ok(/placeWorkitem:\s*placeCronWorkitem/.test(driverBlock), 'scheduled cron uses the shared workitem helper');
A.ok(/placeCronWorkitem\s*\(\s*job\.agentId\s*,\s*job\.prompt\s*,\s*runId\s*,\s*job\.dockId\s*,\s*\{\s*byFire:\s*true,\s*runsLine:\s*job\.runsLine === true,\s*entry:\s*'manual'/.test(runNowBlock), 'manual Run Now places its cron workitem and admits a manual job only for a line fire');
A.ok(/broadcast:\s*true/.test(runNowBlock), 'manual Run Now opts into SSE lifecycle broadcast');
A.ok(/manual[\s/]+Run Now[\s/]+opts into broadcast/i.test(runOnceBlock), 'runOnce comment documents manual cron broadcast reason');

/* GRANTS NEVER FLOW DOWN A LINE (2026-08-04). The routine's unattended grant was approved for ONE agent —
   its own dock. Stage one keeps it; every chain hop must run UNGRANTED, on BOTH fire paths (scheduled goes
   through the driver's advanceChain seam; Run Now runs its line itself). Both run their hops through the ONE hop
   executor (sidecar/routing/line-runner.js, line-job-runner), whose runOnce hands every hop an EMPTY grant list by
   construction — after the profile's own options, so no profile can hand one on. Locked here; driven in
   test/line-runner.test.js (every production profile, a fake runOnce at the transport edge). */
// stage one of Run Now still runs with the routine's own recorded grant…
A.ok(/unattendedGrants:\s*Array\.isArray\(job\.unattendedGrants\)/.test(runNowBlock), "Run Now stage one keeps the routine's own unattended grant");
// …but its line (inside the same handler, after stage one) runs through the one executor's manual profile…
const runNowHopBlock = sliceBetween(runNowBlock, /lineRunner\.runLineJob\(/, /markRun/);
A.ok(/LineRunner\.profiles\.manual\(\{/.test(runNowHopBlock), 'the Run Now line runs its hops through the one hop executor');
A.ok(!/unattendedGrants/.test(runNowHopBlock), "the Run Now line hands the hop executor no grant of the routine's");
// …and so does the scheduled path's advanceChain seam, for every hop it executes.
const seamBlock = sliceBetween(driverBlock, /advanceChain:\s*\(o\)\s*=>\s*lineRunner\.runLineJob\(/, /^\}\);/m);
A.ok(/LineRunner\.profiles\.schedule\(\{/.test(seamBlock), 'the scheduled advanceChain seam runs every hop through the one hop executor');
A.ok(!/unattendedGrants:\s*o\.unattendedGrants/.test(seamBlock), 'the seam never forwards caller-supplied grants into a hop');
const runner = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'routing', 'line-runner.js'), 'utf8');
const runnerHopRun = sliceBetween(runner, /await runOnce\(Object\.assign\(\{\}, own, \{/, /\}\)\);/);
A.ok(/unattendedGrants:\s*\[\]/.test(runnerHopRun), 'the one hop executor runs every hop with NO unattended grants, after the profile\'s own options');

/* A HOP RUNS ON THE TARGET DOCK'S OWN ROSTER CONFIG (2026-08-10 audit #3). Both cron hop executors ran the
   foreign dock on the ROUTINE's provider/model/key — same drawn floor, different models (and the routine's
   credential spending as a foreign agent) depending on nothing but what triggered the line. Channel hops
   already resolved the receiving dock's roster (hub.js resolveRunConfig); both cron paths now resolve
   through cronHopConfigFor (roster config when a roster exists, the routine's own config only under the
   documented EMPTY-roster headless grace). Locked textually so a refactor that quietly re-inherits the
   routine's key into a hop turns this red. */
A.ok(/function cronHopConfigFor\s*\(/.test(src), 'the cron hop config resolver exists');
A.ok(/agentRoster\.size === 0/.test(sliceBetween(src, /function cronHopConfigFor\s*\(/, /function cronProviderFor/)), 'and it fails open ONLY on an empty (never-pushed) roster');
A.ok(/config:\s*\(agentId\)\s*=>\s*cronHopConfigFor\(agentId, o\)/.test(seamBlock), "the scheduled seam resolves each hop's config from the TARGET agent");
A.ok(/config:\s*\(agentId\)\s*=>\s*cronHopConfigFor\(agentId, \{ key: key, model: model, provider: provider \}\)/.test(runNowHopBlock), "the Run Now hop resolves its config from the TARGET agent too");
// the pin lands on the hop's runOnce CALL (the one executor): the fallback arg may name the routine's config (empty-roster
// grace), but what the hop actually SPENDS must be the resolved target config, on both fire paths.
A.ok(/key:\s*cfg\.key,\s*model:\s*cfg\.model,\s*provider:\s*cfg\.provider/.test(runnerHopRun), "every hop's runOnce spends the target's resolved key/model/provider");
A.ok(!/key:\s*o\.key/.test(seamBlock) && !/key:\s*key,/.test(runnerHopRun), "and never the routine's key");

/* THE ENTRY RUN IS PART OF ITS OWN CHAIN'S $ CEILING (2026-08-10 audit): both fire paths seed the chain
   runner with stage one's reconciled spend, so MAX_CHAIN_USD bounds the whole line, not just the hops. */
A.ok(/entryUsd:\s*o\.entryUsd/.test(seamBlock), "the scheduled seam forwards the entry run's spend into the chain ceiling");
A.ok(/entryUsd:\s*state\.usd/.test(runNowBlock), "Run Now seeds the chain ceiling with stage one's reconciled spend");

/* THE ROUTINE'S RECORDED SPEND IS THE WHOLE LINE'S (2026-08-22): a Run Now line that cost real money showed
   `lastUsd 0` — the hop-only chain spend was dropped and markRun never received usd at all. Both fire paths must
   add line.usd to the entry spend and hand it to markRun. Since quick win 25 both paths fold the line through ONE helper
   (routing/line-fire.js foldLineIntoFire — its spend fold is behaviour-tested in cron.chain.test.js). */
A.ok(/foldLineIntoFire\(state, line, pressedText\)/.test(runNowBlock), "Run Now adds the line's hop spend to the entry run's spend (foldLineIntoFire)");
A.ok(/cronDriver\.settleRun\(job\.id, runId, state, null\)/.test(runNowBlock), "Run Now passes the line's full state into the shared durable settlement path");

/* SAME TOOLS AS THE SCHEDULED FIRE (B5 per-bay isolation). Run Now's stage one passed no `station`, so runOnce fell
   back to the broad autonomous default office (dish, cabinet, notebook, studio…) while the scheduled fire runs in the
   routine's bay room only — "test it now" showed web tools the 9:00 fire did not have (or the reverse). Lock stage
   one to the exact resolveStation expression the driver uses, and the driver to its side of it. */
const runNowStageOne = sliceBetween(runNowBlock, /await runOnce\(\{/, /lineRunner\.runLineJob\(/);
A.ok(/station:\s*\(\s*job\.dockId\s*\?\s*admit\.stationFor\(job\.agentId,\s*job\.dockId\)\s*:\s*admit\.stationFor\(job\.agentId\)\s*\)\s*\|\|\s*undefined/.test(runNowStageOne), "Run Now stage one runs in the routine's bay room, exactly like the scheduled fire (B5)");
const driverSrc = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'cron-driver.js'), 'utf8');
A.ok(/job\.dockId \? resolveStation\(job\.agentId, job\.dockId\) : resolveStation\(job\.agentId\)/.test(driverSrc), 'the scheduled fire resolves the same bay station (cron-driver.js)');
A.ok(/resolveStation:\s*\(agentId, dockId\)\s*=>\s*admit\.stationFor\(agentId, dockId\)/.test(driverBlock), "the driver's resolveStation is the router's stationFor, as a dispatch (admit) seam — the seam Run Now calls directly");

/* threads-backend-03: a run whose model went silent AFTER its tools ran must never be reported as "nothing was done"
   (a file was written; "continue" may redo it). Run Now counts the tool calls it streams and hands the count to the
   stop sentence (StopReason.incompleteRunMessage's extra.toolsRan). */
A.ok(/assembler\.feed\(name, p\)\) \{ state\.buf = assembler\.text\(\); state\.toolsRan = assembler\.toolsRan; \}/.test(runNowBlock), 'Run Now counts each tool call it streams (reply-assembler.js counts them)');
// (typed-outcomes: Run Now settles through the scheduled fire's own rule, cron-driver fireOutcome, which hands the count on)
A.ok(/cronDriverMod\.fireOutcome\(state, null\)/.test(runNowBlock), 'Run Now settles through the scheduled fire\'s own rule (fireOutcome)');
A.ok(/incompleteRunMessage\(terminalReason, \{ toolsRan: st\.toolsRan \|\| 0, finishReason: finishReason \}\)/.test(driverSrc), 'and its incomplete-run sentence knows whether tools ran');
{
  const StopReason = require('../sidecar/stop-reason.js');
  A.ok(!/nothing was done/.test(StopReason.incompleteRunMessage('empty', { toolsRan: 2 })), 'an empty reply after tools never says nothing was done');
}

if (require.main === module) A.report('cron.run-now.test');
