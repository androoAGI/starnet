/* test/workflow-panel-source.test.js — the docked Workflow panel's wiring laws, held against the SOURCE
   (workflowpanel.js is a browser module over live DOM + build.js's host, like build.js itself; its truth
   layer is node-tested in workflow-line.test.js). Each assertion is a law the panel must not drift from:
     · station UI law: no native tooltip, no native dialog;
     · the step test is FEATURE-DETECTED (an older sidecar keeps the whole-line sample button);
     · "Try this step" is the SAME mechanism with single:true + startAt (STEPTEST contract);
     · a schedule made here is the line's own trigger (runsLine:true) and grants nothing unattended;
     · a rerun after a brief rewrite flushes the plan first (the sidecar reads the CURRENT plan);
     · the doors: every INBOX / BAY / gate click reaches the ONE panel, never a modal. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', f), 'utf8');
const panel = rd('app/workflowpanel.js'), build = rd('app/build.js'), html = rd('index.html');
const code = panel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

A.ok(!/\stitle="/.test(code) && !/\.title\s*=/.test(code), 'no native title tooltips (data-tip only)');
A.ok(!/\b(confirm|alert|prompt)\(/.test(code), 'no window.confirm/alert/prompt');
A.ok(!/<select/.test(code), 'no bare <select> (the OS arrow cannot be themed)');

// feature detection + the fallback
A.ok(/api\('\/api\/routing\/steptest'\)\.then\(r => \{\s*S\.seam = !!\(r && r\.status !== 404 && r\.status !== 405/.test(panel), 'the step-test route is probed; a 404/405 means an older sidecar');
A.ok(/return m === 'step' && S\.seam !== true \? 'real' : m;/.test(panel) && /H\.runSample\(c, \{ text: t \|\| undefined/.test(panel) && /\? jobResultHTML\(mine, flow\(\)\) : ''/.test(panel) && /H\.sampleHTML\(v\)/.test(panel), 'without the route the TEST view keeps the whole-line real job (STEP THROUGH is off, RUN ONE REAL JOB stays)');
A.ok(/if \(!c \|\| !p\.agentId \|\| S\.seam !== true\) return none;/.test(panel), 'Try this step is hidden unless the route answered');

// the contract
A.ok(/api\('\/api\/routing\/steptest', 'POST', \{ line: c\.key, text, startAt: pid, single: true \}\)/.test(panel), 'Try this step = POST {line, text, startAt: <this BAY>, single:true} (multi-bay: the dock, not the agent)');
A.ok(/api\('\/api\/routing\/steptest', 'POST', \{ line: c\.key, text, pause \}\)/.test(panel), 'the full step test posts the pause rule');
for (const v of ['continue', 'rerun', 'rewind', 'stop', 'pause']) A.ok(new RegExp("sessionCall\\('" + v + "'").test(panel), 'the pause UI drives /' + v);
A.ok(/, 700\);/.test(panel), 'running sessions are polled every ~700 ms');
A.ok(/H\.planGate\(comp\(\)\)\.then\(gate => \{[\s\S]{0,300}sessionCall\('rerun'\)/.test(panel), 'rewrite-brief-and-rerun flushes the plan post before the rerun');
A.ok(/H\.planGate\(c\)\.then/.test(panel), 'every test run posts THIS floor first (the same gate the sample uses)');

// the trigger — no provider: the routine inherits its agent's model AND provider together (freezing the dock's current
// wire paired one provider with another's model, #24 class)
A.ok(/api\('\/api\/cron', 'POST', \{ name, prompt, schedule, agentId, dockId, tz, runsLine: true \}\)/.test(panel), 'a schedule made here runs the line (runsLine), FIRES AT the chosen bay (dockId), carries no unattended grants and no frozen provider');
// SAVE SCHEDULE once threw a ReferenceError: the create handler called paintTrigger's local trgAgent(). The agent is
// resolved inside wireScheduleForm from its OWN docks (the general scope law lives in test/sibling-scope.test.js)
const wsf = (code.match(/function wireScheduleForm\(p, docks, dockHint\) \{[\s\S]*?\n  \}/) || [''])[0];
A.ok(wsf && /const agentOfDock = pid => \{ const d = docks\.find\(x => x\.propId === pid\); return d \? d\.agentId : null; \};/.test(wsf), 'the schedule form resolves the chosen bay\'s agent from its own docks');
A.ok(wsf && /const dockId = S\.trgDock, agentId = agentOfDock\(dockId\);/.test(wsf) && !/trgAgent/.test(wsf), 'the create handler never calls paintTrigger\'s trgAgent');
A.ok(/SchedPicker\.mount\(/.test(panel) && /api\('\/api\/cron\/preview'/.test(panel), 'the same WHEN picker + server preview as AUTOMATION');
A.ok(/H\.openTerm\('messaging'\)/.test(panel), 'one click to the Channels panel to connect a channel');

// hands off is saved through the model
A.ok(/H\.station\(\)\.setPropHands\(p\.id, hands\.value\)/.test(panel), 'HANDS OFF saves through worldmodel.setPropHands');

// the doors
A.ok(/if \(t === 'bay'\) return openStepCard\(p\.id, ev\);/.test(build), 'a BAY configures through openStepCard');
A.ok(/t === 'intake' \|\| t === 'outbox' \|\| t === 'merger' \|\| t === 'splitter' \|\| t === 'joiner' \|\| t === 'loop'\) return openFlowCard\(p\.id\)/.test(build), 'INBOX / OUTBOX / gates configure through openFlowCard');
A.ok(/if\(WF_PART\[p\.t\]\)\{finFocusLine\(p\.id\);openWorkflowPanel\(p\.id,true\);\}/.test(build), 'a floor click on a line machine selects it in the panel');
A.ok(!/refit-step-card|refit-flow-card/.test(build.replace(/\/\*[\s\S]*?\*\//g, ' ')), 'the modal step/flow cards are gone');

// two panels must not squeeze the floor: the Workflow panel minimizes the Build Library through its own
// MINIMIZE state and gives it back on close — unless the Commander reopened it meanwhile
A.ok(/H\.panelShown\(true\)/.test(panel) && /H\.panelShown\(false\)/.test(panel), 'the panel reports open/close to build mode');
A.ok(/if \(dock && !dock\.classList\.contains\('is-collapsed'\)\) \{ toggleKit\(true\); wfKitAuto = true; \}/.test(build), 'opening minimizes the library via toggleKit, remembering it did');
A.ok(/if \(restore && dock && dock\.classList\.contains\('is-collapsed'\)\) toggleKit\(false\);/.test(build), 'closing restores it only if the panel minimized it');
A.ok(/if \(!hide\) wfKitAuto = false;/.test(build), 'a reopen by the Commander cancels the owed restore');
A.ok(/if \(id !== 'select' \|\| !wasSelect\) toggleKit\(false\);/.test(build), 'a bare deselect (ESC) does not pop the minimized library back open');

// the real step-test backend's shape (2026-09-23 live run): an `ended` session did NOT reach the OUTBOX; the
// total includes rewound spend (droppedUsd); a blocked next hop, a hop's error and its exact turn are shown
A.ok(/const shipped = done && !s\.ended && typeof s\.final === 'string';/.test(panel), 'only a server `final` (no `ended`) is called Reached the OUTBOX');
A.ok(/The line ended before the OUTBOX/.test(panel), 'an ended session says it stopped short, and why');
A.ok(/s\.droppedUsd/.test(panel) && /from rewound steps/.test(panel), 'rewound spend is named inside the total');
A.ok(/s\.paused\.next\.blocked/.test(panel) && /h\.turn/.test(panel) && /h\.error/.test(panel), 'blocked next hop, the exact turn and a hop error are shown');
// a draft is only what was TYPED (an input painted empty before the INBOX had a test job must not clobber it)
A.ok(/if \(n\.dataset\.typed === '1'\) S\.drafts\[n\.dataset\.keep\] = n\.value;/.test(panel), 'drafts keep typed text only');

// load order: the truth layer, then the panel, then build.js
const iL = html.indexOf('app/workflowline.js'), iP = html.indexOf('app/workflowpanel.js'), iB = html.indexOf('app/build.js');
A.ok(iL > 0 && iP > iL && iB > iP, 'index.html loads workflowline.js, then workflowpanel.js, then build.js');
A.ok(html.indexOf('css/workflow-panel.css') > 0, 'the panel stylesheet is linked');

// the 5 s trigger re-read (2026-09-24): never paint() on it — an unchanged answer touches nothing, a changed one
// patches rows (an armed DELETE/NEW KEY and the picked schedule survive); only the first answer paints
const ltr = (code.match(/function ltRefresh\(\) \{[\s\S]*?\n  \}/) || [''])[0];
A.ok(ltr && /if \(S\.lt && sig === S\.ltSig\) \{ ltTickAgo\(\); return; \}/.test(ltr), 'an unchanged trigger list repaints nothing');
A.ok(ltr && /if \(first\) paint\(\); else ltPatch\(\);/.test(ltr) && (ltr.match(/paint\(/g) || []).length === 1, 'a changed list is PATCHED, only the first answer paints');
const ltp = (code.match(/function ltPatch\(\) \{[\s\S]*?\n  \}/) || [''])[0];
A.ok(ltp && /WL\(\)\.rowPatch\(/.test(ltp) && /old\.replaceWith\(row\); wireLtRows\(row\);/.test(ltp) && !/paintBody|[^a-zA-Z]paint\(/.test(ltp), 'ltPatch replaces only changed rows and never rebuilds the body');
A.ok(/const schedKey = 'trgsched:' \+ p\.id, wantSched = S\.drafts\[schedKey\];[\s\S]{0,200}schedEl\.dataset\.keep = schedKey;[\s\S]{0,400}picker\.set\(wantSched\)/.test(panel), 'the picked schedule is a kept draft, restored THROUGH the picker after its default-seeding mount');
A.ok(/api\('\/api\/cron\/preview', 'POST', \{ schedule: v, tz \}\)/.test(panel), 'the schedule preview sends the same tz the create sends');
A.ok(/const wasOpen = body\.dataset\.card === cardKey/.test(panel), 'an open section stays open across a repaint of the same card');

// (sweep 2026-09-25) every verb that walks the line flushes the plan first: CONTINUE after "add a BAY" + crewing it
// used to end the test at the OLD plan's dead end ("the belt from agent does not reach the OUTBOX")
A.ok(/function afterFlush\(fn\) \{[\s\S]{0,120}H\.planGate\(comp\(\)\)\.then\(gate =>/.test(panel), 'afterFlush posts the plan before the verb');
A.ok(/afterFlush\(\(\) => sessionCall\('continue', ed \? \{ text \} : \{\}\)\)/.test(panel), 'CONTINUE flushes the plan first');
A.ok(/afterFlush\(\(\) => sessionCall\('rerun'\)\)/.test(panel), 'RE-RUN STEP flushes the plan first');
A.ok(/afterFlush\(\(\) => sessionCall\('pause', \{ pause: 'none' \}\)/.test(panel), 'RUN TO END flushes the plan first');
A.ok(/afterFlush\(\(\) => sessionCall\('rewind', \{ hop: i \}\)\)/.test(panel), 'REWIND flushes the plan first');
A.ok(/if \(s && s\.state === 'paused'\) refreshPaused\(\);/.test(panel), 'returning to a paused test re-reads its preview after posting the floor');

// (sweep 2026-09-25) a belted-but-uncrewed line never tells the owner to lay a belt that exists
A.ok(/f\.outbox\.reachedOnceCrewed \? 'connected · waiting on agents' : 'not connected yet'/.test(panel), 'the OUTBOX node says "waiting on agents" when only crew is missing');
A.ok(/else if \(f\.probeNext && f\.probeNext\[p\.id\]\) to = 'nowhere yet — ' \+ f\.probeNext\[p\.id\]\.map\(pid => dockLabel\(f, pid\)\)\.join\(' or '\) \+ ' needs an agent';/.test(panel), 'a crewed bay before an uncrewed one names the bay that needs an agent');

// (sweep 2026-09-25) one agent on two bays: the owner is told WHICH bay ("between NOVA and NOVA" / two "NOVA" chips)
A.ok(/It is placed on the floor between ' \+ esc\(dockLabel\(f, pid\)\) \+ ' and ' \+ esc\(nextPid \? dockLabel\(f, nextPid\) : nx\.label\)/.test(panel), 'the mid-test insert names the two BAYS it sits between');
A.ok(/thumb\(d\.agentId, 16, 20, 'wf-ithumb'\) \+ esc\(dockLabel\(f, d\.propId\)\) \+ '<\/button>'/.test(panel), 'a schedule\'s starting-step chips name the bay, not only the agent');
A.ok(/'skips ' \+ order\.slice\(0, i\)\.map\(x => dockLabel\(f, x\)\)/.test(panel), 'the starting-step hint names bays too');

// (sweep 2026-09-25) a closed panel stops polling a try-this-step run (it used to poll ~14 min after close)
{
  const i = panel.indexOf('function waitDone(sess)'), body = panel.slice(i, panel.indexOf('\n  }\n', i));
  A.ok(i > 0 && /if \(!el\) return reject\(new Error\('the panel was closed while this step ran/.test(body), 'waitDone stops when the panel closes, saying the run carries on');
  A.ok(body.indexOf('if (!el) return reject') < body.indexOf('setTimeout('), 'the closed check runs before the next poll is scheduled');
}

A.report('workflow-panel-source');
