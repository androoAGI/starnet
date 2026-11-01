/* test/station-power-consent.test.js — widening the station's leash never rides a standing grant or a tainted run (sweep 2026-10-03).

   A review of station.control / station.power found the escalation tool rode silent approval paths: an "always" on its
   card (or a cached grant) approved every later escalation, and Full Access lifted its taint lock, so one prompt-injected
   page read by a Full Access agent could switch on Full Power for every agent, raise the caps, trust a folder or approve
   hook code. On the way to the page the model's own args could swap the approved action, or read a value one way for the
   tier check and another for the page. Pinned here:
     • station.power carries freshConsent: in ASK no cached grant approves it and no yes leaves one behind (its card offers
       Approve once / Deny only; a forged "full" answers that one call); Full Access still covers it untainted;
     • Full Access never lifts the taint lock on it;
     • a phone / non-owner run can never call it (STANDING_ESCALATES);
     • args.action can not swap the action; {on:"off"}, " this-computer", "FULL" read the same for the tier and the page;
     • turning abilities or saved keys ON, installing a market skill and KEEPING away-work are escalations now. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeStationControlTools } = require('../sidecar/tools/builtin/station-control.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const { makeTool } = require('../sidecar/tools/tool.js');
const taint = require('../sidecar/taint.js');
const { standingWorkEscalates } = require('../sidecar/run-origin.js');

const refused = r => /^REFUSED: /.test(r.content);
function stubs() {
  const routes = [], pages = [];
  return {
    routes, pages,
    route: async (method, url, body) => { routes.push({ method, url, body }); return { status: 200, json: { ok: true } }; },
    station: { request: async (verb, args) => { pages.push({ verb, args }); return { ok: true, result: { ok: true } }; } }
  };
}

(async () => {
  const s = stubs();
  const t = makeStationControlTools({ station: s.station, route: s.route, surface: 'interactive' });
  const power = makeTool(t.powerTool), control = makeTool(t.controlTool);
  A.ok(power.freshConsent === true, 'station.power asks fresh every time (the flag survives makeTool)');
  A.ok(control.freshConsent === false, 'station.control keeps the ordinary consent ladder');

  // ---- the broker: in ASK a cached grant never approves it, and a yes never leaves one behind ----
  const call = { name: 'station.power', args: { action: 'fullpower.set', args: { on: true } } };
  let asked = 0;
  const cached = makeConsentBroker({ surface: 'interactive', bypass: false, grantsPermanent: new Set(['station.power:write']), sessionKey: 'r1', prompt: () => { asked++; return 'deny'; } });
  let d = await cached(call, power);
  A.ok(asked === 1 && d.allow === false, 'a cached "always" (from before this fix) still raises the card, and a deny holds: asked ' + asked);
  const routine = makeConsentBroker({ surface: 'autonomous', bypass: false, grantsPermanent: new Set(['station.power:write']), sessionKey: 'r3' });
  d = await routine(call, power);
  A.ok(d.allow === false, 'an unattended run is refused even with a cached grant');
  const fullAccess = makeConsentBroker({ surface: 'interactive', bypass: () => true, sessionKey: 'r2', prompt: () => { throw new Error('asked'); } });
  d = await fullAccess(call, power);
  A.ok(d.allow === true, 'Full Access (the Commander\'s zero-prompt posture, or their own chat with approvals off) still covers it');
  const persisted = [];
  const watched = makeConsentBroker({ surface: 'interactive', bypass: false, sessionKey: 'r4', grantsPermanent: new Set(), persist: g => persisted.push(g), prompt: () => 'always' });
  d = await watched(call, power);
  A.ok(d.allow === true && d.reason === 'granted once', 'an "always" answer approves this one call');
  A.eq(persisted.length, 0, 'and persists nothing');
  asked = 0;
  const again = makeConsentBroker({ surface: 'interactive', bypass: false, sessionKey: 'r4', grantsSession: new Map(), prompt: () => { asked++; return 'session'; } });
  await again(call, power); await again(call, power);
  A.eq(asked, 2, 'a "session" answer does not pre-approve the next escalation');
  const fullPower = makeConsentBroker({ surface: 'interactive', unrestrictedHost: () => true, sessionKey: 'r5', prompt: () => { throw new Error('asked'); } });
  d = await fullPower(call, power);
  A.ok(d.allow === true && d.reason === 'full-power', 'under Full Power (no floor left to protect) it does not ask');
  asked = 0;
  const ordinary = makeConsentBroker({ surface: 'interactive', bypass: () => true, sessionKey: 'r6', prompt: () => { asked++; return 'once'; } });
  d = await ordinary({ name: 'station.control', args: {} }, control);
  A.ok(d.allow === true && asked === 0, 'station.control still rides Full Access without a card');

  // ---- taint: Full Access never lifts the lock on it ----
  const tb = taint.postTaintBoundary(power, { taintedBy: 'web_fetch', surface: 'interactive', hasPrompt: true, fullAccess: true });
  A.ok(tb.allow === false && tb.needsConfirmation === true, 'a Full Access run that read a page needs a fresh confirmation to escalate');
  const tc = taint.postTaintBoundary(control, { taintedBy: 'web_fetch', surface: 'interactive', hasPrompt: true, fullAccess: true });
  A.ok(tc.allow === true, 'station.control under Full Access is unchanged');

  // ---- the host: a "full" answer to its card answers this call only; its card offers once / deny ----
  const idx = readSidecarSource();
  // app-shell-ui-03: every standing grade (full, always, session) answers a fresh card once, and the route ECHOES 'once',
  // so no surface (desk card, phone, voice) confirms "always allowed" for a grant the harness never made
  A.ok(/if \(finish && finish\.freshConsent === true && \/\^\(full\|always\|session\)\$\/\.test\(decision\)\) decision = 'once';\s*if \(finish && decision === 'full'\) \{\s*persisted = persistAgentFullAccess/.test(idx), 'handleConsent: any standing answer on a fresh card is applied and echoed as once, and never persists Full Access');
  A.ok(/fresh: !!\(tool && tool\.freshConsent === true\)/.test(idx) && /if \(orig && fields && fields\.fresh\) orig\.freshConsent = true;/.test(idx), 'the desk prompt marks a fresh card\'s finisher');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  // the fresh-consent cards (station.power, and plugin.submit since app-shell-ui-03) share one once / deny branch
  const freshBranch = "} else if (p.tool === 'station.power' || p.tool === 'plugin.submit') {";
  A.ok(chat.indexOf(freshBranch) >= 0, 'the station.power and plugin.submit cards share the fresh-consent branch');
  const card = chat.slice(chat.indexOf(freshBranch), chat.indexOf("} else {", chat.indexOf(freshBranch)));
  A.ok(/'Approve once'/.test(card) && /'Deny'/.test(card) && !/'Always'|'Full access'/.test(card), 'the station.power card offers Approve once and Deny only');

  // ---- a phone / non-owner run never escalates ----
  A.ok(standingWorkEscalates('station.power', { action: 'budget.set', args: { perDay: 5 } }) && standingWorkEscalates('station_power', {}), 'station.power is withheld from phone and non-owner runs');
  A.ok(standingWorkEscalates('station.control', { action: 'nightshift.focus', args: { ref: 'goal' } }), 'pointing autonomy at work is withheld too');
  A.ok(!standingWorkEscalates('station.control', { action: 'nightshift.focus', args: { clear: true } }) && !standingWorkEscalates('station.control', { action: 'session.pin', args: {} }), 'clearing it, or an ordinary change, is not');

  // ---- one reading of the args ----
  let r = await t.controlTool.run({ action: 'agent.rename', args: { action: 'agent.approval', agent: 'NOVA', mode: 'full', name: 'X' } });
  A.ok(!refused(r) && s.pages[s.pages.length - 1].args.action === 'agent.rename', 'args.action can not swap the approved action on the way to the page');
  r = await t.controlTool.run({ action: 'agent.away_work', args: { agent: 'NOVA', on: 'off' } });
  A.ok(!refused(r) && s.pages[s.pages.length - 1].args.on === false, '{on:"off"} reaches the page as false (it read as ON there)');
  r = await t.controlTool.run({ action: 'agent.away_work', args: { agent: 'NOVA', on: 'on' } });
  A.ok(refused(r) && /station\.power/.test(r.content), '{on:"on"} is an escalation');
  for (const reach of [' this-computer', 'THIS-COMPUTER', 'trusted-project ', 'host']) {
    r = await t.controlTool.run({ action: 'agent.reach', args: { agent: 'NOVA', reach } });
    A.ok(refused(r) && /station\.power/.test(r.content), JSON.stringify(reach) + ' is an escalation, not an ordinary reach change');
  }
  r = await t.controlTool.run({ action: 'agent.reach', args: { agent: 'NOVA', reach: ' Safe-Cell ' } });
  A.ok(!refused(r) && s.pages[s.pages.length - 1].args.reach === 'safe-cell', 'a narrowing reach is read once and reaches the page clean');
  r = await t.controlTool.run({ action: 'agent.approval', args: { agent: 'NOVA', mode: 'FULL' } });
  A.ok(refused(r), '"FULL" is an escalation');

  // ---- what widens access is station.power now ----
  for (const [action, args] of [['ability.set', { id: 'terminal', on: true }], ['key.set', { id: 'k1', on: 'on' }], ['skill.install', { slug: 'x' }], ['deliverable.decide', { runId: 'r', decision: 'keep' }]]) {
    r = await t.controlTool.run({ action, args });
    A.ok(refused(r) && /station\.power/.test(r.content), action + ' ' + JSON.stringify(args) + ' is an escalation');
    r = await t.powerTool.run({ action, args });
    A.ok(!refused(r), action + ' goes through station.power');
  }
  for (const [action, args] of [['ability.set', { id: 'terminal', on: false }], ['key.set', { id: 'k1', on: false }], ['deliverable.decide', { runId: 'r', decision: 'discard' }]]) {
    r = await t.controlTool.run({ action, args });
    A.ok(!refused(r), action + ' ' + JSON.stringify(args) + ' (narrowing) stays ordinary');
  }

  A.report('station-power-consent.test');
})().catch(e => { console.error(e); process.exit(1); });
