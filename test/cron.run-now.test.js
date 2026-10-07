/* node test/cron.run-now.test.js - source-locks manual routine Run Now visibility.

   The reference harness had this exact class of bug: a manual cron run reported success but did
   not actually fire through the same observable path. In StarNet the important
   contract is that /api/cron/run is not only a panel-local NDJSON stream: it
   must also place a cron work item and mirror lifecycle over SSE so the floor
   moves immediately when the user presses Run Now. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

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
A.ok(/placeCronWorkitem\s*\(\s*job\.agentId\s*,\s*job\.prompt\s*,\s*runId\s*(,\s*job\.dockId\s*)?\)/.test(runNowBlock), 'manual Run Now places a cron workitem');
A.ok(/broadcast:\s*true/.test(runNowBlock), 'manual Run Now opts into SSE lifecycle broadcast');
A.ok(/manual[\s/]+Run Now[\s/]+opts into broadcast/i.test(runOnceBlock), 'runOnce comment documents manual cron broadcast reason');

/* GRANTS NEVER FLOW DOWN A LINE (2026-08-04). The routine's unattended grant was approved for ONE agent —
   its own dock. Stage one keeps it; every chain hop must run UNGRANTED, on BOTH fire paths (scheduled goes
   through the driver's advanceChain seam; Run Now calls chainRunner.advance directly). Lock the exact text
   so a refactor that quietly re-inherits job.unattendedGrants into a hop turns this red. */
// stage one of Run Now still runs with the routine's own recorded grant…
A.ok(/unattendedGrants:\s*Array\.isArray\(job\.unattendedGrants\)/.test(runNowBlock), "Run Now stage one keeps the routine's own unattended grant");
// …but its chain hop (inside the same handler, after chainRunner.advance) passes an empty list…
const runNowHopBlock = sliceBetween(runNowBlock, /chainRunner\.advance\(/, /markRun/);
A.ok(/unattendedGrants:\s*\[\]/.test(runNowHopBlock), 'the Run Now chain hop passes NO unattended grants');
A.ok(!/unattendedGrants:\s*Array\.isArray\(job\.unattendedGrants\)/.test(runNowHopBlock), "the Run Now chain hop never inherits the routine's grant");
// …and the scheduled path's advanceChain seam hard-codes the same law for every hop it executes.
const seamBlock = sliceBetween(driverBlock, /advanceChain:\s*\(o\)\s*=>\s*chainRunner\.advance\(/, /^\}\);/m);
A.ok(/unattendedGrants:\s*\[\]/.test(seamBlock), 'the scheduled advanceChain seam runs every hop with NO unattended grants');
A.ok(!/unattendedGrants:\s*o\.unattendedGrants/.test(seamBlock), 'the seam never forwards caller-supplied grants into a hop');

/* A HOP RUNS ON THE TARGET DOCK'S OWN ROSTER CONFIG (2026-08-10 audit #3). Both cron hop executors ran the
   foreign dock on the ROUTINE's provider/model/key — same drawn floor, different models (and the routine's
   credential spending as a foreign agent) depending on nothing but what triggered the line. Channel hops
   already resolved the receiving dock's roster (hub.js resolveRunConfig); both cron paths now resolve
   through cronHopConfigFor (roster config when a roster exists, the routine's own config only under the
   documented EMPTY-roster headless grace). Locked textually so a refactor that quietly re-inherits the
   routine's key into a hop turns this red. */
