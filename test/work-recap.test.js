/* node test/work-recap.test.js — source-lock for WORK VISIBILITY slice 1's wiring (artifacts ledger ->
   end-of-run recap). The pure collector + runstore behavior is unit-tested in artifacts.test.js /
   runstore.test.js; what a unit test CANNOT see is the wiring: sidecar/index.js self-boots a server (not
   requirable) and frontend/app/chat.js is browser-flow (DOM + streaming). So — like chat-runmeta.test.js
   and harness-internal.test.js — we lock those invariants by reading the source.

   The invariants (each was a design rule in the slice):
   1. runOnce observes every dispatched tool result into a per-run collector and threads its list() into
      runStore.record() — no new bus/SSE event types.
   2. GET /api/runs accepts ?runId= so one run's entry (with artifacts) is fetchable.
   3. chat.js renders the recap as a passive .tool-register REPORT in the run's own flow: it never claims
      the single post-run beat slot (no clearNudge, no .turnin/.nudge class, no vanish()), renders ONLY
      when artifacts exist or the run ended abnormally, and offers copy-path (no invented Tauri perms). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const idx = readSidecarSource();
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');

// ---- 1. the sidecar wiring: collector per run, observed on dispatch, recorded at run end ----
A.ok(/require\('\.\/artifacts\.js'\)/.test(idx), 'index.js requires the artifacts collector');
A.ok(/const\s+execution\s*=\s*makeRunExecutionState\(\{[\s\S]*?artifacts:\s*makeArtifactCollector\(\)/.test(idx), 'runOnce builds a fresh per-run collector inside its execution state');
A.ok(/execution\.observeArtifact\(\{\s*toolName:\s*c\.name,\s*args:\s*c\.args,\s*result:\s*r\s*\}\)/.test(idx),
  'every dispatched tool result is observed (toolName/args/result)');
// the observe sits BEFORE the tool-output budget clip, so parses see the real result text
// (the clip now reads the window-scaled cap via runToolBytesCap(), not CAPS.maxToolBytes directly)
const obsAt = idx.indexOf('execution.observeArtifact');
const clipAt = idx.indexOf('execution.boundToolResult(r, runToolBytesCap()', obsAt >= 0 ? obsAt : 0);
A.ok(obsAt >= 0 && clipAt > obsAt, 'observe happens before the tool-output budget clip');
A.ok(/runStore\.record\(\{[^\n]*artifacts:\s*execution\.artifactList\(\)/.test(idx),
  'the recorded run entry carries artifacts from the execution state');
// no new event types: the collector never emits onto the bus
A.ok(!/emit\(\s*['"]artifact/.test(idx), 'no new artifact.* bus/SSE event is emitted (REST-only, by design)');

// ---- 2. the REST read: /api/runs?runId= narrows to one run's entry ----
const serveRuns = idx.slice(idx.indexOf('function serveRuns'), idx.indexOf('function serveInsights'));
A.ok(/searchParams\.get\('runId'\)/.test(serveRuns), 'serveRuns reads a runId query param');
A.ok(/filter\(\s*r\s*=>\s*r\.runId\s*===\s*runId\s*\)/.test(serveRuns), 'runId filters the listed rows');

// ---- 3. the frontend recap: a passive report card, never a beat ----
A.ok(/async function renderRunRecap\s*\(/.test(chat), 'chat.js defines renderRunRecap');
A.ok(/\/api\/runs\?agent='?\s*\+[^\n]*runId=/.test(chat.replace(/\n/g, ' ')) || /'\/api\/runs\?agent=' \+ encodeURIComponent\(agentId\) \+ '&runId='/.test(chat),
  'the recap fetches the single run entry over GET /api/runs?agent=&runId=');
A.ok(/if \(!arts\.length && \(entry\.reason \|\| 'done'\) === 'done'\) return;/.test(chat),
  'a quiet artifact-less clean finish renders NOTHING (existing flow untouched)');
// the recap is wired into the run's own clean-finish flow, fire-and-forget with the live runId
A.ok(/if \(thisRunId\) \{[\s\S]{0,400}renderRunRecap\(ws, thisRunId,/.test(chat), 'recap fires on the clean-finish path with the run\'s id');
// DURATION HONESTY (2026-07-19): the recap's displayed duration is the channel's honest elapsed — the
// confirmed-start, approval-pauses-excluded clock the live COMMS timer already shows — never the raw
// send→teardown span alone (which counted connect latency + time paused waiting on the Commander).
A.ok(/Channels\.elapsedOf\(ws\.id, Date\.now\(\)\)[\s\S]{0,200}renderRunRecap\(ws, thisRunId, honestMs > 0 \? honestMs :/.test(chat),
  'the recap duration reads Channels.elapsedOf (honest run clock), falling back to the raw span only when the channel has no reading');

// report-not-ask: slice out the recap block's CODE (from its first function to the consent block, comments
// stripped — the design-note comment narrates the rule by name) and prove it never touches the beat machinery.
A.ok(chat.indexOf('END-OF-RUN RECAP') > 0, 'the recap block exists as one coherent, labelled section');
const recapStart = chat.indexOf('function fmtRecapCost');
const recapEnd = chat.indexOf('a live consent prompt', recapStart);
A.ok(recapStart > 0 && recapEnd > recapStart, 'the recap code block is locatable');
const recap = chat.slice(recapStart, recapEnd)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')            // block comments out
  .replace(/(^|[^:])\/\/.*$/gm, '$1');          // line comments out (keep :// urls)
A.ok(recap.indexOf('clearNudge') < 0, 'the recap never retires/claims the post-run beat slot (no clearNudge)');
A.ok(recap.indexOf('vanish(') < 0, 'the recap stays in the log like tool lines (no vanish)');
A.ok(!/classList\.add\('(turnin|nudge)'\)/.test(recap), 'the recap never wears the beat classes (.turnin/.nudge)');
A.ok(/classList\.add\('tool'\)/.test(recap) && /classList\.add\('recap'\)/.test(recap),
  'the recap renders in the work-log .tool register with its own .recap class');
A.ok(!/activeNudge/.test(recap), 'the recap never touches the activeNudge beat-slot state');

// file artifacts: use the same open helper as inline deliverables and copy the resolved absolute path
A.ok(/wireFileOpen\(link, path, agentId\)/.test(recap), 'file artifacts open through the existing jailed file-open helper');
A.ok(/copyPathButton\(agentId, path\)/.test(recap), 'the recap offers the shared absolute-path copy action');
A.ok(/folderButton\(agentId, path\)/.test(recap), 'the recap offers the shared exact-artifact reveal action');

// the card carries the promised trio: outcome line, artifact list, cost + duration + model
A.ok(/fmtRecapCost\(entry\)/.test(recap) && /fmtMs\(durMs\)/.test(recap) && /entry\.model/.test(recap),
  'the recap footer folds cost + duration + model');
A.ok(/entry\.title/.test(recap) && /entry\.reason/.test(recap), 'the recap headline names the run title/reason');

// the styling rides existing language: .cmsg.recap rules exist and reuse the CRT variables
A.ok(/\.cmsg\.recap \.recap-line/.test(css), 'app.css styles the recap lines');
A.ok(/\.cmsg\.recap \.recap-head \{[^}]*var\(--gold\)/.test(css), 'the recap headline uses the shared gold accent');

// SAY IT ONCE (10-19): under a RUN COMPLETE footer whose telemetry already tells the run's time and model, the recap's foot
// keeps only the cost ("RUN COMPLETE · 907ms · … · test/model" sat over "922ms · test/model")
A.ok(/const said = !!\(log && Array\.from\(log\.querySelectorAll\('\.comms-presence\.resolved\[data-run-id\]'\)\)\.some\(c => c\.dataset\.runId === runId && c\.dataset\.telemetry === '1'\)\);/.test(chat)
  && /!said && durMs > 0 \? fmtMs\(durMs\) : ''/.test(chat) && /!said && entry\.model && entry\.model !== '\(unknown\)' \? entry\.model : ''/.test(chat),
  'the recap foot never repeats the time and model the RUN COMPLETE footer above it already tells');

A.report('work-recap.test');
