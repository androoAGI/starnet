/* sidecar/capability/project-tools.js — ONE projection of a run's tools: what this agent, from this origin, in this role,
   is granted, what is advertised on the wire, what is deferred behind tool.search, what is withheld, and why
   (authority-census lane, 2026-10-30).

   projectTools(agent, origin, role, facts) -> {
     station, resolved, preAuthorityTools, widgetScope, keySaveOffered, crewless, deferralOff,
     connectorDeferral, unavailable, advertised, deferredWire, pendingFacts, sources, rows
   }

   This is the assembly runOnce used to do inline, MOVED here step for step in the same order, so the run, GET
   /api/toolsets and a channel's /tools describe one decision instead of three copies of it. It composes the
   existing policy helpers (composeOffice, resolveTools, enforceSyntheticOnly, enforceRunAuthority,
   enforceEnabledToolsets, withheldCommandTools, unavailableTools, CrewDiet, planConnectorDeferral); it adds no policy
   of its own. test/authority-census.test.js holds the whole surface x origin x role x tool matrix, and asserts this
   projection reproduces every cell; the capture from 748b0462595, before the move, is kept beside it as history.

   PURE: no I/O, no clock, no registration. Everything the run knows only by asking something (connector and plugin
   tool definitions, the Spotify token, the voice route, a key pasted in chat, the crew count) is a FACT the caller
   collects first and hands in. A fact it needs and was not given is named in `pendingFacts`, never guessed: the
   caller fetches it and projects again. Registering connector, plugin and group-turn definitions into the run's
   registry is the caller's effect (it must happen before this runs, because the run authority reads the registered
   declaration). Consent, taint, the Task Brief and every dispatch-time guard stay where they are: a projection is a
   snapshot of what may be OFFERED, never an approval.

   agent  : { id }
   origin : host-minted facts about where this run came from — { surface, floorless, ownerTrusted, trigger, cronJobId,
            isTask, station, extraObjects, unattendedGrants, enabledToolsets, groupTools }
   role   : { lead, delegatedBy } — the lead of a Commander-started run, or a worker another agent delegated to
   facts  : { registry, authority, connectorIds, disabledCaps, unrestrictedHost, realDesktopAuthority, executionProfile,
            dynamicTools: { connector: [def], plugin: [def] }, widgetScope, internalBriefTools, deferralOff,
            keySaveOffered, directDomain, leanCrew, crewCount, connectorDefer: { bytes, tools },
            availability: { mediaRoute, voiceRoute, spotifyConnected, ptyRuntime } } */
'use strict';

const { composeOffice, stationWithObject, stationWithConnectors } = require('./office.js');
const { resolveTools } = require('./resolve.js');
const { CAP_REGISTRY } = require('./registry.js');
const { unavailableTools } = require('./effective-toolsets.js');
const { withheldCommandTools } = require('./withheld.js');
const { enforceSyntheticOnly, enforceRunAuthority, enforceEnabledToolsets, impactOfTool, isConnectorTool } = require('../inputpolicy.js');
const { isRoutineTrigger } = require('../routine-identity.js');
const { dangerKey } = require('../permissions.js');
const CrewDiet = require('../crew-diet.js');
const { planConnectorDeferral } = require('../tools/builtin/toolsearch.js');
const { note: failNote } = require('../failopen.js');

/* DIRECT-DOMAIN WITHHOLDING — what a run its lead scoped to one host (onlyHost) may not even see: delegation and open
   web search, the two typo-cascade routes. One predicate for the deferred pool, the wire list, tool.search and dispatch. */
function directDomainWithheld(directDomain, name) {
  return !!directDomain && (/^team\./.test(name) || name === 'web_search');
}

/* projectStation — the room this run resolves against: the composed office (or the bay's own room) plus every
   host-side augmentation, in runOnce's order. `sources` names, per room instanceId, the step that put that object
   there — the explanation half of "grant source"; it decides nothing. */