A.ok(/function cronHopConfigFor\s*\(/.test(src), 'the cron hop config resolver exists');
A.ok(/agentRoster\.size === 0/.test(sliceBetween(src, /function cronHopConfigFor\s*\(/, /function cronProviderFor/)), 'and it fails open ONLY on an empty (never-pushed) roster');
A.ok(/cronHopConfigFor\(h\.agentId/.test(seamBlock), "the scheduled seam resolves each hop's config from the TARGET agent");
A.ok(/cronHopConfigFor\(h\.agentId/.test(runNowHopBlock), "the Run Now hop resolves its config from the TARGET agent too");
// the pin lands on the hop's runOnce CALL: the fallback arg may name the routine's config (empty-roster
// grace), but what the hop actually SPENDS must be the resolved target config, on both fire paths.
const seamHopRun = sliceBetween(seamBlock, /await runOnce\(\{/, /\}\);/);
const runNowHopRun = sliceBetween(runNowHopBlock, /await runOnce\(\{/, /\}\);/);
A.ok(/key:\s*hopConfig\.key,\s*model:\s*hopConfig\.model,\s*provider:\s*hopConfig\.provider/.test(seamHopRun), "the scheduled hop's runOnce spends the target's key/model/provider");
A.ok(!/key:\s*o\.key/.test(seamHopRun), "and never the routine's key");
A.ok(/key:\s*hopConfig\.key,\s*model:\s*hopConfig\.model,\s*provider:\s*hopConfig\.provider/.test(runNowHopRun), "the Run Now hop's runOnce spends the target's key/model/provider");
A.ok(!/key:\s*key,/.test(runNowHopRun), "and never the routine's resolved key");

/* THE ENTRY RUN IS PART OF ITS OWN CHAIN'S $ CEILING (2026-08-10 audit): both fire paths seed the chain
   runner with stage one's reconciled spend, so MAX_CHAIN_USD bounds the whole line, not just the hops. */
A.ok(/entryUsd:\s*o\.entryUsd/.test(seamBlock), "the scheduled seam forwards the entry run's spend into the chain ceiling");
A.ok(/entryUsd:\s*state\.usd/.test(runNowBlock), "Run Now seeds the chain ceiling with stage one's reconciled spend");

/* THE ROUTINE'S RECORDED SPEND IS THE WHOLE LINE'S (2026-08-22): a Run Now line that cost real money showed
   `lastUsd 0` — the hop-only chain spend was dropped and markRun never received usd at all. Both fire paths must
   add line.usd to the entry spend and hand it to markRun. */
A.ok(/state\.usd \+= line\.usd/.test(runNowBlock), "Run Now adds the line's hop spend to the entry run's spend");
A.ok(/cronDriver\.settleRun\(job\.id, runId, state, null\)/.test(runNowBlock), "Run Now passes the line's full state into the shared durable settlement path");

/* SAME TOOLS AS THE SCHEDULED FIRE (B5 per-bay isolation). Run Now's stage one passed no `station`, so runOnce fell
   back to the broad autonomous default office (dish, cabinet, notebook, studio…) while the scheduled fire runs in the
   routine's bay room only — "test it now" showed web tools the 9:00 fire did not have (or the reverse). Lock stage
   one to the exact resolveStation expression the driver uses, and the driver to its side of it. */
const runNowStageOne = sliceBetween(runNowBlock, /await runOnce\(\{/, /chainRunner\.advance\(/);
A.ok(/station:\s*\(\s*job\.dockId\s*\?\s*router\.stationFor\(job\.agentId,\s*job\.dockId\)\s*:\s*router\.stationFor\(job\.agentId\)\s*\)\s*\|\|\s*undefined/.test(runNowStageOne), "Run Now stage one runs in the routine's bay room, exactly like the scheduled fire (B5)");
const driverSrc = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'cron-driver.js'), 'utf8');
A.ok(/job\.dockId \? resolveStation\(job\.agentId, job\.dockId\) : resolveStation\(job\.agentId\)/.test(driverSrc), 'the scheduled fire resolves the same bay station (cron-driver.js)');
A.ok(/resolveStation:\s*\(agentId, dockId\)\s*=>\s*router\.stationFor\(agentId, dockId\)/.test(driverBlock), "the driver's resolveStation is router.stationFor — the seam Run Now calls directly");

if (require.main === module) A.report('cron.run-now.test');
