/* sidecar/routing/router.js — the server-authoritative RoutingPlan + dispatch resolution.

   In the sidecar the router is built on the SAVED floor (savedProjection + savedHost, routing/saved-authority.js): the floor the
   user saved is the only plan it routes by, and nothing is ever posted into it. The posted-plan mode below (setPlan/clearPlan, a
   router built with neither seam) is for the pure routing tests, which compile a plan and hand it to a router directly; the
   sidecar never builds it. Either way the router answers "which agent runs this work-item?" via the SAME
   ../../frontend/app/pipeline.js the frontend uses — one compiler, two consumers, zero drift. A non-deployable plan (cycle /
   orphan source / dead bay) is NEVER stored, so routing can't loop or send work into a void; resolveTarget returning null lets
   the caller fall back to its own resolution, so real work never stalls. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');
const { makeStationStore } = require('../station-store.js');
const { healPlan } = require('./planlines.js');
const { fullOffice } = require('../capability/office.js');
const { heldWhy } = require('./saved-hold.js');
// the object types of the default office a headless run is handed with no bay: a posted plan's room is never wider
const DEFAULT_CEILING = new Set(fullOffice().map(o => o.objectType));

function makeRouter(o) {
  o = o || {};
  let plan = null;
  let capsPlan = null;   // last WELL-FORMED posted plan, deployable or not — the CAPABILITY view only (see setPlan)
  let stationPlan = null;
  let rr = {};   // per-SPLITTER-tile round-robin counter so dispatch spreads work across lanes (matches the engine)
  /* the counter-advancing pick the executor's walks take, carrying its own non-advancing READ (`peek`): Pipeline.chainStepDock's look
     past a JOINER reads a splitter with it and never moves one (runtime repair 2026-10-12 — every arriving branch used to move it) */
  function advancingPick() {
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    pick.peek = (k, n) => (rr[k] || 0) % n;
    return pick;
  }
  const stationStore = o.stationStore || makeStationStore();
  /* THE SAVED STATION GRANTS (2026-10-21). `savedStation()` -> the server-side saved floor as a validated station model,
     or null. A posted-plan router (a pure-router fixture) given it bounds a bay's room objects by THAT floor, never widened by
     the plan posted: the plan picks the dock a run is at and may only narrow its room. See savedStationFor. The sidecar does
     not build that router: it builds on savedProjection (below), where the saved floor is the plan itself. */
  const savedStation = typeof o.savedStation === 'function' ? o.savedStation : null;
  // The host supplies the saved authority's projection (routing/saved-authority.js);
  // a malformed supplied seam cannot silently select the legacy posted mode.
  if ('savedProjection' in o && typeof o.savedProjection !== 'function') throw new Error('savedProjection must be the saved-floor reader');
  const savedProjection = o.savedProjection || null;
  /* HOST MODE (savedHost: true, the sidecar). The same authority, read the way the posted-plan router was read, so every caller the host
     has keeps its meaning: a question about a thing the saved floor does not hold (an agent with no bay, a stale dock, an unknown line)
     answers null, [] or false instead of throwing; a saved floor the compiler refuses (unroutable) routes nothing but still answers its
     capability, brief and limit facts; a new install with no saved floor at all (unfloored) answers as a router with no plan. ONLY a
     floor that cannot be proved right now (a hold: corrupt, unreadable, changed, ...) throws, with error.held === true and error.why,
     and the host classifies each caller (admit: shows it; observe: degrades). Without it the router is strict: every mismatch throws. */
  if (o.savedHost != null && !savedProjection) throw new Error('savedHost needs the saved-floor reader');
  const savedHost = !!(savedProjection && o.savedHost === true);
  let currentFloor = null, savedTopology = null;
  let lastSource = null, lastRuntimePlan = null;   // a memoized source is the same object: its runtime plan (and Pipeline's per-plan memos) is built once
  // held: this error is a floor that cannot be proved (the host shows or degrades it); the rest are a caller asking about something the floor lacks
  function savedFailure(status, held) {
    const error = new Error('Saved routing authority is held: ' + status);
    error.code = 'EROUTING_SAVED_' + String(status).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    error.status = status;
    if (held === true) { error.held = true; error.why = heldWhy(status); }
    return error;
  }
  function capabilityPlan() { return savedProjection ? currentFloor.plan : stationPlan || plan || capsPlan; }
  function readOnlyAuthority() { if (savedProjection) throw savedFailure('read-only'); }
  function requireAgent(agentId, dockId) {
    const p = capabilityPlan();
    if (typeof agentId !== 'string' || !agentId || !Pipeline.docksOf(p, agentId).length) throw savedFailure('unknown-agent');
    if (dockId != null && (typeof dockId !== 'string' || !dockId || Pipeline.agentOfDock(p, dockId) !== agentId)) throw savedFailure('unknown-dock');
  }
  function requireDock(dockId) {
    if (typeof dockId !== 'string' || !dockId || !Pipeline.agentOfDock(capabilityPlan(), dockId)) throw savedFailure('unknown-dock');
  }
  function requireLine(lineId) {
    if (typeof lineId !== 'string' || !lineId || !(capabilityPlan().lines || []).some(line => line.lineId === lineId)) throw savedFailure('unknown-line');
  }
  function requireNodeLine(agentId, dockId, lineId) {
    if (lineId == null) return;
    requireLine(lineId);
    const p = capabilityPlan(), dock = dockId || Pipeline.entryDockOf(p, agentId);
    if (Pipeline.lineOfDock(p, dock) !== lineId) throw savedFailure('line-mismatch');
  }
  function guardSavedCall(name, args) {
    const [a, b, c] = args;
    if (['dockOf', 'lineOfAgent', 'lineOriginFor', 'stationFor', 'stageBrief', 'chainShipsToOutbox'].includes(name)) requireAgent(a, b);
    if (['entryDockOf', 'docksOf'].includes(name)) requireAgent(a);
    if (['chainNext', 'chainStep', 'chainPeek', 'fanSiblings'].includes(name)) {
      requireAgent(a, b && b.dockId);
      if (b) requireNodeLine(a, b.dockId, b.lineId);
    }
    if (['agentOfDock', 'lineOfDock', 'chainNextDock', 'chainStepDock', 'chainPeekDock', 'fanSiblingsDock'].includes(name)) {
      requireDock(a);
      if (b) requireNodeLine(Pipeline.agentOfDock(capabilityPlan(), a), a, b.lineId);
    }
    if (name === 'loopGateAfter') { requireAgent(a, c); requireNodeLine(a, c, b); }
    if (name === 'lineLimits') requireLine(a);
    if (name === 'dockRef') {
      if (typeof a !== 'string' || !a || (!Pipeline.agentOfDock(capabilityPlan(), a) && !Pipeline.docksOf(capabilityPlan(), a).length)) throw savedFailure('unknown-dock');
      if (b != null) requireLine(b);
    }
    if (name === 'resolveDock' || name === 'resolveTarget') {
      if (a && a.boundAgentId != null) requireAgent(a.boundAgentId, a.dockId);
      else if (a && a.dockId != null) requireDock(a.dockId);
      if (a && a.lineId != null) requireLine(a.lineId);
      if (a && a.boundAgentId != null) requireNodeLine(a.boundAgentId, a.dockId, a.lineId);
    }
    if (name === 'intakeReceiptFor') {
      if (a && a.agentId != null) requireAgent(a.agentId, a.dockId);
      if (a && a.lineId != null) requireLine(a.lineId);
    }
  }
  function withSavedFloor(name, fn) {
    return function (...args) {
      let source;
      try { source = savedProjection(); } catch (_) { savedTopology = null; rr = {}; throw savedFailure('unreadable', true); }
      if (savedHost && source && source.version === 1 && source.status === 'unfloored') {
        savedTopology = null; rr = {};
        currentFloor = { source, plan: null };
        try { return fn(...args); }
        finally { currentFloor = null; }
      }
      if (!source || source.version !== 1 || source.status !== 'ok' || !source.plan || !source.stationDoc
          || typeof source.routingOk !== 'boolean' || !Number.isSafeInteger(source.revision) || source.revision < 1
          || typeof source.stamp !== 'string' || !source.stamp || !/^saved-plan-v1:[a-f0-9]{64}$/.test(source.identity || '')) {
        savedTopology = null; rr = {};
        throw savedFailure(source && source.status && source.status !== 'ok' ? source.status : 'invalid', true);
      }
      if (source !== lastSource) {
        const built = Object.assign({}, source.plan);
        Object.defineProperty(built, 'links', { value: source.compilerLinks, enumerable: false });
        lastRuntimePlan = Object.freeze(built); lastSource = source;
      }
      const runtimePlan = lastRuntimePlan;
      if (!source.topologyHash || source.topologyHash !== savedTopology) rr = {};
      savedTopology = source.topologyHash || null;
      currentFloor = { source, plan: runtimePlan };
      try {
        if (!savedHost) guardSavedCall(name, args);
        const result = fn(...args);
        if (!savedHost) {
          if (result == null && ['dockRef', 'intakeReceiptFor'].includes(name)) throw savedFailure('unresolved-identity');
          if (name === 'dockRef' && args[1] != null && Pipeline.lineOfDock(currentFloor.plan, result.dockId) !== args[1]) throw savedFailure('unresolved-identity');
        }
        return result;
      }
      finally { currentFloor = null; }
    };
  }

  // store a posted plan. null/empty clears it (no routing floor). A plan with BLOCKING errors is refused.
  function setPlan(p) {
    readOnlyAuthority();
    if (!p || typeof p !== 'object') { plan = null; capsPlan = null; return { ok: true, cleared: true }; }
    if (!Array.isArray(p.errors)) { plan = null; capsPlan = null; return { ok: false, error: 'malformed plan' }; }
    /* SELF-HEAL A PRE-LINE-IDENTITY PLAN (2026-08-07). chainNext reads a missing line map as "every dock is
       terminal", which is the right default for an unknown floor but the WRONG one for a plan whose geometry
       we are holding: a headless sidecar restoring a pre-arc plan from disk ran stage one of every drawn line
       and nothing else, with no browser ever coming along to re-post. planlines derives the map from THIS
       plan's own belts + machine hookups; a plan that already carries one is returned untouched, so the
       compiler stays the authority whenever it has spoken. */
    p = healPlan(p);
    // CAPABILITY IS NOT ROUTING (2026-07-26). Which objects a bay's room holds is a fact about the PLACED
    // FLOOR — true whether or not the belts compile. Refusing a plan outright used to drop that fact too, so
    // one blocking error (a loop, a dup binding, and until today a stray unbelted INTAKE) silently handed
    // every bay-bound agent the DEFAULT OFFICE while the world still painted "NO COMPUTE" over its bay: the
    // UI asserting a restriction the harness had stopped applying, and the looser grant of the two. Keeping
    // the bay projection here means the claim and the grant stay one fact; ROUTING still refuses below.
    // The refusal carries `caps: true` so the persistence seam (index.js handleRouting) keeps this plan on
    // disk: capsPlan was memory-only, so a refusal followed by a RESTART re-opened the same default-office
    // hole this block closed live (2026-08-10 audit #1). Boot replays the file through this same function.
    capsPlan = p;
    if (!Pipeline.ok(p)) { plan = null; return { ok: false, error: 'plan has blocking errors', caps: true, codes: p.errors.filter(e => !e.warn).map(e => e.code) }; }
    /* KEEP SPLITTER BALANCE ACROSS A NO-OP RE-POST (2026-08-07). `rr` is the per-splitter round-robin counter
       that makes dispatch SPREAD across a splitter's lanes; resetting it on every accepted plan meant any
       re-post restarted every splitter at lane 0. plan.hash is exactly the dispatch topology (sources, bays,
       junctions, belts — see the hash note in pipeline.js), so an identical hash guarantees the same splitter
       tiles with the same lane counts and the counters stay meaningful. A CHANGED (or absent, i.e. older and
       unprovable) hash still resets: a floor edit really is a new floor. */
    const same = !!(plan && p.hash && plan.hash && p.hash === plan.hash);
    plan = p; if (!same) rr = {};
    return { ok: true, hash: p.hash || null, bays: (p.bays || []).length };
  }
  function clearPlan() { readOnlyAuthority(); plan = null; capsPlan = null; rr = {}; }
  function activePlan() {
    if (savedProjection) {
      if (!currentFloor.source.routingOk) { if (savedHost) return null; throw savedFailure('unroutable'); }
      return currentFloor.plan;
    }
    return stationPlan || plan;
  }
  function getPlan() { return activePlan(); }
  function hasPlan() { return !!activePlan(); }
  function setStation(stationDoc) {
    readOnlyAuthority();
    const v = stationStore.validateStationDoc(stationDoc);
    if (!v.ok) return { ok: false, error: v.error };
    // a non-deployable station (cycle/orphan/dead bay) is refused UNCONDITIONALLY. The old guard
    // (`!v.routingOk && stationPlan`) made validation order-dependent: a FIRST install of a cyclic
    // station slipped through and claimed ok while arming no routing — the same doc refused a moment
    // later if any station was already installed. Refusal must not depend on install order (2026-08-04).
    if (!v.routingOk) {
      return {
        ok: false,
        error: 'station routing plan has blocking errors',
        codes: v.routingPlan.errors.filter(e => !e.warn).map(e => e.code)
      };
    }
    const r = stationStore.setStation(stationDoc);
    if (!r.ok) return r;
    stationPlan = r.routingOk ? r.routingPlan : null;
    rr = {};
    return r;
  }
  function clearStation() { readOnlyAuthority(); stationPlan = null; return stationStore.clearStation(); }
  function getStation() { return savedProjection ? currentFloor.source.stationDoc : stationStore.getStation(); }
  // the agentId a work-item routes to, or null (caller falls back to its default resolution — never stalls).
  // The picker advances a per-splitter-tile counter, so successive work-items spread across the splitter's lanes
  // (a FILTER stays deterministic by tag and ignores it) — dispatch load-balances instead of always lane 0.
  function resolveTarget(ctx) {
    const r = resolveDock(ctx);
    return r ? r.agentId : null;
  }
  function savedResolution(result, ctx) {
    if (!savedProjection || savedHost) return result;
    if (!result) throw savedFailure('unresolved-target');
    // Pipeline's legacy bound-agent resolution always picks its entry dock.
    // An explicit saved identity must never be silently redirected by that rule.
    if ((ctx.boundAgentId != null && result.agentId !== ctx.boundAgentId)
        || (ctx.dockId != null && result.dockId !== ctx.dockId)) throw savedFailure('target-mismatch');
    if (ctx.lineId != null && Pipeline.lineOfDock(currentFloor.plan, result.dockId) !== ctx.lineId) throw savedFailure('line-mismatch');
    return result;
  }
  /* resolveDock(ctx) -> { agentId, dockId } | null — THE entry dispatcher (multi-bay agents, 2026-09-22). The
     same walk, the same round-robin counters and the same line scope as resolveTarget (which is now its agent
     reading), but it also names WHICH dock the work reached — the dock whose brief, room and line the run gets.
     An addressed item (ctx.boundAgentId) enters at that agent's ENTRY dock (Pipeline.entryDockOf). */
  function resolveDock(ctx) {
    const p = activePlan();
    if (!p) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    ctx = ctx || {};
    /* LINE-SCOPED DISPATCH (sample proof, 2026-08-10 audit — "sample not line-scoped"). An optional
       ctx.lineId narrows the UNADDRESSED source walk to the named line's OWN doors: only the INBOX
       sources whose intake prop the compiled plan puts on that line are walked, so the work enters
       through that line's front door and nowhere else. Everything else is byte-identical — the same
       Pipeline.resolveTarget walk, the same shared round-robin counters (a splitter on the named line
       still spreads), and no caller that omits lineId changes behaviour (no production ctx carried a
       lineId before this). The filter reads the plan's own compiled lineOfProp map — no second
       derivation of line membership. A named line with no doors resolves null (the caller refuses
       honestly; dispatch never silently widens to another line's intake). */
    if (ctx.lineId != null && String(ctx.lineId)) {
      const want = String(ctx.lineId);
      const lop = p.lineOfProp || {};
      const srcs = (p.sources || []).filter(s => s && s.propId != null && String(lop[String(s.propId)] || '') === want);
      if (!srcs.length) { if (savedProjection && !savedHost) throw savedFailure('unresolved-target'); return null; }
      // the narrowed view shares the plan's own dock layer (no re-derivation on a sources-only clone)
      const resolved = Pipeline.resolveDock(Object.assign({}, p, { sources: srcs }, Pipeline.dockLayer(p)), ctx, pick);
      return savedResolution(resolved, ctx);
    }
    const resolved = Pipeline.resolveDock(p, ctx, pick);
    return savedResolution(resolved, ctx);
  }

  /* ---------- THE DOCK KEY (multi-bay agents, 2026-09-22) ----------
     One bay has ONE agent; one agent may crew MANY bays. Every per-dock fact below (line, brief, room,
     chain edge) takes an optional dockId; without one it reads the agent's ENTRY dock — the oldest dock an
     INBOX reaches, else its oldest (Pipeline.entryDockOf) — which on a floor where each agent crews one
     dock is simply THE dock, so every pre-dock caller answers exactly as before. A dockId the plan does
     not know (a stale id after a floor edit) falls back to the entry dock rather than to nothing. */
  function dockOf(agentId, dockId) {
    const p = capabilityPlan();
    return p ? Pipeline.dockOf(p, agentId, dockId) : null;
  }
  function entryDockOf(agentId) { const p = activePlan(); return p ? Pipeline.entryDockOf(p, agentId) : null; }
  function docksOf(agentId) { const p = capabilityPlan(); return p ? Pipeline.docksOf(p, agentId) : []; }
  function agentOfDock(dockId) { const p = capabilityPlan(); return p ? Pipeline.agentOfDock(p, dockId) : null; }
  function lineOfDock(dockId) { const p = activePlan(); return p ? Pipeline.lineOfDock(p, dockId) : null; }
  /* dockRef(ref, lineId?) -> { agentId, dockId } | null. `ref` is a dockId OR an agentId (the step-through test's
     startAt, a routine's FIRES AT). An agentId reads its entry dock — or, when a line is named and the entry dock
     is not on it, the agent's oldest dock ON that line (an INBOX-fed one first). */
  function dockRef(ref, lineId) {
    const p = activePlan();
    if (!p || ref == null || String(ref) === '') return null;
    const r = String(ref);
    const a = Pipeline.agentOfDock(p, r);
    if (a) return { agentId: a, dockId: r };
    const docks = Pipeline.docksOf(p, r);
    if (!docks.length) return null;
    const want = lineId != null && String(lineId) ? String(lineId) : null;
    const entry = Pipeline.entryDockOf(p, r);
    if (!want || Pipeline.lineOfDock(p, entry) === want) return { agentId: r, dockId: entry };
    const L = Pipeline.dockLayer(p);
    const onLine = docks.filter(d => L.lineOfDock[d] === want);
    const d = onLine.find(x => L.reachDock[x]) || onLine[0] || null;
    return d ? { agentId: r, dockId: d } : { agentId: r, dockId: entry };
  }

  /* WHICH LINE DOES THIS DOCK BELONG TO? Read straight off the compiled plan (never re-derived) — the
     single fact the gate, the cron fire and the floor's crate honesty all quote. null = this agent crews
     no dock on the armed plan, or the plan predates line identity (both TERMINAL — see Pipeline.chainNext).
     Used by triggers that name their dock OUTRIGHT: a routine fires AT a dock, so it is that line's own
     trigger whether or not a door also feeds that dock. */
  function lineOfAgent(agentId, dockId) {
    const p = activePlan();
    if (!p) return null;
    // a named dock answers for ITSELF (multi-bay: the writer's two bays may sit on two lines)
    if (dockId != null && String(dockId) && Pipeline.agentOfDock(p, dockId) === agentId) return Pipeline.lineOfDock(p, String(dockId));
    return Pipeline.lineOf(p, agentId);
  }

  /* WORK ORIGIN for work ARRIVING FROM OUTSIDE (a channel message, a sample job): the line it belongs to,
     or null when nothing triggered a workflow. Adds the door test to lineOfAgent — only a dock the plan's
     INBOX sources actually reach counts as "it rode in through this line's front door" (see the full
     reasoning on Pipeline.lineOriginOf). Asked of the agent that RUNS, never of how the message was
     addressed, because the per-agent channel bots hard-lock stage one and consult no floor routing. */
  function lineOriginFor(agentId, dockId) {
    const p = activePlan();
    if (!p) return null;
    // the dock that RUNS decides (multi-bay): only a dock an INBOX reaches carries the line's origin
    if (dockId != null && String(dockId) && Pipeline.agentOfDock(p, dockId) === agentId) return Pipeline.lineOriginOfDock(p, String(dockId));
    return Pipeline.lineOriginOf(p, agentId);
  }

  /* Receipt only: callers pass the line/direct decision they already made. Never resolve again here (a
     second splitter pick could choose another agent). No active plan means unknown, not a direct binding.
     A SEND TO supplies its already-validated intake; other entries name the line identity's owning INBOX. */
  function intakeReceiptFor(facts) {
    const p = activePlan(), f = facts || {}, valid = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v);
    if (!p) return null;
    const agentId = f.agentId == null ? '' : f.agentId;
    if (agentId && !valid(agentId)) return null;
    const dockId = f.dockId || (agentId ? Pipeline.entryDockOf(p, agentId) : null);
    if (dockId && (!valid(dockId) || !agentId || Pipeline.agentOfDock(p, dockId) !== agentId)) return null;
    const identity = Object.assign({}, agentId ? { agentId } : null, dockId ? { dockId } : null);
    if (f.lineId == null) return agentId ? Object.assign({ mode: 'direct' }, identity) : null;
    if (!valid(f.lineId)) return null;
    const line = (Array.isArray(p.lines) ? p.lines : []).find(l => l && l.lineId === f.lineId);
    if (!line || !Array.isArray(line.intakes) || !line.intakes.length) return null;
    if (agentId && (!dockId || Pipeline.lineOfDock(p, dockId) !== f.lineId)) return null;
    const intakeId = f.intakeId || line.intakeId || line.intakes[0];
    if (!valid(intakeId) || !line.intakes.includes(intakeId) || !(Array.isArray(p.sources) ? p.sources : []).some(s => s.propId === intakeId)) return null;
    return Object.assign({ mode: 'line' }, identity, { lineId: f.lineId, intakeId });
  }

  /* Phase B5 — per-bay capability isolation. The resolveTools-shaped station for a BAY-bound agent, built from
     the objects the floor placed in that bay's room: bounded by the saved station when the host passes savedStation
     (the sidecar does — savedStationFor below: never wider than the saved room or the default office), else off the
     posted plan (a router built without one, as the pure routing tests do). null for any agent WITHOUT a bay (the
     caller then uses its own default office), so only bay-routed work is isolated; everything else is unchanged. PURE room objects — no baseline — so an UNEQUIPPED
     bay grants no compute and can't spend (the compute gate stays shut; cost-safe), exactly mirroring resolveTools'
     projection of the placed floor. */
  function stationFor(agentId, dockId) {
    // the CAPABILITY view: an authoritative station wins, else the last well-formed posted plan — deployable
    // or not (a broken belt graph must not widen an agent's reach; see the setPlan note).
    const p = capabilityPlan();
    if (!agentId) return null;
    if (!savedProjection && savedStation && !stationStore.hasStation()) return savedStationFor(agentId, dockId, p);
    if (!p) return null;
    // a bay isolates its agent whether or not a belt is hooked to it: `bays` = belt-hooked dispatch targets,
    // `dockBays` = EVERY bound bay (a lone dock is a complete build — 2026-07-05 sense pass). Older plans
    // without dockBays behave exactly as before.
    /* STATION ISOLATION, PER DOCK (multi-bay, 2026-09-22 — Andrew's ruling). An agent crewing several bays
       gets the room of the dock THIS run is at (dockId, else its entry dock) — never the union of its bays'
       rooms. A deskful agent still gets its desk room on every hop: the floor computes each dock record's
       `objects` through worldmodel.bayObjects(agentId, dockId), which prefers the desk room (remote-bay
       ruling). The first matching record is only the fallback for a plan that predates the dock key. */
    const bay = planBayOf(p, agentId, dockId);
    if (!bay) return null;
    const authoritative = !savedProjection && stationStore.hasStation() ? stationStore.bayObjects(agentId, bay.propId) : null;
    const objs = Array.isArray(authoritative) ? authoritative : (Array.isArray(bay.objects) ? bay.objects : []);
    return roomStation(agentId, bay.propId, objs);
  }
  // the plan's bay record for this agent at this dock (else its entry dock, else its first record), or null
  function planBayOf(p, agentId, dockId) {
    if (!p) return null;
    const want = dockOf(agentId, dockId);
    return (want && ((p.bays || []).find(b => b.propId === want && b.agentId === agentId) || (p.dockBays || []).find(b => b.propId === want && b.agentId === agentId)))
      || (p.bays || []).find(b => b.agentId === agentId) || (p.dockBays || []).find(b => b.agentId === agentId) || null;
  }
  /* A PLAN MAY NARROW A GRANT, NEVER WIDEN IT (2026-10-21). The saved floor and the posted plan each bound a bay's room:
     - the saved floor crews the agent: the room of the run's dock when that dock is one of its saved bays (else its first
       saved bay), cut down to what the plan lists for the agent when the plan crews it too — so a save that lags, or was
       refused, after gear came off a bay cannot hand that gear back;
     - only the plan crews it (no save on the server, an unreadable or invalid save, a save that does not crew it yet):
       the plan's room cut down to the default office (DEFAULT_CEILING) — NEVER null, because null means the caller's
       FULL default office while the floor still paints the bay's restriction (the 2026-08-10 audit #1 class);
     - neither crews it: null, the caller's own office, exactly as with no plan.
     So no posted plan can make a run's grant wider than the saved room or the default office, and a restart re-reads
     the same saved floor and the same persisted plan. */
  function savedStationFor(agentId, dockId, p) {
    let st = null;
    try { st = savedStation(); } catch (e) { st = null; console.warn('[routing] saved station unreadable; a bay room is held to the posted plan within the default office:', (e && e.message) || e); }
    if (st && (typeof st.props !== 'function' || typeof st.bayObjects !== 'function')) st = null;
    const bays = st ? st.props().filter(b => b && b.t === 'bay' && b.agentId === agentId).map(b => String(b.id)) : [];
    if (bays.length) {
      const planDock = p ? dockOf(agentId, dockId) : null;
      const dock = [dockId, planDock].map(d => (d == null ? '' : String(d))).find(d => d && bays.indexOf(d) >= 0) || bays[0];
      const saved = st.bayObjects(agentId, dock);
      const objs = Array.isArray(saved) ? saved : [];
      const listed = planBayOf(p, agentId, dock);
      return roomStation(agentId, dock, listed ? objectsWithin(objs, Array.isArray(listed.objects) ? listed.objects : []) : objs);
    }
    const listed = planBayOf(p, agentId, dockId);
    if (!listed) return null;
    return roomStation(agentId, listed.propId, (Array.isArray(listed.objects) ? listed.objects : []).filter(inDefaultOffice));
  }
  // a room object's identity: its type plus the per-instance binding that selects WHICH server/plugin it projects
  function objectKey(t) {
    return (t && typeof t === 'object') ? [t.objectType, t.connectorId || '', t.pluginId || ''].join('|') : [t, '', ''].join('|');
  }
  // the objects of `objs` that `bound` also lists (never wider than either list)
  function objectsWithin(objs, bound) {
    const keys = new Set(bound.map(objectKey));
    return objs.filter(t => keys.has(objectKey(t)));
  }
  // the default office a headless run gets with no bay (capability/office.js fullOffice), plus connector portals: those
  // are account-level and ride every default office (composeOffice), and one naming no configured server projects nothing.
  // Never the workbench, a plugin terminal, the orchestrator or the builder: those are a host's grant, never a plan's.
  function inDefaultOffice(t) {
    const type = (t && typeof t === 'object') ? t.objectType : t;
    return type === 'connector' || DEFAULT_CEILING.has(type);
  }
  // each entry is EITHER a bare objectType string (the generic caps: 'computer'/'dish'/…) OR a rich object
  // { objectType, … } carrying per-instance data — e.g. a connector portal's { objectType:'connector',
  // connectorId } so the manager can project THAT server's tools. Normalize both to a room object.
  // `floor` marks this as a ROUTED FLOOR ROOM (resolveTools ignores it): runOnce's capability note may then name the
  // room this dock's agent draws on (capability/cap-scope.js), after checking the saved floor reproduces these objects
  function roomStation(agentId, dockId, objs) {
    return {
      agents: { [agentId]: { id: agentId, room: 'bay' } },
      rooms: { bay: { id: 'bay', objects: objs.map((t, i) =>
        (t && typeof t === 'object') ? Object.assign({ instanceId: 'o' + i }, t) : { instanceId: 'o' + i, objectType: t }
      ) } },
      floor: { dockId }
    };
  }

  /* THE STANDING BRIEF (step editor, 2026-08-05): the Commander's job brief for the dock this agent crews,
     or null. PROMPT TEXT ONLY — it is injected into run prompts (hub entry runs, chain handoffs) and must
     never influence resolveTarget/chainNext (routing) or stationFor (capability). Same plan precedence as
     stationFor: a brief is a fact about the PLACED floor, true whether or not the belts compile — so it
     reads the capability view (stationPlan || plan || capsPlan), and a broken belt graph can't strip it. */
  /* SPLIT THE JOB (2026-10-10): the step whose output a dividing splitter cuts is told — on EVERY run at that dock, entry run
     or hand-off, the same way its brief rides — to end its reply with a numbered list of exactly n parts. Prompt text only;
     n (the splitter's crewed branches) is read off the deployable plan, the same one the chain runner divides by. */
  function stageBrief(agentId, dockId) {
    const base = standingBrief(agentId, dockId);
    if (savedProjection && !currentFloor.source.routingOk) return base;
    const p = activePlan(), d = (p && agentId) ? dockOf(agentId, dockId) : null;
    const n = d ? Pipeline.divideAfterDock(p, d) : 0;
    if (!n) return base;
    const add = Pipeline.divideBrief(n);
    return base ? base + '\n\n' + add : add;
  }
  function standingBrief(agentId, dockId) {
    const p = capabilityPlan();
    if (!p || !agentId) return null;
    // PER DOCK (multi-bay): the brief of the bay THIS run is at — writer@C is told bay C's job, never bay A's
    const want = dockOf(agentId, dockId);
    if (want) {
      const d = (p.dockBays || []).find(b => b.propId === want && b.agentId === agentId) || (p.bays || []).find(b => b.propId === want && b.agentId === agentId);
      if (d) { const s = typeof d.brief === 'string' ? d.brief.trim() : ''; return s ? s.slice(0, 2000) : null; }
    }
    // dockBays FIRST (2026-08-07): the brief now rides ONLY the legibility list, because `bays` is a hash input
    // and prompt text may not move the dispatch hash (a brief edit was re-posting the plan and wiping splitter
    // balance — see the pipeline.js note). `bays` stays as a fallback so a plan persisted by an older compile,
    // which carried the brief on both lists, still answers. dockBays ⊇ bays, so nothing is lost.
    const bay = (p.dockBays || []).find(b => b.agentId === agentId) || (p.bays || []).find(b => b.agentId === agentId);
    const b = bay && typeof bay.brief === 'string' ? bay.brief.trim() : '';
    return b ? b.slice(0, 2000) : null;
  }

  /* THE LINE BUDGET (2026-08-21): the normalized per-line limits the Commander set on this line's INBOX
     ({ maxHops, maxUsdPerMessage, maxUsdPerDay, clamped? }), or null = the executor's defaults. Read
     straight off the compiled plan (Pipeline.lineLimitsOf — never re-derived). Same precedence as the
     brief: a limit is a fact about the PLACED floor, true whether or not the belts compile. Policy only —
     it bounds how far/how much a line runs, never which agent runs (chainNext alone decides that). */
  function lineLimits(lineId) {
    const p = capabilityPlan();
    return p ? Pipeline.lineLimitsOf(p, lineId) : null;
  }

  /* THE CHAIN EDGE (agentic graphs): which agent does THIS dock's output hand off to? null = a terminal stage
     (its reply is the pipeline's answer) or no routing floor at all. Reads the same compiled plan and the same
     round-robin counters as resolveTarget, so a SPLIT downstream of a dock spreads exactly like one upstream —
     the crate the world draws and the run the sidecar buys are one decision. */
  function chainNext(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.chainNext(p, agentId, ctx || {}, pick);
  }
  // the DOCK readings of the chain edge (multi-bay): { dockId, agentId } nodes, same counters (see Pipeline)
  function chainNextDock(dockId, ctx) {
    const p = activePlan();
    if (!p || dockId == null) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.chainNextDock(p, String(dockId), ctx || {}, pick);
  }
  function chainStepDock(dockId, ctx) {
    const p = activePlan();
    if (!p || dockId == null) return null;
    return Pipeline.chainStepDock(p, String(dockId), ctx || {}, advancingPick());
  }
  function chainPeekDock(dockId, ctx) {
    const p = activePlan();
    if (!p || dockId == null) return null;
    const peek = (k, n) => (rr[k] || 0) % n; peek.peek = peek;
    return Pipeline.chainStepDock(p, String(dockId), ctx || {}, peek);
  }
  function fanSiblingsDock(dockId) {
    const p = activePlan();
    if (!p || dockId == null) return [];
    return Pipeline.fanSiblingsDock(p, String(dockId));
  }

  /* chainStep / fanSiblings (2026-08-21) — the JOINER + LOOP reading of the same plan, same pick counter, for the
     chain runner. chainNext above stays the plain single-dock reading every older surface uses. */
  function chainStep(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.chainStep) return null;
    return Pipeline.chainStep(p, agentId, ctx || {}, advancingPick());
  }
  /* chainPeek(agentId, ctx) -> what chainStep WOULD answer right now, WITHOUT moving any splitter's round-robin
     counter (2026-09-22, the step-through test's PREVIEW). It reads the counter where it stands, so on an
     unchanged floor the preview names the lane the next real chainStep takes. Read-only by construction. */
  function chainPeek(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.chainStep) return null;
    const peek = (k, n) => (rr[k] || 0) % n; peek.peek = peek;
    return Pipeline.chainStep(p, agentId, ctx || {}, peek);
  }
  /* loopGateAfter(agentId, lineId) -> { loop, when, max, backTo, backDock, onSpent? } when this dock's own lane meets a LOOP gate before any other
     dock (2026-08-22), else null. A PURE read of the same walk chainStep takes, on a no-op pick so the splitter
     round-robin never moves: the chain runner asks it BEFORE a hop, to tell a reviewer dock to end with the
     VERDICT line the gate will read. Prompt-shaping only — never a routing decision. `backTo` / `backDock` (2026-10-21):
     the agent and dock the gate's back lane re-enters (null: no back lane) — a gate that sends the work back into the
     reviewing dock itself (a self-loop) reviews no separate draft, so chain.js never tells that dock a bare approval
     passes the work on. */
  function loopGateAfter(agentId, lineId, dockId) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.chainStep) return null;
    const d = dockOf(agentId, dockId);
    const ctx = { lineId: lineId != null ? lineId : lineOfAgent(agentId, d), tag: 'general', dockId: d || undefined };
    const st = Pipeline.chainStep(p, agentId, ctx, () => 0);
    if (!(st && st.loop)) return null;
    // the same walk read at the DOCK (Pipeline.chainStep is stepToAgents of it), so the back lane's bay is known too
    const sd = Pipeline.chainStepDock ? Pipeline.chainStepDock(p, Pipeline.dockOf(p, agentId, ctx.dockId), ctx, () => 0) : null;
    const back = (sd && sd.loop) ? sd.backTo : null;
    const gate = { loop: st.loop, when: st.when || null, max: st.max, backTo: st.backTo || null, backDock: (back && back.dockId != null) ? String(back.dockId) : null };
    if (st.onSpent) gate.onSpent = st.onSpent;   // (line-hold lane S2, only when the gate sets one) what it does when its passes run out: 'hold' | 'escalate'
    return gate;
  }
  function fanSiblings(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.fanSiblings) return [];
    return Pipeline.fanSiblings(p, agentId, ctx && ctx.dockId);
  }

  // A clean model run is not necessarily a shipped work line. This reports whether the final dock's compiled
  // outbound lane actually reaches OUTBOX rather than terminating at an open belt end.
  function chainShipsToOutbox(agentId, dockId) {
    const p = activePlan();
    if (!p) return false;
    // per DOCK when one is named (multi-bay: the writer's FIRST bay feeds the editor, its last one ships out)
    if (dockId != null && String(dockId) && Pipeline.agentOfDock(p, dockId)) {
      const dr = Pipeline.dockLayer(p).dockChains[String(dockId)];
      return !!(dr && dr.outbox && !dr.deadEnd);
    }
    const rec = p.chains && p.chains[agentId];
    return !!(rec && rec.outbox && !rec.deadEnd);
  }

  const api = { setPlan, clearPlan, getPlan, hasPlan, setStation, clearStation, getStation, resolveTarget, lineOfAgent, lineOriginFor, intakeReceiptFor, lineLimits, chainNext, chainStep, chainPeek, fanSiblings, loopGateAfter, chainShipsToOutbox, stationFor, stageBrief,
    // the DOCK key (multi-bay agents, 2026-09-22)
    resolveDock, dockOf, dockRef, entryDockOf, docksOf, agentOfDock, lineOfDock, chainNextDock, chainStepDock, chainPeekDock, fanSiblingsDock };
  if (savedProjection) for (const name of Object.keys(api)) api[name] = withSavedFloor(name, api[name]);
  return api;
}

module.exports = { makeRouter };
