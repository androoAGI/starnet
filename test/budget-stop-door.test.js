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

// ---- a StarNet run whose ceiling was the BALANCE (admission clamped PER RUN to the wallet) ----
// Raising PER RUN does nothing there — the run spent what the wallet held. The sidecar marks that stop with the
// additive agent.run.end field budgetCapIsBalance; every surface then names the balance and the top-up door.
{
  const line = budgetStopLine('run', 79.24, true);
  A.eq(line, 'used the $79.24 left on your StarNet balance — add credits under SETTINGS → AI & MODELS to keep going', 'a balance stop names the balance and the top-up door');
  A.ok(!/per-run spend cap|raise/.test(line), 'and never tells the user to raise a cap that cannot help');
  A.eq(budgetStopLine('run', 0.001, true), 'used what was left on your StarNet balance — add credits under SETTINGS → AI & MODELS to keep going', 'a sub-cent balance reads without a fake $0.00');
  A.ok(/^hit the \$5 per-run spend cap — raise it in /.test(budgetStopLine('run', 5, false)), 'a stop at a cap the user chose still names that cap');
  A.ok(/^hit the \$25 daily spend cap/.test(budgetStopLine('day', 25, true)), 'the flag only speaks for a per-RUN stop');
  // the door is the top-up door friendlyerror's managed_credit already opens (one door source), not SPENDING LIMITS
  const Friendly = require('../frontend/app/friendlyerror.js');
  const opened = [];
  const prevUI = globalThis.StationUI;
  globalThis.StationUI = { openTerm: (k, s) => opened.push(k + '/' + s) };
  try {
    let row = null, picked = null;
    const offer = new Function('choices', 'retryLast', 'StationUI', 'Friendly', A.fnBody(chat, 'function offerBudgetDoor(') + '\nreturn offerBudgetDoor;')(
      (items, cb) => { row = items; picked = cb; }, () => opened.push('retry'), globalThis.StationUI, Friendly);
    offer(true);
    const store = Friendly.actionButton({ action: 'store' });
    A.eq(row.map(i => i.label), [store.label, '↻ Try again'], 'a balance stop offers the top-up door (' + store.label + ')');
    picked(row[0]);
    A.eq(opened, ['settings/providers'], 'which opens AI & MODELS, where the STORE + ADD CREDITS live');
    opened.length = 0; offer(false); picked(row[0]);
    A.eq([row[0].label, opened[0]], ['$ OPEN SPENDING LIMITS', 'settings/budget'], 'a stop at a chosen cap keeps the SPENDING LIMITS door');
  } finally { globalThis.StationUI = prevUI; }
  // the flag rides from the stream to the stop line and the door
  const harness = read('frontend/app/harness.js');
  A.ok(/budgetCapIsBalance = payload\.budgetCapIsBalance === true;/.test(harness) && /budgetScope, budgetCapUsd, budgetCapIsBalance \};\n    return \{ text: full,[^\n]*budgetCapIsBalance \};/.test(harness), 'Harness.chat latches the lead end\'s budgetCapIsBalance and returns it');
  A.ok(/budgetStopLine\(budgetScope, budgetCapUsd, budgetCapIsBalance\)/.test(chat) && /offerBudgetDoor\(budgetCapIsBalance\)/.test(chat), 'COMMS passes it to the stop line and the door');
  // the sidecar owns the fact: admission's clamp sets it, the lead's own per-run stop at that ceiling carries it
  const idx = read('sidecar/index.js');
  A.ok(/const chosenCapUsd = \(runCapUsd > 0 && isFinite\(runCapUsd\)\) \? runCapUsd : 0;[^\n]*\n    runCapUsd = budgetCaps\.managedRunCapUsd\([^\n]*\);\n(?:    \/\/[^\n]*\n)*    runCapIsBalance = budgetCaps\.managedCapIsBalance\(chosenCapUsd, runCapUsd, avail\);/.test(idx),
    'managed admission marks a ceiling the clamp set to the reported balance (from the cap chosen before the clamp)');
  // which ceilings ARE the balance (review 2026-10-08: a PER RUN that merely equals the wallet is the user's cap)
  const bc = require('../sidecar/budgetcaps.js');
  const D = bc.DEFAULT_MANAGED_PER_RUN_USD;
  const isBal = (chosen, bal) => bc.managedCapIsBalance(chosen, bc.managedRunCapUsd(chosen, bal, D), bal);
  A.eq(isBal(100, 79.24), true, 'a $100 PER RUN clamped to a $79.24 wallet is a balance stop');
  A.eq(isBal(5, 5), false, 'a $5 PER RUN on a $5 wallet stops at the cap the user chose (a top-up would not lift it)');
  A.eq(isBal(5, 79), false, 'a PER RUN under the wallet is a cap stop');
  A.eq(isBal(0, 1.5), true, 'no PER RUN, a wallet under the $' + D + ' default: the wallet is the ceiling');
  A.eq(isBal(0, D), true, 'no PER RUN, a wallet exactly at the default: raising PER RUN cannot help — the balance is the ceiling');
  A.eq(isBal(0, 79), false, 'no PER RUN, a big wallet: the managed default is the ceiling, not the balance');
  A.eq([bc.managedCapIsBalance(0, 0, 0), bc.managedCapIsBalance(5, 5, NaN), bc.managedCapIsBalance(5, 5, null)], [false, false, false], 'an empty or unknown wallet never marks a balance stop');
  A.ok(/if \(runCapIsBalance && name === 'agent\.run\.end' && payload && payload\.runId === runId && payload\.reason === 'budget' && payload\.budgetScope === 'run'\n\s+&& typeof payload\.budgetCapUsd === 'number' && Math\.abs\(payload\.budgetCapUsd - runCapUsd\) < 1e-9\) payload = Object\.assign\(\{\}, payload, \{ budgetCapIsBalance: true \}\);/.test(idx),
    'loopEmit stamps budgetCapIsBalance only on the run\'s own per-run stop at that exact ceiling');
}

