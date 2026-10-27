/* node test/autojobs-ui.test.js — source-lock for the SELF-INITIATION entry point in the ROUTINES panel
   (stationui.js). stationui.js is browser-flow (DOM/terminal panels), not node-loadable, so — like
   autonomy-ui.test.js / newhero-reset.test.js — we lock the invariant by reading the source: the ROUTINES panel
   must expose a "propose standing jobs" control that routes through AutoJobStore.propose() and refreshes the list,
   so the manual entry point can never silently disappear or drift off the store API. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/routines.js'), 'utf8');   // ROUTINES window extracted from stationui.js (BUILDERS split)
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const { AutoJobStore } = require('../frontend/app/autojobstore.js');

// the button exists in the ROUTINES panel.
A.ok(/id="rt-propose"/.test(src), 'the ROUTINES panel has a propose-standing-jobs button (#rt-propose)');
// it routes through the store's propose() (not some ad-hoc path).
A.ok(/AutoJobStore\.propose\(/.test(src), 'the button calls AutoJobStore.propose()');
// it is guarded so a missing store degrades, never throws.
A.ok(/typeof AutoJobStore\s*[!=]==\s*'undefined'/.test(src), 'the handler guards on AutoJobStore being present');
// after scheduling it refreshes the routines list so new jobs appear inline.
A.ok(/AutoJobStore\.propose\([\s\S]{0,200}refresh\(\)/.test(src), 'after proposing it refreshes the routines list');

// E-STOP preserves enabled intent while freezing the global scheduler. Every browser consumer must use BOTH
// facts or it promises work over a durable stop.
A.ok(/schedulerArmed\s*=\s*!!\(j\s*&&\s*j\.enabled\s*&&\s*!j\.halted\)/.test(src),
  'the ROUTINES panel derives runnable scheduler state from enabled and not halted');
A.ok(/const next\s*=\s*on\s*&&\s*schedulerArmed\s*&&\s*j\.nextRunAt\s*\?/.test(src),
  'routine rows show a countdown only while the scheduler is actually runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: true }), false,
  'self-initiation confirmations treat E-STOP as not runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: false }), true,
  'self-initiation confirmations recognize a genuinely armed scheduler');
A.ok(/j\s*&&\s*j\.halted\s*\?\s*'stopped \(E-STOP\)'/.test(chatSrc),
  '/cron names the durable E-STOP instead of reporting scheduler on');

/* ROUTINE ROW FEEDBACK (stranded-user sweep, 2026-08-22): a row must survive a job without `skills`
   (an unguarded `j.skills.length` threw and the catch painted "sidecar offline"), must say it runs the
   WHOLE line when the record carries runsLine, and must show the line's recorded spend (lastUsd). */
A.ok((src.match(/j\.skills\.length/g) || []).length === 1 && /Array\.isArray\(j\.skills\) \? j\.skills\.length/.test(src), 'routine row only reads j.skills.length behind the Array.isArray guard');
A.ok(/Array\.isArray\(j\.skills\)/.test(src), 'routine row guards the skills array');
A.ok(/runs the <b>/.test(src) && /j\.runsLine !== true\) return 'runs as '/.test(src), "a runsLine routine says it runs the line; others keep 'runs as'");
A.ok(/Build\.lineOfAgentInfo/.test(src), 'the line name/dock count come from the compiled plan (Build.lineOfAgentInfo), never guessed');
A.ok(/Number\(j\.lastUsd\)/.test(src) && /mc-spend/.test(src), 'the row shows the recorded spend (lastUsd)');