function projectStation(agent, origin, role, facts) {
  agent = agent || {}; origin = origin || {}; role = role || {}; facts = facts || {};
  const agentId = String(agent.id || '');
  const ownerTrusted = !!origin.ownerTrusted;
  const surface = origin.surface === 'interactive' ? 'interactive' : 'autonomous';
  const unattendedGrants = Array.isArray(origin.unattendedGrants) ? origin.unattendedGrants : [];
  const connectorIds = Array.isArray(facts.connectorIds) ? facts.connectorIds : [];
  const unrestricted = facts.unrestrictedHost === true;
  const executionProfile = facts.executionProfile || { capabilityObjects: [], connectors: false };
  const sources = {};
  /* THE MOAT IS A FLOOR FACT, NOT A CONSENT FACT (2026-07-28): `floorless` says this run has no floor to read placed
     props off (a phone), whoever answers its prompts — so opting into approvals never costs a channel run its office. */
  const officeSurface = origin.floorless ? 'autonomous' : surface;
  const officeLead = !!role.lead || ownerTrusted;
  const defaultObjects = composeOffice({ surface: officeSurface, lead: officeLead, connectorIds, extraObjects: origin.extraObjects });
  let station = origin.station || { agents: { [agentId]: { id: agentId, room: 'office' } }, rooms: { office: { id: 'office', objects: defaultObjects } } };
  if (origin.station) {
    for (const ob of roomObjects(station, agentId)) if (ob && ob.instanceId) sources[ob.instanceId] = 'bay';
  } else {
    const baseCount = composeOffice({ surface: officeSurface, lead: officeLead, connectorIds }).length;
    defaultObjects.forEach((ob, i) => {
      sources[ob.instanceId] = i >= baseCount ? 'placed'
        : ob.objectType === 'connector' ? 'connector-account'
        : ob.objectType === 'orchestrator' ? 'lead' : 'office';
    });
  }
  const add = (next, why) => {
    if (next !== station) for (const ob of roomObjects(next, agentId)) if (ob && ob.instanceId && !sources[ob.instanceId]) sources[ob.instanceId] = why;
    station = next;
  };
  // OWNER TELEGRAM PARITY + UNATTENDED GRANTS — the OBJECT half. Every addition is non-mutating and applies to a bay
  // station too, whose explicit room otherwise bypasses composeOffice.
  if (ownerTrusted || unattendedGrants.indexOf('workbench') >= 0) add(stationWithObject(station, agentId, 'workbench'), ownerTrusted ? 'owner-dm' : 'routine-grant');
  if (ownerTrusted || unattendedGrants.indexOf('connectors') >= 0) add(stationWithConnectors(station, agentId, connectorIds), ownerTrusted ? 'owner-dm' : 'routine-grant');
  if (ownerTrusted) add(stationWithObject(station, agentId, 'orchestrator'), 'owner-dm');
  // a group chat's LEAD may stand in a bay room (router.stationFor), which bypasses composeOffice: confer the kit directly
  if (role.lead && Array.isArray(origin.groupTools)) add(stationWithObject(station, agentId, 'orchestrator'), 'group-lead');
  /* FULL POWER is capability authority: every execution object family and every configured connector. The
     LEAD-ONLY orchestration invariant holds (a delegated worker gets the whole computer but not team.dispatch), and
     the BUILDER is never swept in: it is the lead's to lend. */
  if (unrestricted) {
    for (const objectType of Object.keys(CAP_REGISTRY)) {
      if (objectType !== 'builder' && (objectType !== 'orchestrator' || role.lead || ownerTrusted)) add(stationWithObject(station, agentId, objectType), 'full-power');
    }
    add(stationWithConnectors(station, agentId, connectorIds), 'full-power');
  }
  // EXECUTION PROFILE — actual capability projection: every named profile carries the objects it advertises.
  for (const objectType of (executionProfile.capabilityObjects || [])) add(stationWithObject(station, agentId, objectType), 'execution-profile');
  if (executionProfile.connectors) add(stationWithConnectors(station, agentId, connectorIds), 'execution-profile');
  return { station, sources };
}

function roomObjects(station, agentId) {
  const roomId = station && station.agents && station.agents[agentId] && station.agents[agentId].room;
  const room = roomId && station.rooms && station.rooms[roomId];
  return (room && Array.isArray(room.objects)) ? room.objects : [];
}