// ---- the SLAG toast (world.js → SlagLog) on the same stop: it must not tell a balance stop to "raise the budget" ----
{
  const SlagLog = require('../frontend/app/slaglog.js');
  const bal = SlagLog.diagnose('budget', { atBalance: true, cacheFrac: 0.05 });
  const line = SlagLog.line(bal);
  A.eq(bal.reason, 'budget', 'a balance stop is still a budget post-mortem (the maintenance quest keys on the reason)');
  A.ok(/StarNet balance/.test(line) && /add credits under SETTINGS → AI & MODELS/i.test(line) && !/raise/i.test(line), 'a balance stop toast names the balance and the top-up door: ' + line);
  A.ok(/^hit the budget cap — Raise the budget/.test(SlagLog.line(SlagLog.diagnose('budget', { atBalance: false }))), 'a stop at a chosen cap keeps its own post-mortem');
  A.ok(/cold cache/.test(SlagLog.diagnose('budget', { cacheFrac: 0.05 }).title), 'and the cold-cache lesson is unchanged for a cap stop');
  const world = read('frontend/app/world.js');
  A.ok(/slaglog\.record\(r, \{ cacheFrac: lastCacheFrac, turns: p && p\.turns, usd: p && p\.usd, error, agentId: p && p\.agentId, atBalance: !!\(p && p\.budgetCapIsBalance === true\) \}\)/.test(world),
    'the floor passes the run end\'s budgetCapIsBalance into the post-mortem');
}

// ---- messaging channels ----
{
  const { endNote } = require('../sidecar/channels/hub.js');
  const bal = endNote('budget', { budgetScope: 'run', budgetCapUsd: 10, budgetCapIsBalance: true });
  A.eq(bal, '\n\n(used the $10 left on your StarNet balance — add credits in the app under SETTINGS → AI & MODELS.)', 'a channel balance stop names the balance and the top-up door');
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
  const bal = endNote('budget', true);
  A.ok(/StarNet balance/.test(bal) && /SETTINGS → AI & MODELS/.test(bal) && !/raise/.test(bal), 'an ACP balance stop names the balance and the top-up door: ' + bal);
}
// ACP: only the lead's own end decides (a delegated worker's run.end rides the same stream)
async function acpLeadOnly() {
  const { makeAcpCore } = require('../sidecar/acp/core.js');
  const sent = [];
  const turn = async (events) => {
    sent.length = 0;
    const core = makeAcpCore({
      callSidecar: async () => ({}), notify: (m, p) => sent.push(p), request: async () => ({}), newId: () => 'x', log: () => {},
      openRun: async (o) => { for (const [n, p] of events) o.onEvent(n, p); return { reason: 'budget' }; }
    });
    await core.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const s = await core.handleRpc({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await core.handleRpc({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'go' }] } });
    return sent.map(p => (p && p.update && p.update.content && p.update.content.text) || '').join('');
  };
  const lead = await turn([['agent.run.start', { runId: 'lead' }], ['agent.run.end', { runId: 'lead', reason: 'budget', budgetScope: 'run', budgetCapUsd: 3, budgetCapIsBalance: true }]]);
  A.ok(/StarNet balance/.test(lead), 'the lead\'s balance stop reaches the editor: ' + JSON.stringify(lead.slice(-160)));
  const worker = await turn([['agent.run.start', { runId: 'lead' }], ['agent.run.start', { runId: 'w1' }], ['agent.run.end', { runId: 'w1', reason: 'budget', budgetScope: 'run', budgetCapIsBalance: true }], ['agent.run.end', { runId: 'lead', reason: 'budget', budgetScope: 'run', budgetCapUsd: 3 }]]);
  A.ok(/SPENDING LIMITS/.test(worker) && !/StarNet balance/.test(worker), 'a worker\'s balance stop never speaks for the lead: ' + JSON.stringify(worker.slice(-160)));
}
// ---- /usage ----
(async () => {
  await acpLeadOnly();
  const { makeSlashActions } = require('../sidecar/slash-actions.js');
  const SNAP = { ok: true, today: 0, lifetime: 0, runs: 0, tokens: 0, agentUsd: 0, caps: {} };
  const r = await makeSlashActions({ budget: { snapshot: async () => SNAP } }).run('usage', '', {});
  const line = (r.lines || []).find(l => /No spend caps are set/.test(l)) || '';
  A.ok(/SETTINGS › SPENDING LIMITS/.test(line) && !/→ BUDGET/.test(line), '/usage points an uncapped station at SPENDING LIMITS: ' + line);
  A.report('budget-stop-door');
})().catch(e => { console.error(e); process.exit(1); });