// the delivery-backlog ceiling is the SERVER's (GET /api/cron .maxPendingDeliveries), never a hardcoded copy; the
// EDIT TASK textarea is capped and the save refuses a request over the update route's 64 KB body limit
A.ok(/maxPendingDeliveries = (j && Number(j.maxPendingDeliveries)) || 0;/.test(src) && !/pending.length >= 100/.test(src), 'deliveryLine quotes the server backlog ceiling (no hardcoded 100)');
A.ok(/data-edit-prompt rows="5" maxlength="' \+ EDIT_PROMPT_MAX \+ '"/.test(src) && /EDIT_BODY_MAX = 1 << 16/.test(src), 'EDIT TASK is capped under the 64 KB update body');
const idx = readSidecarSource();
A.ok(/maxPendingDeliveries: cronStore.MAX_PENDING_DELIVERIES/.test(idx), 'GET /api/cron exposes the backlog ceiling');
/* The REAL deliveryLine, sliced and run (review 2026-10-23): the backlog collapse leaves ONE receipt that stands for
   many (`superseded`), and the driver defers on that undelivered total — so the row must say so; a routine the
   Commander paused holds its results until resumed, so it never promises a retry. */
{
  const vm = require('vm');
  const m = src.match(/\n {4}function deliveryLine\(j\) \{[\s\S]*?\n {4}\}\n/);
  A.ok(!!m, 'fixture: deliveryLine is sliceable from routines.js');
  const ctx = { esc: s => String(s), wallClock: () => '09:00', fmtRel: () => '1m ago', maxPendingDeliveries: 100 };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.deliveryLine = deliveryLine;', ctx);
  const past = new Date(Date.now() - 3600000).toISOString();
  const collapsed = ctx.deliveryLine({ enabled: true, state: 'scheduled',
    finalization: { runId: 'r100', state: 'pending', superseded: 99, nextAttemptAt: past } });
  A.ok(/1 result awaiting delivery/.test(collapsed), 'one collapsed receipt reads as one result awaiting delivery');
  A.ok(/new runs deferred until the destination recovers/.test(collapsed), 'a receipt standing for 100 undelivered results says new runs are deferred (the driver defers on undeliveredCount)');
  const few = ctx.deliveryLine({ enabled: true, state: 'scheduled',
    finalization: { runId: 'r3', state: 'pending', superseded: 2, nextAttemptAt: past } });
  A.ok(!/deferred/.test(few) && /next retry 09:00/.test(few), 'below the ceiling: a retry time, no deferral claim');
  const held = ctx.deliveryLine({ enabled: false, state: 'paused',
    finalization: { runId: 'p1', state: 'pending', superseded: 120, nextAttemptAt: past } });
  A.ok(/held until the routine is resumed/.test(held), 'a paused routine says its result is held until it is resumed');
  A.ok(!/next retry/.test(held) && !/deferred/.test(held), 'a paused routine promises no retry and no deferred runs');
  const autoPaused = ctx.deliveryLine({ enabled: false, state: 'error', disabledReason: 'consecutive-failures',
    finalization: { runId: 'e1', state: 'pending', nextAttemptAt: past } });
  A.ok(/next retry 09:00/.test(autoPaused) && !/held/.test(autoPaused), 'an auto-paused routine still delivers its notice (not held): its retry is shown');
}