function projectTools(agent, origin, role, facts) {
  agent = agent || {}; origin = origin || {}; role = role || {}; facts = facts || {};
  const agentId = String(agent.id || '');
  const registry = facts.registry;
  const surface = origin.surface === 'interactive' ? 'interactive' : 'autonomous';
  const trigger = origin.trigger || 'directive';
  const isTask = !!origin.isTask;
  const unrestricted = facts.unrestrictedHost === true;
  const realDesktopAuthority = facts.realDesktopAuthority === true;
  const enabledToolsets = unrestricted ? null : origin.enabledToolsets;
  const dynamicTools = facts.dynamicTools || {};
  const ddw = (name) => directDomainWithheld(facts.directDomain, name);
  const { station, sources } = projectStation(agent, origin, role, facts);

  // TOOLSET kill-switch: a family the Commander switched OFF in the TOOLSETS console never reaches this run.
  let resolved = enforceSyntheticOnly(resolveTools(agentId, station, undefined, { disabledCaps: unrestricted ? new Set() : facts.disabledCaps }), realDesktopAuthority);
  const injected = {};
  if (Array.isArray(origin.groupTools)) {
    // Host-created closures scope these tools to this exact live group turn (registered by the caller). They cannot
    // be supplied through /api/run or peer text, and never grant peer filesystem access.
    resolved.tools = resolved.tools.filter(name => !/^team\.|^session\./.test(name));
    for (const def of origin.groupTools) {
      resolved.tools.push(def.name);
      resolved.grants.push({ capId: 'compute', tool: def.name, scope: def.scope, requiresConsent: false, network: false });
      resolved.approvalRules[def.name] = { requiresConsent: false, scope: def.scope, network: false };
      resolved.networkCaps[def.name] = false;
      injected[def.name] = 'group-turn';
    }
  }
  // A host authority injection, not a room prop: a paired owner asks to control the machine they own.
  if (realDesktopAuthority) {
    for (const g of [
      { capId: 'remote-desktop', tool: 'computer.use', scope: 'execute', requiresConsent: true, network: false },
      { capId: 'remote-desktop', tool: 'desktop.open', scope: 'execute', requiresConsent: true, network: false }
    ]) {
      if (resolved.tools.indexOf(g.tool) < 0) resolved.tools.push(g.tool);
      if (!resolved.grants.some(x => x && x.tool === g.tool)) resolved.grants.push(g);
      resolved.approvalRules[g.tool] = { requiresConsent: true, scope: 'execute', network: false };
      resolved.networkCaps[g.tool] = false;
      injected[g.tool] = 'desktop-lease';
    }
  }
  // MCP CONNECTORS: a connector object placed in THIS agent's room grants its server's live tools (the caller found
  // and registered them for this room).
  for (const def of (dynamicTools.connector || [])) {
    if (resolved.tools.indexOf(def.name) < 0) resolved.tools.push(def.name);
    resolved.networkCaps[def.name] = true;
    resolved.approvalRules[def.name] = { requiresConsent: !!def.requiresConsent, scope: def.scope, network: true };
    if (!injected[def.name]) injected[def.name] = 'connector';
  }
  // PLUGIN TERMINALS: a placed plugin terminal grants that approved plugin's api.tool()s (connector trust contract).
  for (const def of (dynamicTools.plugin || [])) {
    if (resolved.tools.indexOf(def.name) < 0) resolved.tools.push(def.name);
    resolved.networkCaps[def.name] = true;
    resolved.approvalRules[def.name] = { requiresConsent: true, scope: def.scope, network: true };
    if (!injected[def.name]) injected[def.name] = 'plugin';
  }
  // Re-apply the host floor so no dynamic server or registration order can restore a real-screen tool by name.
  resolved = enforceSyntheticOnly(resolved, realDesktopAuthority);
  const preAuthorityTools = resolved.tools.slice();
  resolved = enforceRunAuthority(resolved, registry, facts.authority);
  resolved = enforceEnabledToolsets(resolved, registry, enabledToolsets);
  /* THE WIDGET'S OWN UPDATE RUN PUBLISHES IT (releases#6): exactly widget.get + widget.set (no consent, no network),
     applied after the narrowing above because a per-run list must not strip the one tool this run exists to call. */
  const widgetScope = String(facts.widgetScope || '');
  if (widgetScope) {
    const grants = (CAP_REGISTRY.notebook || []).filter(g => g && /^widget\./.test(g.tool));
    resolved = Object.assign({}, resolved, {
      tools: resolved.tools.concat(grants.map(g => g.tool).filter(n => resolved.tools.indexOf(n) < 0)),
      grants: resolved.grants.concat(grants.filter(g => !resolved.grants.some(x => x && x.tool === g.tool))),
      approvalRules: Object.assign({}, resolved.approvalRules), networkCaps: Object.assign({}, resolved.networkCaps)
    });
    for (const g of grants) { resolved.approvalRules[g.tool] = { requiresConsent: false, scope: g.scope, network: false }; resolved.networkCaps[g.tool] = false; injected[g.tool] = injected[g.tool] || 'widget-scope'; }
  }
  /* WITHHELD COMMANDS, EXPLAINED (issue #77): which workspace-process tools the authority removed (and the toolset
     switch would otherwise have allowed), so tool.search, the capability note and the WITHHELD reply say why. */
  try {
    const kept = new Set(resolved.tools);
    const stripped = enforceEnabledToolsets({ tools: preAuthorityTools.filter(n => !kept.has(n)) }, registry, enabledToolsets).tools;
    resolved.withheld = withheldCommandTools(stripped, { impactOf: n => impactOfTool(registry.get(n)),
      opts: { delegatedBy: role.delegatedBy || '', routine: surface === 'autonomous' && isRoutineTrigger(trigger) } });
  } catch (e) { failNote('tools.withheld', e); resolved.withheld = {}; }
  // Harness controls never grant reach into the world. They exist only while an attended Task Brief is active.
  for (const name of (facts.internalBriefTools || [])) {
    if (resolved.tools.indexOf(name) < 0) resolved.tools.push(name);
    injected[name] = injected[name] || 'task-brief';
  }
  // TOOL FOOTPRINT (w2): ADVERTISING decisions only. A deferred tool stays granted, dispatchable and findable through
  // tool.search. KILL SWITCH: SKYNET_TOOL_SEARCH=0 (facts.deferralOff) advertises everything.
  const deferralOff = facts.deferralOff === true;
  // keys.save rides ONLY a task run whose Commander's own recent turns hold a key-shaped string (facts.keySaveOffered).
  let keySaveOffered = false;
  if (resolved.tools.indexOf('keys.save') >= 0) {
    resolved.deferred = (resolved.deferred || []).filter(n => n !== 'keys.save');
    keySaveOffered = !!(isTask && facts.keySaveOffered === true);
    if (!keySaveOffered) resolved.tools = resolved.tools.filter(n => n !== 'keys.save');
  }
  // ZERO-CREW DIET (lean-prompt, 2026-10-12): a crewless lead defers the crew-only part of its kit.
  const crewless = CrewDiet.isCrewlessLead({ isTask, deferralOff, leanCrew: facts.leanCrew, tools: resolved.tools, crewCount: facts.crewCount });
  const availability = facts.availability || {};
  const pendingFacts = [];
  let connectorDeferral = { deferred: [], servers: [] };
  let unavailable = { byTool: {}, bySignal: {} };
  {
    const granted = new Set(resolved.tools);
    // A deferred name must be a GRANTED one: enforceRunAuthority narrows `tools` but not `deferred`.
    const deferred = (resolved.deferred || []).filter(n => granted.has(n) && !ddw(n));
    if (isTask && !deferralOff) {
      try {
        const entries = [];
        for (const name of resolved.tools) {
          const t = registry.get(name);
          const cap = String((t && t.capability) || '');
          if (cap.indexOf('mcp:') !== 0) continue;
          entries.push({ name, server: cap.slice(4), bytes: JSON.stringify(registry.wireFormat([t])[0]).length });
        }
        const limits = facts.connectorDefer || {};
        if (entries.length) connectorDeferral = planConnectorDeferral(entries, { maxBytes: limits.bytes, maxTools: limits.tools });
      } catch (e) { failNote('tools.connector-deferral', e); connectorDeferral = { deferred: [], servers: [] }; }
      // Spotify's only certain fact is "no token at all"; the caller reads the store only when this run holds a
      // spotify_* tool, so a projection that needs it and was not given it says so instead of guessing.
      if (resolved.tools.some(n => /^spotify_/.test(n)) && !Object.prototype.hasOwnProperty.call(availability, 'spotifyConnected')) pendingFacts.push('spotifyConnected');
      unavailable = unavailableTools({
        mediaRoute: availability.mediaRoute,
        voiceRoute: availability.voiceRoute,
        spotifyConnected: availability.spotifyConnected,
        ptyRuntime: availability.ptyRuntime,
        // the SAME predicate the run's capCtx.cronJobId is minted from; routine.notepad refuses without it
        routineRun: !!(surface === 'autonomous' && isRoutineTrigger(trigger) && String(origin.cronJobId || ''))
      }, granted);
    }
    const extra = connectorDeferral.deferred.concat(Object.keys(unavailable.byTool), crewless ? CrewDiet.CREW_KIT_DEFERRED : []);
    resolved.deferred = deferred.concat(extra.filter(n => granted.has(n) && deferred.indexOf(n) < 0 && !ddw(n)));
    resolved.unavailable = unavailable.byTool;
  }
  // CORE vs DEFERRED on the wire: both granted; only the core list rides every request (task runs only).
  const deferredNames = new Set((deferralOff ? [] : (resolved.deferred || [])).filter(n => !ddw(n)));
  const coreNames = resolved.tools.filter(n => !deferredNames.has(n) && !ddw(n));
  const advertised = isTask ? coreNames : [];
  const deferredWire = isTask ? Array.from(deferredNames) : [];
  const projection = { station, resolved, preAuthorityTools, widgetScope, keySaveOffered, crewless, deferralOff,
    connectorDeferral, unavailable, advertised, coreNames, deferredNames, deferredWire, pendingFacts, sources, injected };
  projection.rows = rowsOf(projection, { agentId, registry, authority: facts.authority, surface, enabledToolsets, directDomain: facts.directDomain, groupTurn: Array.isArray(origin.groupTools) });
  return projection;
}

