/* test/budget-stop-door.test.js — a budget stop names a door that EXISTS, on every surface that prints one.
   COMMS (frontend/app/chat.js budgetStopLine + offerBudgetDoor), the messaging channels (sidecar/channels/hub.js
   endNote), ACP editors (sidecar/acp/core.js endNote) and /usage (sidecar/slash-actions.js) all used to send the
   user to "MISSION CONTROL → BUDGET" / "SETTINGS → BUDGET". MISSION CONTROL is only a room/prop label and SETTINGS
   has no BUDGET section: the caps live in SETTINGS › SPENDING LIMITS (stationui.js section id 'budget'). Spend-truth
   lane B4, 2026-10-08. Behavioral where the code is reachable headlessly; the chat.js functions are evaluated from
   their own source (fnBody) with fake collaborators. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
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
A.ok(lineSrc.length > 50 && lineSrc.length < 4000, 'budgetStopLine exists and is bounded');   // grew past 3,000 with the projected-stop line (d3a76db3)
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
  A.ok(/budgetCapIsBalance = payload\.budgetCapIsBalance === true;/.test(harness) && /budgetScope, budgetCapUsd, budgetCapIsBalance, unpricedModel, unpricedCapTokens, subscriptionModel, subscriptionCapTokens, budgetProjected \};\n    return \{ text: full,[^\n]*budgetCapIsBalance, unpricedModel, unpricedCapTokens, subscriptionModel, subscriptionCapTokens, budgetProjected \};/.test(harness), 'Harness.chat latches the lead end\'s budgetCapIsBalance (and the unpriced ceiling, and budgetProjected) and returns them');
  A.ok(/budgetStopLine\(budgetScope, budgetCapUsd, budgetCapIsBalance, unpriced, subscription, budgetProjected\)/.test(chat) && /offerBudgetDoor\(budgetCapIsBalance\)/.test(chat), 'COMMS passes it to the stop line and the door');
}

// ---- a PROJECTED per-run stop (bug d3a76db3 review): the run and its workers share one PER RUN cap, and the run
// stopped BEFORE it because the calls still in flight already took what was left (agent.run.end budgetProjected).
// Every surface says "stopped before it would pass", never "hit" a cap that was not reached. ----
{
  A.eq(budgetStopLine('run', 0.5, false, null, null, true), 'stopped before it would pass the $0.50 per-run spend cap — raise it in SETTINGS › SPENDING LIMITS', 'COMMS: a projected stop names the cap it stopped short of');
  A.ok(!/\bhit\b/.test(budgetStopLine('run', 0.5, false, null, null, true)), 'COMMS: a projected stop never says hit');
  A.eq(budgetStopLine('run', 3, true, null, null, true), 'stopped before it would spend more than the $3 left on your StarNet balance — add credits under SETTINGS → AI & MODELS to keep going', 'COMMS: a projected stop at the balance names the balance');
  A.ok(/^hit the \$0\.50 per-run spend cap/.test(budgetStopLine('run', 0.5, false, null, null, false)), 'COMMS: a real hit still says hit');
  // the latch from the lead's agent.run.end, and the background notify line
  const harness = read('frontend/app/harness.js');
  A.ok(/budgetProjected = payload\.budgetProjected === true;/.test(harness), 'Harness.chat latches the lead end\'s budgetProjected');
  A.ok(/budgetProjected === true \? \(budgetCapIsBalance === true \? 'stopped before it would spend the rest of your StarNet balance' : 'stopped before it would pass a spending limit'\)/.test(chat), 'a background session\'s notify says "stopped before", not "hit", for a projected stop');
  const { endNote } = require('../sidecar/channels/hub.js');
  A.eq(endNote('budget', { budgetScope: 'run', budgetCapUsd: 0.5, budgetProjected: true }), '\n\n(stopped before it would pass the $0.50 per-run spend cap — raise it in the app under SETTINGS › SPENDING LIMITS.)', 'channels: a projected stop names the cap it stopped short of');
  A.ok(/stopped before it would spend more than the \$3 left on your StarNet balance/.test(endNote('budget', { budgetScope: 'run', budgetCapUsd: 3, budgetCapIsBalance: true, budgetProjected: true })), 'channels: a projected stop at the balance names the balance');
  const hubSrc = read('sidecar/channels/hub.js');
  A.ok(/state\.budgetProjected = p\.budgetProjected === true;/.test(hubSrc) && /budgetNote\(st\.budgetScope, st\.budgetCapUsd, !!st\.budgetCapIsBalance, st\.budgetProjected === true\)/.test(hubSrc), 'channels: the run end\'s budgetProjected is latched and reaches the note');
  const acp = require('../sidecar/acp/core.js')._internals;
  A.ok(/stopped before it would pass its per-run spend cap/.test(acp.endNote('budget', false, true)), 'ACP: a projected stop says it stopped before its cap');
  A.ok(/StarNet balance/.test(acp.endNote('budget', true, true)) && !/used what was left/.test(acp.endNote('budget', true, true)), 'ACP: a projected balance stop never says the balance was used up');
}

// ---- the UNPRICED-model TOKEN ceiling is not a $ cap (2026-10-11) ----
// A model with no known price is bounded per run in TOKENS (loop.js maxUnpricedTokens); the $ settings never read it,
// so "hit the per-run spend cap — raise it" sent users to a lever that changes nothing. Every surface names the real limit.
{
  const line = budgetStopLine('run', null, false, { model: 'x/mystery', capTokens: 2000000 });
  A.ok(/2,000,000-token safety ceiling for x\/mystery/.test(line), 'COMMS names the token ceiling and the model: ' + line);
  A.ok(/does not change this/.test(line) && !/raise it in SETTINGS/.test(line), 'and says raising the $ limit does not help: ' + line);
  const harness = read('frontend/app/harness.js');
  A.ok(/unpricedModel = payload\.unpricedModel/.test(harness), 'Harness.chat reads the additive unpricedModel field off agent.run.end');
  A.ok(/offerUnpricedDoor\(\)/.test(chat), 'the unpriced stop offers a model door, not SPENDING LIMITS');
  const { endNote } = require('../sidecar/channels/hub.js');
  const note = endNote('budget', { budgetScope: 'run', unpricedModel: 'x/mystery', unpricedCapTokens: 2000000 });
  A.ok(/2,000,000-token safety ceiling/.test(note) && !/SPENDING LIMITS/.test(note), 'channels name the token ceiling too: ' + note);
  const { stopSentence } = require('../sidecar/stop-reason.js');
  // the SUBSCRIPTION-token ceiling (2026-10-12): a Claude Code sign-in books $0 per turn, so its run is bounded in tokens
  const sub = budgetStopLine('run', null, false, null, { model: 'claude-opus-5-5', capTokens: 2000000 });
  A.ok(/2,000,000-token per-run ceiling on your Claude subscription \(claude-opus-5-5\)/.test(sub) && /Runtime limits/.test(sub) && !/SPENDING LIMITS/.test(sub), 'COMMS names the subscription ceiling and its real lever: ' + sub);
  A.ok(/subscriptionModel = payload\.subscriptionModel/.test(harness) && /else if \(endReason === 'budget' && !subscription\) offerBudgetDoor/.test(chat), 'the subscription stop rides to COMMS and never offers the $ door');
  const subNote = endNote('budget', { budgetScope: 'run', subscriptionModel: 'claude-opus-5-5', subscriptionCapTokens: 2000000 });
  A.ok(/2,000,000-token per-run ceiling/.test(subNote) && /STARNET_MAX_SUBSCRIPTION_TOKENS/.test(subNote) && !/SPENDING LIMITS/.test(subNote), 'channels name the subscription ceiling too: ' + subNote);
  A.ok(/STARNET_MAX_UNPRICED_TOKENS/.test(stopSentence('budget', { unpricedModel: 'x/mystery', unpricedCapTokens: 2000000 })), 'and the server-side sentence names the real knob');
  // the sidecar owns the fact: admission's clamp sets it, the lead's own per-run stop at that ceiling carries it
  const idx = readSidecarSource();
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
  A.ok(/slaglog\.record\(r, \{ cacheFrac: lastCacheFrac, turns: p && p\.turns, usd: p && p\.usd, error, agentId: p && p\.agentId, atBalance: !!\(p && p\.budgetCapIsBalance === true\), projected: !!\(p && p\.budgetProjected === true\) \}\)/.test(world),
    'the floor passes the run end\'s budgetCapIsBalance and budgetProjected into the post-mortem');
  // a PROJECTED stop (a forwarded worker end lands here too) hit no cap: its post-mortem never says it did
  const proj = SlagLog.diagnose('budget', { projected: true, cacheFrac: 0.05 });
  A.eq(proj.reason, 'budget', 'a projected stop is still a budget post-mortem');
  A.ok(proj.title === 'stopped before the budget cap' && !/\bhit\b|reached its/i.test(SlagLog.line(proj)) && /SETTINGS › SPENDING LIMITS/.test(proj.fix), 'a projected stop toast says it stopped BEFORE the cap: ' + SlagLog.line(proj));
  A.ok(/add credits under SETTINGS → AI & MODELS/i.test(SlagLog.diagnose('budget', { projected: true, atBalance: true }).fix), 'a projected stop at the balance names the top-up door');
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
  // a PROJECTED lead stop (agent.run.end budgetProjected) reaches the editor as "stopped before", never "hit"
  const projected = await turn([['agent.run.start', { runId: 'lead' }], ['agent.run.end', { runId: 'lead', reason: 'budget', budgetScope: 'run', budgetCapUsd: 3, budgetProjected: true }]]);
  A.ok(/stopped before it would pass its per-run spend cap/.test(projected) && !/hit a spend cap/.test(projected), 'the lead\'s projected stop reaches the editor as "stopped before": ' + JSON.stringify(projected.slice(-160)));
  const workerProjected = await turn([['agent.run.start', { runId: 'lead' }], ['agent.run.start', { runId: 'w1' }], ['agent.run.end', { runId: 'w1', reason: 'budget', budgetScope: 'run', budgetProjected: true }], ['agent.run.end', { runId: 'lead', reason: 'budget', budgetScope: 'run', budgetCapUsd: 3 }]]);
  A.ok(/hit a spend cap/.test(workerProjected) && !/stopped before/.test(workerProjected), 'a worker\'s projected stop never speaks for the lead: ' + JSON.stringify(workerProjected.slice(-160)));
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