/* ---------- org P16 (2026-10-14): one arm rule, a true status line, one switch name, RUN BY ---------- */
{
  // the create-state line tells the truth for each of the four states (never "will not run until you enable" while saving arms)
  A.ok(src.includes("'Scheduling is off. Saving turns it on for the whole station, so every saved schedule runs at its time.'"), 'a never-set switch: the line says scheduling is off and saving turns it on — the INBOX form\'s own words');
  A.ok(src.includes('id="rt-add">▸ SAVE SCHEDULE<'), 'the SCHEDULES save key wears the INBOX key\'s ▸');
  A.ok(src.includes("(j && j.armSet) ? 'Scheduling is off — you turned it off. Saving keeps it off"), 'an explicit OFF: saving keeps it off (armSet from GET /api/cron)');
  A.ok(!src.includes('it will not run automatically until you enable scheduling'), 'the old line that contradicted arm-on-save is gone');
  // (org wire AUTO-P16-2) the lines send the Commander to a page that exists, by its key: AUTOMATE calls the routines page 'Scheduled jobs'
  const autoSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/automation.js'), 'utf8');
  const jobsPage = (autoSrc.match(/const labels = \{ routines: '([^']+)'/) || [])[1];
  A.eq(jobsPage, 'Scheduled jobs', 'fixture: AUTOMATE labels the routines page Scheduled jobs');
  A.ok(!/Active Routines/.test(src), 'no line sends the Commander to an "Active Routines" no page is called');
  A.ok(src.includes('Saving keeps it stopped: it runs only after you press ▶ TURN SCHEDULING ON in ' + jobsPage + '.') && src.includes('Saving keeps it off: press ▶ TURN SCHEDULING ON in ' + jobsPage + ' when'), 'the E-STOP and OFF lines name the key and the page it is on');
  A.ok(src.includes('nothing fires until you press ▶ TURN SCHEDULING ON in AUTOMATE › SCHEDULES › ' + jobsPage + "'") && !/until you resume it in AUTOMATE/.test(src), 'the E-STOP save toast names the key, never a RESUME there is none of');
  // one switch name: ▶ TURN SCHEDULING ON / ⏸ TURN SCHEDULING OFF
  A.ok(!/ENABLE SCHEDULING<|RESUME SCHEDULING<|DISABLE SCHEDULING</.test(src), 'no ENABLE / RESUME / DISABLE SCHEDULING keys remain');
  A.eq((src.match(/>▶ TURN SCHEDULING ON</g) || []).length >= 3, true, 'E-STOP, OFF and the save note all offer ▶ TURN SCHEDULING ON');
  A.ok(src.includes('>⏸ TURN SCHEDULING OFF</button>'), 'the armed state offers ⏸ TURN SCHEDULING OFF');
  // the save says what it did: armedNow → "scheduling is now on"; offByChoice → the switch, never a silent override
  A.ok(src.includes("msgEl.textContent = '✓ saved · scheduling is now on'") && src.includes('r.scheduler.offByChoice') && src.includes('id="rt-msg-arm"'), 'the save confirm follows the server verdict');
  // RUN BY: agents, then workflows; a workflow posts its first step's agent + BAY + runsLine:true
  A.ok(src.includes("'<label class=\"sn-menu-field\">Run by<select id=\"rt-agent-select\"") && /optgroup label="AGENTS"[\s\S]*optgroup label="WORKFLOWS"/.test(src), 'RUN BY lists agents, then workflows');
  A.ok(src.includes("dockId: line ? line.dockId : undefined, runsLine: line ? true : undefined,"), 'a workflow choice posts dockId + runsLine:true (the line-schedule path)');
  /* (org wire AUTO-P16-3) a draft opened into the form never inherits a WORKFLOW picked earlier: the REAL applyDraftAgent over a fake form */
  {
    const autoSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/automation.js'), 'utf8');
    const m = autoSrc.match(/\n  function applyDraftAgent\(body, agentId\) \{[\s\S]*?\n  \}\n/);
    A.ok(!!m && /applyDraftAgent\(body, draft\.agentId\);/.test(autoSrc), 'openDraft applies the draft\'s agent through applyDraftAgent');
    const applyDraftAgent = new Function('Event', m[0] + '; return applyDraftAgent;')(class { constructor(t) { this.type = t; } });
    const form = (selValue) => {
      const clicked = [], changes = [];
      const btns = ['nova', 'ada'].map(id => ({ dataset: { agent: id }, click: () => clicked.push(id) }));
      const sel = { value: selValue, options: [{ value: 'nova' }, { value: 'ada' }, { value: 'line:L1' }], dispatchEvent: e => changes.push([e.type, sel.value]) };
      return { clicked, changes, sel, body: { querySelectorAll: q => (q === '.rt-agent-btn' ? btns : []), querySelector: q => (q === '#rt-agent-select' ? sel : null) } };
    };
    let f = form('line:L1'); applyDraftAgent(f.body, 'ada');
    A.ok(f.clicked.join() === 'ada' && !f.changes.length, 'a draft naming an agent aboard picks that agent (its button clears the workflow pick)');
    f = form('line:L1'); applyDraftAgent(f.body, undefined);
    A.ok(f.sel.value === 'nova' && f.changes.length === 1 && f.changes[0][0] === 'change', 'a draft naming no agent puts RUN BY back on an agent when a workflow was picked: ' + JSON.stringify(f.changes));
    f = form('line:L1'); applyDraftAgent(f.body, 'ghost');
    A.ok(f.sel.value === 'nova' && f.changes.length === 1, '…and so does a draft whose agent is not aboard');
    f = form('ada'); applyDraftAgent(f.body, 'ghost');
    A.ok(f.sel.value === 'ada' && !f.changes.length && !f.clicked.length, 'an agent already picked is kept as before');
    A.ok(/if \(v\.indexOf\('line:'\) === 0\) \{ routineLineKey = v\.slice\(5\);[^\n]*\n\s*routineLineKey = null;/.test(src), 'the select\'s change handler clears the workflow pick for an agent value (what the reset relies on)');
  }
  const wfw = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/workflows.js'), 'utf8');
  A.ok(/function startLines\(\)[\s\S]*Wl\.entryDocksOf/.test(wfw) && /showJob, startLines,/.test(wfw), 'WORKFLOWS exports each line\'s schedule entry (its first routed step) for RUN BY');
  // the server: one rule for the form, the INBOX form and station.start_line
  A.ok(/function armOnSaveIfUnset\(\) \{\n  if \(cronArmed \|\| cronArmSet\) return false;/.test(idx), 'arm on save only when the switch was never set');
  // (org wire AUTO-P16-1) every SAVE path: handleCronCreate, startLineFor, routine.create's armScheduler and /routine add's host create
  A.ok((idx.match(/armOnSaveIfUnset\(\)/g) || []).length === 5, 'handleCronCreate, startLineFor, routine.create and /routine add all use the one rule (definition + 4 callers)');
  A.ok(/if \(enabled === true\) \{ armOnSaveIfUnset\(\); return cronArmed; \}/.test(idx), 'routine.create\'s default arm never overrides an explicit OFF');
  const mkt = fs.readFileSync(path.join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
  const mr = mkt.slice(mkt.indexOf('function makeRoutine(r, values, schedule) {'), mkt.indexOf('function makeRoutine(r, values, schedule) {') + 4200);
  A.ok(/\n\s*arm: true\n\s*\};/.test(mr) && /const sch = \(d && d\.scheduler\) \|\| null/.test(mr), 'RECIPES › SCHEDULE IT saves with arm:true and reads the server\'s scheduler verdict');
  A.ok(/else if \(sch && !sch\.armed\) note\('routine saved: '/.test(mr) && /sch\.offByChoice \? ' \(you turned it off\)' : ''/.test(mr) && /sch && sch\.armedNow \? ' · scheduling is now on' : ''/.test(mr), '…and never says "routine scheduled" about one that cannot fire');
  A.ok(/armSet: !!cronArmSet/.test(idx) && /armedNow: armedNow, offByChoice: !cronArmed && !!cronArmSet/.test(idx), 'GET /api/cron and the create reply carry armSet / armedNow / offByChoice');
}
A.report('autojobs-ui.test');