/* rowsOf — the per-tool explanation of a projection: one row for every tool this run's room offered, with its
   state (advertised / deferred / withheld / internal), impact class, consent class, grant source and the rule that
   limits it. Derived from the projection's own outputs; it decides nothing. A readout renders these rows; the run
   gates on `resolved`. */
function rowsOf(p, ctx) {
  const registry = ctx.registry;
  const granted = new Set(p.resolved.tools);
  const advertised = new Set(p.advertised);
  const deferred = new Set(p.deferredWire);
  const withheldExplained = p.resolved.withheld || {};
  // which room object (and which step put it there) first granted each tool — the same object order resolveTools walks
  const grantedBy = {};
  for (const ob of roomObjects(p.station, ctx.agentId)) {
    for (const g of (CAP_REGISTRY[ob && ob.objectType] || [])) {
      if (!g || g.capId === 'compute' || grantedBy[g.tool]) continue;
      grantedBy[g.tool] = ob.objectType + '/' + (p.sources[ob.instanceId] || 'room');
    }
  }
  const names = [];
  const seen = new Set();
  for (const n of p.preAuthorityTools.concat(p.resolved.tools)) if (!seen.has(n)) { seen.add(n); names.push(n); }
  const rows = {};
  for (const name of names) {
    const tool = registry && typeof registry.get === 'function' ? registry.get(name) : null;
    const impact = impactOfTool(tool || { name });
    const state = advertised.has(name) ? 'advertised' : deferred.has(name) ? 'deferred'
      : granted.has(name) ? (directDomainWithheld(ctx.directDomain, name) ? 'withheld' : 'granted') : 'withheld';
    const row = { state, impact, consent: consentClassOf(tool, impact), source: p.injected[name] || grantedBy[name] || 'room' };
    if (state === 'withheld') row.reason = limitOf(name, tool, impact, p, ctx);
    if (state === 'deferred') row.reason = p.resolved.unavailable && p.resolved.unavailable[name] ? 'unavailable:' + p.resolved.unavailable[name].signal
      : p.connectorDeferral.deferred.indexOf(name) >= 0 ? 'connector-index' : (p.crewless && CrewDiet.CREW_KIT_DEFERRED.indexOf(name) >= 0) ? 'crewless-lead' : 'catalog-deferred';
    if (Object.prototype.hasOwnProperty.call(withheldExplained, name)) row.why = withheldExplained[name].why;
    rows[name] = row;
  }
  return rows;
}

