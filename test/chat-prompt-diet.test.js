/* node test/chat-prompt-diet.test.js — source lock for the CHAT DIET + prefix-cache order (issue #17).

   A non-task COMMS turn ("hello", an ack, a question about the agent itself) has no tools on the wire, yet it
   used to ship the operator manual (~9KB), the skill recipe block (~12KB), the runtime skill index and the
   lead's [ORCHESTRATION] briefing (~2.6KB) — ~25KB of prefill for a greeting. On a 3B local model that was
   a 2.5-minute wait before the first token (GitHub issue #17). The per-run 'Run id:' line also sat FIRST in
   the sidecar's appended payload, so every provider's prefix cache missed from that byte onward each turn.

   test/chat-prompt-diet.e2e.test.js proves the bytes the model receives; this lock keeps the gates from
   quietly regressing in an auto-merge. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = readSidecarSource();
const once = (needle, label) => { A.eq(src.split(needle).length - 1, 1, label + ' (exactly one occurrence)'); };

// 600ab235c hoisted a project-conversation lookup behind the same gate, so the crew>0 briefing is now the else-branch
// of the crewless one (CrewDiet.isCrewlessLead requires isTask + team.dispatch too): lock each gate exactly once.
once("} else if (isTask && resolved.tools.includes('team.dispatch')) {", 'the [ORCHESTRATION] briefing follows actual delegation authority on task turns');
once("  if (isTask && resolved.tools.includes('team.dispatch')) {\n    try { projectConversation = ", 'the project-conversation lookup rides the same delegation gate');
once("const crewless = CrewDiet.isCrewlessLead({ isTask, ", 'the crewless briefing is gated on isTask too');
once("const manualBlock = (isTask && surface === 'interactive') ? (coreNames.indexOf('manual.read') >= 0 ? starnetManualIndex() : starnetManual())", 'the operator manual is gated on isTask (index form only when manual.read is on the wire)');
// self-driving lane 2 (2026-10-05): an owner-trusted chat-app task turn gets only the short pointer to manual.read — still task-only
once("    : (isTask && ownerTrusted && coreNames.indexOf('manual.read') >= 0) ? starnetManualPointer() : '';", 'the owner chat-app pointer is gated on isTask too (and only when manual.read is on the wire)');
once("skillBlock = isTask", 'the skill recipe block is gated on isTask');
once("if (isTask && resolved.tools.indexOf('skill.view') >= 0) {", 'the runtime skill index is gated on isTask');
A.ok(src.indexOf("(system || '') + runtimeBlock + toolNote") < 0, 'the runtime block no longer leads the appended payload');
once("+ deliverableNote + crewCallNote + runtimeBlock, { isTask, internal, tools: resolved.tools });", 'the runtime block rides LAST in the appended payload');
// The explicit skill PRELOAD ("/skill Name" or body.preloadSkills) is a Commander request and stays ungated.
once("    if (resolved.tools.indexOf('skill.view') >= 0) {", 'explicit skill preload keeps its own (isTask-free) gate');

A.report('chat-prompt-diet.test');
