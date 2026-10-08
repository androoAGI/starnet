/* test/budget-stop-door.test.js — a budget stop names a door that EXISTS, on every surface that prints one.
   COMMS (frontend/app/chat.js budgetStopLine + offerBudgetDoor), the messaging channels (sidecar/channels/hub.js
   endNote), ACP editors (sidecar/acp/core.js endNote) and /usage (sidecar/slash-actions.js) all used to send the
   user to "MISSION CONTROL → BUDGET" / "SETTINGS → BUDGET". MISSION CONTROL is only a room/prop label and SETTINGS
   has no BUDGET section: the caps live in SETTINGS › SPENDING LIMITS (stationui.js section id 'budget'). Spend-truth
   lane B4, 2026-10-08. Behavioral where the code is reachable headlessly; the chat.js functions are evaluated from
   their own source (fnBody) with fake collaborators. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DOOR = 'SETTINGS › SPENDING LIMITS';

// the door exists: the SPENDING LIMITS section is the 'budget' pane every budget door opens
const station = read('frontend/app/stationui.js');
A.ok(/\{ id: 'budget', label: 'SPENDING LIMITS'/.test(station), 'SETTINGS has a SPENDING LIMITS section (id budget)');

// ---- COMMS: the stop line ----
const chat = read('frontend/app/chat.js');
const lineSrc = A.fnBody(chat, 'function budgetStopLine(');
A.ok(lineSrc.length > 50 && lineSrc.length < 3000, 'budgetStopLine exists and is bounded');
const budgetStopLine = new Function(lineSrc + '\nreturn budgetStopLine;')();
for (const [scope, cap, want] of [
  ['run', 5, /^hit the \$5 per-run spend cap — raise it in /],
  ['agent', 12.5, /^this agent hit its \$12\.50 lifetime spend cap — raise or remove it in /],
  ['day', 25, /^hit the \$25 daily spend cap — raise or remove it in /],
  ['global', 100, /^hit the \$100 all-time spend cap — raise or remove it in /],
  [null, null, /^hit a spend cap — raise or remove it in /]
]) {
  const line = budgetStopLine(scope, cap);
  A.ok(want.test(line), scope + ' stop names its cap: ' + line);
  A.ok(line.endsWith(DOOR), scope + ' stop names SETTINGS › SPENDING LIMITS: ' + line);
  A.ok(!/MISSION CONTROL|→ BUDGET/.test(line), scope + ' stop never names MISSION CONTROL → BUDGET');
}
// the stop's door chip is labelled with the section it opens
{
  const doorSrc = A.fnBody(chat, 'function offerBudgetDoor(');
  A.ok(doorSrc.length > 50 && doorSrc.length < 3000, 'offerBudgetDoor exists and is bounded');
  let row = null, picked = null; const opened = [];
  const offer = new Function('choices', 'retryLast', 'StationUI', 'Friendly', doorSrc + '\nreturn offerBudgetDoor;')(
    (items, cb) => { row = items; picked = cb; }, () => opened.push('retry'),
    { openTerm: (k, s) => opened.push(k + '/' + s) }, undefined);
  offer();
  A.eq(row.map(i => i.label), ['$ OPEN SPENDING LIMITS', '↻ Try again'], 'the chip names SPENDING LIMITS, the section it opens');
  picked(row[0]);
  A.eq(opened, ['settings/budget'], 'and opens SETTINGS on the SPENDING LIMITS (budget) section');
}

// ---- messaging channels ----
{
  const { endNote } = require('../sidecar/channels/hub.js');
  const run = endNote('budget', { budgetScope: 'run', budgetCapUsd: 5 });
  A.ok(/hit the \$5 per-run spend cap — raise it in the app under SETTINGS › SPENDING LIMITS\.\)$/.test(run), 'a channel per-run stop says raise it, under SPENDING LIMITS: ' + run);
  const day = endNote('budget', { budgetScope: 'day', budgetCapUsd: 25 });
  A.ok(/hit the \$25 daily spend cap — raise or remove it in the app under SETTINGS › SPENDING LIMITS\.\)$/.test(day), 'a channel day stop names SPENDING LIMITS: ' + day);
  A.ok(!/MISSION CONTROL/.test(run + day + endNote('budget', {})), 'no channel stop names MISSION CONTROL');
}
// ---- ACP editors ----
{
  const { endNote } = require('../sidecar/acp/core.js')._internals;
  const note = endNote('budget');
  A.ok(/SETTINGS › SPENDING LIMITS/.test(note) && !/MISSION CONTROL/.test(note), 'an ACP budget stop names SPENDING LIMITS: ' + note);
}
// ---- /usage ----
(async () => {
  const { makeSlashActions } = require('../sidecar/slash-actions.js');
  const SNAP = { ok: true, today: 0, lifetime: 0, runs: 0, tokens: 0, agentUsd: 0, caps: {} };
  const r = await makeSlashActions({ budget: { snapshot: async () => SNAP } }).run('usage', '', {});
  const line = (r.lines || []).find(l => /No spend caps are set/.test(l)) || '';
  A.ok(/SETTINGS › SPENDING LIMITS/.test(line) && !/→ BUDGET/.test(line), '/usage points an uncapped station at SPENDING LIMITS: ' + line);
  A.report('budget-stop-door');
})().catch(e => { console.error(e); process.exit(1); });