// the consent class a call to this tool meets at dispatch: none, the ordinary broker under its standing key (fresh =
// never cached), or an exact one-call confirmation (an unclassifiable host effect that is not a real connector)
function consentClassOf(tool, impact) {
  if (!tool) return 'none';
  const exact = impact === 'external-unknown' && !isConnectorTool(tool);
  if (exact) return 'exact:' + dangerKey(tool);
  if (!tool.requiresConsent) return 'none';
  return (tool.freshConsent ? 'fresh:' : 'broker:') + dangerKey(tool);
}

// WHY a tool the room offered is not this run's: the first rule that removed it, in projection order
function limitOf(name, tool, impact, p, ctx) {
  if (directDomainWithheld(ctx.directDomain, name)) return 'direct-domain';
  if (name === 'keys.save' && p.preAuthorityTools.indexOf(name) >= 0 && !p.keySaveOffered) {
    const authorityKept = !(ctx.authority && typeof ctx.authority.project === 'function') || (tool && ctx.authority.project(tool) === true);
    if (authorityKept) return 'keys-save-not-offered';
  }
  if (tool && ctx.authority && typeof ctx.authority.project === 'function' && ctx.authority.project(tool) !== true) return 'authority:' + impact;
  if (ctx.enabledToolsets != null) return 'routine-toolsets';
  return 'withheld';
}

module.exports = { projectTools, projectStation, rowsOf, directDomainWithheld, consentClassOf };
