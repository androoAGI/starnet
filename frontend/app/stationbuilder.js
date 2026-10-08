/* StationBuilder — the lead agent builds a room and a ready-made line EXACTLY (2026-09-29, the Agent Station Builder plan).

   WHY IT IS SHAPED THIS WAY: models are bad at spatial layout, and a weak one laying belts by hand would break a
   Commander's station. So the model never sends a position, a belt or a piece of furniture. It fills a FIXED MENU —
   one of the Lines shelf's tested lines, where it goes, a name, what each step does and who works it, a daily spending
   cap, review tries — and StarNet does all the placing with the same code Build mode uses (roomSpots, stampBlueprint).

   plan(doc, request, env) builds the request on a PROBE COPY and checks it: every new machine reachable, no new routing
   error anywhere, every existing line's compiled routing unchanged. It returns a plain summary and the new line's
   readiness (WorkflowLine.readiness — the Workflow panel's own blocking list). It never touches the live station.
   apply(station, plan, env) replays EXACTLY those edits on the live station inside ONE transact (one undo slot,
   all-or-nothing): it refuses when the floor changed since the plan, and undoes itself if the result differs from the
   plan by a single tile. Add-only: nothing already on the station can be moved, changed or removed.

   env = { WorldModel, Pipeline, WorkflowLine, crew: [{ id, name }], heroId }. Pure: no DOM, no clock, no globals. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StationBuilder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MENU = ['line', 'shape', 'purpose', 'where', 'beside', 'side', 'hallway', 'name', 'steps', 'dailyCap', 'tries'];
  const STEP_KEYS = ['step', 'role', 'instructions', 'agent'];
  const LEAD_WORDS = { lead: 1, me: 1, you: 1, yourself: 1, overseer: 1, hero: 1 };
  // "recruit someone for this step": the build summons that role's specialist (Build's own summonForRole) and seats it
  const NEW_WORDS = { new: 1, recruit: 1, 'new agent': 1, 'a new one': 1, 'new recruit': 1, 'someone new': 1, 'a new agent': 1 };
  const MIN_W = 12, MIN_H = 7, MAX_TRIES_IN_ROOM = 600;
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const clone = o => JSON.parse(JSON.stringify(o));
  const refuse = (error, extra) => Object.assign({ ok: false, error }, extra || {});
  const titleCase = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  /* a floor fingerprint over what an edit can change (never meta or derived links), in CANONICAL form: object keys
     sorted, because a live prop that gained agentId after role and the same prop read back from a save (migrate
     normalizes key order) are the same floor */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function sigOf(doc) {
    // doc.links: the authored links (conveyor links phase B) — a link-only edit is a floor change too
    const s = canon([doc._nid, doc.order, doc.rooms, doc.props, doc.belts, doc.edges || [], doc.links == null ? null : doc.links]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16) + ':' + s.length;
  }

  // the card's drawing of a plan (planpreview.js): every room (those the plan adds or changes marked), what it adds, its new belts
  const MACHINE_T = /^(intake|bay|outbox|filter|merger|splitter|joiner|loop)$/;
  /* ON A ROOM BY FOOTPRINT (sweep 2026-10-02): WorldModel.removeRoom drops every piece whose footprint TOUCHES the room,
     not only the ones whose top-left tile is on it. Judged by the top-left tile, a desk or an outbox reaching one tile
     into a hallway passed the re-lay's guard, went uncounted on the card ("furniture, lines, desks and agents stay as
     they are") — and was deleted. Every count and guard of what a removal takes uses this. */
  const touchesRoom = (p, room) => !!room && (room.rects || []).some(r => p.x <= r.x2 && p.x + (p.w || 1) - 1 >= r.x1 && p.y <= r.y2 && p.y + (p.h || 1) - 1 >= r.y1);
  const AISLE = 3;   // clear tiles between two lines that share a room, every way (a walkway, and room for each line's plate)
  function previewOf(WM, before, after, zones, markRoomId) {
    const was = new Set(before.order || []), wasProps = new Set((before.props || []).map(p => p.id)), wasBelts = before.belts || {};
    return {
      rooms: (after.order || []).map(id => { const rm = after.rooms[id]; return { rects: rm.rects, mine: !was.has(id) || id === markRoomId, corridor: rm.kind === 'corridor', plank: rm.floorMat === 'plank' }; }),
      props: (after.props || []).filter(p => !wasProps.has(p.id)).map(p => ({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, cap: !!(WM.capForProp && WM.capForProp(p.t)), machine: MACHINE_T.test(p.t) })),
      belts: Object.keys(after.belts || {}).filter(k => !wasBelts[k]).map(k => { const [x, y] = k.split(',').map(Number); return { x, y }; }),
      zones: zones || []
    };
  }

  /* THE MENU, read from the shelf catalog (WorldModel.BLUEPRINTS) — never hand-kept here, so a new shelf line is a new
     choice and a removed one can never be built. */
  function catalog(WM) {
    return (WM.BLUEPRINTS || []).map(bp => ({
      id: bp.id, name: bp.plain || bp.label, label: bp.label, work: bp.work || null,
      roles: bp.props.filter(p => p.t === 'bay').map(p => p.role || 'STEP'),
      reviewLoop: bp.props.some(p => p.t === 'loop'), inbox: bp.props.some(p => p.t === 'intake')
    }));
  }
  function resolveLine(WM, raw) {
    const n = norm(raw);
    if (!n) return null;
    return (WM.BLUEPRINTS || []).find(bp => norm(bp.id) === n || norm(bp.plain) === n || norm(bp.label) === n) || null;
  }
  const lineList = WM => catalog(WM).map(l => l.id + ' (' + l.name + ')').join(', ');

  // the Commander's existing crew, by id or name; "lead"/"me"/"you" is the lead
  function agentOf(env, raw) {
    const n = norm(raw), crew = (env.crew || []).filter(a => a && a.id);
    if (!n) return { ok: true, id: '' };
    if (LEAD_WORDS[n] && env.heroId) return { ok: true, id: env.heroId };
    if (NEW_WORDS[n]) return env.canRecruit ? { ok: true, id: '', recruit: true } : refuse('Recruiting is not available on this page. Staff the step with a crew member, or leave agent empty.');
    const hit = crew.filter(a => norm(a.id) === n || norm(a.name) === n);
    if (hit.length === 1) return { ok: true, id: hit[0].id };
    return refuse((hit.length ? 'More than one crew member matches "' : 'Nobody on the crew is called "') + String(raw).slice(0, 40) + '".'
      + ' Leave agent empty to staff it later, say "new" to recruit a specialist for it, or use one of: ' + (crew.map(a => a.name || a.id).join(', ') || 'no crew yet') + '.');
  }
  const nameOf = (env, id) => { const a = (env.crew || []).find(x => x && x.id === id); return a ? (a.name || a.id) : id; };

  /* what the floor routes, so a build can prove it changed no existing line. The routing plan speaks in the geometry's
     LOCAL tiles (counted from the station's top-left corner), and a room added north or west of everything moves that
     corner: so every tile here is put back into WORLD tiles, or such a room would read as "every line re-routed". */
  function floorFacts(st, P) {
    const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo), L = P.dockLayer ? P.dockLayer(plan) : {};
    const ox = (geo.origin && geo.origin.tx) || 0, oy = (geo.origin && geo.origin.ty) || 0;
    const world = t => (t && isFinite(t.x) && isFinite(t.y)) ? { x: t.x + ox, y: t.y + oy } : t;
    const errs = new Set((plan.errors || []).filter(e => e && !e.warn).map(e => { const t = world(e.tile); return e.code + ':' + (e.propId || '') + ':' + (t ? t.x + ',' + t.y : ''); }));
    const chains = {}, raw = L.dockChains || {};
    for (const d in raw) chains[d] = raw[d] && raw[d].tile ? Object.assign({}, raw[d], { tile: world(raw[d].tile) }) : raw[d];
    return { geo, plan, errs, chains, reach: L.reachDock || plan.reachDock || {} };
  }
  // where a walk starts: the walkable tile nearest the middle of the spawn room (a desk may stand on the middle itself)
  function spawnTile(doc, g) {
    const rm = doc.rooms[doc.meta && doc.meta.spawnRoomId] || doc.rooms[doc.order[0]];
    const r = rm && rm.rects && rm.rects[0];
    if (!r) return null;
    const cx = (r.x1 + r.x2) >> 1, cy = (r.y1 + r.y2) >> 1;
    let best = null, bd = Infinity;
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bd && g.walkable(x - g.origin.tx, y - g.origin.ty)) { bd = d; best = { x, y }; }
    }
    return best;
  }

  /* one placement, tried on its own probe: the room (when new) + the stamped line. It passes only when every new solid
     machine can be walked up to, no NEW routing error appears anywhere, and every existing dock routes exactly as before. */
  function tryPlacement(doc, bp, spec, env, before) {
    const WM = env.WorldModel, P = env.Pipeline;
    const probe = WM.create(clone(doc));
    const b = buildInto(probe, Object.assign({}, spec, { steps: [] }), WM);
    if (!b.ok) return b;
    const after = floorFacts(probe, P), g = after.geo;
    for (const e of after.errs) if (!before.errs.has(e)) return refuse('that spot would add a routing problem (' + e.split(':')[0] + ')');
    for (const dock in before.chains) if (JSON.stringify(before.chains[dock]) !== JSON.stringify(after.chains[dock])) return refuse('that spot would change how an existing line routes');
    for (const dock in before.reach) if (!!before.reach[dock] !== !!after.reach[dock]) return refuse('that spot would change which existing steps the Inbox reaches');
    const o = spawnTile(probe.serialize(), g);
    if (o) for (const pid of b.ids) {
      const p = probe.propById(pid);
      if (!p || p.block === false) continue;
      if (!g.path(o.x - g.origin.tx, o.y - g.origin.ty, p.x - g.origin.tx, p.y + p.h - g.origin.ty)) return refuse('a machine there could not be walked up to');
    }
    return { ok: true, probe, ids: b.ids };
  }

  /* the ONE edit list, run on a probe by plan() and on the live station by apply(). Three plan kinds:
     a LINE (spec.bpId: the new room if any, the stamped line, its name, each step's instructions and agent), ROOMS
     (spec.parts: each a room kit — a new room or an existing one, its furniture, its own line), and a RESTYLE (one
     room's floor, material or name). Every setter's answer is checked; one failure fails the whole edit. */
  function buildInto(st, spec, WM) {
    if (spec && spec.kind === 'restyle') return restyleInto(st, spec);
    if (spec && spec.kind === 'edit') return editInto(st, spec);
    if (spec && spec.kind === 'build') return buildParts(st, spec, WM);
    if (spec && spec.kind === 'swap') { const r = st.replaceLayout(spec.layout); return r && r.ok ? { ok: true, ids: [] } : refuse('the preset could not be applied' + (r && r.msg ? ' (' + r.msg + ')' : '')); }
    // a whole new layout: the station cleared to its main room exactly as the plan did it, then the layout built on it
    if (spec && spec.kind === 'relayout') {
      const r = st.replaceLayout(clone(spec.stripped));
      if (!r || !r.ok) return refuse('the station could not be cleared for the new layout' + (r && r.msg ? ' (' + r.msg + ')' : ''));
      const b = buildParts(st, spec.build, WM);
      if (!b.ok) return b;
      for (const m of spec.moves || []) { const mv = st.moveProp(m.id, m.dx, m.dy); if (!mv || !mv.ok) return refuse('a desk could not be moved to its new room'); }
      return b;
    }
    if (spec && spec.kind === 'rooms') {
      const ids = [], parts = [];
      for (const part of spec.parts || []) { const r = buildKit(st, part, WM); if (!r.ok) return r; ids.push(...r.ids); parts.push(r); }
      return { ok: true, ids, parts };
    }
    return buildLine(st, spec, WM);
  }
  // a hallway's corridor deck and its planters and lights (a grid room's hallway, as a layout's)
  function trimHall(st, hallId, spec) {
    if (!hallId || (!spec.hallDeck && !(spec.hallProps || []).length)) return { ok: true };
    if (spec.hallDeck) { const d = st.setDeck(hallId, spec.hallDeck); if (!d || !d.ok) return refuse('the hallway floor could not be laid'); }
    for (const p of spec.hallProps || []) { const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) return refuse('the hallway could not be dressed'); }
    return { ok: true };
  }
  // a part's second hallway, laid first: the stretch a concourse's spine is lengthened by, deck and planters too
  function layHall2(st, spec) {
    if (!spec.hall2) return { ok: true };
    const h = st.placeHallway({ rect: spec.hall2 }); if (!h || !h.ok) return refuse('the concourse could not be lengthened' + (h && h.msg ? ' (' + h.msg + ')' : ''));
    if (spec.hall2Deck) { const d = st.setDeck(h.id, spec.hall2Deck); if (!d || !d.ok) return refuse('the concourse floor could not be laid'); }
    for (const p of spec.hall2Props || []) { const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) return refuse('the concourse could not be dressed'); }
    return { ok: true };
  }
  function buildKit(st, part, WM) {
    const ids = [];
    let roomId = part.roomId || null, hallId = null;
    const h2 = layHall2(st, part); if (!h2.ok) return h2;
    if (part.hall) { const h = st.placeHallway({ rect: part.hall }); if (!h || !h.ok) return refuse('the hallway could not be laid there' + (h && h.msg ? ' (' + h.msg + ')' : '')); hallId = h.id; }
    if (part.room) {
      const before = new Set(st.rooms().map(r => r.id));
      const r = st.addRoom({ kind: part.room.kind, name: part.room.name, floorStyle: part.room.floorStyle, floorMat: part.room.floorMat, rect: part.room.rect });
      if (!r || !r.ok) return refuse('the room could not be added there' + (r && r.msg ? ' (' + r.msg + ')' : ''));
      roomId = (st.rooms().find(x => !before.has(x.id)) || {}).id || null;
    }
    for (const p of part.props || []) {
      const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block });
      if (!r || !r.ok) return refuse('a piece of furniture could not be placed there' + (r && r.msg ? ' (' + r.msg + ')' : ''));
      ids.push(r.id);
    }
    let line = null;
    if (part.line) {
      line = buildLine(st, Object.assign({}, part.line, { room: null }), WM);
      if (!line.ok) return line;
      ids.push(...line.ids);
    }
    const th = trimHall(st, hallId, part); if (!th.ok) return th;
    return { ok: true, ids, roomId, lineIds: line ? line.ids : [], intakeId: line ? line.intakeId : null };
  }
  /* an edit of what stands, in a fixed order: furniture out, rooms out (everything on them goes with them), the agents
     whose seats stood there seated again, then a refurnished room's floor, walls, name and furniture */
  function editInto(st, spec) {
    for (const id of spec.removeProps || []) { const r = st.removeProp(id); if (!r || !r.ok) return refuse('a piece of furniture could not be removed'); }
    if ((spec.removeBelts || []).length) { const r = st.removeBelts(spec.removeBelts); if (!r || !r.ok) return refuse('a line\'s belts could not be removed'); }
    for (const id of spec.removeRooms || []) { const r = st.removeRoom(id); if (!r || !r.ok) return refuse('a room could not be removed' + (r && r.msg ? ' (' + r.msg + ')' : '')); }
    if (spec.moveRoom) { const m = spec.moveRoom, r = st.moveRoom(m.id, m.dx, m.dy); if (!r || !r.ok) return refuse('the room could not be moved there' + (r && r.msg ? ' (' + r.msg + ')' : '')); }
    if (spec.newHall) {
      const h = st.placeHallway({ rect: spec.newHall.rect }); if (!h || !h.ok) return refuse('the new hallway could not be laid' + (h && h.msg ? ' (' + h.msg + ')' : ''));
      if (spec.newHall.deck) { const d = st.setDeck(h.id, spec.newHall.deck); if (!d || !d.ok) return refuse('the hallway floor could not be laid'); }
      for (const p of spec.newHall.props || []) { const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) return refuse('the hallway could not be dressed'); }
    }
    for (const s of spec.reseat || []) {
      const d = s.desk, a = st.addProp({ t: d.t, x: d.x, y: d.y, w: d.w, h: d.h, r: 0, block: true });
      if (!a || !a.ok) return refuse('an agent\'s new desk could not be placed');
      const g = st.assignPropAgent(a.id, s.agentId); if (!g || !g.ok) return refuse('an agent could not be given its new desk');
    }
    const rs = spec.restyle;
    if (rs) {
      if (rs.deck) { const r = st.setDeck(rs.roomId, rs.deck); if (!r || !r.ok) return refuse('the floor could not be laid'); }
      if (rs.walls) { const r = st.setWalls(rs.roomId, rs.walls); if (!r || !r.ok) return refuse('the walls could not be put up'); }
      if (rs.name) { const r = st.renameRoom(rs.roomId, rs.name); if (!r || !r.ok) return refuse('the room could not be renamed'); }
    }
    for (const p of spec.props || []) { const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) return refuse('a piece of furniture could not be placed'); }
    for (const a of spec.assign || []) { const r = st.assignPropAgent(a.id, a.agentId || ''); if (!r || !r.ok) return refuse('a step\'s agent could not be set'); }
    for (const b of spec.briefs || []) { const r = st.setPropBrief(b.id, b.brief); if (!r || !r.ok) return refuse('a step\'s instructions could not be saved'); }
    return { ok: true, ids: [] };
  }
  function restyleInto(st, spec) {
    if (spec.floorStyle) { const r = st.setFloor(spec.roomId, spec.floorStyle); if (!r || !r.ok) return refuse('the floor could not be changed'); }
    if (spec.floorMat) { const r = st.setMaterial(spec.roomId, spec.floorMat); if (!r || !r.ok) return refuse('the floor material could not be changed'); }
    if (spec.name) { const r = st.renameRoom(spec.roomId, spec.name); if (!r || !r.ok) return refuse('the room could not be renamed'); }
    return { ok: true, ids: [] };
  }
  function buildLine(st, spec, WM) {
    const bp = (WM.BLUEPRINTS || []).find(x => x.id === spec.bpId);
    if (!bp) return refuse('unknown line');
    let hallId = null;
    const h2 = layHall2(st, spec); if (!h2.ok) return h2;
    if (spec.hall) { const h = st.placeHallway({ rect: spec.hall }); if (!h || !h.ok) return refuse('the hallway could not be laid there' + (h && h.msg ? ' (' + h.msg + ')' : '')); hallId = h.id; }
    if (spec.room) {
      const r = st.addRoom({ kind: spec.room.kind, name: spec.room.name, rect: spec.room.rect });
      if (!r || !r.ok) return refuse('the room could not be added there' + (r && r.msg ? ' (' + r.msg + ')' : ''));
    }
    const s = st.stampBlueprint(bp.id, spec.ox, spec.oy, spec.opts || {});
    if (!s || !s.ok) return refuse('the line could not be placed there' + (s && s.msg ? ' (' + s.msg + ')' : ''));
    for (const d of spec.desks || []) { const r = st.addProp({ t: d.t, x: d.x, y: d.y, w: d.w, h: d.h, r: 0, block: true }); if (!r || !r.ok) return refuse('a desk could not be placed by the line'); }
    let intakeId = null;
    for (let i = 0; i < s.ids.length; i++) if (bp.props[i].t === 'intake') {
      intakeId = intakeId || s.ids[i];
      if (spec.label) { const r = st.setPropLabel(s.ids[i], spec.label); if (!r || !r.ok) return refuse('the line could not be named'); }
    }
    for (const step of (spec.steps || [])) {
      const pid = s.ids[step.propIndex];
      if (!pid) return refuse('a step is missing');
      if (step.brief) { const r = st.setPropBrief(pid, step.brief); if (!r || !r.ok) return refuse('a step\'s instructions could not be saved'); }
      if (step.agentId) { const r = st.assignPropAgent(pid, step.agentId); if (!r || !r.ok) return refuse('a step\'s agent could not be assigned'); }
    }
    const th = trimHall(st, hallId, spec); if (!th.ok) return th;
    return { ok: true, ids: s.ids, intakeId };
  }

  // the new line as the Workflow panel reads it: its steps in run order, and WorkflowLine.readiness
  function readLine(st, ids, env, crewIds) {
    const P = env.Pipeline, W = env.WorkflowLine;
    const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo);
    const mine = new Set(ids);
    const comp = P.lineComponents(geo).find(c => (c.props || []).some(pid => mine.has(pid)) || c.bays.some(b => mine.has(b.propId)));
    if (!comp) return { comp: null, order: [], ready: false, blocking: ['the line is not connected'] };
    const flow = W.lineFlow(plan, comp, P, geo.props);
    const r = W.readiness(flow, comp, { errors: plan.errors, hasCompute: (aid, pid) => st.bayObjects(aid, pid).indexOf('computer') >= 0,
      isCrew: aid => !crewIds || !crewIds.length || crewIds.indexOf(aid) >= 0 });
    // the run columns as the Workflow panel groups them: one step, several at once (all), one of them (oneof / turns)
    const cols = (flow.cols || []).map(c => ({ mode: c.mode, docks: (c.docks || []).map(d => d.propId).filter(pid => mine.has(pid)) })).filter(c => c.docks.length);
    return { comp, order: flow.order.filter(pid => mine.has(pid)), cols, ready: r.ready, blocking: r.blocking.map(b => b.what) };
  }

  /* the steps as they RUN: "A → B" in sequence, "A + B (at once)" for a fan-out, "A or B" where a sorter or a splitter
     sends each job to one of them — never a sequence that is really a choice */
  function flowText(cols, runOrder, stepsView) {
    const view = pid => { const x = stepsView[runOrder.indexOf(pid)]; return x ? x.role + ' (' + (x.agent || 'nobody yet') + ')' : '?'; };
    if (!cols || !cols.length) return stepsView.map(x => x.role + ' (' + (x.agent || 'nobody yet') + ')').join(' → ');
    return cols.map(c => c.docks.length === 1 ? view(c.docks[0]) : c.mode === 'all' ? c.docks.map(view).join(' + ') + ' (at once)' : c.docks.map(view).join(' or ')).join(' → ');
  }

  // a steps list the model sent ({ step | role, instructions, agent }), checked before any placement work
  function stepsListOk(reqSteps) {
    if (!Array.isArray(reqSteps)) return refuse('steps must be a list like [{ "step": 1, "instructions": "…", "agent": "NOVA" }].');
    for (const s of reqSteps) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return refuse('each step must be an object with: ' + STEP_KEYS.join(', ') + '.');
      const bad = Object.keys(s).filter(k => STEP_KEYS.indexOf(k) < 0);
      if (bad.length) return refuse('A step only takes: ' + STEP_KEYS.join(', ') + '. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
      if (s.instructions != null && typeof s.instructions !== 'string') return refuse('a step\'s instructions must be text.');
      if (s.agent != null && typeof s.agent !== 'string') return refuse('a step\'s agent must be a crew member\'s name or id.');
    }
    return { ok: true };
  }
  /* the line's steps in run order ({ step, role, brief, agentId }), told who works them and what to do: by step number or
     a unique role; "new" marks a recruit. A step left without instructions gets its role's standard ones (the Workflow
     panel's first starter chip), carrying the Commander's purpose when there is one. */
  function staffSteps(stepsOut, reqSteps, env, purpose) {
    const used = {};
    for (const s of reqSteps) {
      let hit = null;
      if (s.step != null) {
        const n = Number(s.step);
        hit = Number.isInteger(n) ? stepsOut[n - 1] : null;
        if (!hit) return refuse('This line has steps 1 to ' + stepsOut.length + ': ' + stepsOut.map(x => x.step + ' ' + titleCase(x.role)).join(', ') + '.');
      } else if (s.role != null) {
        const m = stepsOut.filter(x => norm(x.role) === norm(s.role));
        if (m.length !== 1) return refuse((m.length ? 'This line has more than one ' + titleCase(s.role) + ' step: use "step" instead.' : 'This line has no ' + String(s.role).slice(0, 30) + ' step.')
          + ' Its steps are: ' + stepsOut.map(x => x.step + ' ' + titleCase(x.role)).join(', ') + '.');
        hit = m[0];
      } else return refuse('Each step needs "step" (a number) or "role". Its steps are: ' + stepsOut.map(x => x.step + ' ' + titleCase(x.role)).join(', ') + '.');
      if (used[hit.step]) return refuse('Step ' + hit.step + ' was given twice.');
      used[hit.step] = 1;
      if (s.instructions != null) hit.brief = String(s.instructions).trim().slice(0, 2000);
      if (s.agent != null) { const a = agentOf(env, s.agent); if (!a.ok) return a; hit.agentId = a.id; hit.recruit = !!a.recruit; }
    }
    for (const x of stepsOut) if (!x.brief) {
      const st = env.WorkflowLine.starters ? env.WorkflowLine.starters(x.role) : [];
      x.brief = ((st[0] && st[0].does) || '') + (purpose ? ' This line is for: "' + purpose + '".' : '');
    }
    return { ok: true };
  }

  function plan(doc, req, env) {
    const WM = env && env.WorldModel, P = env && env.Pipeline, W = env && env.WorkflowLine;
    if (!WM || !P || !W || !doc) return refuse('the station builder is not loaded on this page');
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse('Send the request as an object with: ' + MENU.join(', ') + '.');
    const extra = Object.keys(req).filter(k => MENU.indexOf(k) < 0);
    if (extra.length) return refuse('StarNet chooses every position, belt and piece of furniture itself, so these fields are not accepted: '
      + extra.slice(0, 8).join(', ') + '. Use only: ' + MENU.join(', ') + '.');
    /* NOWHERE NAMED: a line goes into the station's conveyor hall when one has room for it (that is what the hall is for),
       and only then into a room of its own on the grid */
    if (req.where == null && req.beside == null && req.side == null && req.hallway == null) {
      let halls = [];
      try { halls = worksHalls(WM.create(clone(doc))); } catch (_) { halls = []; }
      for (const h of halls) { const r = plan(doc, Object.assign({}, req, { where: h.name }), env); if (r.ok) return r; }
    }
    /* a CUSTOM line the Commander described (a SHAPE of steps: in order, at once, taking turns, sorted, reviewed): the whole
       of a room of its own, or of an existing room around what stands there, laid out by the layout engine through the
       same planner as a designed room's line zone */
    if (req.shape != null) {
      if (req.line != null) return refuse('Give a line from the menu or a shape of its own, not both.');
      const into = req.where != null && !/^(a )?new( room)?$/i.test(String(req.where).trim());
      const zone = { area: 'whole', shape: req.shape, staff: req.steps == null ? [] : req.steps };
      for (const k of ['name', 'purpose', 'dailyCap', 'tries']) if (req[k] !== undefined) zone[k] = req[k];
      const d = { zones: [zone] };
      if (req.where != null) d.where = req.where;
      if (!into && typeof req.name === 'string') d.name = req.name;
      const r = planDesign(doc, d, env);
      if (!r.ok) return r;
      const l = r.plan.lines[0] || {};
      return { ok: true, plan: Object.assign(r.plan, { line: { id: null, name: l.plain || 'a custom line', label: l.label || null }, ready: !!l.ready, blocking: l.blocking || [] }) };
    }
    // purpose: the Commander's own words. With no line named, StarNet picks one with the reader behind FOR YOUR GOAL
    // (WorkflowLine.suggestLineFor: the SHAPE of the work), and every step's standard instructions carry those words
    if (req.purpose != null && typeof req.purpose !== 'string') return refuse('purpose is the Commander\'s own words for what the line is for, as text.');
    const purpose = typeof req.purpose === 'string' ? req.purpose.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    let bp = resolveLine(WM, req.line), picked = null;
    const lines = { lines: catalog(WM).map(l => ({ id: l.id, name: l.name, roles: l.roles })) };
    if (!bp && req.line == null && purpose) {
      const s = W.suggestLineFor ? W.suggestLineFor(purpose) : null;
      bp = s ? resolveLine(WM, s.id) : null;
      if (!bp) return refuse('StarNet picks a line from the shape of the work (research then writing, a draft and a reviewer, code with tests or a review, two takes to compare), and "'
        + purpose.slice(0, 80) + '" names no such shape. Choose a line: ' + lineList(WM) + '.', lines);
      picked = s.why;
    }
    if (!bp) return refuse((req.line ? 'There is no line called "' + String(req.line).slice(0, 60) + '".' : 'Choose a line, or give its purpose in the Commander\'s words.') + ' The lines are: ' + lineList(WM) + '.', lines);
    const plain = bp.plain || bp.label;
    const label = (typeof req.name === 'string' ? req.name : '').replace(/\s+/g, ' ').trim().slice(0, 48) || plain.toUpperCase();
    const notes = [];

    // daily cap: undefined keeps the line's own, null/"none"/0 is no cap, a positive dollar amount caps it
    const hasIntake = bp.props.some(p => p.t === 'intake'), hasLoop = bp.props.some(p => p.t === 'loop');
    const opts = {};
    if (req.dailyCap !== undefined) {
      if (!hasIntake) notes.push('this line has no Inbox, so dailyCap was ignored');
      else if (req.dailyCap === null || req.dailyCap === 0 || /^(none|no cap|off|0)$/i.test(String(req.dailyCap).trim())) opts.limits = { maxUsdPerDay: null };
      else {
        const n = Number(String(req.dailyCap).replace(/[$,\s]/g, ''));
        if (!isFinite(n) || n <= 0 || n > 10000) return refuse('dailyCap must be a dollar amount above 0 (up to 10000), or null for no cap.');
        opts.limits = { maxUsdPerDay: Math.round(n * 100) / 100 };
      }
    }
    if (req.tries !== undefined && req.tries !== null) {
      if (!hasLoop) notes.push('this line has no review loop, so tries was ignored');
      else {
        const n = Number(req.tries);
        if (!Number.isInteger(n) || n < 1 || n > 5) return refuse('tries must be a whole number from 1 to 5.');
        opts.maxIter = n;
      }
    }

    // where: a new room (default), or an existing room by name where the line fits on clear floor
    const live = WM.create(clone(doc));
    const rooms = live.rooms().filter(r => r.kind !== 'corridor');
    const whereRaw = req.where == null ? '' : String(req.where).trim();
    let target = null;
    if (whereRaw && !/^(a )?new( room)?$/i.test(whereRaw)) {
      const m = rooms.filter(r => norm(r.name) === norm(whereRaw));
      if (m.length !== 1) return refuse((m.length ? 'More than one room is called "' + whereRaw.slice(0, 40) + '".' : 'There is no room called "' + whereRaw.slice(0, 40) + '".')
        + ' Use "new room", or one of: ' + rooms.map(r => r.name).join(', ') + '.');
      target = m[0];
    }

    // steps: validated against the crew BEFORE any placement work
    const reqSteps = req.steps == null ? [] : req.steps;
    const sl = stepsListOk(reqSteps); if (!sl.ok) return sl;

    // placement: StarNet's own choice, first one that passes every check
    const before = floorFacts(live, P);
    const base = { bpId: bp.id, opts, label: hasIntake ? label : '' };
    let placed = null, spec = null;
    if (!target) {
      // a room of its own: beside the asked room (the main room by default), on the asked side or the one that keeps the
      // station compact, joined by a hallway (the spatial builder's own placement)
      const tq = req.beside != null ? roomNamed(live, req.beside) : { ok: true, room: null }; if (!tq.ok) return tq;
      const sd = sideOf(req.side); if (!sd.ok) return sd;
      const hl = hallOf(req.hallway); if (!hl.ok) return hl;
      let none = null;
      for (const m of [1, 2]) {
        const Wd = Math.max(bp.w + 2 * m, MIN_W), Hd = Math.max(bp.h + 2 * m, MIN_H);
        const grid = req.beside == null && req.side == null && req.hallway == null ? gridSpots(WM, live, Wd, Hd, hangsOf(env)) : [];
        const pl = roomPlacements(live, tq.room, Wd, Hd, { side: sd.side, len: hl.len, align: null, kind: 'hab', hangs: hangsOf(env) });
        if (!pl.ok && !grid.length) { none = none || pl; continue; }
        for (const cand of grid.concat(pl.ok ? pl.list : [])) {
          const rect = cand.rect, rw = rect.x2 - rect.x1 + 1, rh = rect.y2 - rect.y1 + 1;
          const s = Object.assign({}, base, { hall: cand.hall, placed: { side: cand.side, target: cand.target, len: cand.len }, room: { kind: 'hab', name: label.toUpperCase().slice(0, 24), rect },
            ox: rect.x1 + ((rw - bp.w) >> 1), oy: rect.y1 + ((rh - bp.h) >> 1) }, gridHallTrim(WM, env, live, cand, 'hab'));
          const t = tryPlacement(doc, bp, s, env, before);
          if (t.ok) { placed = t; spec = s; break; }
        }
        if (placed) break;
      }
      if (!placed) return none || refuse('There is no clear space ' + (tq.room ? 'beside ' + tq.room.name : 'beside the station') + ' for a room that fits ' + plain + '. Try another side or another room (station.map shows what is free).');
    } else {
      if (['beside', 'side', 'hallway'].some(k => req[k] != null)) return refuse('beside, side and hallway place a NEW room; with where naming ' + target.name + ', leave them out.');
      let tries = 0;
      // every machine and belt must stand inside THIS room: a stamp that fits the floor can still run through a doorway
      // into the next room, and "in the HOME room" would then be a lie
      const inRoom = (x, y) => target.rects.some(q => x >= q.x1 && x <= q.x2 && y >= q.y1 && y <= q.y2);
      const staysInside = (ox, oy) => bp.props.every(p => { for (let yy = 0; yy < p.h; yy++) for (let xx = 0; xx < p.w; xx++) if (!inRoom(ox + p.x + xx, oy + p.y + yy)) return false; return true; })
        && bp.belts.every(b => inRoom(ox + b.x, oy + b.y));
      /* TIDY first: a tile in from the walls, off the doorways' landings and AISLE clear of every line already there — at
         the first such spot in reading order when the room has lines or is a hall (so it fills in rows), else as near the
         middle of a small empty room as it goes; then, failing that, the first spot that fits at all */
      const inset = (x, y) => target.rects.some(q => x > q.x1 && x < q.x2 && y > q.y1 && y < q.y2);
      const aisle = aisleTiles(live, target.id), land = landingTiles(live, live.projectGeometry(), target.id);
      const tidy = (ox, oy) => bp.props.every(p => { for (let yy = 0; yy < p.h; yy++) for (let xx = 0; xx < p.w; xx++) { const x = ox + p.x + xx, y = oy + p.y + yy; if (!inset(x, y) || aisle.has(x + ',' + y) || land.has(x + ',' + y)) return false; } return true; })
        && bp.belts.every(b => { const x = ox + b.x, y = oy + b.y; return inset(x, y) && !aisle.has(x + ',' + y) && !land.has(x + ',' + y); });
      const spots = [];
      for (const r of target.rects) for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) spots.push([x, y]);
      const R0 = target.rects[0], shelved = roomHasLines(live, target.id) || target.rects.length > 1 || isHallSized(R0);
      const mid = [(R0.x1 + R0.x2 + 1 - bp.w) / 2, (R0.y1 + R0.y2 + 1 - bp.h) / 2];
      const tidySpots = spots.filter(([x, y]) => tidy(x, y));
      if (!shelved) tidySpots.sort((p, q) => (Math.abs(p[0] - mid[0]) + Math.abs(p[1] - mid[1])) - (Math.abs(q[0] - mid[0]) + Math.abs(q[1] - mid[1])) || p[1] - q[1] || p[0] - q[0]);
      outer: for (const pass of [tidySpots, spots]) {
        tries = 0;
        for (const [x, y] of pass) {
          if (!staysInside(x, y) || !live.canPlaceBlueprint(bp.id, x, y).ok) continue;
          if (++tries > MAX_TRIES_IN_ROOM) continue outer;
          const s = Object.assign({}, base, { room: null, roomId: target.id, ox: x, oy: y });
          const t = tryPlacement(doc, bp, s, env, before);
          if (t.ok) { placed = t; spec = s; break outer; }
        }
      }
      if (!placed) return refuse(plain + ' does not fit on clear floor in ' + target.name + '. Use "new room", or clear some floor there first.');
    }

    // the line's steps in RUN ORDER (a stand-in crew on the probe, so order follows the belts, not who is assigned)
    const crewProbe = env.WorldModel.create(clone(placed.probe.serialize()));
    const bays = placed.ids.filter((pid, i) => bp.props[i].t === 'bay');
    bays.forEach((pid, i) => crewProbe.assignPropAgent(pid, '__sb_probe_' + i));
    const shape = readLine(crewProbe, placed.ids, env, null), order = shape.order;
    const runOrder = order.length === bays.length ? order : bays;
    const stepsOut = runOrder.map((pid, i) => {
      const propIndex = placed.ids.indexOf(pid), role = bp.props[propIndex].role || 'STEP';
      return { step: i + 1, role, propIndex, brief: '', agentId: '' };
    });
    const staffed = staffSteps(stepsOut, reqSteps, env, purpose); if (!staffed.ok) return staffed;
    const recruits = stepsOut.filter(x => x.recruit).map(x => ({ propIndex: x.propIndex, role: x.role }));
    if (recruits.length > MAX_RECRUITS) return refuse('That plan recruits ' + recruits.length + ' new agents. Recruit only when the Commander asks for new crew, and at most ' + MAX_RECRUITS + ' in one plan: staff the other steps with "lead" or a crew member, or leave agent out (the card then lists them as still to do).');
    spec = Object.assign({}, spec, { steps: stepsOut.map(x => ({ propIndex: x.propIndex, brief: x.brief, agentId: x.agentId })), recruits });

    // the whole build on one more probe: its fingerprint is what apply() must reproduce exactly (the recruits' desks, a
    // tidy row by the line, found on a first build and laid by the second)
    let finalProbe = WM.create(clone(doc));
    let fb = buildInto(finalProbe, spec, WM);
    if (!fb.ok) return fb;
    if (recruits.length) {
      const lineRoom = finalProbe.roomAt(finalProbe.propById(fb.ids[recruits[0].propIndex]).x, finalProbe.propById(fb.ids[recruits[0].propIndex]).y);
      const desks = desksFor(WM.create(clone(finalProbe.serialize())), env, lineRoom, recruits.length);
      recruits.forEach((rc, k) => { rc.desk = desks[k] ? { x: desks[k].x, y: desks[k].y } : null; });
      spec = Object.assign({}, spec, { desks });
      finalProbe = WM.create(clone(doc)); fb = buildInto(finalProbe, spec, WM);
      if (!fb.ok) return fb;
    }
    const crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean);
    // readiness counts the recruits: on a copy, each gets the desk its summon seeds (ensureWorkstation) and its step
    const rp = WM.create(clone(finalProbe.serialize())), deskRooms = [];
    recruits.forEach((rc, i) => {
      const id = '__sb_recruit_' + i, slot = rc.desk ? rp.propAt(rc.desk.x, rc.desk.y) : null;
      const d = slot ? Object.assign(rp.assignPropAgent(slot, id) || {}, { roomId: rp.roomAt(rc.desk.x, rc.desk.y) }) : rp.ensureWorkstation(id);
      if (d && d.ok && d.roomId) { const rm = rp.roomById ? rp.roomById(d.roomId) : null; if (rm && deskRooms.indexOf(rm.name) < 0) deskRooms.push(rm.name); }
      rp.assignPropAgent(fb.ids[rc.propIndex], id); crewIds.push(id);
    });
    const rd = readLine(rp, fb.ids, env, crewIds);
    const whereText = spec.room ? 'a new room ' + spec.placed.side + ' of ' + spec.placed.target + (spec.placed.len ? ', through a hallway' : ', open to it') : 'the ' + target.name + ' room';
    const stepsView = stepsOut.map(x => ({ step: x.step, role: titleCase(x.role), agent: x.recruit ? 'a new recruit' : x.agentId ? nameOf(env, x.agentId) : null, instructions: x.brief }));
    const capNow = (() => { const ip = fb.ids.map(id => finalProbe.propById(id)).find(p => p && p.t === 'intake'); return ip && ip.limits ? ip.limits.maxUsdPerDay : null; })();
    const summary = plain + (hasIntake ? ' ("' + label + '")' : '') + ' in ' + whereText + ': '
      + flowText(shape.cols, runOrder, stepsView)
      + (bp.props.some(p => p.t === 'outbox') ? ' → Outbox' : '')
      + (hasIntake ? (capNow != null ? ' · daily cap $' + capNow : ' · no daily cap') : '')
      + (hasLoop ? ' · up to ' + (opts.maxIter || (bp.props.find(p => p.t === 'loop') || {}).maxIter || 3) + ' review tries' : '')
      + '. ' + (rd.ready ? 'It will be ready to run.' : 'Still to do after building: ' + rd.blocking.join('; ') + '.')
      + (recruits.length ? ' It adds ' + recruits.length + ' crew member' + (recruits.length > 1 ? 's' : '') + ': ' + recruits.map(r => r.role).join(', ')
        + (deskRooms.length ? ', with a desk in ' + deskRooms.join(' and ') : '') + '. UNDO does not remove agents; DELETE AGENT in a Dossier does.' : '')
      + (picked ? ' Picked for "' + purpose.slice(0, 80) + '": ' + picked + '.' : '');
    return { ok: true, plan: {
      floorSig: sigOf(doc), resultSig: sigOf(finalProbe.serialize()), spec, preview: previewOf(WM, doc, finalProbe.serialize(), [], target ? target.id : null),
      line: { id: bp.id, name: plain, label: hasIntake ? label : null }, where: whereText,
      steps: stepsView, ready: rd.ready, blocking: rd.blocking, notes, summary, recruits: recruits.map(r => r.role), picked
    } };
  }

  /* ================= ROOMS & DECOR (phase 2, 2026-09-29) =================
     The same rule as lines: the agent picks from curated options and never places furniture. A ROOM KIT is one of the
     hand-designed rooms the presets are made of (StationTemplates.kits) — its furniture, and for some a ready line with
     written steps. planRoom places a kit in a NEW room (the shared room finder), FURNISHES an existing room that has
     clear floor for the whole kit, or adds every room of a PRESET beside the station — always add-only. A kit is tried
     as designed and mirrored (never a kit with a line: mirroring would reverse its belts) until every piece can be
     walked up to and no piece blocks a doorway. planRestyle is the one cosmetic change: a room's floor, material or
     name, from fixed lists. The card says what equipment a kit brings (a desk is a computer: object = capability). */
  const ROOM_MENU = ['zones', 'kit', 'preset', 'replace', 'where', 'beside', 'side', 'hallway', 'size', 'name', 'type', 'floorStyle', 'floorMat'];
  const STYLE_MENU = ['room', 'name', 'type', 'floorStyle', 'floorMat'];
  const KIT_W = 18, KIT_H = 11;
  const kitsOf = env => (env.StationTemplates && env.StationTemplates.kits) ? env.StationTemplates.kits() : [];
  const kitMenu = env => kitsOf(env).map(k => k.name + ' (' + k.about + ')').join('; ');
  const presetsOf = env => ((env.StationTemplates && env.StationTemplates.catalog) || []).filter(c => env.StationTemplates.presetKits(c.id).length);
  function resolveKit(env, raw) { const n = norm(raw); return n ? kitsOf(env).find(k => norm(k.id) === n || norm(k.name) === n) || null : null; }
  function resolvePreset(env, raw) { const n = norm(raw); return n ? presetsOf(env).find(c => norm(c.id) === n || norm(c.name) === n) || null : null; }
  function styleOf(WM, req) {
    const styles = Object.keys(WM.FLOOR_STYLES || {}).filter(s => s !== 'corridor'), mats = Object.keys(WM.FLOOR_MATERIALS || {});
    const pick = (raw, list, field) => {
      if (raw == null) return { ok: true, value: null };
      const v = String(raw).toLowerCase().replace(/[^a-z]/g, '');
      return list.indexOf(v) >= 0 ? { ok: true, value: v } : refuse(field + ' must be one of: ' + list.join(', ') + '.');
    };
    const fs = pick(req.floorStyle, styles, 'floorStyle'); if (!fs.ok) return fs;
    const fm = pick(req.floorMat, mats, 'floorMat'); if (!fm.ok) return fm;
    // a room TYPE is a deck, as in Build mode's TYPE palette: its floor and material (a floorStyle or floorMat given too wins)
    let type = null;
    if (req.type != null) {
      const K = WM.ROOM_KINDS || {}, order = (WM.KIND_ORDER || Object.keys(K)).filter(k => k !== 'corridor' && K[k]), v = norm(req.type);
      const k = order.find(id => norm(id) === v || norm(K[id].label) === v);
      if (!k) return refuse('type must be one of: ' + order.map(id => K[id].label).join(', ') + '.');
      type = { id: k, label: K[k].label, floor: K[k].floor, mat: K[k].mat };
    }
    return { ok: true, floorStyle: fs.value || (type && type.floor) || null, floorMat: fm.value || (type && type.mat) || null, type };
  }
  // a kit's furniture at (x0, y0), as designed or mirrored left-to-right (a chair facing east then faces west)
  function kitProps(env, kit, x0, y0, mirror) {
    const S = env.PropSprites, out = [];
    for (const [t, x, y, facing = 0] of kit.props) {
      const spec = S && S.spec ? S.spec(t) : null;
      if (!spec) return null;
      const r = mirror ? (facing === 1 ? 3 : facing === 3 ? 1 : facing) : facing;
      out.push({ t, x: x0 + (mirror ? KIT_W - x - spec.w : x), y: y0 + y, w: spec.w, h: spec.h, r, block: spec.blocks !== false });
    }
    return out;
  }
  // a kit's own line, with the kit's written steps (its briefs, by role) and nobody assigned yet
  function kitLine(env, kit, x0, y0) {
    if (!kit.line) return null;
    const bp = (env.WorldModel.BLUEPRINTS || []).find(b => b.id === kit.line.bp);
    if (!bp) return null;
    const steps = [];
    bp.props.forEach((p, i) => {
      if (p.t !== 'bay') return;
      const st = env.WorkflowLine.starters ? env.WorkflowLine.starters(p.role) : [];
      steps.push({ propIndex: i, brief: (kit.line.briefs && kit.line.briefs[p.role]) || (st[0] && st[0].does) || '', agentId: '' });
    });
    return { bpId: bp.id, ox: x0 + kit.line.x, oy: y0 + kit.line.y, opts: {}, label: kit.line.label || '', steps };
  }
  // the tiles a room's doorways need clear: each door tile inside the room and the one tile past it
  function landingTiles(st, g, roomId) {
    const out = new Set(), ox = g.origin.tx, oy = g.origin.ty;
    for (const d of g.doorDefs || []) {
      const a = { x: d[0] + ox, y: d[1] + oy }, b = { x: d[2] + ox, y: d[3] + oy };
      const inA = st.roomAt(a.x, a.y) === roomId, inB = st.roomAt(b.x, b.y) === roomId;
      if (inA === inB) continue;
      const door = inA ? a : b, other = inA ? b : a;
      out.add(door.x + ',' + door.y); out.add((2 * door.x - other.x) + ',' + (2 * door.y - other.y));
    }
    return out;
  }
  // every tile within AISLE of a workflow machine or a belt already in the room: a new line there keeps clear of them all
  function aisleTiles(st, roomId) {
    const out = new Set(), mark = (x, y, w, h) => { for (let yy = y - AISLE; yy < y + h + AISLE; yy++) for (let xx = x - AISLE; xx < x + w + AISLE; xx++) out.add(xx + ',' + yy); };
    for (const p of st.props()) if (MACHINE_T.test(p.t) && st.roomAt(p.x, p.y) === roomId) mark(p.x, p.y, p.w || 1, p.h || 1);
    const belts = st.serialize().belts || {};
    for (const k in belts) { const [x, y] = k.split(',').map(Number); if (st.roomAt(x, y) === roomId) mark(x, y, 1, 1); }
    return out;
  }
  // a room holds lines already, or is a hall big enough for several (two grid rooms' floor or more)
  function roomHasLines(st, roomId) { return st.props().some(p => MACHINE_T.test(p.t) && st.roomAt(p.x, p.y) === roomId); }
  function isHallSized(R) { return (R.x2 - R.x1 + 1) * (R.y2 - R.y1 + 1) >= 2 * CELL[0] * CELL[1]; }
  // the same checks as a line's placement, plus: no piece of furniture on a doorway's landing
  function tryKit(doc, spec, env, before) {
    const WM = env.WorldModel, P = env.Pipeline;
    const probe = WM.create(clone(doc));
    const b = buildInto(probe, spec, WM);
    if (!b.ok) return b;
    const after = floorFacts(probe, P), g = after.geo;
    for (const e of after.errs) if (!before.errs.has(e)) return refuse('that spot would add a routing problem (' + e.split(':')[0] + ')');
    for (const dock in before.chains) if (JSON.stringify(before.chains[dock]) !== JSON.stringify(after.chains[dock])) return refuse('that spot would change how an existing line routes');
    for (const dock in before.reach) if (!!before.reach[dock] !== !!after.reach[dock]) return refuse('that spot would change which existing steps the Inbox reaches');
    const o = spawnTile(probe.serialize(), g);
    for (const part of b.parts) {
      const land = landingTiles(probe, g, part.roomId);
      for (const pid of part.ids) {
        const p = probe.propById(pid);
        if (!p || p.block === false) continue;
        for (let yy = p.y; yy < p.y + p.h; yy++) for (let xx = p.x; xx < p.x + p.w; xx++) if (land.has(xx + ',' + yy)) return refuse('a piece of furniture would block a doorway');
        if (o && !g.path(o.x - g.origin.tx, o.y - g.origin.ty, p.x - g.origin.tx, p.y + p.h - g.origin.ty)) return refuse('a piece of furniture could not be walked up to');
      }
    }
    return { ok: true, probe, parts: b.parts };
  }
  // the kit's furniture that is EQUIPMENT (object = capability): "a desk (COMPUTE)", by the prop's own label
  const equipmentOf = (env, props) => {
    const WM = env.WorldModel, S = env.PropSprites, seen = {}, out = [];
    for (const p of props) {
      const cap = WM.capForProp ? WM.capForProp(p.t) : null; if (!cap) continue;
      const k = cap + ':' + p.t; if (seen[k]) continue; seen[k] = 1;
      const spec = S && S.spec ? S.spec(p.t) : null, label = String((spec && spec.label) || p.t).toLowerCase().replace(/_/g, ' ').replace(/ [a-z]$/, '');   // "CONSOLE L" (its shape) reads as a console
      out.push((/^[aeiou]/.test(label) ? 'an ' : 'a ') + label + ' (' + ((WM.CAP_LABEL || {})[cap] || cap) + ')');
    }
    return out;
  };
  // what agents gain in the room, in EquipmentHelp's own words (the one plain-English source for each ability)
  const gainsOf = (env, props) => {
    const WM = env.WorldModel, H = env.EquipmentHelp, out = [];
    if (!H || !H.PURPOSE) return out;
    for (const p of props) {
      const cap = WM.capForProp ? WM.capForProp(p.t) : null, said = cap && H.PURPOSE[cap]; if (!said) continue;
      const g = cap === 'computer' ? 'a place to work' : said.replace(/\.$/, '').replace(/^./, c => c.toLowerCase());
      if (out.indexOf(g) < 0) out.push(g);
    }
    return out;
  };

  /* THE WHOLE-STATION SWAP ("build me a research station", replace: true): exactly Build mode's Presets apply
     (StationTemplates.build → replaceLayout, which keeps every agent's workstation). The page backs the current layout up
     to Build mode's own slot first, so RESTORE PREVIOUS in Build → Presets brings it back; one UNDO does too. */
  function planSwap(doc, req, env) {
    const WM = env.WorldModel, P = env.Pipeline, T = env.StationTemplates;
    if (req.kit) return refuse('replace swaps the whole station for a preset; a kit is one room. Use preset, or leave replace out to add the kit as a room.');
    const extra = Object.keys(req).filter(k => k !== 'preset' && k !== 'replace');
    if (extra.length) return refuse('A swap puts in a preset exactly as designed, so leave out: ' + extra.slice(0, 8).join(', ') + '.');
    const all = T.catalog || [], n = norm(req.preset), pr = n ? all.find(c => norm(c.id) === n || norm(c.name) === n) : null;
    if (!pr) return refuse('There is no preset called "' + String(req.preset || '').slice(0, 40) + '". Presets: ' + all.map(c => c.name).join(', ') + '.');
    const layout = T.build(pr.id, WM, env.PropSprites, (doc._nid || 0) + 100);
    const probe = WM.create(clone(doc)), r = probe.replaceLayout(layout);
    if (!r || !r.ok) return refuse(pr.name + ' could not replace this station (' + ((r && (r.msg || r.error)) || 'it did not fit') + '), so nothing was changed.');
    if (floorFacts(probe, P).errs.size) return refuse(pr.name + ' would not route cleanly on this station, so nothing was changed.');
    const crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean), geo = probe.projectGeometry();
    const steps = [], lines = [];
    const comps = P.lineComponents(geo).filter(c => (c.bays || []).length);
    for (const c of comps) {
      const line = readLine(probe, c.bays.map(b => b.propId), env, crewIds);
      const intake = probe.props().find(p => p.t === 'intake' && (c.props || []).indexOf(p.id) >= 0);
      const label = (intake && intake.label) || 'the line';
      lines.push({ label, ready: line.ready, blocking: line.blocking });
      let k = 0;
      for (const pid of line.order) {
        const b = probe.props().find(q => q.id === pid);
        if (b && b.t === 'bay') steps.push({ step: ++k, role: titleCase(b.role) + (comps.length > 1 ? ' on ' + label : ''), agent: b.agentId ? nameOf(env, b.agentId) : null, instructions: b.brief || '' });
      }
    }
    const was = WM.create(clone(doc)), wasRooms = was.rooms().filter(x => x.kind !== 'corridor').length, wasProps = was.props().length;
    const rooms = probe.rooms().filter(x => x.kind !== 'corridor').map(x => x.name);
    const equip = equipmentOf(env, probe.props()), gains = gainsOf(env, probe.props());
    const summary = 'Swap your whole station for ' + pr.name + ' (' + rooms.join(', ') + '). Your ' + wasRooms + (wasRooms === 1 ? ' room' : ' rooms') + ' and ' + wasProps + ' props are replaced; agents and conversations stay, and every agent keeps a desk. '
      + 'Your current layout is backed up: RESTORE PREVIOUS in Build → Presets brings it back.'
      + (equip.length ? ' It brings equipment: ' + equip.join(', ') + (gains.length ? '. What agents gain there: ' + gains.join('; ') : '') + '.' : '')
      + lines.map(l => ' Its line "' + l.label + '" ' + (l.ready ? 'will be ready to run' : 'still needs: ' + l.blocking.join('; ')) + '.').join('');
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(probe.serialize()), spec: { kind: 'swap', preset: pr.id, layout }, preview: previewOf(WM, doc, probe.serialize(), []), summary, notes: [], steps, line: null,
      where: 'the whole station', rooms: rooms.map(name => ({ name })), preset: { id: pr.id, name: pr.name }, lines } };
  }

  function planRoom(doc, req, env) {
    if (req && typeof req === 'object' && !Array.isArray(req) && req.zones != null) {
      if (req.kit != null || req.preset != null || req.replace != null) return refuse('zones describe a room part by part; kit, preset and replace build rooms as designed. Use one or the other.');
      return planDesign(doc, req, env);
    }
    const WM = env && env.WorldModel, P = env && env.Pipeline, W = env && env.WorkflowLine;
    if (!WM || !P || !W || !doc || !env.StationTemplates || !env.PropSprites) return refuse('the station builder is not loaded on this page');
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse('Send the request as an object with: ' + ROOM_MENU.join(', ') + '.');
    if (req.replace != null && req.replace !== false && !/^(false|no)$/i.test(String(req.replace))) {
      if (req.replace !== true && !/^(true|yes)$/i.test(String(req.replace))) return refuse('replace is true (swap the whole station for the preset) or left out (add rooms).');
      return planSwap(doc, req, env);
    }
    const extra = Object.keys(req).filter(k => ROOM_MENU.indexOf(k) < 0);
    if (extra.length) return refuse('StarNet chooses every position and piece of furniture itself, so these fields are not accepted: ' + extra.slice(0, 8).join(', ') + '. Use only: ' + ROOM_MENU.join(', ') + '.');
    const presetNames = presetsOf(env).map(c => c.name).join(', ');
    if (!!req.kit === !!req.preset) return refuse('Choose one: kit (one room) or preset (every room of a preset, added beside your station). Kits: ' + kitMenu(env) + '. Presets: ' + presetNames + '.');
    const style = styleOf(WM, req); if (!style.ok) return style;
    let list;
    if (req.kit) { const k = resolveKit(env, req.kit); if (!k) return refuse('There is no room kit called "' + String(req.kit).slice(0, 40) + '". Kits: ' + kitMenu(env) + '.'); list = [k]; }
    else {
      const pr = resolvePreset(env, req.preset);
      if (!pr) return refuse('There is no preset called "' + String(req.preset).slice(0, 40) + '". Presets: ' + presetNames + '.');
      list = env.StationTemplates.presetKits(pr.id).map(id => kitsOf(env).find(k => k.id === id)).filter(Boolean);
    }
    const name = typeof req.name === 'string' ? req.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : '';
    if (name && list.length > 1) return refuse('name names one room; a preset adds several rooms under their own names. Leave name out.');
    const live = WM.create(clone(doc));
    const rooms = live.rooms().filter(r => r.kind !== 'corridor');
    const whereRaw = req.where == null ? '' : String(req.where).trim();
    let target = null;
    if (whereRaw && !/^(a )?new( room)?$/i.test(whereRaw)) {
      if (list.length > 1) return refuse('A preset\'s rooms are always added as new rooms. Leave where out.');
      const m = rooms.filter(r => norm(r.name) === norm(whereRaw));
      if (m.length !== 1) return refuse((m.length ? 'More than one room is called "' + whereRaw.slice(0, 40) + '".' : 'There is no room called "' + whereRaw.slice(0, 40) + '".') + ' Use "new room", or one of: ' + rooms.map(r => r.name).join(', ') + '.');
      target = m[0];
    }
    const before = floorFacts(live, P), parts = [];
    // where new rooms go: beside the asked room (the main room by default), on the asked side or the compact one, by a hallway
    const bq = req.beside != null ? roomNamed(live, req.beside) : { ok: true, room: null }; if (!bq.ok) return bq;
    const sq = sideOf(req.side); if (!sq.ok) return sq;
    const hq = hallOf(req.hallway); if (!hq.ok) return hq;
    if (target && ['beside', 'side', 'hallway'].some(k => req[k] != null)) return refuse('beside, side and hallway place a NEW room; with where naming ' + target.name + ', leave them out.');
    if (req.size != null) return refuse('A preset room comes at its own size (18 × 11). For a room of another size use station.plan_build.');
    const besideRoom = bq.room, placeSide = sq.side, placeHall = hq.len;
    for (const kit of list) {
      let found = null;
      const mirrors = kit.line ? [false] : [false, true];
      if (target) {
        const R = target.rects[0], Wd = R.x2 - R.x1 + 1, Hd = R.y2 - R.y1 + 1;
        if (target.rects.length > 1 || Wd < KIT_W || Hd < KIT_H) return refuse(target.name + ' is ' + Wd + ' × ' + Hd + '; a ' + kit.name + ' needs a plain 18 × 11 room. Use "new room".');
        const x0 = R.x1 + ((Wd - KIT_W) >> 1), y0 = R.y1 + ((Hd - KIT_H) >> 1);
        for (const mirror of mirrors) {
          const props = kitProps(env, kit, x0, y0, mirror); if (!props) return refuse('this page is missing the furniture for ' + kit.name);
          const part = { room: null, roomId: target.id, props, line: kitLine(env, kit, x0, y0), meta: { kit: kit.id, name: target.name, about: kit.about, existing: true } };
          if (tryKit(doc, { kind: 'rooms', parts: parts.concat([part]) }, env, before).ok) { found = part; break; }
        }
        if (!found) return refuse(kit.name + ' does not fit in ' + target.name + ': every piece needs clear floor, a way to walk up to it, and its doorways open. Use "new room".');
      } else {
        const sofar = WM.create(clone(doc));
        if (parts.length) { const b = buildInto(sofar, { kind: 'rooms', parts }, WM); if (!b.ok) return b; }
        const roomName = name || kit.name;
        // beside the asked room, else wherever keeps the station compact (a preset's later rooms may stand beside its earlier ones)
        const T = besideRoom ? (sofar.rooms().find(r => r.id === besideRoom.id) || besideRoom) : null;
        const grid = !besideRoom && !placeSide && req.hallway == null ? gridSpots(env.WorldModel, sofar, KIT_W, KIT_H, hangsOf(env)) : [];
        const pl = roomPlacements(sofar, T, KIT_W, KIT_H, { side: placeSide, len: placeHall, align: null, kind: kit.kind, hangs: hangsOf(env) });
        if (!pl.ok && !grid.length) return pl;
        outer: for (const cand of grid.concat(pl.ok ? pl.list : [])) for (const mirror of mirrors) {
          const rect = cand.rect, props = kitProps(env, kit, rect.x1, rect.y1, mirror); if (!props) return refuse('this page is missing the furniture for ' + kit.name);
          const part = { hall: cand.hall, room: { kind: kit.kind, name: roomName, floorStyle: style.floorStyle || kit.floorStyle, floorMat: style.floorMat || kit.floorMat, rect },
            props, line: kitLine(env, kit, rect.x1, rect.y1), meta: { kit: kit.id, name: roomName, about: kit.about, existing: false, placed: { side: cand.side, target: cand.target, len: cand.len } } };
          Object.assign(part, gridHallTrim(env.WorldModel, env, sofar, cand, kit.kind));
          if (tryKit(doc, { kind: 'rooms', parts: parts.concat([part]) }, env, before).ok) { found = part; break outer; }
        }
        if (!found) return refuse('There is no clear space ' + (besideRoom ? 'beside ' + besideRoom.name : 'beside the station') + ' for an 18 × 11 ' + kit.name + '. Try another side or another room (station.map shows what is free).');
      }
      parts.push(found);
    }
    const spec = { kind: 'rooms', parts };
    const finalProbe = WM.create(clone(doc)), fb = buildInto(finalProbe, spec, WM);
    if (!fb.ok) return fb;
    const crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean);
    // a kit's line writes instructions every later run obeys: the card lists them, step by step in run order
    const steps = [], manyLines = fb.parts.filter(b => b.lineIds.length).length > 1;
    const view = parts.map((part, i) => {
      const built = fb.parts[i], pr = finalProbe.rooms().find(r => r.id === built.roomId);
      const equip = equipmentOf(env, part.props), gains = gainsOf(env, part.props);
      const line = built.lineIds.length ? readLine(finalProbe, built.lineIds, env, crewIds) : null;
      const roomName = pr ? pr.name : part.meta.name;
      let n = 0;
      if (line) for (const pid of line.order) {
        const b = finalProbe.props().find(q => q.id === pid);
        if (b && b.t === 'bay') steps.push({ step: ++n, role: titleCase(b.role) + (manyLines ? ' in ' + roomName : ''), agent: null, instructions: b.brief || '' });
      }
      return { name: roomName, kit: part.meta.kit, about: part.meta.about, where: part.room ? 'a new room ' + part.meta.placed.side + ' of ' + part.meta.placed.target + (part.meta.placed.len ? ', through a hallway' : ', open to it') : 'the ' + part.meta.name + ' room',
        equipment: equip, gains, line: line ? { label: part.line.label, ready: line.ready, blocking: line.blocking } : null };
    });
    const summary = view.map(v => (v.where.indexOf('a new room') === 0 ? v.name + ' (' + v.about + ') in ' + v.where : v.about.charAt(0).toUpperCase() + v.about.slice(1) + ', furnishing ' + v.where)
      + (v.equipment.length ? '. It brings equipment: ' + v.equipment.join(', ') + (v.gains.length ? '. What agents gain there: ' + v.gains.join('; ') : '') : '')
      + (v.line ? '. Its line "' + v.line.label + '" ' + (v.line.ready ? 'will be ready to run' : 'still needs: ' + v.line.blocking.join('; ')) : '') + '.').join(' ');
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(finalProbe.serialize()), spec, preview: previewOf(WM, doc, finalProbe.serialize(), [], target ? target.id : null), rooms: view, summary, notes: [], steps, line: null, where: view.map(v => v.where).join('; ') } };
  }

  function planRestyle(doc, req, env) {
    const WM = env && env.WorldModel;
    if (!WM || !doc) return refuse('the station builder is not loaded on this page');
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse('Send the request as an object with: ' + STYLE_MENU.join(', ') + '.');
    const extra = Object.keys(req).filter(k => STYLE_MENU.indexOf(k) < 0);
    if (extra.length) return refuse('A restyle only changes a room\'s floor, material or name, so these fields are not accepted: ' + extra.slice(0, 8).join(', ') + '. Use only: ' + STYLE_MENU.join(', ') + '.');
    const live = WM.create(clone(doc)), rooms = live.rooms().filter(r => r.kind !== 'corridor');
    const m = rooms.filter(r => norm(r.name) === norm(req.room));
    if (m.length !== 1) return refuse((req.room ? (m.length ? 'More than one room is called "' + String(req.room).slice(0, 40) + '".' : 'There is no room called "' + String(req.room).slice(0, 40) + '".') : 'Say which room.') + ' Rooms: ' + rooms.map(r => r.name).join(', ') + '.');
    const room = m[0], style = styleOf(WM, req); if (!style.ok) return style;
    const name = typeof req.name === 'string' ? req.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : '';
    if (name && rooms.some(r => r.id !== room.id && norm(r.name) === norm(name))) return refuse('Another room is already called ' + name + '.');
    const changes = [];
    if (style.floorStyle && style.floorStyle !== room.floorStyle) changes.push('floor ' + (room.floorStyle || 'default') + ' → ' + style.floorStyle);
    if (style.floorMat && style.floorMat !== room.floorMat) changes.push('material ' + (room.floorMat || 'default') + ' → ' + style.floorMat);
    if (name && name !== room.name) changes.push('renamed to ' + name);
    if (!changes.length) return refuse('Nothing would change. Give a new floorStyle, floorMat or name for ' + room.name + '.');
    const spec = { kind: 'restyle', roomId: room.id, floorStyle: style.floorStyle, floorMat: style.floorMat, name: name || null };
    const probe = WM.create(clone(doc)), r = buildInto(probe, spec, WM);
    if (!r.ok) return r;
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(probe.serialize()), spec, preview: previewOf(WM, doc, probe.serialize(), [], room.id), summary: 'Restyle ' + room.name + (style.type ? ' with the ' + style.type.label + ' floor' : '') + ': ' + changes.join(', ') + '. Nothing is added, moved or removed.',
      notes: name ? ['requests that name this room by its old name will need the new one'] : [], steps: [], line: null, where: 'the ' + room.name + ' room', rooms: [] } };
  }

  /* ================= EDIT WHAT STANDS (2026-09-30, "it should be able to build anything the user wants") =================
     Three edits of the station as it stands, each planned on a copy, checked, and built in ONE undo:
     - remove: a room, or a list. Everything on it goes (its furniture, and any line in it, named on the card); a hallway
       that joined it and now joins nothing goes too; an agent whose seat stood there gets a desk in a tidy row elsewhere.
       The main room stays, and a removal that would cut another room off from the bridge is refused naming it.
     - refurnish: { room, style, name }: its furniture is cleared and it is furnished in another whole-room style, floor
       and walls too; its lines and agents' desks stay; a room still named for what it was takes the new style's name.
     - clear: a room: its furniture goes; its lines and agents' desks stay.
     Rooms do not move or resize: the refusal says to remove one and build it again where it should be. */
  const EDIT_KEYS = ['remove', 'refurnish', 'clear', 'add', 'seat', 'move', 'staff', 'refit', 'rearrange'];
  const EDIT_HOW = 'An edit is one of: { remove: a room or [rooms] }, { remove: { room, pieces } }, { remove: { line } }, { refurnish: { room, style, name } }, { clear: a room }, { add: { room, pieces } }, { seat: { agent, room } }, { move: { room, beside, side } }, { staff: { line, steps } }. Rooms do not resize: remove one and build it again the size it should be.';
  const SEAT_T = /^(desk|desk2|console|consoleL|pixelrig|bench|workbench)$/, KEEP_T = /^(airlock)$/;
  // the zones a room or hallway opens onto
  function zoneNeighbours(st, id) {
    const g = st.projectGeometry(), ox = g.origin.tx, oy = g.origin.ty, out = new Set();
    for (const d of g.doorDefs || []) { const a = st.roomAt(d[0] + ox, d[1] + oy), b = st.roomAt(d[2] + ox, d[3] + oy); if (a === id && b && b !== id) out.add(b); if (b === id && a && a !== id) out.add(a); }
    return out;
  }
  // the rooms the crew can walk into from the main room
  function walkableRooms(st) {
    const g = st.projectGeometry(), o = spawnTile(st.serialize(), g), out = new Set();
    if (!o) return out;
    for (const r of st.rooms().filter(x => x.kind !== 'corridor')) {
      const R = r.rects[0], cx = (R.x1 + R.x2) >> 1, cy = (R.y1 + R.y2) >> 1;
      let t = null, bd = Infinity;
      for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) { const d = Math.abs(x - cx) + Math.abs(y - cy); if (d < bd && g.walkable(x - g.origin.tx, y - g.origin.ty)) { bd = d; t = { x, y }; } }
      if (t && g.path(o.x - g.origin.tx, o.y - g.origin.ty, t.x - g.origin.tx, t.y - g.origin.ty)) out.add(r.id);
    }
    return out;
  }
  // a room's furniture: everything on it but its workflow machines, agents' seats and fixtures
  const furnitureIn = (st, roomId) => st.props().filter(p => st.roomAt(p.x, p.y) === roomId && !MACHINE_T.test(p.t) && !p.agentId && !KEEP_T.test(p.t));
  // equipment an edit takes away (what agents gained there), named on the card
  const lostGear = (env, props) => { const e = equipmentOf(env, props); return e.length ? 'Equipment that goes: ' + e.join(', ') + '. ' : ''; };
  const shortList = (env, props) => { const t = piecesText(env, props).split(', '); return t.length > 7 ? t.slice(0, 6).join(', ') + ' and more' : t.join(', '); };
  /* every check an edit passes, on a copy built exactly as station.build will build it: no new routing problem (a moved
     room's machines may report theirs at their new tiles), no existing line routing differently (one that went may
     vanish), and no room the crew could walk into cut off */
  function editChecks(doc, live, spec, env, before, goneRects, moved) {
    const WM = env.WorldModel, P = env.Pipeline, main = mainRoom(live);
    const probe = WM.create(clone(doc)), b = editInto(probe, spec);
    if (!b.ok) return b;
    const after = floorFacts(probe, P), inGoneTile = t => t && goneRects.some(r => t.x >= r.x1 && t.x <= r.x2 && t.y >= r.y1 && t.y <= r.y2);
    const loose = new Set(moved ? moved.propIds : []), keyOf = e => { const [code, pid] = e.split(':'); return loose.has(pid) ? code + ':' + pid : e; };
    const was = new Set([...before.errs].map(keyOf));
    for (const e of after.errs) if (!was.has(keyOf(e))) return refuse('that would add a routing problem (' + e.split(':')[0] + ')');
    const inMoved = t => moved && t && moved.rects.some(r => t.x >= r.x1 && t.x <= r.x2 && t.y >= r.y1 && t.y <= r.y2);
    for (const dock in before.chains) {
      const t0 = (before.chains[dock] || {}).tile;
      if (inMoved(t0)) continue;   // a moved room's own lines move with it, as a whole
      if (!(dock in after.chains)) { if (inGoneTile(t0)) continue; return refuse('that would change how an existing line routes'); }
      if (JSON.stringify(before.chains[dock]) !== JSON.stringify(after.chains[dock])) return refuse('that would change how an existing line routes (a line elsewhere runs into what changes)');
    }
    const walkBefore = walkableRooms(live), walkAfter = walkableRooms(probe);
    const cut = live.rooms().filter(r => walkBefore.has(r.id) && probe.rooms().some(x => x.id === r.id) && !walkAfter.has(r.id)).map(r => r.name);
    if (cut.length) return refuse('That would cut ' + cut.join(', ') + ' off from ' + (main ? main.name : 'the main room') + ': ' + (cut.length > 1 ? 'they are' : 'it is') + ' reached through ' + (moved ? 'it' : 'what goes') + '. ' + (moved ? 'Move it somewhere else, or remove what hangs off it first.' : 'Remove ' + (cut.length > 1 ? 'them' : 'it') + ' too, or keep the room.'));
    return { ok: true, probe };
  }
  // the hallways that joined `goneIds` and join nothing once they go (a hallway that never touched them stays)
  function danglingHalls(live, scratch, goneIds) {
    const wasNext = new Map(), halls = [];
    for (const h of live.rooms().filter(r => r.kind === 'corridor')) wasNext.set(h.id, zoneNeighbours(live, h.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const h of scratch.rooms().filter(r => r.kind === 'corridor')) {
        const was = wasNext.get(h.id) || new Set();
        if (![...was].some(id => goneIds.has(id) || halls.indexOf(id) >= 0)) continue;
        if (zoneNeighbours(scratch, h.id).size <= 1) { halls.push(h.id); scratch.removeRoom(h.id); changed = true; }
      }
    }
    return halls;
  }

  /* PIECES BY ANY NAME: every piece of the page's own catalog (a player-made prop too, by the name its maker gave it) by
     its id, its label, its card name or a word for it ("sofa", "fridge", "fish tank"), with a count ("three plants"). A
     workflow machine is not a piece (lines bring their own), nor is an airlock. */
  const PIECE_WORDS = { sofa: 'couch', settee: 'couch', television: 'tv', telly: 'tv', 'tv screen': 'tv', fridge: 'quarters_minifridge', refrigerator: 'quarters_minifridge', minifridge: 'quarters_minifridge',
    bed: 'bunk', bunkbed: 'bunk', 'bunk bed': 'bunk', vending: 'quarters_vending', 'vending machine': 'quarters_vending', 'snack machine': 'quarters_vending',
    'pool table': 'quarters_pooltable', pooltable: 'quarters_pooltable', billiards: 'quarters_pooltable', 'snooker table': 'quarters_pooltable', lockers: 'quarters_lockerbank', 'locker bank': 'quarters_lockerbank', locker: 'industrial_locker',
    aquarium: 'fishtank', 'fish tank': 'fishtank', lamp: 'arc_floorlight', 'floor lamp': 'arc_floorlight', light: 'arc_floorlight', 'floor light': 'arc_floorlight', 'lava lamp': 'lavalamp', 'desk lamp': 'desklamp',
    table: 'loungetable', 'coffee table': 'lowtable', 'dining table': 'dinertable', 'kitchen table': 'dinertable', 'round table': 'industrial_roundtable', 'conference table': 'longtable', 'meeting table': 'longtable',
    tree: 'tallplant', 'potted plant': 'plant', flower: 'plant', flowers: 'plant', palm: 'monstera', bookcase: 'bookshelf', books: 'bookstack', armchair: 'recliner', 'bean bag': 'beanbag',
    'arcade machine': 'arcade', 'arcade cabinet': 'arcade', 'arcade game': 'arcade', 'pinball machine': 'pinball', 'coffee machine': 'coffee', espresso: 'coffee', carpet: 'rug', 'big rug': 'rug_large', 'large rug': 'rug_large', 'small rug': 'rug_small',
    speakers: 'speaker', 'dj booth': 'djbooth', dj: 'djbooth', 'punching bag': 'punchbag', 'heavy bag': 'punchbag', 'bench press': 'benchpress', weights: 'benchpress', 'weapon rack': 'weaponrack',
    'big screen': 'bigscreen', projector: 'bigscreen', monitor: 'screens', monitors: 'screens', computer: 'desk', pc: 'desk', workstation: 'desk', 'poker table': 'pokertable', 'card table': 'pokertable',
    'bar stool': 'stool', 'hologram pet': 'holopet', pet: 'holopet', globe: 'plasmaglobe', 'plasma ball': 'plasmaglobe', 'server rack': 'rack', server: 'gigs_servercart', board: 'whiteboard',
    box: 'boxes', 'tool box': 'toolbox', vent: 'industrial_floorvent', partition: 'industrial_partition', 'room divider': 'industrial_partition', divider: 'industrial_partition', planter: 'industrial_planter',
    bench: 'industrial_bench', 'park bench': 'industrial_bench', 'office chair': 'chair', counter: 'bar', 'cryo pod': 'cryopod', 'model ship': 'modelship', 'mission board': 'missionboard', 'trophy case': 'trophycase' };
  const NOT_PIECE = /^(intake|bay|outbox|filter|merger|splitter|joiner|loop|airlock)$/;
  const NUM_WORDS = { a: 1, an: 1, one: 1, another: 1, two: 2, pair: 2, couple: 2, three: 3, few: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  function pieceIndex(env) {
    const S = env.PropSprites, idx = {};
    for (const c of (S && S.CATALOG) || []) {
      if (!c || !c.id || NOT_PIECE.test(c.id) || /_r$/.test(c.id)) continue;
      const lab = norm(String(c.label || '').replace(/[\u2039\u203a]/g, ' ').replace(/\b(LEFT|RIGHT)\b/g, ' '));
      for (const k of [c.id, c.id.replace(/_/g, ' '), lab, norm(pieceName(env, c.id))]) if (k && !idx[k]) idx[k] = c.id;
    }
    return idx;
  }
  const singular = w => [w, w.replace(/ies$/, 'y'), w.replace(/(ch|sh|s|x)es$/, '$1'), w.replace(/s$/, ''), w.replace(/ves$/, 'f')];
  function resolvePiece(env, raw, idx) {
    const n = norm(raw).replace(/^(a|an|the|some|another)\s+/, '');
    if (!n) return null;
    const ok = t => t && !NOT_PIECE.test(t) && env.PropSprites.spec(t) ? t : null;
    for (const v of singular(n)) { if (idx[v]) return idx[v]; const w = ok(PIECE_WORDS[v]); if (w) return w; }
    // the head word, read from the end ("red couch", "tall potted plant")
    for (const word of n.split(' ').reverse()) for (const v of singular(word)) { if (idx[v]) return idx[v]; const w = ok(PIECE_WORDS[v]); if (w) return w; }
    return null;
  }
  // a list of pieces asked for: "a tv", "three plants", { piece, count }; up to 16 in one plan
  function piecesAsked(env, list, allowAll) {
    const items = typeof list === 'string' ? list.split(/,| and /) : Array.isArray(list) ? list : list != null ? [list] : [];
    if (!items.length) return refuse('pieces is a list such as ["a tv", "three plants", { "piece": "couch", "count": 2 }].');
    const idx = pieceIndex(env), out = [];
    let total = 0;
    for (const it of items) {
      let name = it, count = null;
      if (it && typeof it === 'object') { name = it.piece != null ? it.piece : it.name; count = it.count; }
      name = String(name == null ? '' : name).trim();
      if (!name) continue;
      const m = /^(\d+|a|an|one|another|two|pair of|couple of|three|few|four|five|six|seven|eight|all(?: the)?|every)\s+(.+)$/i.exec(name);
      if (m && count == null) { const w = m[1].toLowerCase().replace(/ of$/, ''); count = /^(all|all the|every)$/.test(w) ? 'all' : /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w]; name = m[2]; }
      if (count === 'all' && !allowAll) return refuse('"all" removes pieces; to add, give a number (up to 8).');
      if (count == null) count = 1;
      if (count !== 'all' && (!Number.isInteger(count) || count < 1 || count > 40)) return refuse('A count is a whole number from 1 to 40' + (allowAll ? ', or "all"' : '') + '.');
      const t = resolvePiece(env, name, idx);
      if (!t) return refuse('There is no piece called "' + name.slice(0, 40) + '". Pieces include: a couch, a TV, a rug, a plant, a tall plant, a bookshelf, a lamp, a table, a chair, a bed, a fridge, a vending machine, an arcade cabinet, a pool table, a fish tank, a whiteboard, a desk, a big screen, a bar, a coffee machine, a jukebox, lockers, crates, a bench (and any prop you made, by its name). Workflow machines come with a line.');
      total += count === 'all' ? 1 : count;
      out.push({ t, count, name });
    }
    if (!out.length) return refuse('pieces is a list such as ["a tv", "three plants"].');
    if (total > 120) return refuse('That is ' + total + ' pieces; ask for up to 120 in one plan (or refurnish the room in a style).');
    return { ok: true, items: out };
  }
  /* PLACE NAMED PIECES in a room, the way a decorator would: a wall piece on the back wall, a table piece on a table, a
     rug on the open floor, everything else against a wall first (the back, then the sides, then the front), then the
     open floor; never on a belt or a doorway's lane, and never where it, or anything already there, could not be walked
     up to, or where it would cut a room off. Answers the pieces placed (they stand on `st`), or which one found no spot. */
  const TABLE_FIRST = /^(mug|desklamp|figurine|deskterminal|bookstack|radio|toolbox|modelship|research_papers|lavalamp|plasmaglobe)$/;
  function placePieces(st, env, roomId, items) {
    const S = env.PropSprites, rm = st.rooms().find(r => r.id === roomId), R = rm.rects[0], placed = [];
    const g0 = st.projectGeometry(), reserve = new Set(), belts = st.serialize().belts || {};
    for (const d of doorTiles(st, g0, roomId)) for (let k = 0; k < 3; k++) reserve.add((d.x + d.dx * k) + ',' + (d.y + d.dy * k));
    for (const k of deskSeats(st, roomId, S).keys()) reserve.add(k);   // a desk's seat row: the desk brings its own chair
    const o0 = spawnTile(st.serialize(), g0), walk0 = walkableRooms(st);
    const must = st.props().filter(p => st.roomAt(p.x, p.y) === roomId && p.block !== false && sideReachable(g0, o0, p)).map(p => p.id);
    const cx = (R.x1 + R.x2 + 1) / 2, cy = (R.y1 + R.y2 + 1) / 2;
    for (const it of items) for (let k = 0; k < it.count; k++) {
      const t = it.t, sp = S.spec(t), rule = (S.ruleFor ? S.ruleFor(t) : null) || { mount: sp.mount || null, stack: !!sp.stack, flat: !!sp.flat };
      const w = sp.w, h = sp.h, solid = sp.blocks !== false, cands = [];
      const tables = st.props().filter(p => st.roomAt(p.x, p.y) === roomId && (S.spec(p.t) || {}).surface);
      const onTables = () => { for (const tb of tables) for (let y = tb.y; y + h <= tb.y + tb.h; y++) for (let x = tb.x; x + w <= tb.x + tb.w; x++) cands.push([x, y, 0]); };
      if (rule.mount === 'wall') { for (let x = R.x1; x + w - 1 <= R.x2; x++) cands.push([x, R.y1, Math.abs(x + w / 2 - cx)]); }
      else if (rule.mount === 'surface') onTables();
      else {
        if (TABLE_FIRST.test(t)) onTables();
        const floor = [];
        for (let y = R.y1; y + h - 1 <= R.y2; y++) for (let x = R.x1; x + w - 1 <= R.x2; x++) {
          const top = y === R.y1, left = x === R.x1, right = x + w - 1 === R.x2, bottom = y + h - 1 === R.y2;
          const wall = rule.flat ? 9 : top ? 0 : (left || right) ? 1 : bottom ? 2 : 3;   // a rug lies in the open; the rest stand against a wall first
          floor.push([x, y, wall * 1000 + Math.abs(x + w / 2 - cx) + Math.abs(y + h / 2 - cy)]);
        }
        floor.sort((a, b) => a[2] - b[2]);
        cands.push(...floor);
      }
      if (rule.mount === 'wall') cands.sort((a, b) => a[2] - b[2]);
      let done = null;
      for (const [x, y] of cands) {
        let clear = true;
        for (let yy = y; yy < y + h && clear; yy++) for (let xx = x; xx < x + w; xx++) { const kk = xx + ',' + yy; if (st.roomAt(xx, yy) !== roomId || belts[kk] || (solid && reserve.has(kk))) { clear = false; break; } }
        if (!clear) continue;
        // a desk needs its own seat row clear (in the room, nothing solid on it)
        const ws = isWorkstation(st, t), row = ws ? seatRow({ t, x, y, w, h, r: 0 }, S) : [];
        if (ws && row.some(([xx, yy]) => { const pid = st.roomAt(xx, yy) === roomId ? st.propAt(xx, yy) : 'out', q = pid && pid !== 'out' ? st.propById(pid) : null; return pid === 'out' || belts[xx + ',' + yy] || (q && q.block !== false); })) continue;
        const a = st.addProp({ t, x, y, w, h, r: 0, block: solid });
        if (!a || !a.ok) continue;
        const g = st.projectGeometry(), o = spawnTile(st.serialize(), g);
        let fine = !solid || sideReachable(g, o, { x, y, w, h });
        if (fine && solid) fine = must.every(id => { const p = st.propById(id); return !p || sideReachable(g, o, p); });
        if (fine && solid) { const wk = walkableRooms(st); fine = [...walk0].every(id => wk.has(id)); }
        if (!fine) { st.removeProp(a.id); continue; }
        if (solid) must.push(a.id);
        for (const [xx, yy] of row) reserve.add(xx + ',' + yy);   // the next pieces keep off the new desk's seat
        faceItsTable(st, env, a.id);   // a chair set beside a table faces it
        done = { t, x, y, w, h, r: (st.propById(a.id).r | 0) & 3, block: solid };
        break;
      }
      if (!done) return refuse('There is no clear spot left in ' + rm.name + ' for ' + (/^[aeiou]/.test(pieceName(env, t)) ? 'an ' : 'a ') + pieceName(env, t) + ' (it needs ' + w + ' × ' + h + (rule.mount === 'wall' ? ' on the back wall' : rule.mount === 'surface' ? ' on a table: add a table first' : ' of clear floor off the doorways') + '). Clear some floor (clear or remove pieces), or put it in another room.');
      placed.push(done);
    }
    return { ok: true, props: placed };
  }
  function editAdd(live, env, q) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse('add is { room, pieces }: pieces such as ["a tv", "three plants"].');
    const bad = Object.keys(q).filter(k => ['room', 'pieces'].indexOf(k) < 0); if (bad.length) return refuse('add only takes room and pieces. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
    const t = roomNamed(live, q.room); if (!t.ok) return t;
    const room = t.room; if (room.rects.length > 1) return refuse(room.name + ' is not a plain rectangle, so StarNet cannot place pieces in it.');
    const pa = piecesAsked(env, q.pieces, false); if (!pa.ok) return pa;
    const scratch = env.WorldModel.create(clone(live.serialize())), pl = placePieces(scratch, env, room.id, pa.items);
    if (!pl.ok) return pl;
    const gear = equipmentOf(env, pl.props), gains = gainsOf(env, pl.props);
    return { ok: true, spec: { kind: 'edit', props: pl.props }, mark: room.id, where: 'new pieces in ' + room.name,
      summary: 'Add to ' + room.name + ': ' + piecesText(env, pl.props) + ', each against a wall or on the open floor, clear of its doorways, lines and walkways.' + (gear.length ? ' It brings equipment: ' + gear.join(', ') + (gains.length ? '. What agents gain there: ' + gains.join('; ') : '') + '.' : '') + ' One UNDO in Build mode takes them back.' };
  }
  function editRemovePieces(live, env, q) {
    const bad = Object.keys(q).filter(k => ['room', 'pieces'].indexOf(k) < 0); if (bad.length) return refuse('remove { room, pieces } only takes room and pieces. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
    const t = roomNamed(live, q.room); if (!t.ok) return t;
    const room = t.room, S = env.PropSprites, pa = piecesAsked(env, q.pieces, true); if (!pa.ok) return pa;
    const base = id => id.replace(/_r$/, ''), here = furnitureIn(live, room.id), chosen = [];
    for (const it of pa.items) {
      const pool = here.filter(p => base(p.t) === base(it.t) && chosen.indexOf(p) < 0);
      if (!pool.length) {
        const seat = live.props().some(p => live.roomAt(p.x, p.y) === room.id && p.agentId && base(p.t) === base(it.t));
        return refuse(seat ? 'The ' + pieceName(env, it.t) + ' in ' + room.name + ' is an agent\'s seat: seat that agent elsewhere first ({ seat: { agent, room } }).' : room.name + ' has no ' + pieceName(env, it.t) + '. It holds: ' + (here.length ? shortList(env, here) : 'no furniture') + '.');
      }
      const n = it.count === 'all' ? pool.length : it.count;
      if (n > pool.length) return refuse(room.name + ' has only ' + pool.length + ' ' + (pool.length === 1 ? pieceName(env, it.t) : plural(pieceName(env, it.t))) + '.');
      chosen.push(...pool.slice(0, n));
    }
    // what stands on a table that goes, goes with it
    const onTop = here.filter(p => chosen.indexOf(p) < 0 && chosen.some(tb => (S.spec(tb.t) || {}).surface && p.x >= tb.x && p.x < tb.x + tb.w && p.y >= tb.y && p.y < tb.y + tb.h));
    const all = chosen.concat(onTop);
    return { ok: true, spec: { kind: 'edit', removeProps: all.map(p => p.id) }, mark: room.id, where: 'pieces out of ' + room.name,
      summary: 'Remove from ' + room.name + ': ' + piecesText(env, chosen) + (onTop.length ? ', and ' + piecesText(env, onTop) + ' standing on ' + (chosen.length > 1 ? 'them' : 'it') : '') + '. ' + lostGear(env, all) + 'Everything else stays; one UNDO in Build mode brings ' + (all.length > 1 ? 'them' : 'it') + ' back.' };
  }
  // a line on the floor by its name (its Inbox's label), in a room if one is named
  function lineNamed(live, env, raw, roomRaw) {
    const P = env.Pipeline, g = live.projectGeometry(), ox = g.origin.tx, oy = g.origin.ty;
    let comps = []; try { comps = P.lineComponents(g) || []; } catch (_) { comps = []; }
    const key = v => norm(String(v == null ? '' : v).replace(/&|\+/g, ' and ')).replace(/^the /, '').replace(/ (line|workflow|conveyor)$/, '');
    let room = null; if (roomRaw != null) { const t = roomNamed(live, roomRaw); if (!t.ok) return t; room = t.room; }
    const named = live.props().filter(p => p.t === 'intake' && (!room || live.roomAt(p.x, p.y) === room.id));
    const all = named.map(p => p.label || 'an unnamed line');
    // a line is found by ITS name: an unnamed line never answers to a name (an empty label is inside every string)
    if (!key(raw)) return refuse('Say which line: its name (or the id of any machine on it). Lines: ' + (all.length ? all.join(', ') : 'none') + '.');
    let hits = named.filter(p => key(p.label) && key(p.label) === key(raw));
    // …or by whole words of it ("research" finds "Research + write"): letters inside a word never match ("email triage" is not the
    // line "AI", whose letters sit inside "email" — a schedule or a paid test landed on the wrong line)
    const words = v => ' ' + key(v) + ' ';
    if (!hits.length) hits = named.filter(p => key(p.label) && (words(p.label).indexOf(words(raw)) >= 0 || words(raw).indexOf(words(p.label)) >= 0));
    if (!hits.length) return refuse('There is no line called "' + String(raw).slice(0, 40) + '"' + (room ? ' in ' + room.name : '') + '. Lines: ' + (all.length ? all.join(', ') : 'none') + '.');
    if (hits.length > 1) return refuse('More than one line is called ' + (hits[0].label || '"' + raw + '"') + ': say which room it is in (' + hits.map(p => (live.rooms().find(r => r.id === live.roomAt(p.x, p.y)) || {}).name).join(', ') + ').');
    const intake = hits[0], comp = comps.find(c => (c.intakes || []).indexOf(intake.id) >= 0);
    if (!comp) return refuse('the line ' + (intake.label || '') + ' could not be read');
    const tiles = Object.keys(comp.tiles || {}).map(k => { const [x, y] = k.split(',').map(Number); return [x + ox, y + oy]; });
    const inRoom = live.rooms().find(r => r.id === live.roomAt(intake.x, intake.y));
    return { ok: true, intake, comp, tiles, room: inRoom, label: intake.label || 'the line' };
  }
  /* A LINE BY ITS NAME, OR BY ANY MACHINE ON IT (station.test_line, 2026-10-01): the compiled line id (the component key,
     which is the routing plan's lineId), its name and room, and its steps in order with who works each. */
  function lineRef(doc, env, ref, roomRef) {
    const WM = env && env.WorldModel, P = env && env.Pipeline;
    if (!WM || !P || !doc) return refuse('the station builder is not loaded on this page');
    const live = WM.create(clone(doc));
    let comp = null, label = null, room = null;
    const p = typeof ref === 'string' ? live.propById(ref) : null;
    if (p) {
      let comps = []; try { comps = P.lineComponents(live.projectGeometry()) || []; } catch (_) { comps = []; }
      comp = comps.find(c => (c.props || []).some(q => (q && q.id ? q.id : q) === p.id)) || null;
      if (!comp) return refuse('the ' + pieceName(env, p.t) + ' ' + p.id + ' is not on a line');
      const ip = live.propById((comp.intakes || [])[0]);
      label = (ip && ip.label) || 'the line'; room = ip ? live.rooms().find(r => r.id === live.roomAt(ip.x, ip.y)) : null;
    } else {
      const ln = lineNamed(live, env, ref, roomRef); if (!ln.ok) return ln;
      comp = ln.comp; label = ln.label; room = ln.room;
    }
    const steps = (comp.bays || []).map(b => live.propById(b && typeof b === 'object' ? (b.propId || b.id) : b)).filter(Boolean)
      .map(b => ({ id: b.id, role: b.role ? titleCase(b.role) : null, agent: b.agentId ? nameOf(env, b.agentId) : null }));
    if (!comp.key) return refuse('the line ' + label + ' could not be read');
    return { ok: true, lineId: comp.key, name: label, room: room ? room.name : null, steps, crewed: steps.filter(s => s.agent).length };
  }
  function editRemoveLine(live, env, q) {
    const bad = Object.keys(q).filter(k => ['line', 'room'].indexOf(k) < 0); if (bad.length) return refuse('remove { line, room } only takes line and room. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
    const ln = lineNamed(live, env, q.line, q.room); if (!ln.ok) return ln;
    const ids = ln.comp.props, props = ids.map(id => live.propById(id)).filter(Boolean);
    const staffed = [...new Set(props.filter(p => p.agentId).map(p => { const a = (env.crew || []).find(x => x && x.id === p.agentId); return a ? a.name : null; }).filter(Boolean))];
    const xs = props.map(p => p.x).concat(ln.tiles.map(t => t[0])), ys = props.map(p => p.y).concat(ln.tiles.map(t => t[1]));
    const box = { x1: Math.min(...xs) - 1, y1: Math.min(...ys) - 1, x2: Math.max(...props.map(p => p.x + (p.w || 1)), ...ln.tiles.map(t => t[0] + 1)), y2: Math.max(...props.map(p => p.y + (p.h || 1)), ...ln.tiles.map(t => t[1] + 1)) };
    return { ok: true, spec: { kind: 'edit', removeProps: ids.slice(), removeBelts: ln.tiles }, mark: ln.room ? ln.room.id : null, goneRects: [box], where: 'the removal of the line ' + ln.label,
      summary: 'Remove the line ' + ln.label + (ln.room ? ' from ' + ln.room.name : '') + ': its ' + props.length + ' machines and ' + ln.tiles.length + ' belt tiles go' + (staffed.length ? '; ' + staffed.join(', ') + (staffed.length > 1 ? ' are' : ' is') + ' no longer staffed on it' : '') + '. The room, the crew and every other line stay; one UNDO in Build mode brings it back.' };
  }
  function editSeat(live, env, q) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse('seat is { agent, room }: the agent whose desk moves, and the room it goes to.');
    const bad = Object.keys(q).filter(k => ['agent', 'room'].indexOf(k) < 0); if (bad.length) return refuse('seat only takes agent and room. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
    const a = agentOf(env, q.agent); if (!a.ok) return a;
    const t = roomNamed(live, q.room); if (!t.ok) return t;
    const room = t.room, name = ((env.crew || []).find(x => x && x.id === a.id) || {}).name || 'that agent';
    const seats = live.props().filter(p => p.agentId === a.id && SEAT_T.test(p.t));
    if (seats.some(p => live.roomAt(p.x, p.y) === room.id)) return refuse(name + ' already has a desk in ' + room.name + '.');
    const scratch = env.WorldModel.create(clone(live.serialize()));
    for (const p of seats) scratch.removeProp(p.id);
    const slot = recruitDesks(scratch, env, room.id, 1)[0];
    if (!slot) return refuse('There is no clear spot for a desk in ' + room.name + ' (a desk needs a clear stretch of wall with room for its chair). Clear some floor there first, or pick another room.');
    const from = [...new Set(seats.map(p => (live.rooms().find(r => r.id === live.roomAt(p.x, p.y)) || {}).name).filter(Boolean))];
    return { ok: true, spec: { kind: 'edit', removeProps: seats.map(p => p.id), reseat: [{ agentId: a.id, desk: slot }] }, mark: room.id, where: name + '\'s desk in ' + room.name,
      summary: (seats.length ? name + '\'s desk moves from ' + from.join(' and ') + ' to ' + room.name : name + ' gets a desk in ' + room.name) + ', in a tidy spot against its wall. Nothing else moves; one UNDO in Build mode puts it back.' };
  }
  /* MOVE A ROOM with everything in it (its furniture, machines, belts and seats ride along): beside a room on a side
     (beside the main room when only a side is given). Its old hallways that would join nothing go, and a new corridor,
     planted and lit, joins it where it lands. */
  // what of a moving room's contents is worth naming: its lines and its agents' desks
  function rideText(live, ids) {
    const ps = ids.map(id => live.propById(id)).filter(Boolean), lines = ps.filter(p => p.t === 'intake').length, seats = ps.filter(p => p.agentId && SEAT_T.test(p.t)).length;
    return (lines ? ', its ' + (lines > 1 ? lines + ' lines' : 'line') + ' too' : '') + (seats ? ', and ' + (seats > 1 ? seats + ' agents\' desks' : 'an agent\'s desk') : '');
  }
  function editMove(doc, live, env, q, before) {
    const WM = env.WorldModel;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse('move is { room, beside, side }: the room, and beside which room and on which side it goes (beside the main room when only a side is given).');
    const bad = Object.keys(q).filter(k => ['room', 'beside', 'side', 'hallway'].indexOf(k) < 0); if (bad.length) return refuse('move only takes room, beside, side and hallway. Not accepted: ' + bad.slice(0, 6).join(', ') + '. Rooms do not resize: remove one and build it again the size it should be.');
    const t = roomNamed(live, q.room); if (!t.ok) return t;
    const room = t.room, main = mainRoom(live), spawnId = (live.serialize().meta || {}).spawnRoomId;
    if ((main && room.id === main.id) || room.id === spawnId) return refuse(room.name + ' is the main room: the station is built round it, so it stays. Move the rooms round it instead.');
    if (room.rects.length > 1) return refuse(room.name + ' is not a plain rectangle, so it cannot be moved whole.');
    const R = room.rects[0], W = R.x2 - R.x1 + 1, H = R.y2 - R.y1 + 1;
    const sd = sideOf(q.side); if (!sd.ok) return sd;
    const hl = hallOf(q.hallway); if (!hl.ok) return hl;
    // where it can go: on a copy without it (and without the hallways that would hang loose)
    const free = WM.create(clone(doc)); free.removeRoom(room.id);
    const halls = danglingHalls(live, free, new Set([room.id]));
    let cands = [];
    if (q.beside != null || q.side != null) {
      const tq = q.beside != null ? roomNamed(free, q.beside) : { ok: true, room: mainRoom(free) }; if (!tq.ok) return tq;
      if (tq.room && tq.room.id === room.id) return refuse('A room cannot move beside itself.');
      const pl = roomPlacements(free, tq.room, W, H, { side: sd.side, len: hl.len, align: null, kind: room.kind, hangs: hangsOf(env) });
      if (!pl.ok) return refuse('There is no clear place for ' + room.name + ' (' + W + ' × ' + H + ')' + (tq.room ? ' beside ' + tq.room.name : '') + (sd.side ? ' to the ' + sd.side : '') + ': ' + String(pl.error || 'nothing fits').replace(/\.+$/, '') + '.');
      cands = pl.list;
    } else return refuse('Say where ' + room.name + ' goes: beside which room, and on which side (north, south, east or west).');
    if (!cands.length) return refuse('There is no clear place for ' + room.name + ' there.');
    const riders = live.props().filter(p => p.x >= R.x1 && p.y >= R.y1 && p.x + (p.w || 1) - 1 <= R.x2 && p.y + (p.h || 1) - 1 <= R.y2).map(p => p.id);
    let why = null;
    for (const cand of cands) {
      const dx = cand.rect.x1 - R.x1, dy = cand.rect.y1 - R.y1;
      if (!dx && !dy) continue;
      const spec = { kind: 'edit', removeRooms: halls.slice(), moveRoom: { id: room.id, dx, dy }, newHall: cand.hall ? { rect: cand.hall, deck: CORRIDOR_DECK, props: [] } : null };
      // the new corridor dressed like a layout's, from a copy with the room already there
      if (spec.newHall) { try { const pr = WM.create(clone(doc)), b0 = editInto(pr, spec); if (b0.ok) { const hid = pr.roomAt((cand.hall.x1 + cand.hall.x2) >> 1, (cand.hall.y1 + cand.hall.y2) >> 1); const dh = hid ? dressHall(pr, env, hid, null) : null; spec.newHall.props = (dh && dh.props) || []; } } catch (_) {} }
      const moved = { propIds: riders, rects: [R] };
      const ck = editChecks(doc, live, spec, env, before, [], moved);
      if (!ck.ok) { why = why || ck; continue; }
      const at = q.beside != null || q.side != null ? (cand.side || '') + ' of ' + (cand.target || '') : 'the next free place of the grid (' + (cand.side || '') + ' of ' + (cand.target || '') + ')';
      return { ok: true, spec, moved, mark: room.id, where: 'the move of ' + room.name,
        summary: 'Move ' + room.name + ' (' + W + ' × ' + H + ') to ' + at + ', with everything in it' + (riders.length ? ' (all ' + riders.length + ' of its pieces ride along' + rideText(live, riders) + ')' : '') + '. '
          + (halls.length ? 'Its old ' + (halls.length > 1 ? halls.length + ' hallways go' : 'hallway goes') + (cand.hall ? ' and a new one joins it there. ' : '. ') : cand.hall ? 'A new hallway joins it there. ' : '')
          + 'One UNDO in Build mode puts it back.' };
    }
    return why || refuse('There is no clear place to move ' + room.name + ' to.');
  }
  /* RESTAFF AN EXISTING LINE: who works each step (in run order) and what it is told, set on the line where it stands.
     "new" is not here: recruiting comes with a new line, or the crew panel. */
  function editStaff(live, env, q) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse('staff is { line, room?, steps: [ { step, agent, instructions } ] }.');
    const bad = Object.keys(q).filter(k => ['line', 'room', 'steps'].indexOf(k) < 0); if (bad.length) return refuse('staff only takes line, room and steps. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
    const ln = lineNamed(live, env, q.line, q.room); if (!ln.ok) return ln;
    const list = Array.isArray(q.steps) ? q.steps : null;
    if (!list || !list.length) return refuse('steps is a list of { step, agent, instructions }: the step by its number in run order, the agent by name (or "lead", or "nobody" to clear it).');
    const bays = ln.comp.props.filter(id => { const p = live.propById(id); return p && p.t === 'bay'; });
    const cp = env.WorldModel.create(clone(live.serialize()));
    bays.forEach((pid, i) => cp.assignPropAgent(pid, '__sb_probe_' + i));
    const shape = readLine(cp, ln.comp.props, env, null), order = shape.order.length === bays.length ? shape.order : bays;
    const assign = [], briefs = [], out = [], seen = new Set();
    for (const x of list) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return refuse('Each step is { step, agent, instructions }.');
      const n = Number(x.step);
      if (!Number.isInteger(n) || n < 1 || n > order.length) return refuse('step is a number from 1 to ' + order.length + ' (the line ' + ln.label + ' has ' + order.length + (order.length === 1 ? ' step' : ' steps') + ').');
      if (seen.has(n)) return refuse('Step ' + n + ' is listed twice.'); seen.add(n);
      const pid = order[n - 1], bay = live.propById(pid), role = titleCase((bay && bay.role) || 'step');
      const row = { step: n, role, agent: null, instructions: '' };
      if (x.agent !== undefined) {
        if (/^(new|recruit|a new.*)$/i.test(String(x.agent || '').trim())) return refuse('A new recruit comes with a new line (station.plan with "new") or from the crew panel; staff an existing line with crew names.');
        if (x.agent === null || /^(nobody|none|no one|empty|unassigned|clear)$/i.test(String(x.agent).trim())) { assign.push({ id: pid, agentId: '' }); row.agent = 'nobody'; }
        else { const a = agentOf(env, x.agent); if (!a.ok) return a; assign.push({ id: pid, agentId: a.id }); row.agent = nameOf(env, a.id); }
      }
      if (x.instructions != null) {
        const txt = String(x.instructions).trim();
        if (!txt) return refuse('instructions for step ' + n + ' are empty.');
        if (txt.length > 2000) return refuse('instructions for step ' + n + ' are over 2000 characters.');
        briefs.push({ id: pid, brief: txt }); row.instructions = txt;
      }
      if (x.agent === undefined && x.instructions == null) return refuse('Step ' + n + ' changes nothing: give it an agent or instructions.');
      out.push(row);
    }
    // what the line will need once restaffed
    const pr = env.WorldModel.create(clone(live.serialize()));
    for (const a of assign) pr.assignPropAgent(a.id, a.agentId);
    const crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean), rd = readLine(pr, ln.comp.props, env, crewIds);
    return { ok: true, spec: { kind: 'edit', assign, briefs }, mark: ln.room ? ln.room.id : null, where: 'the crew of the line ' + ln.label,
      steps: out.map(r => ({ step: r.step, role: r.role, agent: r.agent, instructions: r.instructions })),
      summary: 'Staff the line ' + ln.label + ': ' + out.map(r => 'step ' + r.step + ' (' + r.role + ')' + (r.agent ? ' → ' + r.agent : '') + (r.instructions ? (r.agent ? ', with' : ' gets') + ' new instructions' : '')).join('; ') + '. '
        + (rd.ready ? 'It will be ready to run.' : 'Still to do after: ' + rd.blocking.join('; ') + '.') + ' Nothing on the floor moves; one UNDO in Build mode puts the crew back.' };
  }
  /* ================= BUILD MODE: the Commander's own tools, op by op =================
     Every op names exact WORLD tiles (as station.map reports them: x grows east, y grows south) and is run by the very
     world-model call Build Mode makes for that tool, so it passes or fails on Build Mode's own checks. Props and rooms
     made earlier in the same plan are named with `as` and used by that name. Ops run in order; the first that fails
     refuses the whole plan, naming it. */
  // the edits a long refit's card always names, and what it calls them when it has to count them
  const REFIT_WEIGHTY = { delete: 'removals', unbelt: 'belts taken up', resize: 'resizes', move: 'moves', type: 'room types', brief: 'briefs', hands: 'hand-offs', role: 'roles',
    agent: 'staffing', cap: 'budgets', budget: 'budgets', loop: 'loop rules', tries: 'loop rules', routes: 'routes', wait: 'joiner waits', swap: 'joiner swaps', folder: 'folders',
    bind: 'bound services', door: 'doors', edit: 'line edits' };
  const REFIT_MAX = 1500;   // a whole station designed by hand, room by room and piece by piece, fits one plan
  const REFIT_OPS = 'room, hall, resize, move, delete, rename, type, floor, walls, hull, paint, style, place, rotate, mirror, agent, door, belt, unbelt, connect, role, brief, hands, label, budget, cap, loop, tries, routes, wait, swap, folder, bind, stamp, edit';
  const LOOP_WHEN = /^(approved|revise|code|research|general)$/, CONNECTOR_T = /^connector_portal$/, DIR_WORD = { N: 'north', E: 'east', S: 'south', W: 'west' };
  const dirOf = v => { const s = String(v == null ? '' : v).trim().toLowerCase(); return { n: 'N', north: 'N', up: 'N', e: 'E', east: 'E', right: 'E', s: 'S', south: 'S', down: 'S', w: 'W', west: 'W', left: 'W' }[s] || null; };
  const tileRect = o => (o && isFinite(o.x) && isFinite(o.y) && isFinite(o.w) && isFinite(o.h) && o.w >= 1 && o.h >= 1) ? { x1: Math.round(o.x), y1: Math.round(o.y), x2: Math.round(o.x) + Math.round(o.w) - 1, y2: Math.round(o.y) + Math.round(o.h) - 1 } : null;
  const tileOf = v => Array.isArray(v) && v.length === 2 && v.every(n => isFinite(n)) ? { x: Math.round(v[0]), y: Math.round(v[1]) } : v && isFinite(v.x) && isFinite(v.y) ? { x: Math.round(v.x), y: Math.round(v.y) } : null;
  const wmMsg = r => (r && (r.msg || r.error)) || 'it was refused';
  function refitOne(st, env, o, names, res, ctx) {
    const WM = env.WorldModel, S = env.PropSprites, at = (x, y) => '(' + x + ', ' + y + ')';
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.op !== 'string') return refuse('each edit is an object with an op (' + REFIT_OPS + ')');
    const op = o.op.toLowerCase().trim();
    const roomRef = ref => { if (ref == null) return refuse('it needs a room'); if (names[ref] && st.rooms().some(r => r.id === names[ref])) return { ok: true, room: st.rooms().find(r => r.id === names[ref]) };
      const byId = st.rooms().find(r => r.id === ref); if (byId) return { ok: true, room: byId }; return roomNamed(st, ref); };
    const propRef = ref => { const id = names[ref] || ref; const p = typeof id === 'string' ? st.propById(id) : null; if (p) return { ok: true, p };
      const t = tileOf(ref); if (t) { const pid = st.propAt(t.x, t.y), q = pid ? st.propById(pid) : null; if (q) return { ok: true, p: q }; }
      return refuse('there is no piece "' + String(typeof ref === 'object' ? JSON.stringify(ref) : ref).slice(0, 40) + '" (use an id from station.map with { room } detail, a name given with as, or a tile [x, y])'); };
    const nm = t => pieceName(env, t), inRoom = (x, y) => { const id = st.roomAt(x, y), r = id && st.rooms().find(q => q.id === id); return r ? ' in ' + r.name : ''; };
    const did = (r, text) => r && r.ok ? { ok: true, text, res: r } : refuse(wmMsg(r));
    const targetOf = ref => { if (ref == null) return null; const id = names[ref] || ref, pp = typeof id === 'string' ? st.propById(id) : null; if (pp) return pp; const tt = tileOf(ref); if (!tt) return null; const pid = st.propAt(tt.x, tt.y), q = pid ? st.propById(pid) : null; return q || { x: tt.x, y: tt.y, w: 1, h: 1 }; };
    const isMain = rm => { const m = mainRoom(st), sp = (st.serialize().meta || {}).spawnRoomId; return (m && rm.id === m.id) || rm.id === sp; };
    const jcfg = p => { const c = {}; for (const k of ['routes', 'def', 'bufferSize', 'timeoutMin', 'maxIter', 'done', 'esc', 'when']) if (p[k] != null) c[k] = clone(p[k]); return c; };   // a junction edit changes only what it names
    const intakeOf = p => { if (p.t === 'intake') return p; if (!env.Pipeline || !env.Pipeline.lineComponents) return null; const g = st.projectGeometry(), o0 = g.origin || { tx: 0, ty: 0 }; const c = env.Pipeline.lineComponents(g).find(k => (k.props || []).some(q => (q && q.id ? q.id : q) === p.id)); const id = c && (c.intakes || [])[0]; return id ? st.propById(id) : null; };
    switch (op) {
      case 'room': case 'hall': {
        const rects = Array.isArray(o.rects) ? o.rects.map(tileRect) : [tileRect(o)];
        if (!rects.length || rects.some(r => !r)) return refuse('a ' + op + ' is { x, y, w, h } in tiles' + (op === 'room' ? ', or rects: [ { x, y, w, h }, … ] for an L or U' : ''));
        if (op === 'hall') { if (rects.length > 1) return refuse('a hall is one straight run; give several hall edits for a turning one'); const r = st.placeHallway({ rect: rects[0] }); if (!r || !r.ok) return refuse(wmMsg(r)); st.setDeck(r.id, CORRIDOR_DECK); if (o.as) names[o.as] = r.id; const R = rects[0]; return { ok: true, text: 'a ' + (R.x2 - R.x1 + 1) + ' × ' + (R.y2 - R.y1 + 1) + ' hallway at ' + at(R.x1, R.y1) }; }
        const kind = o.kind == null ? 'hab' : String(o.kind).toLowerCase(), K = WM.ROOM_KINDS || {};
        const kid = K[kind] ? kind : Object.keys(K).find(k => K[k].label && K[k].label.toLowerCase() === kind);
        if (!kid || kid === 'corridor') return refuse('kind is one of ' + Object.keys(K).filter(k => k !== 'corridor').join(', ') + ' (use hall for a hallway)');
        const name = typeof o.name === 'string' && o.name.trim() ? o.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : null;
        if (name && st.rooms().some(r => r.kind !== 'corridor' && norm(r.name) === norm(name))) return refuse('a room is already called ' + name);
        const r = st.addRoom(Object.assign({ kind: kid, rects }, name ? { name } : {})); if (!r || !r.ok) return refuse(wmMsg(r));
        if (o.as) names[o.as] = r.id;
        const rm = st.rooms().find(q => q.id === r.id), B = bboxOf(rm);
        return { ok: true, text: 'a new ' + (B.x2 - B.x1 + 1) + ' × ' + (B.y2 - B.y1 + 1) + ' ' + ((K[kid] || {}).label || kid) + ' room ' + rm.name + (rects.length > 1 ? ' (' + rects.length + ' sections)' : '') + ' at ' + at(B.x1, B.y1) };
      }
      case 'resize': { const t = roomRef(o.room); if (!t.ok) return t; const R = tileRect(o); if (!R) return refuse('resize is { room, x, y, w, h }: its whole new footprint'); return did(st.resizeRoom ? st.resizeRoom(t.room.id, R) : refuse('this page cannot resize rooms; reload it'), t.room.name + ' resized to ' + (R.x2 - R.x1 + 1) + ' × ' + (R.y2 - R.y1 + 1) + ' at ' + at(R.x1, R.y1)); }
      case 'rename': { const t = roomRef(o.room); if (!t.ok) return t; const n2 = String(o.name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24); if (!n2) return refuse('rename needs a name'); if (st.rooms().some(r => r.id !== t.room.id && r.kind !== 'corridor' && norm(r.name) === norm(n2))) return refuse('a room is already called ' + n2); const was = t.room.name; return did(st.renameRoom(t.room.id, n2), was + ' renamed ' + n2); }
      case 'type': { const t = roomRef(o.room); if (!t.ok) return t; const K = WM.ROOM_KINDS || {}, k = String(o.kind || '').toLowerCase(), kid = K[k] ? k : Object.keys(K).find(q => K[q].label && K[q].label.toLowerCase() === k); if (!kid) return refuse('kind is one of ' + Object.keys(K).filter(q => q !== 'corridor').join(', ')); return did(st.setRoomKind ? st.setRoomKind(t.room.id, kid) : refuse('this page cannot change a room type; reload it'), t.room.name + ' becomes a ' + ((K[kid] || {}).label || kid) + ' room'); }
      case 'floor': case 'walls': case 'hull': { const t = roomRef(o.room); if (!t.ok) return t; const v = {}; if (o.style != null) v.style = o.style; if (o.mat != null) v.mat = o.mat; if (!Object.keys(v).length) return refuse(op + ' needs a style and/or a mat'); const fn = op === 'floor' ? 'setDeck' : op === 'walls' ? 'setWalls' : 'setHull'; return did(st[fn](t.room.id, v), t.room.name + '\'s ' + (op === 'floor' ? 'floor' : op) + ' ' + [v.style, v.mat].filter(Boolean).join(' ')); }
      case 'paint': { const t = roomRef(o.room); if (!t.ok) return t; const tiles = (Array.isArray(o.tiles) ? o.tiles : []).map(tileOf).filter(Boolean).map(q => [q.x, q.y]); if (!tiles.length) return refuse('paint needs tiles: [[x, y], …]'); return did(st.paintTiles(t.room.id, tiles, o.style), tiles.length + ' tiles of ' + t.room.name + ' painted ' + o.style); }
      case 'style': { const t = roomRef(o.room); if (!t.ok) return t; const sid = env.RoomStyles && env.RoomStyles.resolveRoom ? env.RoomStyles.resolveRoom(o.style) : null; if (!sid) return refuse('style is one of ' + env.RoomStyles.ROOM_ORDER.join(', '));
        const rec = env.RoomStyles.ROOMS[sid]; if (rec.deck) st.setDeck(t.room.id, rec.deck); if (rec.walls) st.setWalls(t.room.id, rec.walls); const d = dressRoom(st, env, t.room.id, sid); if (!d.ok) return d; return { ok: true, text: t.room.name + ' furnished as ' + rec.name.toLowerCase() + ' (' + (d.props.length ? piecesText(env, d.props) : 'no clear floor left') + ')' }; }
      case 'place': {
        const t = String(o.t || o.piece || '');
        const sp = S && S.spec ? S.spec(t) : null;
        let tt = sp ? t : resolvePiece(env, t, pieceIndex(env));
        if (!tt && MACHINE_T.test(t)) tt = t;
        if (!tt || !S.spec(tt)) return refuse('there is no piece "' + t.slice(0, 40) + '" (station.map with { catalog: true } lists every piece and its size)');
        const q = tileOf(o); if (!q) return refuse('place needs x and y: the piece\'s top-left tile');
        // toward: what the piece faces (a chair its table, a sofa its screen): the builder works out r, never backwards
        let r = o.r == null ? 0 : Math.round(Number(o.r));
        let tg = null;
        if (o.toward != null) { tg = targetOf(o.toward); if (!tg) return refuse('toward is a piece (an id, an as, or a tile with a piece on it) or a tile [x, y] for it to face'); const sp0 = S.spec(tt); r = facingToward({ x: q.x, y: q.y, w: sp0.w, h: sp0.h }, tg); }
        if (!(r >= 0 && r <= 3)) return refuse('r is 0 (facing south), 1 (west), 2 (north) or 3 (east)');
        // a piece drawn facing one way ships as a LEFT and a RIGHT twin (recliner faces west, recliner_r east): toward, or r
        // west or east, picks the twin that faces that way, never a backwards one (Andrew 10-02: "always backwards")
        let mirror = !!o.m, twinNote = '';
        const side = sideFacing(S, tt), twin = side != null && o.toward != null || side != null && (r === 1 || r === 3) ? twinOf(S, tt) : null;
        if (twin) {
          let want = r;
          if (tg) { const sp0 = S.spec(tt), dx = (tg.x + (tg.w || 1) / 2) - (q.x + sp0.w / 2); if (!dx) return refuse('a ' + nm(tt) + ' faces only west or east: give toward something to its west or east'); want = dx < 0 ? 1 : 3; }
          if (want !== side) tt = twin;
          r = 0; mirror = false; twinNote = ', facing ' + (want === 1 ? 'west' : 'east');
        }
        // toward is an aim, not an order: a piece that cannot turn that way (a stool) stands as drawn, and the card says so
        if (o.toward != null && r && ((S.canRotate && !S.canRotate(tt)) || (S.facings && S.facings(tt).indexOf(r) < 0))) { r = 0; twinNote = ' (it does not turn that way, so it stands as drawn)'; }
        if (r && S.canRotate && !S.canRotate(tt)) return refuse('a ' + nm(tt) + ' does not turn');
        if (r && S.facings && S.facings(tt).indexOf(r) < 0) return refuse('a ' + nm(tt) + ' cannot face ' + ['south', 'west', 'north', 'east'][r] + ' (it faces ' + S.facings(tt).map(k => ['south', 'west', 'north', 'east'][k]).join(', ') + ')');
        if (mirror && S.canMirror && !S.canMirror(tt)) return refuse('a ' + nm(tt) + ' does not flip');
        const box = S.footprintAt ? S.footprintAt(tt, r) : null, sp2 = S.spec(tt), w = (box && box.w) || sp2.w, h = (box && box.h) || sp2.h;
        const p = { t: tt, x: q.x, y: q.y, w, h, block: sp2.blocks !== false };
        if (r) p.r = r; if (mirror) p.m = 1; if (tt === 'airlock') p.door = 'closed';
        const a = st.addProp(p); if (!a || !a.ok) return refuse(wmMsg(a));
        if (o.as) names[o.as] = a.id;
        if (ctx && o.toward != null) ctx.aimed.add(a.id);
        return { ok: true, text: (/^[aeiou]/.test(nm(tt)) ? 'an ' : 'a ') + nm(tt) + ' at ' + at(q.x, q.y) + inRoom(q.x, q.y) + (r ? ', facing ' + ['south', 'west', 'north', 'east'][r] : '') + twinNote + (mirror ? ', flipped' : '') };
      }
      case 'move': {
        if (o.room != null) { const t = roomRef(o.room); if (!t.ok) return t; if (isMain(t.room)) return refuse(t.room.name + ' is the main room: the station is built round it'); const q = tileOf(o); if (!q) return refuse('move a room with its new top-left x and y'); const B = bboxOf(t.room); return did(st.moveRoom(t.room.id, q.x - B.x1, q.y - B.y1), t.room.name + ' moved to ' + at(q.x, q.y) + ' with everything in it'); }
        const t = propRef(o.prop); if (!t.ok) return t; const q = tileOf(o.to || o); if (!q) return refuse('move a piece with its new top-left x and y'); const p = t.p, from = at(p.x, p.y);
        if (ctx) ctx.touched.add(p.id);
        return did(st.moveProp(p.id, q.x - p.x, q.y - p.y), 'the ' + nm(p.t) + ' at ' + from + ' moved to ' + at(q.x, q.y) + inRoom(q.x, q.y));
      }
      case 'rotate': { const t = propRef(o.prop); if (!t.ok) return t; let r = Math.round(Number(o.r));
        if (o.toward != null) { const tg = targetOf(o.toward); if (!tg) return refuse('toward is a piece (an id, an as, or a tile with a piece on it) or a tile [x, y] for it to face'); r = facingToward(t.p, tg); }
        if (ctx) (o.toward != null ? ctx.aimed : ctx.touched).add(t.p.id);
        // a LEFT/RIGHT twin (a recliner) turns west or east by flipping
        const side = sideFacing(S, t.p.t);
        if (side != null) {
          let want = r;
          if (o.toward != null) { const tg = targetOf(o.toward), dx = (tg.x + (tg.w || 1) / 2) - (t.p.x + (t.p.w || 1) / 2); if (!dx) return refuse('a ' + nm(t.p.t) + ' faces only west or east: give toward something to its west or east'); want = dx < 0 ? 1 : 3; }
          if (want !== 1 && want !== 3) return refuse('a ' + nm(t.p.t) + ' faces only west or east (r 1 or 3, or toward)');
          const face = 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' turned to face ' + (want === 1 ? 'west' : 'east');
          return facingOf(S, t.p) === want ? { ok: true, text: face + ' (it already did)' } : did(st.mirrorProp(t.p.id), face);
        }
        if (!(r >= 0 && r <= 3)) return refuse('r is 0 (south), 1 (west), 2 (north) or 3 (east), or give toward: what it should face'); if (S.canRotate && !S.canRotate(t.p.t)) return refuse('a ' + nm(t.p.t) + ' does not turn');
        if (S.facings && S.facings(t.p.t).indexOf(r) < 0) return refuse('a ' + nm(t.p.t) + ' cannot face ' + ['south', 'west', 'north', 'east'][r] + ' (it faces ' + S.facings(t.p.t).map(k => ['south', 'west', 'north', 'east'][k]).join(', ') + ')'); const box = S.footprintAt ? S.footprintAt(t.p.t, r) : null; return did(st.faceProp(t.p.id, r, box || undefined), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' turned to face ' + ['south', 'west', 'north', 'east'][r]); }
      case 'mirror': { const t = propRef(o.prop); if (!t.ok) return t; if (S.canMirror && !S.canMirror(t.p.t)) return refuse('a ' + nm(t.p.t) + ' does not flip'); return did(st.mirrorProp(t.p.id), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' flipped'); }
      case 'delete': {
        // a hallway by the name a refusal or station.map gives it ("CORRIDOR-1117"), by an `as`, or by a tile on it
        const hallOf = ref => { if (ref == null) return null; const tt = tileOf(ref), onTile = tt ? st.roomAt(tt.x, tt.y) : null;
          return st.rooms().find(r => r.kind === 'corridor' && (r.id === ref || r.id === onTile || names[ref] === r.id || (typeof ref === 'string' && norm(r.name) === norm(ref)))) || null; };
        const hall = o.hall != null ? hallOf(o.hall) : hallOf(o.room);
        if (o.hall != null && !hall) return refuse('there is no hallway "' + String(typeof o.hall === 'object' ? JSON.stringify(o.hall) : o.hall).slice(0, 40) + '" (station.map lists every hallway under halls)');
        // what goes with a removal: every piece TOUCHING it (removeRoom's own rule), and an agent's desk or a line's machine by name
        const goes = room => { const ps = st.props().filter(p => touchesRoom(p, room)), key = ps.filter(p => p.agentId || MACHINE_T.test(p.t));
          return { n: ps.length, named: key.length ? ' (' + key.slice(0, 6).map(p => p.agentId ? nameOf(env, p.agentId) + '\'s ' + nm(p.t) : 'the ' + nm(p.t)).join(', ') + (key.length > 6 ? ' …' : '') + ')' : '' }; };
        if (hall) { const B = bboxOf(hall), g = goes(hall), n = g.n; return did(st.removeRoom(hall.id), 'the hallway ' + hall.name + ' at ' + at(B.x1, B.y1) + ' taken up' + (n ? ', with the ' + n + (n === 1 ? ' piece' : ' pieces') + ' in or reaching into it' + g.named : '')); }
        if (o.room != null) { const t = roomRef(o.room); if (!t.ok) return t; if (isMain(t.room)) return refuse(t.room.name + ' is the main room, so it stays'); const g = goes(t.room), n = g.n; return did(st.removeRoom(t.room.id), t.room.name + ' removed, with the ' + n + (n === 1 ? ' piece' : ' pieces') + ' on it' + g.named); }
        const t = propRef(o.prop); if (!t.ok) return t; const p = t.p; return did(st.removeProp(p.id), 'the ' + nm(p.t) + ' at ' + at(p.x, p.y) + inRoom(p.x, p.y) + ' removed' + (p.agentId ? ' (it was ' + nameOf(env, p.agentId) + '\'s)' : ''));
      }
      case 'agent': { const t = propRef(o.prop); if (!t.ok) return t; let aid = ''; if (o.agent != null && !/^(nobody|none|no one|clear)$/i.test(String(o.agent))) { const a = agentOf(env, o.agent); if (!a.ok) return a; aid = a.id; } const as = st.assignDesk(t.p.id, aid); if (!as || !as.ok) return refuse(wmMsg(as));
        // one desk per agent (the station's assignDesk, the same rule as BUILD MODE's WHO SITS HERE): an agent given a desk
        // leaves the one it had — world.js seats it at its FIRST bound desk, so a second binding moved nobody — and the line says so
        const left = (as.released || []).map(id => st.propById(id)).filter(Boolean);
        // a desk seats its agent in its own chair: a chair already standing on its seat would make two, so it goes
        const gone = [];
        if (aid && isWorkstation(st, t.p.t)) { const row = seatRow(st.propById(t.p.id) || t.p, S), isSeat = isSeatPiece(env); for (const q of st.props().slice()) if (isSeat(q.t) && row.some(([x, y]) => x >= q.x && x < q.x + (q.w || 1) && y >= q.y && y < q.y + (q.h || 1))) { const rm = st.removeProp(q.id); if (rm && rm.ok) gone.push('the ' + nm(q.t) + ' at ' + at(q.x, q.y)); } }
        return { ok: true, text: 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + (aid ? ' is ' + nameOf(env, aid) + '\'s' : ' has nobody') + (gone.length ? ' (' + gone.join(', ') + ' removed: the desk brings its own chair)' : '')
          + (left.length ? '; ' + nameOf(env, aid) + ' leaves its ' + left.map(q => nm(q.t) + ' at ' + at(q.x, q.y)).join(' and its ') : '') }; }
      case 'door': { const t = propRef(o.prop); if (!t.ok) return t; return did(st.setDoorState(t.p.id, String(o.state || '')), 'the airlock at ' + at(t.p.x, t.p.y) + ' ' + o.state); }
      case 'belt': { const a = tileOf(o.from), b = tileOf(o.to); if (!a || !b) return refuse('a belt is { from: [x, y], to: [x, y] }, one straight run'); return did(st.placeBeltRun({ tx: a.x, ty: a.y }, { tx: b.x, ty: b.y }), 'a belt from ' + at(a.x, a.y) + ' to ' + at(b.x, b.y)); }
      case 'unbelt': { const tiles = (Array.isArray(o.tiles) ? o.tiles : []).map(tileOf).filter(Boolean).map(q => [q.x, q.y]); if (!tiles.length) return refuse('unbelt needs tiles: [[x, y], …]'); return did(st.removeBelts(tiles), tiles.length + ' belt tiles taken up'); }
      case 'connect': { const a = propRef(o.from); if (!a.ok) return a; const b = propRef(o.to); if (!b.ok) return b; return did(st.connectBelt(a.p.id, b.p.id), 'the ' + nm(a.p.t) + ' at ' + at(a.p.x, a.p.y) + ' belted to the ' + nm(b.p.t) + ' at ' + at(b.p.x, b.p.y)); }
      case 'role': { const t = propRef(o.prop); if (!t.ok) return t; const role = String(o.role || '').toUpperCase().replace(/[^A-Z]/g, ''); return did(st.setPropRole(t.p.id, role), 'the bay at ' + at(t.p.x, t.p.y) + ' is ' + (role ? titleCase(role) : 'roleless')); }
      case 'brief': { const t = propRef(o.prop); if (!t.ok) return t; const txt = String(o.text == null ? '' : o.text).trim(); if (!txt || txt.length > 2000) return refuse('brief text is 1 to 2000 characters'); return did(st.setPropBrief(t.p.id, txt), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' is told: "' + txt.slice(0, 160) + (txt.length > 160 ? '…' : '') + '"'); }
      case 'label': { const t = propRef(o.prop); if (!t.ok) return t; const txt = String(o.text == null ? '' : o.text).trim().slice(0, 48); return did(st.setPropLabel(t.p.id, txt), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' named ' + (txt || '(no name)')); }
      case 'cap': case 'budget': { const t = propRef(o.prop); if (!t.ok) return t; const ip = intakeOf(t.p); if (!ip) return refuse('that piece is not on a line with an inbox');
        const was = Object.assign({}, ip.limits || {}), nx = Object.assign({}, was), off = v => v == null || /^(none|no cap|off|default)$/i.test(String(v));
        const usd = (k, v, what) => { if (v === undefined) return null; if (off(v)) { delete nx[k]; return null; } const n = Number(v); if (!(n > 0 && n <= 10000)) return what + ' is a dollar amount above 0, or null for the default'; nx[k] = n; return null; };
        // a cap names its amount (usd, or the budget's own perDay): one left out took the line's day cap OFF, never asked for
        const capV = op === 'cap' ? (o.usd !== undefined ? o.usd : o.perDay) : o.perDay;
        if (op === 'cap' && capV === undefined) return refuse('cap is { op: "cap", prop, usd }: a dollar amount a day, or null for no day cap');
        const e1 = usd('maxUsdPerDay', capV, op === 'cap' ? 'cap usd' : 'perDay'); if (e1) return refuse(e1);
        if (op === 'budget') { const e2 = usd('maxUsdPerMessage', o.perJob, 'perJob'); if (e2) return refuse(e2); if (o.stages !== undefined) { if (off(o.stages)) delete nx.maxHops; else { const n = Math.round(Number(o.stages)); if (!(n >= 1 && n <= 200)) return refuse('stages is how many steps one job may pass through, 1 to 200'); nx.maxHops = n; } } }
        const r = st.setPropLimits(ip.id, Object.keys(nx).length ? nx : null); if (!r || !r.ok) return refuse(wmMsg(r)); const L2 = r.limits || {};
        const money = (v, per) => v == null ? 'no ' + per + ' cap' : '$' + v + ' a ' + per;
        return { ok: true, text: 'the line at ' + at(ip.x, ip.y) + (Object.keys(nx).length ? ' may spend ' + money(L2.maxUsdPerDay, 'day') + ', ' + money(L2.maxUsdPerMessage, 'job') + ', through ' + (L2.maxHops == null ? 'the default number of' : L2.maxHops) + ' steps' : ' keeps the default budget') + ((r.clamped || []).length ? ' (held to the ceiling)' : '') }; }
      case 'tries': case 'loop': { const t = propRef(o.prop); if (!t.ok) return t; if (t.p.t !== 'loop') return refuse(op + ' is for a LOOP gate'); const cfg = jcfg(t.p), said = [];
        const n = o.max !== undefined ? o.max : o.passes; if (n !== undefined) { const k = Math.round(Number(n)); if (!(k >= 1 && k <= 20)) return refuse('a loop allows 1 to 20 passes'); cfg.maxIter = k; said.push('allows ' + k + (k === 1 ? ' pass' : ' passes')); }
        if (o.until !== undefined) { const w = String(o.until || '').toLowerCase().trim(); if (!LOOP_WHEN.test(w)) return refuse('until is approved, revise (the reviewer\'s VERDICT), or code, research or general (repeat while the result is that kind)'); cfg.when = w; said.push(/^(approved|revise)$/.test(w) ? 'repeats until the verdict is ' + w : 'repeats while the result is ' + w); }
        // a loop escalates down any third belt wired to it (the pipeline reads the wiring), so "never" is a belt taken up, not a setting
        if (o.escalate === null || /^(none|never|no|off)$/i.test(String(o.escalate))) return refuse('a loop escalates down its third belt: to stop it escalating, take that belt up ({ op: "unbelt", tiles })');
        for (const [k, key, word] of [['done', 'done', 'moves on'], ['escalate', 'esc', 'escalates']]) if (o[k] !== undefined) { const d = dirOf(o[k]); if (!d) return refuse(k + ' is the side work leaves by: north, east, south or west'); cfg[key] = d; said.push(word + ' ' + DIR_WORD[d]); }
        if (!said.length) return refuse('loop sets passes, until, done or escalate'); return did(st.configureJunction(t.p.id, cfg), 'the loop at ' + at(t.p.x, t.p.y) + ' ' + said.join(', ')); }
      case 'routes': { const t = propRef(o.prop); if (!t.ok) return t; if (t.p.t !== 'filter') return refuse('routes is for a FILTER (a sorter): which kind of work leaves by which side'); const cfg = jcfg(t.p); if (o.routes === undefined && o.def === undefined) return refuse('routes sets routes: { code | research | general: side } and/or def');
        if (o.routes !== undefined) { cfg.routes = {}; for (const [tag, side] of Object.entries(o.routes || {})) { const d = dirOf(side); if (!d) return refuse('a route sends a kind of work out north, east, south or west'); cfg.routes[tag] = d; } }
        if (o.def !== undefined) { if (o.def == null) delete cfg.def; else { const d = dirOf(o.def); if (!d) return refuse('def is the side everything else leaves by'); cfg.def = d; } }
        return did(st.configureJunction(t.p.id, cfg), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + ' sorts ' + (Object.keys(cfg.routes || {}).join(', ') || 'nothing apart') + (cfg.def ? ', everything else ' + DIR_WORD[cfg.def] : '')); }
      case 'wait': { const t = propRef(o.prop); if (!t.ok) return t; if (t.p.t !== 'joiner') return refuse('wait is for a JOINER: how long it waits for every branch'); const cfg = jcfg(t.p); if (o.minutes == null || /^(default|none)$/i.test(String(o.minutes))) delete cfg.timeoutMin; else { const m = Math.round(Number(o.minutes)); if (!(m >= 1 && m <= 120)) return refuse('a joiner waits 1 to 120 minutes'); cfg.timeoutMin = m; }
        return did(st.configureJunction(t.p.id, cfg), 'the joiner at ' + at(t.p.x, t.p.y) + (cfg.timeoutMin ? ' waits up to ' + cfg.timeoutMin + ' minutes for every branch' : ' waits the default time')); }
      case 'swap': { const t = propRef(o.prop); if (!t.ok) return t; if (!/^(joiner|merger)$/.test(t.p.t)) return refuse('swap turns a JOINER (waits for every branch: the splitter copies to each) into a MERGER (takes each as it comes: the branches take turns), or back'); const to = t.p.t === 'joiner' ? 'merger' : 'joiner';
        return did(st.swapJoinerMerger(t.p.id), 'the ' + t.p.t + ' at ' + at(t.p.x, t.p.y) + ' becomes a ' + to + (to === 'joiner' ? ' (the branches each get a copy and it waits for all of them)' : ' (the branches take turns)')); }
      case 'hands': { const t = propRef(o.prop); if (!t.ok) return t; if (t.p.t !== 'bay') return refuse('hands is for a bay: what that step hands on'); const txt = String(o.text == null ? '' : o.text).replace(/\s+/g, ' ').trim(); if (txt.length > 160) return refuse('hands text is up to 160 characters');
        return did(st.setPropHands(t.p.id, txt), 'the bay at ' + at(t.p.x, t.p.y) + (txt ? ' hands on: "' + txt + '"' : ' hands on its whole result')); }
      case 'folder': { const t = propRef(o.prop); if (!t.ok) return t; const ip = intakeOf(t.p); if (!ip) return refuse('that piece is not on a line with an inbox'); if (!res || res.root == null) return refuse('the folder must be one of the Commander\'s trusted projects');
        return did(st.setPropProject(ip.id, res.root), 'the line at ' + at(ip.x, ip.y) + (res.root ? ' works in ' + res.name : ' works in no project folder')); }
      case 'bind': { const t = propRef(o.prop); if (!t.ok) return t; if (!res) return refuse('bind needs a service the station has'); const fn = t.p.t === 'plugin_terminal' ? 'bindPlugin' : 'bindConnector';
        if (t.p.t !== 'plugin_terminal' && !CONNECTOR_T.test(t.p.t)) return refuse('bind is for a connector portal (a connector) or a plugin terminal (a plugin)'); if (res.id && (fn === 'bindPlugin') !== (res.kind === 'plugin')) return refuse(fn === 'bindPlugin' ? 'a plugin terminal takes a plugin' : 'a connector portal takes a connector');
        return did(st[fn](t.p.id, res.id), 'the ' + nm(t.p.t) + ' at ' + at(t.p.x, t.p.y) + (res.id ? ' gives its room\'s agents ' + res.name + '\'s tools' : ' is unbound')); }
      case 'stamp': { const bp = resolveLine(WM, o.line); if (!bp) return refuse('there is no line called "' + String(o.line).slice(0, 40) + '" (lines: ' + lineList(WM) + ')'); const q = tileOf(o); if (!q) return refuse('stamp needs the line\'s top-left x and y'); const r = st.stampBlueprint(bp.id, q.x, q.y, {}); if (!r || !r.ok) return refuse(wmMsg(r)); if (o.as) names[o.as] = r.ids[0]; return { ok: true, text: 'the line ' + (bp.plain || bp.label) + ' laid at ' + at(q.x, q.y) + inRoom(q.x, q.y) }; }
      case 'edit': { const t = propRef(o.prop); if (!t.ok) return t; if (!env.LineEdit || !env.LineEdit.run) return refuse('line edits are not loaded on this page'); const args = Object.assign({}, o.args || {}); for (const k of ['from', 'to', 'after', 'around', 'id', 'split', 'head']) if (args[k] != null && names[args[k]]) args[k] = names[args[k]];
        const r = env.LineEdit.run(st, t.p.id, String(o.edit || ''), args, { sizes: sizesOf(env), tidy: !!o.tidy }); if (!r || !r.ok) return refuse(wmMsg(r)); if (o.as && r.focus) names[o.as] = r.focus; return { ok: true, text: 'the line at ' + at(t.p.x, t.p.y) + ' edited: ' + o.edit + (args.role ? ' (' + titleCase(String(args.role)) + ')' : '') }; }
      default: return refuse('there is no op "' + op.slice(0, 20) + '" (ops: ' + REFIT_OPS + ')');
    }
  }
  // every op in order on `st`; the first that fails refuses, naming it
  function refitAll(st, env, ops, resolved) {
    const names = {}, texts = [], ctx = { aimed: new Set(), touched: new Set() }, byOp = new Map();   // seat id -> the edit that put it there
    for (let i = 0; i < ops.length; i++) {
      let r;
      const had = new Set(st.props().map(p => p.id)), op = String((ops[i] && ops[i].op) || '').toLowerCase().trim(), touched = new Set(ctx.touched);
      try { r = refitOne(st, env, ops[i], names, resolved ? resolved[i] : null, ctx); } catch (e) { r = refuse(String((e && e.message) || e)); }
      if (!r.ok) return refuse('Edit ' + (i + 1) + ' (' + String((ops[i] && ops[i].op) || '?').slice(0, 12) + '): ' + r.error.replace(/\.$/, '') + '. Nothing was built; fix that edit and plan again.');
      texts.push(r.text);
      if (op === 'place') for (const p of st.props()) if (!had.has(p.id)) byOp.set(p.id, i);
      for (const id of ctx.touched) if (!touched.has(id)) byOp.set(id, i);
    }
    // the lead's chairs face their table (Andrew 10-02: "when it places left chair and right chair its always backwards"):
    // a seat placed, moved or turned by hand right beside a table or desk, and not aimed with toward, is turned to face it
    // once every edit is down (the table may come after its chairs); the edit that set it says so
    for (const [id, i] of byOp) {
      if (ctx.aimed.has(id)) continue;
      const turn = faceItsTable(st, env, id); if (!turn) continue;
      const what = 'the ' + pieceName(env, turn.table.t) + ' beside it';
      texts[i] = String((ops[i] && ops[i].op) || '').toLowerCase().trim() === 'place' ? texts[i].replace(/, facing (south|west|north|east)/, '') + ', facing ' + turn.dir + ' (turned to face ' + what + ')' : texts[i] + ' (then turned ' + turn.dir + ' to face ' + what + ')';
    }
    return { ok: true, texts, names };
  }
  // a folder or bind edit names a service the station has: matched here against env.services (the page reads them for the plan)
  function serviceOf(o, env) {
    const op = o && typeof o.op === 'string' ? o.op.toLowerCase().trim() : '';
    if (op !== 'folder' && op !== 'bind') return null;
    const sv = (env && env.services) || {}, none = v => v == null || /^(none|nothing|clear|no folder|unbind)$/i.test(String(v).trim());
    const pick = (rows, want, keys) => { const w = String(want).trim().toLowerCase(); return rows.find(r => keys.some(k => r[k] != null && String(r[k]).trim().toLowerCase() === w)) || rows.find(r => keys.some(k => r[k] != null && String(r[k]).toLowerCase().replace(/\\/g, '/').split('/').pop() === w)) || null; };
    if (op === 'folder') {
      if (none(o.project)) return { root: '', name: '' };
      if (!Array.isArray(sv.projects)) return { error: 'this page could not read the Commander\'s trusted projects; try again' };
      const p = pick(sv.projects, o.project, ['name', 'root']);
      return p ? { root: String(p.root), name: String(p.name || p.root) } : { error: '"' + String(o.project).slice(0, 60) + '" is not one of the Commander\'s trusted projects (' + (sv.projects.map(x => x.name || x.root).join(', ') || 'none yet') + '). The Commander trusts a folder under PROJECTS first' };
    }
    const want = o.plugin != null ? ['plugin', o.plugin] : o.connector != null ? ['connector', o.connector] : null;
    if (!want || none(want[1])) return { id: '', name: '', kind: want ? want[0] : null };
    const rows = want[0] === 'plugin' ? sv.plugins : sv.connectors;
    if (!Array.isArray(rows)) return { error: 'this page could not read the station\'s ' + want[0] + 's; try again' };
    const r = pick(rows, want[1], ['id', 'name', 'label']);
    return r ? { id: String(r.id), name: String(r.name || r.label || r.id), kind: want[0] } : { error: 'there is no ' + (want[0] === 'plugin' ? 'plugin that is on' : 'connected service') + ' called "' + String(want[1]).slice(0, 40) + '" (' + (rows.map(x => x.name || x.label || x.id).join(', ') || 'none yet') + ')' };
  }
  function planRefit(doc, ops, env) {
    const WM = env && env.WorldModel, P = env && env.Pipeline;
    if (!WM || !P || !doc) return refuse('the station builder is not loaded on this page');
    if (!Array.isArray(ops) || !ops.length) return refuse('refit is a list of edits, each { op, … } (ops: ' + REFIT_OPS + ').');
    if (ops.length > REFIT_MAX) return refuse('That is ' + ops.length + ' edits; send up to ' + REFIT_MAX + ' in one plan and the rest in the next.');
    const live = WM.create(clone(doc)), before = floorFacts(live, P), probe = WM.create(clone(doc));
    const resolved = ops.map(o => serviceOf(o, env)), bad = resolved.findIndex(x => x && x.error);
    if (bad >= 0) return refuse('Edit ' + (bad + 1) + ' (' + String(ops[bad].op) + '): ' + resolved[bad].error + '. Nothing was built; fix that edit and plan again.');
    const ran = refitAll(probe, env, ops, resolved); if (!ran.ok) return ran;
    // a refit never leaves a hallway leading nowhere (a room moved away from it, a hall drawn into empty space): that is how a
    // hand-moved station turned into corridor spaghetti (10-02)
    const strandedBefore = new Set(strandedHalls(live)), stranded = strandedHalls(probe).filter(id => !strandedBefore.has(id));
    if (stranded.length) {
      const hs = probe.rooms().filter(r => stranded.indexOf(r.id) >= 0), one = hs.length === 1;
      return refuse('That would leave ' + (one ? 'a hallway' : hs.length + ' hallways') + ' leading nowhere (' + hs.slice(0, 6).map(h => { const B = bboxOf(h); return h.name + ' at (' + B.x1 + ', ' + B.y1 + ')'; }).join(', ') + (hs.length > 6 ? ', …' : '')
        + '): a hallway joins two rooms. Take ' + (one ? 'it' : 'them') + ' up ({ op: "delete", hall: "' + hs[0].name + '" }) or join ' + (one ? 'it' : 'them') + ' to a room; to reshape the whole station, { rearrange: "diamond" } re-lays every room with clean hallways. Nothing was built.');
    }
    // nothing new stands on a desk's seat: the desk draws its own chair when an agent works it (Andrew 10-02: two chairs)
    const seatKey = b => b.piece.id + '@' + b.desk.id, seatsBefore = new Set(blockedSeats(live, env).map(seatKey)), seatHits = blockedSeats(probe, env).filter(b => !seatsBefore.has(seatKey(b)));
    if (seatHits.length) {
      const b = seatHits[0], pn = t => pieceName(env, t), more = seatHits.length > 1 ? ' (and ' + (seatHits.length - 1) + ' more like it)' : '';
      // the desk is the new one: say so, rather than blaming the piece that was already standing there
      if (!live.propById(b.desk.id) && live.propById(b.piece.id)) return refuse('The ' + pn(b.desk.t) + ' at (' + b.desk.x + ', ' + b.desk.y + ') would have its seat on the ' + pn(b.piece.t) + ' at (' + b.piece.x + ', ' + b.piece.y + '): a desk draws its own chair in front of it when an agent works it, so that row must be open' + more + '. Place the desk where the row in front of it is clear, or move the ' + pn(b.piece.t) + ' first. Nothing was built.');
      return refuse('The ' + pn(b.piece.t) + ' at (' + b.piece.x + ', ' + b.piece.y + ') would stand on the seat of the ' + pn(b.desk.t) + ' at (' + b.desk.x + ', ' + b.desk.y + '): a desk draws its own chair when an agent works it, so its seat row stays clear'
        + more + '. ' + (isSeatPiece(env)(b.piece.t) ? 'Never place a chair at a desk; put the piece elsewhere' : 'Put the ' + pn(b.piece.t) + ' elsewhere') + '. Nothing was built.');
    }
    // what the Commander should know before approving: routing that breaks, rooms nobody can walk into any more
    const after = floorFacts(probe, P), warn = [];
    const newErr = [...after.errs].filter(e => !before.errs.has(e));
    if (newErr.length) warn.push(newErr.length + (newErr.length === 1 ? ' routing problem' : ' routing problems') + ' on the floor after it (' + [...new Set(newErr.map(e => e.split(':')[0]))].join(', ') + ')');
    const wb = walkableRooms(live), wa = walkableRooms(probe), cut = probe.rooms().filter(r => r.kind !== 'corridor' && !wa.has(r.id) && (wb.has(r.id) || !live.rooms().some(x => x.id === r.id))).map(r => r.name);
    if (cut.length) warn.push((cut.length > 1 ? cut.join(', ') + ' cannot be walked into' : cut[0] + ' cannot be walked into') + ' from the main room');
    // a long refit shows its first edits, and EVERY edit that takes something away, moves or resizes, or changes what a line
    // does, spends or reaches, wherever it falls (judged by its op, never by its wording): none of those hides behind "and more"
    const list = ran.texts.map((t, i) => ({ t: (i + 1) + '. ' + t, k: REFIT_WEIGHTY[String((ops[i] && ops[i].op) || '').toLowerCase().trim()] || null }));
    let shown = list.map(x => x.t);
    if (list.length > 30) {
      const rest = list.slice(25), keep = rest.filter(x => x.k), named = keep.slice(0, 60), over = keep.slice(60);
      // a design of hundreds of edits: past 60 weighty ones the card counts the rest by kind (the preview shows them all)
      const counts = {}; for (const x of over) counts[x.k] = (counts[x.k] || 0) + 1;
      shown = list.slice(0, 25).map(x => x.t).concat(named.map(x => x.t), over.length ? ['… and ' + over.length + ' more edits that change what stands (' + Object.keys(counts).map(k => counts[k] + ' ' + k).join(', ') + ')'] : [],
        rest.length > keep.length ? ['… and ' + (rest.length - keep.length) + ' more edits that add or name pieces'] : []);
    }
    const summary = 'BUILD MODE, ' + ops.length + (ops.length === 1 ? ' edit' : ' edits') + ', in order: ' + shown.join('; ') + '.' + (warn.length ? ' Heads-up: ' + warn.join('; ') + '.' : '') + ' One UNDO in Build mode takes all of it back.';
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(probe.serialize()), spec: { kind: 'refit', ops: clone(ops), res: clone(resolved) }, summary, notes: warn, steps: [], line: null, where: 'a refit of ' + ops.length + (ops.length === 1 ? ' edit' : ' edits'), rooms: [],
      preview: previewOf(WM, doc, probe.serialize(), [], null) } };
  }

  /* UNDO THE LEAD'S OWN LAST BUILD: `last` is the page's record of the builds the lead made (newest last). Only while the
     station is exactly as that build left it, so it never takes back someone else's edit; one step, as Build mode's UNDO. */
  function planUndo(doc, last, opts) {
    if (!doc) return refuse('the station builder is not loaded on this page');
    if (!last) return refuse('There is nothing of the lead\'s to undo: StarNet only takes back a build the lead made on this station. The Commander can press UNDO in Build mode.');
    if (sigOf(doc) !== last.resultSig) return refuse('The station has changed since the lead\'s last build, so StarNet will not undo it (that could take back someone else\'s edit). The Commander can press UNDO in Build mode.');
    if (opts && opts.canUndo === false) return refuse('The page was reloaded since that build, so its one-step UNDO is gone. Take it back with an edit instead: a new room with { remove: room }, added pieces with { remove: { room, pieces } }, a new line with { remove: { line } }, a restaffing with { staff } as it was.');
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: last.floorSig, spec: { kind: 'undo' }, notes: [], steps: [], line: null, where: 'the undo of the last build', rooms: [],
      summary: 'Undo the last build (' + String(last.summary || 'the lead\'s last change').replace(/\s+/g, ' ').slice(0, 260).replace(/[.\s]+$/, '') + '): the station goes back exactly as it was before it.' + (last.recruited ? ' The agents it recruited stay on the crew (DELETE AGENT in a Dossier removes one).' : '') } };
  }
  function planEdit(doc, req, env) {
    const WM = env && env.WorldModel, P = env && env.Pipeline;
    if (!WM || !P || !doc) return refuse('the station builder is not loaded on this page');
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse(EDIT_HOW);
    const keys = Object.keys(req).filter(k => req[k] != null), extra = keys.filter(k => EDIT_KEYS.indexOf(k) < 0);
    if (extra.length) return refuse('An edit only takes one of: ' + EDIT_KEYS.join(', ') + '. Not accepted here: ' + extra.slice(0, 6).join(', ') + '. ' + EDIT_HOW);
    if (keys.length !== 1) return refuse(EDIT_HOW);
    if (keys[0] === 'refit') return planRefit(doc, req.refit, env);
    if (keys[0] === 'rearrange') return planRearrange(doc, req.rearrange, env);
    const live = WM.create(clone(doc)), main = mainRoom(live), spawnId = (live.serialize().meta || {}).spawnRoomId, before = floorFacts(live, P), RS = env.RoomStyles;
    const nameOfRoom = raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.room : raw);
    let spec, summary, where, mark = null, goneRects = [], moved = null, steps = [];
    const q0 = req[keys[0]], isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    let sub = null;
    if (keys[0] === 'add') sub = editAdd(live, env, q0);
    else if (keys[0] === 'seat') sub = editSeat(live, env, q0);
    else if (keys[0] === 'staff') sub = editStaff(live, env, q0);
    else if (keys[0] === 'move') sub = editMove(doc, live, env, q0, before);
    else if (keys[0] === 'remove' && isObj(q0) && q0.line != null) sub = editRemoveLine(live, env, q0);
    else if (keys[0] === 'remove' && isObj(q0) && q0.pieces != null) sub = editRemovePieces(live, env, q0);
    if (sub) {
      if (!sub.ok) return sub;
      spec = sub.spec; summary = sub.summary; where = sub.where; mark = sub.mark || null; goneRects = sub.goneRects || []; moved = sub.moved || null; steps = sub.steps || [];
    } else if (keys[0] === 'remove') {
      const list = Array.isArray(req.remove) ? req.remove : [req.remove];
      if (!list.length || list.length > 60) return refuse('remove is a room name, or a list of up to 60 room names.');
      const gone = [];
      for (const raw of list) {
        const t = roomNamed(live, nameOfRoom(raw)); if (!t.ok) return t;
        if ((main && t.room.id === main.id) || t.room.id === spawnId) return refuse(t.room.name + ' is the main room, so it stays. To lay everything else out again, plan a layout with replace: true.');
        if (!gone.some(r => r.id === t.room.id)) gone.push(t.room);
      }
      const goneIds = new Set(gone.map(r => r.id));
      goneRects = [].concat(...gone.map(r => r.rects));
      const inGone = p => goneIds.has(live.roomAt(p.x, p.y));
      const furniture = live.props().filter(p => inGone(p) && !MACHINE_T.test(p.t) && !(p.agentId && SEAT_T.test(p.t)));
      const intakes = live.props().filter(p => inGone(p) && p.t === 'intake'), machines = live.props().filter(p => inGone(p) && MACHINE_T.test(p.t));
      // an agent whose only seat stands there is seated again elsewhere
      const seats = live.props().filter(p => p.agentId && SEAT_T.test(p.t) && inGone(p) && !live.props().some(q => q.agentId === p.agentId && q.id !== p.id && SEAT_T.test(q.t) && !inGone(q)));
      // the hallways that joined what goes and now join nothing
      const scratch = WM.create(clone(doc)), wasNext = new Map();
      for (const h of live.rooms().filter(r => r.kind === 'corridor')) wasNext.set(h.id, zoneNeighbours(live, h.id));
      for (const r of gone) scratch.removeRoom(r.id);
      const halls = [];
      for (let changed = true; changed;) {
        changed = false;
        for (const h of scratch.rooms().filter(r => r.kind === 'corridor')) {
          const was = wasNext.get(h.id) || new Set();
          if (![...was].some(id => goneIds.has(id) || halls.indexOf(id) >= 0)) continue;   // it never touched what goes
          if (zoneNeighbours(scratch, h.id).size <= 1) { halls.push(h.id); scratch.removeRoom(h.id); changed = true; }
        }
      }
      const slots = seats.length ? desksFor(scratch, env, null, seats.length) : [];
      if (slots.length < seats.length) return refuse('There is no clear floor left for ' + seats.length + ' agents\' desks once ' + gone.map(r => r.name).join(' and ') + (gone.length > 1 ? ' go' : ' goes') + '. Clear some floor first (clear: a room), or remove fewer rooms.');
      spec = { kind: 'edit', removeRooms: gone.map(r => r.id).concat(halls), reseat: seats.map((p, i) => ({ agentId: p.agentId, desk: slots[i] })) };
      const deskRooms = [...new Set(slots.map(d => (scratch.rooms().find(r => r.id === scratch.roomAt(d.x, d.y)) || {}).name).filter(Boolean))];
      const crewName = id => { const a = (env.crew || []).find(x => x && x.id === id); return a ? a.name : 'an agent'; };
      const sized = gone.map(r => { const R = r.rects[0]; return r.name + ' (' + (R.x2 - R.x1 + 1) + ' × ' + (R.y2 - R.y1 + 1) + ')'; });
      summary = 'Remove ' + (sized.length > 1 ? sized.slice(0, -1).join(', ') + ' and ' + sized[sized.length - 1] : sized[0])
        + (halls.length ? ', with the ' + (halls.length > 1 ? halls.length + ' hallways' : 'hallway') + ' that joined ' + (gone.length > 1 ? 'them' : 'it') : '') + '. '
        + (furniture.length ? (gone.length > 1 ? 'Their furniture goes with them (' : 'Its furniture goes with it (') + shortList(env, furniture) + '). ' : '')
        + (machines.length ? (intakes.length ? (intakes.length > 1 ? intakes.length + ' workflow lines go too: ' : 'A workflow line goes too: ') + intakes.map(p => p.label || 'an unnamed line').join(', ') : machines.length + ' workflow machines go too') + '. ' : '')
        + lostGear(env, furniture)
        + (seats.length ? seats.map(p => crewName(p.agentId)).join(', ') + (seats.length > 1 ? ' get new desks in ' : ' gets a new desk in ') + deskRooms.join(' and ') + '. ' : '')
        + 'Agents and conversations stay; one UNDO in Build mode brings ' + (gone.length > 1 ? 'them' : 'it') + ' back.';
      where = 'the removal of ' + gone.map(r => r.name).join(', ');
    } else {
      const isRefurnish = keys[0] === 'refurnish', q = isRefurnish ? req.refurnish : req.clear;
      if (isRefurnish && (!q || typeof q !== 'object' || Array.isArray(q))) return refuse('refurnish is { room, style, name }: style is one of ' + RS.ROOM_ORDER.join(', ') + '.');
      if (isRefurnish) { const bad = Object.keys(q).filter(k => ['room', 'style', 'name'].indexOf(k) < 0); if (bad.length) return refuse('refurnish only takes room, style and name. Not accepted: ' + bad.slice(0, 6).join(', ') + '.'); }
      const t = roomNamed(live, nameOfRoom(q)); if (!t.ok) return t;
      const room = t.room;
      if (room.rects.length > 1) return refuse(room.name + ' is not a plain rectangle, so StarNet cannot furnish it. Build a new room instead.');
      const old = furnitureIn(live, room.id);
      if (!isRefurnish) {
        if (!old.length) return refuse(room.name + ' has no furniture to clear (its workflow lines and agents\' desks always stay).');
        spec = { kind: 'edit', removeProps: old.map(p => p.id) };
        summary = 'Clear ' + room.name + ': its ' + old.length + (old.length === 1 ? ' piece' : ' pieces') + ' of furniture go (' + shortList(env, old) + '). ' + lostGear(env, old) + 'Its workflow lines and agents\' desks stay; one UNDO in Build mode brings the furniture back.';
        where = 'the clearing of ' + room.name;
      } else {
        const sid = q.style != null && RS.resolveRoom ? RS.resolveRoom(q.style) : null;
        if (!sid) return refuse((q.style == null ? 'refurnish needs a style.' : 'There is no room style called "' + String(q.style).slice(0, 30) + '".') + ' Styles: ' + RS.ROOM_ORDER.join(', ') + '.');
        const rec = RS.ROOMS[sid];
        let name = typeof q.name === 'string' ? q.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : '';
        const taken = nm => live.rooms().some(r => r.id !== room.id && r.kind !== 'corridor' && norm(r.name) === norm(nm));
        if (name && taken(name)) return refuse('Another room is already called ' + name + '.');
        // a room still named for what it was (LOUNGE, ROOM 3) takes the name of what it becomes
        const auto = Object.keys(AUTO_NAME).some(k => AUTO_NAME[k] === room.name.replace(/ \d+$/, '')) || /^ROOM \d+$/.test(room.name);
        if (!name && auto && AUTO_NAME[sid] && AUTO_NAME[sid] !== room.name && !taken(AUTO_NAME[sid])) name = AUTO_NAME[sid];
        const scratch = WM.create(clone(doc));
        for (const p of old) scratch.removeProp(p.id);
        const dr = dressRoom(scratch, env, room.id, sid);
        if (!dr.ok) return dr;
        if (!dr.props.length) return refuse(room.name + ' has no clear floor left for ' + rec.name + ' (its lines and agents\' desks stay where they are).');
        spec = { kind: 'edit', removeProps: old.map(p => p.id), restyle: { roomId: room.id, deck: rec.deck, walls: rec.walls, name: name && name !== room.name ? name : null }, props: dr.props };
        summary = 'Refurnish ' + room.name + ' as ' + rec.name.replace(/^(a|an) /i, m => m.toLowerCase()) + ': ' + (old.length ? 'its ' + old.length + (old.length === 1 ? ' piece' : ' pieces') + ' of furniture are cleared (' + shortList(env, old) + '), and it' : 'it')
          + ' is furnished as ' + rec.name.toLowerCase() + ', floor and walls too (' + shortList(env, dr.props) + ')' + (spec.restyle.name ? '; renamed ' + spec.restyle.name : '') + '. ' + lostGear(env, old.filter(p => !dr.props.some(q => q.t === p.t))) + 'Its workflow lines and agents\' desks stay; one UNDO in Build mode brings it back as it was.';
        where = 'the refurnishing of ' + room.name;
      }
      mark = room.id;
    }
    // the edit, on a copy, exactly as station.build will make it; then every check
    const ck = editChecks(doc, live, spec, env, before, goneRects, moved);
    if (!ck.ok) return ck;
    const probe = ck.probe;
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(probe.serialize()), spec, summary, notes: [], steps, line: null, where, rooms: [],
      preview: previewOf(WM, doc, probe.serialize(), [], mark) } };
  }

  /* ================= VIBE DESIGN (2026-09-29): the Commander describes the room, part by part =================
     "The left side cozy, the right side a line that builds and tests code." The lead turns the words into ZONES: a part of
     the room (an AREA on a 2 × 2 grid) and what goes there, either a STYLE (RoomStyles: StarNet furnishes it from a
     hand-arranged set of the presets' own furniture) or a LINE (a shelf line, one picked from the Commander's words, or a
     custom SHAPE of steps), laid out inside that zone by the same layout engine the Workflow panel builds lines with. A new
     room is sized to hold what its zones need; an existing room is split down the middle. Lines go in first, then the
     furniture, which keeps doorways clear and every piece reachable. Every check the other plans run runs here too, on a
     copy, and the whole room lands in ONE undo. */
  const DESIGN_MENU = ['zones', 'where', 'name', 'size', 'beside', 'side', 'hallway', 'type', 'floorStyle', 'floorMat'];
  const ZONE_KEYS = ['area', 'style', 'line', 'purpose', 'shape', 'name', 'staff', 'dailyCap', 'tries'];
  // [column, row, columns, rows] on the room's 2 × 2 grid; the back is the far wall (the top of the floor)
  const AREAS = { whole: [0, 0, 2, 2], left: [0, 0, 1, 2], right: [1, 0, 1, 2], back: [0, 0, 2, 1], front: [0, 1, 2, 1],
    'back left': [0, 0, 1, 1], 'back right': [1, 0, 1, 1], 'front left': [0, 1, 1, 1], 'front right': [1, 1, 1, 1] };
  const AREA_LABEL = { whole: 'the whole room', left: 'the left half', right: 'the right half', back: 'the back half', front: 'the front half',
    'back left': 'the back-left corner', 'back right': 'the back-right corner', 'front left': 'the front-left corner', 'front right': 'the front-right corner' };
  const AREA_MENU = 'left, right, back, front, back-left, back-right, front-left, front-right, or whole';
  const DESIGN_MIN_ONE = [12, 8], DESIGN_MIN_MANY = [18, 10], DESIGN_MAX = [96, 60];

  // "the left side", "top right corner", "back-left" → an AREAS key (top = back, bottom = front), or null
  function areaOf(raw) {
    let n = norm(raw).replace(/\b(the|side|half|part|area|corner|of|room|wall|end|section)\b/g, ' ').replace(/\b(top|rear|far)\b/g, 'back')
      .replace(/\b(bottom|near)\b/g, 'front').replace(/\s+/g, ' ').trim();
    if (/^(whole|all|everything|entire|full|middle|center|centre)$/.test(n)) n = 'whole';
    const w = n.split(' ');
    if (w.length === 2 && (w[0] === 'left' || w[0] === 'right') && (w[1] === 'back' || w[1] === 'front')) n = w[1] + ' ' + w[0];
    return AREAS[n] ? n : null;
  }
  const sizesOf = env => { const S = env.PropSprites, o = {}; for (const t of ['intake', 'bay', 'outbox']) { const s = S && S.spec ? S.spec(t) : null; o[t] = s ? [s.w, s.h] : [2, 2]; } return o; };
  const roleOf = (WM, r) => { const n = String(r == null ? '' : r).toUpperCase().replace(/[^A-Z]/g, ''); return (WM.BAY_ROLES && WM.BAY_ROLES[n]) ? n : null; };
  function capOf(v, hasIntake, notes) {
    if (v === undefined) return { ok: true, limits: null };
    if (!hasIntake) { notes.push('this line has no Inbox, so dailyCap was ignored'); return { ok: true, limits: null }; }
    if (v === null || v === 0 || /^(none|no cap|off|0)$/i.test(String(v).trim())) return { ok: true, limits: { maxUsdPerDay: null } };
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    if (!isFinite(n) || n <= 0 || n > 10000) return refuse('dailyCap must be a dollar amount above 0 (up to 10000), or null for no cap.');
    return { ok: true, limits: { maxUsdPerDay: Math.round(n * 100) / 100 } };
  }

  /* A CUSTOM LINE from a SHAPE (the plan's phase 4): stages in order, each laid in between the line's last machine and its
     OUTBOX through the Workflow panel's own graph edits (LineEdit.OPS), so a custom line is exactly a line the panel could
     have built by hand. */
  function shapeGraph(env, shape, label, limits) {
    const WM = env.WorldModel, E = env.LineEdit;
    if (!E || !E.OPS) return refuse('the line editor is not loaded on this page');
    const roles = Object.keys(WM.BAY_ROLES || {}).join(', ');
    const HOW = 'shape is a list of 1 to 6 stages in order: a role ("RESEARCHER"), { "together": [2 or 3 roles] } (each gets a copy of the job), '
      + '{ "turns": [2 or 3 roles] } (they take turns), { "sort": { "code": role, "research": role } } (everything else goes straight on), '
      + 'or { "review": true, "tries": 3 } (a reviewer sends the step before it back until it is right). Roles: ' + roles + '.';
    if (!Array.isArray(shape) || !shape.length || shape.length > 6) return refuse(HOW);
    const sizes = sizesOf(env), o = { sizes }, OPS = E.OPS, O = '+o0';
    const intake = { id: '+i0', t: 'intake', w: sizes.intake[0], h: sizes.intake[1], label };
    if (limits) intake.limits = limits;
    const g = { nodes: [intake, { id: O, t: 'outbox', w: sizes.outbox[0], h: sizes.outbox[1] }], links: [{ id: '+l0', from: { node: '+i0', port: 'out' }, to: { node: O } }] };
    const node = id => g.nodes.find(n => n.id === id);
    const done = e => e && e.ok ? e : refuse((e && e.msg) || HOW);
    let last = '+i0', lastBay = null, sort = null;
    for (const s of shape) {
      if (typeof s === 'string') {
        const role = roleOf(WM, s);
        if (!role) return refuse('"' + String(s).slice(0, 30) + '" is not a step. ' + HOW);
        const e = done(OPS.insertStep(g, { from: last, to: O, role }, o)); if (!e.ok) return e;
        if (sort) { const f = done(OPS.addSorter(g, { from: last, to: e.focus, routes: sort }, o)); if (!f.ok) return f; sort = null; }
        last = e.focus; lastBay = e.focus;
        continue;
      }
      if (!s || typeof s !== 'object' || Array.isArray(s)) return refuse(HOW);
      if (sort) return refuse('After a sort comes one step, or the end of the line. ' + HOW);
      const keys = Object.keys(s);
      if ((s.together || s.turns) && keys.length === 1) {
        const list = s.together || s.turns;
        if (!Array.isArray(list) || list.length < 2 || list.length > 3) return refuse('together and turns take 2 or 3 roles. ' + HOW);
        const rs = list.map(r => roleOf(WM, r));
        if (rs.some(r => !r)) return refuse('together and turns take roles from: ' + roles + '.');
        const e = done(OPS.addBranch(g, { from: last, to: O, n: rs.length, mode: s.turns ? 'turns' : 'copy', role: rs[0] }, o)); if (!e.ok) return e;
        g.links.filter(l => l.from.node === e.focus).forEach((l, j) => { const k = node(l.to.node); if (k && k.t === 'bay') k.role = rs[j]; });
        last = g.links.find(l => l.to.node === O).from.node; lastBay = null;
      } else if (s.sort && keys.length === 1) {
        const m = Array.isArray(s.sort) ? s.sort : Object.keys(s.sort).map(tag => ({ tag, role: s.sort[tag] }));
        sort = [];
        for (const r of m) {
          const tag = norm(r && r.tag), role = roleOf(WM, r && r.role);
          if ((tag !== 'code' && tag !== 'research') || !role || sort.some(x => x.tag === tag)) return refuse('sort sends "code" and/or "research" work to a role; everything else goes straight on. Roles: ' + roles + '.');
          sort.push({ tag, role });
        }
        if (!sort.length) return refuse('sort needs "code" or "research" and the role that takes it.');
        lastBay = null;
      } else if (s.review != null && keys.every(k => k === 'review' || k === 'tries')) {
        if (!lastBay) return refuse('A review goes right after one step (not first, and not after a branch or a sort).');
        const tries = s.tries == null ? 3 : Number(s.tries);
        if (!Number.isInteger(tries) || tries < 1 || tries > 5) return refuse('tries must be a whole number from 1 to 5.');
        const e = done(OPS.addLoop(g, { around: lastBay, max: tries }, o)); if (!e.ok) return e;
        if (typeof s.review === 'string') {
          const rr = roleOf(WM, s.review); if (!rr) return refuse('review names a role from: ' + roles + ', or is true for a REVIEWER.');
          const rv = g.links.find(l => l.to.node === e.focus && l.from.node !== lastBay && (node(l.from.node) || {}).t === 'bay');
          if (rv) node(rv.from.node).role = rr;
        }
        last = e.focus; lastBay = null;
      } else return refuse(HOW);
    }
    if (sort) { const f = done(OPS.addSorter(g, { from: last, to: O, routes: sort }, o)); if (!f.ok) return f; }
    const steps = g.nodes.filter(n => n.t === 'bay').length;
    if (!steps) return refuse('A line needs at least one step. ' + HOW);
    if (steps > 8) return refuse('A line holds up to 8 steps.');
    return { ok: true, graph: g };
  }

  // a LINE zone's graph: a custom shape, or a shelf line (by id or name, or picked from the Commander's words)
  function zoneLine(live, env, z, notes) {
    const WM = env.WorldModel, W = env.WorkflowLine;
    if (z.purpose != null && typeof z.purpose !== 'string') return refuse('purpose is the Commander\'s own words for what the line is for, as text.');
    const purpose = typeof z.purpose === 'string' ? z.purpose.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const named = typeof z.name === 'string' ? z.name.replace(/\s+/g, ' ').trim().slice(0, 48) : '';
    if (z.shape != null) {
      if (z.line != null) return refuse('A zone takes a line from the menu or a shape of its own, not both.');
      if (z.tries != null) notes.push('tries belongs to a shape\'s { "review": true, "tries": n } stage, so it was ignored');
      const cap = capOf(z.dailyCap, true, notes); if (!cap.ok) return cap;
      const sg = shapeGraph(env, z.shape, named || 'A NEW LINE', cap.limits); if (!sg.ok) return sg;
      // no name given: the line is named for its steps ("RESEARCHER + WRITER + REVIEWER")
      const roles = [...new Set([].concat(...z.shape.map(st => typeof st === 'string' ? [roleOf(WM, st)] : st && (st.together || st.turns) ? (st.together || st.turns).map(r => roleOf(WM, r)) : st && st.sort ? (Array.isArray(st.sort) ? st.sort.map(r => roleOf(WM, r && r.role)) : Object.keys(st.sort).map(k => roleOf(WM, st.sort[k]))) : st && st.review != null ? [typeof st.review === 'string' ? roleOf(WM, st.review) : 'REVIEWER'] : [])).filter(Boolean))];
      const label = named || (roles.join(' + ').slice(0, 48) || 'A NEW LINE');
      sg.graph.nodes.find(n => n.t === 'intake').label = label;
      return { ok: true, graph: sg.graph, plain: 'a custom line', label, purpose, picked: null, loop: sg.graph.nodes.some(n => n.t === 'loop') };
    }
    let bp = resolveLine(WM, z.line), picked = null;
    if (!bp && z.line == null && purpose) {
      const s = W.suggestLineFor ? W.suggestLineFor(purpose) : null;
      bp = s ? resolveLine(WM, s.id) : null;
      if (!bp) return refuse('StarNet picks a line from the shape of the work (research then writing, a draft and a reviewer, code with tests or a review, two takes to compare), and "'
        + purpose.slice(0, 80) + '" names no such shape. Choose a line: ' + lineList(WM) + ', or give the zone a shape of its own.');
      picked = s.why;
    }
    if (!bp) return refuse((z.line != null ? 'There is no line called "' + String(z.line).slice(0, 60) + '".' : 'A line zone needs a line, a purpose, or a shape.') + ' The lines are: ' + lineList(WM) + '.');
    const hasIntake = bp.props.some(p => p.t === 'intake'), hasLoop = bp.props.some(p => p.t === 'loop');
    const cap = capOf(z.dailyCap, hasIntake, notes); if (!cap.ok) return cap;
    let maxIter;
    if (z.tries != null) {
      if (!hasLoop) notes.push('this line has no review loop, so tries was ignored');
      else { const n = Number(z.tries); if (!Number.isInteger(n) || n < 1 || n > 5) return refuse('tries must be a whole number from 1 to 5.'); maxIter = n; }
    }
    const b = live.blueprintGraph(bp.id, { limits: cap.limits || undefined, maxIter });
    if (!b || !b.ok) return refuse('the line ' + (bp.plain || bp.label) + ' could not be read');
    const plain = bp.plain || bp.label, label = named || plain.toUpperCase();
    const ip = b.graph.nodes.find(n => n.t === 'intake'); if (ip) ip.label = label;
    return { ok: true, graph: b.graph, plain, label: hasIntake ? label : null, purpose, picked, loop: hasLoop, bpId: bp.id };
  }

  // "a couch, a rug, two plants and a side table": the pieces a set really placed, in the props' own labels
  const pieceName = (env, t) => {
    const N = (env.RoomStyles && env.RoomStyles.NAMES) || {}, S = env.PropSprites, spec = S && S.spec ? S.spec(t) : null;
    if (N[t]) return N[t];
    return String((spec && spec.label) || t).toLowerCase().replace(/_/g, ' ').replace(/[\u2039\u203a]/g, ' ').replace(/\b(left|right)\b/g, ' ').replace(/ [a-z]$/, '').replace(/\s+/g, ' ').trim();
  };
  // "bookshelf" → "bookshelves", "stack of papers" → "stacks of papers"
  const plural = w => { const m = / of /.exec(w); if (m) return plural(w.slice(0, m.index)) + w.slice(m.index);
    return /(s|sh|ch|x|z)$/.test(w) ? w + 'es' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /fe?$/.test(w) ? w.replace(/fe?$/, 'ves') : w + 's'; };
  function piecesText(env, props) {
    const counts = [], idx = {};
    for (const p of props) {
      const label = pieceName(env, p.t);
      if (idx[label] == null) { idx[label] = counts.length; counts.push([label, 0]); }
      counts[idx[label]][1]++;
    }
    const NUM = ['', 'a', 'two', 'three', 'four', 'five', 'six'];
    const words = counts.map(([l, n]) => n === 1 ? (/^[aeiou]/.test(l) ? 'an ' : 'a ') + l : (NUM[n] || n) + ' ' + plural(l));
    return words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words.join('');
  }

  /* a style set's pieces at (x0, y0), as arranged or mirrored left to right (a chair facing east then faces west). Sizes come
     from the page's own catalog (the remastered desk is a tile wider than the classic one), so a FLAT decor piece that would
     then overlap another piece (a lamp beside a desk) is left out, and a set whose SOLID pieces would collide is not used.
     The catalog's mount rules hold (the page hands them to the world model): a piece that may stand on a table (stack, or
     mount 'surface') stands on the set's own table where the set puts it there, and one that MUST (a lava lamp) is left out
     when no table is under it. Tables are laid first, so what stands on them is placed after them. */
  function setProps(env, set, x0, y0, mirror) {
    const S = env.PropSprites, out = [], taken = new Map();
    const pieces = set.pieces.map(([t0, x, y, facing = 0]) => {
      let t = t0;
      if (mirror) t = /_r$/.test(t0) ? t0.slice(0, -2) : (S.spec(t0 + '_r') ? t0 + '_r' : t0);
      return { t, x, y, facing, spec: S.spec(t) };
    });
    if (pieces.some(p => !p.spec)) return null;
    // solid pieces claim their tiles first, then flat ones take what is left
    for (const pass of [true, false]) for (const p of pieces) {
      const solid = p.spec.blocks !== false;
      if (solid !== pass) continue;
      const px = x0 + (mirror ? set.w - p.x - p.spec.w : p.x), py = y0 + p.y, tiles = [];
      for (let yy = py; yy < py + p.spec.h; yy++) for (let xx = px; xx < px + p.spec.w; xx++) tiles.push(xx + ',' + yy);
      const onTop = !!(p.spec.stack || p.spec.mount === 'surface'), under = tiles.map(k => taken.get(k));
      const onTable = onTop && under.length > 0 && under.every(u => u && u.spec.surface);
      if (p.spec.mount === 'surface' && !onTable) continue;   // it has no business on bare deck
      if (!onTable && under.some(Boolean)) { if (solid) return null; continue; }
      if (!onTable) tiles.forEach(k => taken.set(k, p));
      const r = mirror ? (p.facing === 1 ? 3 : p.facing === 3 ? 1 : p.facing) : p.facing;
      out.push({ t: p.t, x: px, y: py, w: p.spec.w, h: p.spec.h, r, block: solid, order: pieces.indexOf(p) + (onTable ? 1000 : 0) });
    }
    return out.sort((q, w) => q.order - w.order).map(({ order, ...p }) => p);
  }
  // a solid piece can be walked up to: some tile on one of its sides is floor a walk from the spawn reaches
  function sideReachable(g, o, p) {
    if (!o) return true;
    const ox = g.origin.tx, oy = g.origin.ty;
    for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
      const edgeY = y === p.y - 1 || y === p.y + p.h, edgeX = x === p.x - 1 || x === p.x + p.w;
      if (edgeY === edgeX) continue;   // the footprint itself, or a corner
      if (g.walkable(x - ox, y - oy) && g.path(o.x - ox, o.y - oy, x - ox, y - oy)) return true;
    }
    return false;
  }

  /* ================= THE SPATIAL BUILDER (2026-09-30): rooms where the Commander says, joined by hallways =================
     The first builder could not say WHERE a room goes: every room landed flush against the station's east wall, and the
     station grew into one long strip with no hallways (Andrew's test, 09-30). Now a room is placed on a named SIDE of a
     named ROOM, at a named SIZE, joined by a HALLWAY the way the presets join their wings (or flush, open plan). With no
     side given StarNet takes the one that keeps the station compact. One plan may hold several rooms, a later one attached
     to an earlier one; a room may stay EMPTY (floor for lines to come), be furnished by zones, or be filled with lines.
     The model names intent; StarNet computes every tile and refuses with what IS free. */
  const SIZES = { small: [12, 8], medium: [18, 11], large: [24, 14], giant: [36, 20] };
  const SIZE_WORDS = { tiny: 'small', little: 'small', normal: 'medium', standard: 'medium', regular: 'medium', big: 'large', huge: 'giant', massive: 'giant', enormous: 'giant' };
  const SIZE_MENU = 'small (12 × 8), medium (18 × 11), large (24 × 14), giant (36 × 20), or { "w": 6-' + DESIGN_MAX[0] + ', "h": 5-' + DESIGN_MAX[1] + ' }';
  const SIDES = ['east', 'south', 'west', 'north'];
  const SIDE_WORDS = { right: 'east', left: 'west', top: 'north', up: 'north', above: 'north', back: 'north', bottom: 'south', down: 'south', below: 'south', front: 'south', e: 'east', w: 'west', n: 'north', s: 'south' };
  const HALL_LEN = 3, HALL_W = { east: 3, west: 3, north: 4, south: 4 };   // the presets' own hallways (stationtemplates slots)
  const MAIN_WORDS = { bridge: 1, main: 1, hub: 1, home: 1, center: 1, centre: 1, station: 1, base: 1, core: 1, start: 1, 'main room': 1, 'first room': 1 };
  const BUILD_MENU = ['rooms', 'hallways'];
  const ROOM_KEYS = ['name', 'style', 'size', 'beside', 'side', 'hallway', 'align', 'into', 'type', 'floorStyle', 'floorMat', 'zones', 'lines'];
  const LINE_KEYS = ['line', 'purpose', 'shape', 'name', 'staff', 'dailyCap', 'tries'];

  const bboxOf = room => { let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (const r of room.rects) { x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1); x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2); } return { x1, y1, x2, y2 }; };
  // the room every station starts from (the Commander may call it the bridge, the hub, the main room)
  function mainRoom(st) {
    const d = st.serialize(), id = (d.meta && (d.meta.trunkRoomId || d.meta.spawnRoomId)) || d.order[0];
    return st.rooms().find(r => r.id === id && r.kind !== 'corridor') || st.rooms().find(r => r.kind !== 'corridor') || null;
  }
  // a room by the name the Commander used: its own name, or a word for the main room when no room carries that name
  function roomNamed(st, raw) {
    const rooms = st.rooms().filter(r => r.kind !== 'corridor'), n = norm(raw), bare = n.replace(/^the /, '').replace(/ room$/, '');
    const m = rooms.filter(r => norm(r.name) === n || norm(r.name) === bare);
    if (m.length === 1) return { ok: true, room: m[0] };
    if (m.length > 1) return refuse('More than one room is called "' + String(raw).slice(0, 40) + '". Rename one first (station.plan_restyle).');
    if (MAIN_WORDS[bare]) { const main = mainRoom(st); if (main) return { ok: true, room: main }; }
    return refuse('There is no room called "' + String(raw).slice(0, 40) + '". Rooms: ' + rooms.map(r => r.name).join(', ') + '.');
  }
  function sizeOfRoom(raw) {
    if (raw == null) return { ok: true, size: null };
    let v = raw;
    if (typeof v === 'string') {
      const k = norm(v).replace(/ (room|size|sized)$/, ''), word = SIZE_WORDS[k] || k;
      if (SIZES[word]) return { ok: true, size: SIZES[word].slice(), word };
      const m = /^(\d+)\s*(?:x|×|by)\s*(\d+)$/.exec(v.toLowerCase().trim());
      if (m) v = { w: +m[1], h: +m[2] };
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const w = Number(v.w), h = Number(v.h);
      if (Number.isInteger(w) && Number.isInteger(h) && w >= 6 && h >= 5 && w <= DESIGN_MAX[0] && h <= DESIGN_MAX[1]) return { ok: true, size: [w, h] };
    }
    return refuse('size is ' + SIZE_MENU + '.');
  }
  function sideOf(raw) {
    if (raw == null) return { ok: true, side: null };
    const k = norm(raw).replace(/^(the|to the|on the) /, '').replace(/ (side|of|wall)$/, ''), s = SIDE_WORDS[k] || k;
    return SIDES.indexOf(s) >= 0 ? { ok: true, side: s } : refuse('side is north, south, east or west (north is the back wall, the top of the map).');
  }
  function hallOf(raw) {
    if (raw == null || raw === true || /^(yes|true|hall|hallway|corridor)$/i.test(String(raw))) return { ok: true, len: HALL_LEN };
    if (raw === false || raw === 0 || /^(no|none|false|flush|open|door|0)$/i.test(String(raw))) return { ok: true, len: 0 };
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 2 && n <= 8) return { ok: true, len: n };
    return refuse('hallway is true (a short hallway joins the rooms), false (the rooms touch, open plan), or a length from 2 to 8.');
  }

  /* A RECRUIT'S DESK stands in the room of the line it works: a tidy row along the room's back wall (then its front wall),
     a clear tile between desks, the seat tile in front of each free, off every doorway's lane, on no belt, every one
     reachable. The desks are laid on `probe` unbound; station.build seats each recruit at its own. Answers the spots it
     could find (fewer than asked when the room is full: those recruits get the usual desk in the main room). */
  const MAX_RECRUITS = 12;
  function recruitDesks(probe, env, roomId, n) {
    const S = env.PropSprites, sp = S && S.spec('desk'); if (!sp || n < 1) return [];
    const rm = probe.rooms().find(r => r.id === roomId); if (!rm) return [];
    const R = rm.rects[0], g = probe.projectGeometry(), belts = probe.serialize().belts || {}, lane = new Set();
    for (const d of doorTiles(probe, g, roomId)) for (let k = 0; k < 3; k++) lane.add((d.x + d.dx * k) + ',' + (d.y + d.dy * k));
    const solidAt = (x, y) => probe.props().some(p => { const s2 = S.spec(p.t); return !(s2 && s2.flat) && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1); });
    const clear = (x, y) => probe.roomAt(x, y) === roomId && !belts[x + ',' + y] && !lane.has(x + ',' + y) && !solidAt(x, y);
    const deskOk = (x, y) => { if (x < R.x1 + 1 || x + sp.w - 1 > R.x2 - 1) return false; for (let k = -1; k <= sp.w; k++) for (const yy of [y, y + 1]) if (!clear(x + k, yy)) return false; return true; };   // the desk, its seat row, a tile each side
    // ONE ROW for them all first, centred on the wall (the top wall, then the bottom): a batch is never split while a row takes it
    const span = n * (sp.w + 1) - 1, mid = (R.x1 + R.x2 + 1 - span) / 2;
    for (const y of [R.y1, R.y2 - 1]) {
      const starts = [];
      for (let x = R.x1 + 1; x + span - 1 <= R.x2 - 1; x++) starts.push(x);
      starts.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
      for (const x0 of starts) {
        const xs = Array.from({ length: n }, (_, i) => x0 + i * (sp.w + 1));
        if (!xs.every(x => deskOk(x, y))) continue;
        const ids = [];
        let ok = true;
        for (const x of xs) { const a = probe.addProp({ t: 'desk', x, y, w: sp.w, h: sp.h, r: 0, block: true }); if (!a || !a.ok) { ok = false; break; } ids.push(a.id); }
        if (ok) { const g2 = probe.projectGeometry(), o = spawnTile(probe.serialize(), g2); ok = xs.every(x => sideReachable(g2, o, { x, y, w: sp.w, h: sp.h })); }
        if (ok) return xs.map(x => ({ t: 'desk', x, y, w: sp.w, h: sp.h, r: 0, block: true }));
        for (const id of ids) probe.removeProp(id);
      }
    }
    // else wherever each fits, the top row then the bottom
    const out = [];
    for (const y of [R.y1, R.y2 - 1]) {
      for (let x = R.x1 + 1; x + sp.w - 1 <= R.x2 - 1 && out.length < n; x++) {
        if (!deskOk(x, y)) continue;
        const a = probe.addProp({ t: 'desk', x, y, w: sp.w, h: sp.h, r: 0, block: true });
        if (!a || !a.ok) continue;
        const g2 = probe.projectGeometry();
        if (!sideReachable(g2, spawnTile(probe.serialize(), g2), { x, y, w: sp.w, h: sp.h })) { probe.removeProp(a.id); continue; }
        out.push({ t: 'desk', x, y, w: sp.w, h: sp.h, r: 0, block: true });
        x += sp.w + 1;
      }
      if (out.length >= n) break;
    }
    return out;
  }
  // desks for n recruits: in the line's room first, then a tidy row in the main room, then the other rooms in turn
  function desksFor(probe, env, lineRoomId, n) {
    const main = mainRoom(probe), order = [lineRoomId, main && main.id].concat(probe.rooms().filter(r => r.kind !== 'corridor').map(r => r.id));
    const out = [], tried = new Set();
    for (const id of order) {
      if (!id || tried.has(id) || out.length >= n) continue;
      tried.add(id);
      out.push(...recruitDesks(probe, env, id, n - out.length));
    }
    return out;
  }
  // a plan's recruits, capped, each with its desk (by its line where it fits): the desks join the part that holds the line
  function seatRecruits(probe, env, spec, roomOfPart) {
    const recruits = spec.recruits || [];
    if (recruits.length > MAX_RECRUITS) return refuse('That plan recruits ' + recruits.length + ' new agents. Recruit only when the Commander asks for new crew, and at most ' + MAX_RECRUITS + ' in one plan: staff the other steps with "lead" or a crew member, or leave agent out (the card then lists them as still to do).');
    const byPart = new Map();
    for (const rc of recruits) { if (!byPart.has(rc.part)) byPart.set(rc.part, []); byPart.get(rc.part).push(rc); }
    for (const [pi, list] of byPart) {
      const desks = desksFor(probe, env, roomOfPart(pi), list.length);
      list.forEach((rc, k) => { const d = desks[k]; rc.desk = d ? { x: d.x, y: d.y } : null; if (d) spec.parts[pi].props.push(d); });
    }
    return { ok: true };
  }

  /* What a new opening in a room's wall would run into. A HALLWAY's doorway (`door`): a solid piece on the tile just inside
     that wall. Any opening in a NORTH wall (the only wall boards and screens hang on): a piece that hangs there, which would
     be left hanging on nothing. `hangs` is the catalog's rule (type -> true when it mounts on a wall); without it every
     piece on that row counts. `from`..`to` runs along the wall. */
  const hangsOf = env => { const S = env && env.PropSprites; return S && S.spec ? (t => { const sp = S.spec(t); return !!(sp && sp.mount === 'wall'); }) : null; };
  function doorwayBlocked(st, side, B, from, to, door, hangs) {
    for (const p of st.props()) {
      const solid = door && p.block !== false, hung = side === 'north' && (hangs ? hangs(p.t) : true);
      if (!solid && !hung) continue;
      const px2 = p.x + (p.w || 1) - 1, py2 = p.y + (p.h || 1) - 1;
      const hit = side === 'east' ? (p.x <= B.x2 && px2 >= B.x2 && p.y <= to && py2 >= from)
        : side === 'west' ? (p.x <= B.x1 && px2 >= B.x1 && p.y <= to && py2 >= from)
        : side === 'south' ? (p.y <= B.y2 && py2 >= B.y2 && p.x <= to && px2 >= from)
        : (p.y <= B.y1 && py2 >= B.y1 && p.x <= to && px2 >= from);
      if (hit) return true;
    }
    return false;
  }
  // rooms that touch open onto each other, so a new rect may stand against the rooms in `allow` and no other: the first
  // other room it would touch (its name), or null
  function neighbourOf(st, r, allow) {
    const other = (x, y) => { const id = st.roomAt(x, y); return id && allow.indexOf(id) < 0 ? id : null; };
    let id = null;
    for (let x = r.x1; x <= r.x2 && !id; x++) id = other(x, r.y1 - 1) || other(x, r.y2 + 1);
    for (let y = r.y1; y <= r.y2 && !id; y++) id = other(r.x1 - 1, y) || other(r.x2 + 1, y);
    if (!id) return null;
    const rm = st.rooms().find(x => x.id === id);
    return !rm ? 'another room' : rm.kind === 'corridor' ? 'a hallway' : rm.name;
  }

  /* Every place a W × H room may stand on one SIDE of the room T: against T through a hallway `len` tiles long (0 = the
     rooms touch). The room slides ALONG the shared wall: centred first, then outward, or pinned by `align`. The hallway
     sits in the middle of the stretch both rooms face, and the wall it meets must really be T's floor (T may be L-shaped). */
  function placementsOn(st, T, side, W, H, len, align, kind, hangs) {
    const B = bboxOf(T), horiz = side === 'east' || side === 'west', out = [];
    const lo = horiz ? B.y1 : B.x1, hi = horiz ? B.y2 : B.x2, span = horiz ? H : W, centre = lo + ((hi - lo + 1 - span) >> 1);
    let offs, why = '';
    if (align === 'start') offs = [lo]; else if (align === 'end') offs = [hi - span + 1]; else if (align === 'center') offs = [centre];
    else { offs = [centre]; for (let d = 1; d <= Math.max(span, hi - lo + 1); d++) offs.push(centre - d, centre + d); }
    for (const a of offs) {
      const o1 = Math.max(lo, a), o2 = Math.min(hi, a + span - 1), facing = o2 - o1 + 1;
      if (facing < 2) continue;   // the two rooms must face each other across at least a doorway
      const w = len ? Math.min(HALL_W[side], facing) : facing, h1 = o1 + ((facing - w) >> 1);
      let rect, hall = null;
      if (side === 'east') { rect = { x1: B.x2 + 1 + len, y1: a, x2: B.x2 + len + W, y2: a + H - 1 }; if (len) hall = { x1: B.x2 + 1, y1: h1, x2: B.x2 + len, y2: h1 + w - 1 }; }
      else if (side === 'west') { rect = { x1: B.x1 - len - W, y1: a, x2: B.x1 - len - 1, y2: a + H - 1 }; if (len) hall = { x1: B.x1 - len, y1: h1, x2: B.x1 - 1, y2: h1 + w - 1 }; }
      else if (side === 'south') { rect = { x1: a, y1: B.y2 + 1 + len, x2: a + W - 1, y2: B.y2 + len + H }; if (len) hall = { x1: h1, y1: B.y2 + 1, x2: h1 + w - 1, y2: B.y2 + len }; }
      else { rect = { x1: a, y1: B.y1 - len - H, x2: a + W - 1, y2: B.y1 - len - 1 }; if (len) hall = { x1: h1, y1: B.y1 - len, x2: h1 + w - 1, y2: B.y1 - 1 }; }
      // T's own floor along the wall the hallway (or, flush, the doorway) meets
      let meets = 0;
      for (let i = h1; i < h1 + w; i++) {
        const tx = side === 'east' ? B.x2 : side === 'west' ? B.x1 : i, ty = side === 'south' ? B.y2 : side === 'north' ? B.y1 : i;
        if (st.roomAt(tx, ty) === T.id) meets++;
      }
      if (meets < (len ? w : 2)) { why = why || T.name + '\'s wall is not straight there'; continue; }
      // the doorway opens onto clear floor in T (open plan: only what hangs on a north wall matters)
      const inWay = m => /^overlaps CORRIDOR/i.test(m || '') ? 'a hallway is already there' : /^overlaps /.test(m || '') ? m.replace(/^overlaps /, '') + ' is in the way' : (m || 'it does not fit');
      if (hall) { const c = st.canPlaceHallway([hall]); if (!c.ok) { why = why || inWay(c.msg); continue; } }
      const c = st.canPlaceRoom([rect], kind || 'hab');
      if (!c.ok) { why = why || inWay(c.msg); continue; }
      // nothing built here stands against a room it was not asked to join
      const nb = (hall && neighbourOf(st, hall, [T.id])) || neighbourOf(st, rect, len ? [] : [T.id]);
      if (nb) { why = why || 'it would stand against ' + nb; continue; }
      // and the opening runs onto clear floor in T (open plan: only what hangs on a north wall matters)
      if (doorwayBlocked(st, side, B, h1, h1 + w - 1, !!len, hangs)) { why = why || (len ? 'furniture in ' + T.name + ' stands against that wall' : 'something hangs on ' + T.name + '\'s wall there'); continue; }
      out.push({ rect, hall, side, target: T.name, targetId: T.id, len });
      if (out.length >= 10) break;
    }
    return { list: out, why: why || 'there is no floor there for it' };
  }
  /* WHERE A NEW ROOM GOES. Beside the room T when the Commander named one, on the asked side, else on whichever side leaves
     the station most COMPACT (the smaller long side of its outline, then the smaller area) — never just "to the east", which
     is how a station becomes one long strip. With no room named (T null) every room is a candidate, the main room first on
     a tie. Answers every spot in preference order, or why there is none and what does fit. */
  function roomPlacements(st, T, W, H, o) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of st.rooms()) { const b = bboxOf(r); x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
    const score = c => { const r = c.rect, w = Math.max(x2, r.x2) - Math.min(x1, r.x1) + 1, h = Math.max(y2, r.y2) - Math.min(y1, r.y1) + 1; return Math.max(w, h) * 100000 + w * h; };
    const main = mainRoom(st), hosts = T ? [T] : st.rooms().filter(r => r.kind !== 'corridor').sort((p, q) => (p === main ? -1 : q === main ? 1 : 0));
    const per = [];
    hosts.forEach((host, hi) => (o.side ? [o.side] : SIDES).forEach((side, si) => {
      const p = placementsOn(st, host, side, W, H, o.len, o.align, o.kind, o.hangs);
      per.push({ host, side, list: p.list, why: p.why, score: p.list.length ? score(p.list[0]) : Infinity, order: hi * 10 + si });
    }));
    // a named room on a named side is taken as asked; otherwise the most compact spot wins
    if (!(T && o.side)) per.sort((p, q) => p.score - q.score || p.order - q.order);
    const list = [].concat(...per.map(p => p.list));
    if (list.length) return { ok: true, list };
    const size = W + ' × ' + H, hall = o.len ? ' with a hallway' : '';
    if (!T) return refuse('There is no clear space beside any room for a ' + size + ' room' + (o.side ? ' on its ' + o.side + ' side' : '') + hall + '. Try a smaller size, or name the room and side (station.map shows what is free).');
    // nothing fits as asked: say why, and what does fit around T, or beside which other rooms it would fit
    const elsewhere = () => {
      const spots = [];
      for (const r of st.rooms()) { if (r === T || r.kind === 'corridor') continue; const sides = SIDES.filter(sd => placementsOn(st, r, sd, W, H, o.len, null, o.kind, o.hangs).list.length); if (sides.length) spots.push(r.name + ' (' + sides.join(', ') + ')'); if (spots.length >= 5) break; }
      return spots.length ? ' That size fits beside: ' + spots.join('; ') + '.' : ' Nothing that size fits beside any room; try a smaller one.';
    };
    const free = SIDES.filter(sd => (!o.side || sd !== o.side) && placementsOn(st, T, sd, W, H, o.len, null, o.kind, o.hangs).list.length);
    const smaller = Object.keys(SIZES).filter(k => SIZES[k][0] * SIZES[k][1] < W * H && (o.side ? [o.side] : SIDES).some(sd => placementsOn(st, T, sd, SIZES[k][0], SIZES[k][1], o.len, null, o.kind, o.hangs).list.length));
    return refuse('There is no room for a ' + size + ' room ' + (o.side ? o.side + ' of ' : 'beside ') + T.name + hall + ': ' + per.map(p => (o.side ? '' : p.side + ': ') + p.why).join('; ') + '.'
      + (free.length ? ' That size fits ' + free.join(', ') + ' of ' + T.name + '.' : '') + (smaller.length ? ' Sizes that fit ' + (o.side ? 'there' : 'beside it') + ': ' + smaller.join(', ') + '.' : '')
      + (!free.length ? elsewhere() : ''), { free, smaller });
  }

  /* A HALLWAY BETWEEN TWO ROOMS that face each other across a gap: straight, as wide as the presets' own, in the middle of
     the stretch both rooms face, sliding along it to find clear wall at both ends. */
  function hallBetween(st, A, Bm, hangs) {
    const a = bboxOf(A), b = bboxOf(Bm);
    const yo1 = Math.max(a.y1, b.y1), yo2 = Math.min(a.y2, b.y2), xo1 = Math.max(a.x1, b.x1), xo2 = Math.min(a.x2, b.x2);
    const pair = A.name + ' and ' + Bm.name;
    let horiz;
    if (yo2 - yo1 + 1 >= 2 && (a.x2 < b.x1 || b.x2 < a.x1)) horiz = true;
    else if (xo2 - xo1 + 1 >= 2 && (a.y2 < b.y1 || b.y2 < a.y1)) horiz = false;
    else return refuse(pair + ' do not face each other, and a hallway runs straight. Join rooms that stand side by side or one above the other (station.map shows where each room is).');
    const firstIsA = horiz ? a.x2 < b.x1 : a.y2 < b.y1, F = firstIsA ? A : Bm, S = firstIsA ? Bm : A, fb = firstIsA ? a : b, sb = firstIsA ? b : a;
    const g1 = (horiz ? fb.x2 : fb.y2) + 1, g2 = (horiz ? sb.x1 : sb.y1) - 1, gap = g2 - g1 + 1;
    if (gap < 1) return refuse(pair + ' already stand against each other: they are open to each other.');
    if (gap < 2) return refuse(pair + ' are one tile apart, and a hallway is at least two tiles long.');
    if (gap > 160) return refuse(pair + ' are ' + gap + ' tiles apart; a hallway runs at most 160.');
    const o1 = horiz ? yo1 : xo1, o2 = horiz ? yo2 : xo2, w = Math.min(horiz ? HALL_W.east : HALL_W.south, o2 - o1 + 1), centre = o1 + ((o2 - o1 + 1 - w) >> 1);
    const offs = [centre]; for (let d = 1; d <= o2 - o1; d++) offs.push(centre - d, centre + d);
    let why = '';
    for (const h1 of offs) {
      if (h1 < o1 || h1 + w - 1 > o2) continue;
      const rect = horiz ? { x1: g1, y1: h1, x2: g2, y2: h1 + w - 1 } : { x1: h1, y1: g1, x2: h1 + w - 1, y2: g2 };
      let meets = true;
      for (let i = h1; i < h1 + w && meets; i++) meets = horiz ? (st.roomAt(fb.x2, i) === F.id && st.roomAt(sb.x1, i) === S.id) : (st.roomAt(i, fb.y2) === F.id && st.roomAt(i, sb.y1) === S.id);
      if (!meets) { why = why || 'a wall is not straight there'; continue; }
      if (doorwayBlocked(st, horiz ? 'east' : 'south', fb, h1, h1 + w - 1, true, hangs)) { why = why || 'furniture in ' + F.name + ' stands against that wall'; continue; }
      if (doorwayBlocked(st, horiz ? 'west' : 'north', sb, h1, h1 + w - 1, true, hangs)) { why = why || 'furniture in ' + S.name + ' stands against that wall'; continue; }
      const c = st.canPlaceHallway([rect]);
      if (!c.ok) { why = why || (/^overlaps /.test(c.msg || '') ? 'something is already between them' : (c.msg || 'it does not fit')); continue; }
      const nb = neighbourOf(st, rect, [A.id, Bm.id]);
      if (nb) { why = why || 'it would stand against ' + nb; continue; }
      return { ok: true, rect };
    }
    return refuse('There is no clear straight run for a hallway between ' + pair + ': ' + (why || 'nothing fits') + '.');
  }

  /* A HALLWAY ROUND ONE CORNER between two rooms that stand diagonally apart: out of A's wall that faces B across one axis,
     along to B's column (or row), then into B's wall — tried both ways round (out sideways first, or out of the top or
     bottom first), the middle of each wall first. Two straight 3-wide runs that meet at the corner square; every check a
     straight hallway passes: clear wall at both doorways, nothing in the way, standing against no other room. */
  function hallL(st, A, Bm, hangs) {
    const a = bboxOf(A), b = bboxOf(Bm), w = 3, pair = A.name + ' and ' + Bm.name;
    const east = b.x1 > a.x2, west = b.x2 < a.x1, south = b.y1 > a.y2, north = b.y2 < a.y1;
    if (!(east || west) || !(north || south)) return refuse(pair + ' face each other');
    const mid = (lo, hi) => { const c = lo + ((hi - lo + 1 - w) >> 1), out = [c]; for (let d = 1; d <= hi - lo; d++) out.push(c - d, c + d); return out.filter(v => v >= lo && v + w - 1 <= hi); };
    const tries = [];
    // out of A's east or west wall at row ya, along to B's columns xb, then north or south into B
    for (const ya of mid(a.y1, a.y2)) for (const xb of mid(b.x1, b.x2)) {
      const r1 = east ? { x1: a.x2 + 1, x2: xb + w - 1, y1: ya, y2: ya + w - 1 } : { x1: xb, x2: a.x1 - 1, y1: ya, y2: ya + w - 1 };
      const r2 = south ? { x1: xb, x2: xb + w - 1, y1: ya + w, y2: b.y1 - 1 } : { x1: xb, x2: xb + w - 1, y1: b.y2 + 1, y2: ya - 1 };
      tries.push({ r1, r2, aSide: east ? 'east' : 'west', aFrom: ya, bSide: south ? 'north' : 'south', bFrom: xb });
    }
    // out of A's top or bottom wall at column xa, along to B's rows yb, then east or west into B
    for (const xa of mid(a.x1, a.x2)) for (const yb of mid(b.y1, b.y2)) {
      const r1 = south ? { x1: xa, x2: xa + w - 1, y1: a.y2 + 1, y2: yb + w - 1 } : { x1: xa, x2: xa + w - 1, y1: yb, y2: a.y1 - 1 };
      const r2 = east ? { x1: xa + w, x2: b.x1 - 1, y1: yb, y2: yb + w - 1 } : { x1: b.x2 + 1, x2: xa - 1, y1: yb, y2: yb + w - 1 };
      tries.push({ r1, r2, aSide: south ? 'south' : 'north', aFrom: xa, bSide: east ? 'west' : 'east', bFrom: yb });
    }
    let why = '';
    for (const t of tries.slice(0, 400)) {
      const { r1, r2 } = t, len = r => Math.max(r.x2 - r.x1, r.y2 - r.y1) + 1;
      if (r1.x2 < r1.x1 || r1.y2 < r1.y1 || r2.x2 < r2.x1 || r2.y2 < r2.y1 || len(r2) < 2) continue;
      if (len(r1) + len(r2) > 200) { why = why || 'they are too far apart (a hallway runs at most 200 tiles round a corner)'; continue; }
      // the doorways meet each room's own wall, straight, with clear floor behind them
      const meetA = i => t.aSide === 'east' ? st.roomAt(a.x2, i) === A.id : t.aSide === 'west' ? st.roomAt(a.x1, i) === A.id : t.aSide === 'south' ? st.roomAt(i, a.y2) === A.id : st.roomAt(i, a.y1) === A.id;
      const meetB = i => t.bSide === 'north' ? st.roomAt(i, b.y1) === Bm.id : t.bSide === 'south' ? st.roomAt(i, b.y2) === Bm.id : t.bSide === 'west' ? st.roomAt(b.x1, i) === Bm.id : st.roomAt(b.x2, i) === Bm.id;
      let ok = true;
      for (let i = 0; i < w && ok; i++) ok = meetA(t.aFrom + i) && meetB(t.bFrom + i);
      if (!ok) { why = why || 'a wall is not straight there'; continue; }
      if (doorwayBlocked(st, t.aSide, a, t.aFrom, t.aFrom + w - 1, true, hangs)) { why = why || 'furniture in ' + A.name + ' stands against that wall'; continue; }
      if (doorwayBlocked(st, t.bSide, b, t.bFrom, t.bFrom + w - 1, true, hangs)) { why = why || 'furniture in ' + Bm.name + ' stands against that wall'; continue; }
      const c = st.canPlaceHallway([r1, r2]);
      if (!c.ok) { why = why || (/^overlaps /.test(c.msg || '') ? 'something is in the way' : (c.msg || 'it does not fit')); continue; }
      const nb = neighbourOf(st, r1, [A.id, Bm.id]) || neighbourOf(st, r2, [A.id, Bm.id]);
      if (nb) { why = why || 'it would stand against ' + nb; continue; }
      return { ok: true, rects: [r1, r2] };
    }
    return refuse('There is no clear run for a hallway between ' + pair + ', straight or round one corner: ' + (why || 'nothing fits') + '.');
  }
  // a room's zones, checked and measured: each a style or a line, no two on the same part of the room
  function parseZones(list, env, live, notes) {
    const RS = env.RoomStyles, styleMenu = RS.menu().map(s => s.id + ' (' + s.name + ': ' + s.about + ')').join('; ');
    const ZONE_HOW = 'zones is a list of 1 to 4 parts of the room, each { area, style } or { area, line | purpose | shape }. Areas: ' + AREA_MENU + '. Styles: ' + styleMenu + '.';
    if (!Array.isArray(list) || !list.length || list.length > 4) return refuse(ZONE_HOW);
    const zones = [], cells = {};
    for (const z of list) {
      if (!z || typeof z !== 'object' || Array.isArray(z)) return refuse(ZONE_HOW);
      const bad = Object.keys(z).filter(k => ZONE_KEYS.indexOf(k) < 0);
      if (bad.length) return refuse('A zone only takes: ' + ZONE_KEYS.join(', ') + '. Not accepted: ' + bad.slice(0, 6).join(', ') + '.');
      const area = areaOf(z.area);
      if (!area) return refuse((z.area == null ? 'Each zone needs an area.' : 'There is no area called "' + String(z.area).slice(0, 30) + '".') + ' Areas: ' + AREA_MENU + '.');
      const [c, r, cs, rs] = AREAS[area];
      for (let yy = r; yy < r + rs; yy++) for (let xx = c; xx < c + cs; xx++) {
        if (cells[xx + ',' + yy]) return refuse(AREA_LABEL[area] + ' overlaps ' + AREA_LABEL[cells[xx + ',' + yy]] + '. Give each part of the room one thing.');
        cells[xx + ',' + yy] = area;
      }
      const isLine = z.line != null || z.purpose != null || z.shape != null;
      if (isLine === (z.style != null)) return refuse('Each zone is a style or a line: ' + AREA_LABEL[area] + ' needs exactly one of style, or line / purpose / shape.');
      if (!isLine) {
        if (['name', 'staff', 'dailyCap', 'tries'].some(k => z[k] != null)) return refuse('name, staff, dailyCap and tries belong to a line zone, not to ' + AREA_LABEL[area] + '.');
        const id = RS.resolve(z.style);
        if (!id) return refuse('There is no style called "' + String(z.style).slice(0, 30) + '". Styles: ' + styleMenu + '.');
        const set0 = RS.STYLES[id].sets[0];
        zones.push({ area, kind: 'style', style: id, need: { w: set0.w + 3, h: set0.h + 2 } });
      } else {
        const ln = parseLine(z, env, live, notes); if (!ln.ok) return ln;
        zones.push(Object.assign({ area }, ln.line));
      }
    }
    return { ok: true, zones };
  }
  // one workflow line asked for (a zone's, or one of a room's `lines`): its graph, and the floor it takes laid out in the open
  function parseLine(z, env, live, notes) {
    if (!env.LineLayout || !env.LineLayout.layout) return refuse('the layout engine is not loaded on this page');
    const staff = z.staff == null ? [] : z.staff;
    const sl = stepsListOk(staff); if (!sl.ok) return refuse(sl.error.replace(/^steps /, 'staff '));
    for (const x of staff) if (x && x.agent != null) { const a = agentOf(env, x.agent); if (!a.ok) return a; }
    const zl = zoneLine(live, env, z, notes); if (!zl.ok) return zl;
    const L0 = env.LineLayout.layout(zl.graph, { rects: [{ x1: 0, y1: 0, x2: 119, y2: 79 }], blocked: [], belts: {}, junctions: [] });
    if (!L0.ok) return refuse('that line could not be laid out (' + (L0.error || 'no layout') + ')');
    return { ok: true, line: Object.assign({ kind: 'line', staff, need: { w: L0.box.x2 - L0.box.x1 + 1, h: L0.box.y2 - L0.box.y1 + 1 } }, zl) };
  }
  /* The floor a list of lines takes, laid the way the layout engine fills a room: left to right in a row while they fit,
     then a new row, a clear tile between neighbours. Of every row width it answers the one nearest a room's usual shape
     (about 1.7 wide to 1 tall) that StarNet can build at once. */
  function packLines(lines) {
    const shelf = maxW => { let w = 0, h = 0, rw = 0, rh = 0; for (const l of lines) { const lw = l.need.w, lh = l.need.h; if (rw && rw + 1 + lw > maxW) { w = Math.max(w, rw); h += rh + 1; rw = 0; rh = 0; } rw = rw ? rw + 1 + lw : lw; rh = Math.max(rh, lh); } return { w: Math.max(w, rw), h: h + rh }; };
    const widths = new Set(); let acc = 0;
    for (const l of lines) { acc = acc ? acc + 1 + l.need.w : l.need.w; widths.add(acc); widths.add(l.need.w); }
    let best = null, bs = Infinity;
    for (const mw of widths) { const p = shelf(mw), over = p.w > DESIGN_MAX[0] || p.h > DESIGN_MAX[1], sc = Math.max(p.w / 1.7, p.h) + (over ? 1000 : 0); if (sc < bs) { bs = sc; best = p; } }
    return best;
  }
  /* what a room's contents need: for zones, a 2 × 2 grid (each column as wide as its widest zone, each row as tall as its
     tallest; a zone across both shares them out) and where the grid splits, as fractions of the room; for a list of lines,
     the rows packLines lays them in (hardW × hardH: the least any room must be, its biggest single line) */
  function contentNeed(zones, lines) {
    if (lines.length) { const p = packLines(lines); return { w: p.w, h: p.h, fx: 1, fy: 1, one: true, hardW: Math.max(...lines.map(l => l.need.w)), hardH: Math.max(...lines.map(l => l.need.h)) }; }
    if (!zones.length) return { w: 0, h: 0, fx: 1, fy: 1, one: true };
    const colNeed = [0, 0], rowNeed = [0, 0];
    let spanW = 0, spanH = 0;
    for (const z of zones) {
      const [c, r, cs, rs] = AREAS[z.area];
      if (cs === 1) colNeed[c] = Math.max(colNeed[c], z.need.w); else spanW = Math.max(spanW, z.need.w);
      if (rs === 1) rowNeed[r] = Math.max(rowNeed[r], z.need.h); else spanH = Math.max(spanH, z.need.h);
    }
    const share = (need, span) => {
      let [a, b] = need;
      if (!a && !b) { a = Math.ceil(span / 2); b = span - a; }
      else if (!a) a = b; else if (!b) b = a;
      if (a + b < span) { const more = span - a - b; a += Math.ceil(more / 2); b += more >> 1; }
      return [a, b];
    };
    const one = zones.length === 1 && zones[0].area === 'whole';
    if (one) return { w: zones[0].need.w, h: zones[0].need.h, fx: 1, fy: 1, one: true };
    const [c0, c1] = share(colNeed, spanW), [r0, r1] = share(rowNeed, spanH);
    return { w: c0 + c1, h: r0 + r1, fx: c0 / (c0 + c1), fy: r0 / (r0 + r1), one: false };
  }

  /* FILL A ROOM on the probe: lines first (each laid inside its zone, or anywhere in the room, by the layout engine — never
     on a doorway's landing), then every style's furniture. `split` says where the 2 × 2 grid divides the room. Answers the
     part of the spec it built ({ lines, props }) and what the card will say about it; the probe holds the result. */
  /* a room's lines are SHELVED when it takes several, already holds some, or is a hall: each at the first clear spot in
     reading order, a tile in from the walls, AISLE clear of every line there (rows that fill the same at once or one by
     one); one line in a room its own size is CENTRED; failing both, anywhere it fits */
  function fillRoom(probe, env, roomId, R, zones, lines, split, roomLabel, recruitBase) {
    if (lines.length) {
      const shelved = lines.length > 1 || roomHasLines(probe, roomId) || isHallSized(R);
      for (const mode of shelved ? ['shelf', 'centred'] : ['centred']) {
        const cp = env.WorldModel.create(clone(probe.serialize()));
        if (fillRoomOnce(cp, env, roomId, R, zones, lines, split, roomLabel, recruitBase, mode).ok) return fillRoomOnce(probe, env, roomId, R, zones, lines, split, roomLabel, recruitBase, mode);
      }
    }
    return fillRoomOnce(probe, env, roomId, R, zones, lines, split, roomLabel, recruitBase, 'loose');
  }
  function fillRoomOnce(probe, env, roomId, R, zones, lines, split, roomLabel, recruitBase, mode) {
    const WM = env.WorldModel;
    const Wd = R.x2 - R.x1 + 1, Hd = R.y2 - R.y1 + 1;
    const cx = R.x1 + Math.max(1, Math.min(Wd - 1, Math.round(Wd * split.fx))), ry = R.y1 + Math.max(1, Math.min(Hd - 1, Math.round(Hd * split.fy)));
    const colX = [[R.x1, cx - 1], [cx, R.x2]], rowY = [[R.y1, ry - 1], [ry, R.y2]];
    const rectOf = a => { if (a == null || a === 'whole' || split.one) return { x1: R.x1, y1: R.y1, x2: R.x2, y2: R.y2 }; const [c, r, cs, rs] = AREAS[a]; return { x1: colX[c][0], x2: colX[c + cs - 1][1], y1: rowY[r][0], y2: rowY[r + rs - 1][1] }; };
    const land = landingTiles(probe, probe.projectGeometry(), roomId);
    const out = { lines: [], props: [], view: [], recruits: [] };
    const whereOf = z => z.area ? AREA_LABEL[z.area] + ' of ' + roomLabel : roomLabel;
    const lineList = zones.filter(q => q.kind === 'line').concat(lines);
    for (const z of lineList) {
      const zr = rectOf(z.area), fl = probe.lineGraph(null), nth = lines.indexOf(z), shelf = mode === 'shelf' && nth >= 0, gap = shelf ? AISLE : 1;
      if (!fl || !fl.ok) return refuse('this floor does not build by links');
      /* lines are told apart by their belts TOUCHING (Pipeline.lineComponents), so a new line keeps a clear tile from every
         belt and every workflow machine already on the floor; and it never stands on a doorway's landing */
      const halo = [];
      for (const k in fl.floor.belts) { const [x, y] = k.split(',').map(Number); halo.push({ x: x - gap, y: y - gap, w: 2 * gap + 1, h: 2 * gap + 1 }); }
      for (const p of probe.props()) if (MACHINE_T.test(p.t)) halo.push({ x: p.x - gap, y: p.y - gap, w: (p.w || 1) + 2 * gap, h: (p.h || 1) + 2 * gap });
      const floor = Object.assign({}, fl.floor, { rects: [shelf ? { x1: zr.x1 + 1, y1: zr.y1 + 1, x2: zr.x2 - 1, y2: zr.y2 - 1 } : zr], blocked: fl.floor.blocked.concat(halo, [...land].map(k => { const [x, y] = k.split(',').map(Number); return { x, y, w: 1, h: 1 }; })) });
      const near = { x: (zr.x1 + zr.x2) >> 1, y: (zr.y1 + zr.y2) >> 1 };
      let L = env.LineLayout.layout(z.graph, floor, shelf ? undefined : z.area || (nth >= 0 && mode === 'centred') ? { near } : undefined);
      if (!L.ok && !shelf && env.LineEdit && env.LineEdit._internals && env.LineEdit._internals.layoutNear) L = env.LineEdit._internals.layoutNear(env.LineLayout, z.graph, floor, near, 12);
      if (!L.ok) return refuse(whereOf(z) + ' is ' + (zr.x2 - zr.x1 + 1) + ' × ' + (zr.y2 - zr.y1 + 1) + (z.area ? '' : ' and has no clear floor left') + '; ' + (z.plain === 'a custom line' ? 'that line' : z.plain) + ' needs ' + z.need.w + ' × ' + z.need.h + '.', { tooSmall: true });
      const a = probe.applyLineLayout(clone(z.graph), L);
      if (!a || !a.ok) return refuse('that line could not be laid in ' + whereOf(z) + (a && a.msg ? ' (' + a.msg + ')' : ''));
      // its steps in RUN ORDER (a stand-in crew on a copy, so the order follows the belts), then who works them
      const lineIds = z.graph.nodes.map(n => a.ids[n.id]).filter(Boolean), nodeOf = {};
      for (const n of z.graph.nodes) nodeOf[a.ids[n.id]] = n;
      const cp = WM.create(clone(probe.serialize())), bayIds = lineIds.filter(pid => (nodeOf[pid] || {}).t === 'bay');
      bayIds.forEach((pid, i) => cp.assignPropAgent(pid, '__sb_probe_' + i));
      const shape = readLine(cp, lineIds, env, null), runOrder = shape.order.length === bayIds.length ? shape.order : bayIds;
      const stepsOut = runOrder.map((pid, i) => ({ step: i + 1, role: (nodeOf[pid] || {}).role || 'STEP', node: nodeOf[pid].id, brief: '', agentId: '' }));
      const st = staffSteps(stepsOut, z.staff, env, z.purpose); if (!st.ok) return st;
      for (const x of stepsOut) {
        if (x.brief) probe.setPropBrief(a.ids[x.node], x.brief);
        if (x.agentId) probe.assignPropAgent(a.ids[x.node], x.agentId);
      }
      out.lines.push({ graph: clone(z.graph), L, steps: stepsOut.map(x => ({ node: x.node, brief: x.brief, agentId: x.agentId })) });
      stepsOut.filter(x => x.recruit).forEach(x => out.recruits.push({ line: out.lines.length - 1, node: x.node, role: x.role }));
      out.view.push({ area: z.area || null, kind: 'line', rect: zr, z, lineIds, shape, runOrder, stepsOut, line: out.lines.length - 1 });
    }
    for (const z of zones.filter(q => q.kind === 'style')) {
      const zr = rectOf(z.area), sets = env.RoomStyles.STYLES[z.style].sets, inner = { x1: zr.x1 + 1, y1: zr.y1 + 1, x2: zr.x2 - 1, y2: zr.y2 - 1 };
      const iw = inner.x2 - inner.x1 + 1, ih = inner.y2 - inner.y1 + 1, onRight = zr.x2 === R.x2 && zr.x1 !== R.x1;
      let placed = null;
      const belts = probe.serialize().belts;
      for (const set of sets) {
        if (set.w > iw || set.h > ih) continue;
        const wallX = onRight ? inner.x2 - set.w + 1 : inner.x1, xs = [...new Set([wallX, onRight ? wallX - 1 : wallX + 1, inner.x1 + ((iw - set.w) >> 1), onRight ? inner.x1 : inner.x2 - set.w + 1])].filter(x => x >= inner.x1 && x + set.w - 1 <= inner.x2);
        const ys = [...new Set([inner.y1, inner.y1 + 1, inner.y1 + ((ih - set.h) >> 1), inner.y2 - set.h + 1])].filter(y => y >= inner.y1 && y + set.h - 1 <= inner.y2);
        outer: for (const mirror of onRight ? [true, false] : [false, true]) for (const y0 of ys) for (const x0 of xs) {
          const props = setProps(env, set, x0, y0, mirror); if (!props) return refuse('this page is missing the furniture for ' + env.RoomStyles.STYLES[z.style].name);
          const clash = props.some(p => { for (let yy = p.y; yy < p.y + p.h; yy++) for (let xx = p.x; xx < p.x + p.w; xx++) {
            if (probe.roomAt(xx, yy) !== roomId || probe.propAt(xx, yy) || belts[xx + ',' + yy] || (p.block && land.has(xx + ',' + yy))) return true; }
            return false; });
          if (clash) continue;
          const cp = WM.create(clone(probe.serialize())), added = [];
          let ok = true;
          for (const p of props) { const r = cp.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) { ok = false; break; } added.push(r.id); }
          if (!ok) continue;
          const g = cp.projectGeometry(), o = spawnTile(cp.serialize(), g);
          if (added.some(pid => { const p = cp.propById(pid); return p && p.block !== false && !sideReachable(g, o, p); })) continue;
          placed = { props }; break outer;
        }
        if (placed) break;
      }
      if (!placed) return refuse(whereOf(z) + ' is ' + (zr.x2 - zr.x1 + 1) + ' × ' + (zr.y2 - zr.y1 + 1) + ', with no clear spot there for ' + env.RoomStyles.STYLES[z.style].name + ' (it needs ' + (sets[sets.length - 1].w + 2) + ' × ' + (sets[sets.length - 1].h + 2) + ' of clear floor).', { tooSmall: true });
      for (const p of placed.props) probe.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block });
      out.props.push(...placed.props);
      out.view.push({ area: z.area, kind: 'style', rect: zr, z, props: placed.props });
    }
    return Object.assign({ ok: true }, out);
  }

  // the edit list of a build: each part its hallway, its room (or the existing room it fills), its lines, its furniture
  function buildParts(st, spec, WM) {
    const ids = [], parts = [];
    for (const part of spec.parts || []) {
      let roomId = part.roomId || null, hallId = null;
      const h2 = layHall2(st, part); if (!h2.ok) return h2;
      if (part.hall) {
        const r = st.placeHallway({ rect: part.hall }); if (!r || !r.ok) return refuse('the hallway could not be laid there' + (r && r.msg ? ' (' + r.msg + ')' : '')); hallId = r.id;
        if (part.hallDeck) { const d = st.setDeck(hallId, part.hallDeck); if (!d || !d.ok) return refuse('the hallway floor could not be laid'); }
        for (const p of part.hallProps || []) { const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block }); if (!r || !r.ok) return refuse('the hallway could not be dressed'); }
      }
      if (part.room) {
        const r = st.addRoom({ kind: part.room.kind, name: part.room.name, floorStyle: part.room.floorStyle, floorMat: part.room.floorMat, rect: part.room.rect });
        if (!r || !r.ok) return refuse('the room could not be added there' + (r && r.msg ? ' (' + r.msg + ')' : ''));
        roomId = r.id;
        if (part.room.walls) { const w = st.setWalls(roomId, part.room.walls); if (!w || !w.ok) return refuse('the walls could not be put up'); }
      }
      // lines first (the layout each was planned with was laid on exactly this floor), then the furniture
      const lines = [], mine = [];
      for (const ln of part.lines || []) {
        const a = st.applyLineLayout(clone(ln.graph), ln.L);
        if (!a || !a.ok) return refuse('a line could not be laid there' + (a && a.msg ? ' (' + a.msg + ')' : ''));
        const idOf = a.ids || {};
        for (const s of ln.steps || []) {
          const pid = idOf[s.node];
          if (!pid) return refuse('a step is missing');
          if (s.brief) { const r = st.setPropBrief(pid, s.brief); if (!r || !r.ok) return refuse('a step\'s instructions could not be saved'); }
          if (s.agentId) { const r = st.assignPropAgent(pid, s.agentId); if (!r || !r.ok) return refuse('a step\'s agent could not be assigned'); }
        }
        const lineIds = ln.graph.nodes.map(n => idOf[n.id]).filter(Boolean);
        mine.push(...lineIds);
        lines.push({ idOf, lineIds });
      }
      for (const p of part.props || []) {
        const r = st.addProp({ t: p.t, x: p.x, y: p.y, w: p.w, h: p.h, r: p.r || 0, block: p.block });
        if (!r || !r.ok) return refuse('a piece of furniture could not be placed there' + (r && r.msg ? ' (' + r.msg + ')' : ''));
        mine.push(r.id);
      }
      ids.push(...mine);
      parts.push({ roomId, hallId, lines, ids: mine });
    }
    return { ok: true, ids, parts, roomId: parts.length ? parts[0].roomId : null, lines: [].concat(...parts.map(p => p.lines)) };
  }
  // the same checks as every plan: no new routing problem, every existing line routes as before, and in each room nothing
  // solid on a doorway's landing and every new piece and machine reachable on foot (through the new hallways)
  function tryBuild(doc, spec, env, before) {
    const WM = env.WorldModel, P = env.Pipeline;
    const probe = WM.create(clone(doc));
    const b = buildParts(probe, spec, WM);
    if (!b.ok) return b;
    const after = floorFacts(probe, P), g = after.geo;
    for (const e of after.errs) if (!before.errs.has(e)) return refuse('that would add a routing problem (' + e.split(':')[0] + ')');
    for (const dock in before.chains) if (JSON.stringify(before.chains[dock]) !== JSON.stringify(after.chains[dock])) return refuse('that would change how an existing line routes');
    for (const dock in before.reach) if (!!before.reach[dock] !== !!after.reach[dock]) return refuse('that would change which existing steps an Inbox reaches');
    const o = spawnTile(probe.serialize(), g);
    for (const part of b.parts) {
      const land = landingTiles(probe, g, part.roomId || part.hallId);
      for (const pid of part.ids) {
        const p = probe.propById(pid);
        if (!p || p.block === false) continue;
        for (let yy = p.y; yy < p.y + p.h; yy++) for (let xx = p.x; xx < p.x + p.w; xx++) if (land.has(xx + ',' + yy)) return refuse('something would block a doorway');
        if (!sideReachable(g, o, p)) return refuse('something could not be walked up to');
      }
      if (o && part.hallId && !part.roomId) {
        const hr = probe.rooms().find(r => r.id === part.hallId), H = hr && hr.rects[0];
        if (H && !g.path(o.x - g.origin.tx, o.y - g.origin.ty, ((H.x1 + H.x2) >> 1) - g.origin.tx, ((H.y1 + H.y2) >> 1) - g.origin.ty)) return refuse('that hallway could not be walked into');
      }
      // an empty room must still be one the crew can walk into
      if (o && part.roomId && !part.ids.length) {
        const rm = probe.rooms().find(r => r.id === part.roomId), R = rm && rm.rects[0];
        if (R && !g.path(o.x - g.origin.tx, o.y - g.origin.ty, ((R.x1 + R.x2) >> 1) - g.origin.tx, ((R.y1 + R.y2) >> 1) - g.origin.ty)) return refuse('that room could not be walked into');
      }
    }
    return { ok: true, probe, built: b };
  }

  function planBuild(doc, req, env) {
    const WM = env && env.WorldModel, P = env && env.Pipeline, W = env && env.WorkflowLine, RS = env && env.RoomStyles;
    if (!WM || !P || !W || !doc || !env.PropSprites || !RS) return refuse('the station builder is not loaded on this page');
    if (req && typeof req === 'object' && !Array.isArray(req) && req.layout != null) return planLayout(doc, req, env);
    const HOW = 'Send { "rooms": [ … ] }: 1 to 24 rooms, each with ' + ROOM_KEYS.join(', ') + '; and/or { "hallways": [ { "from": room, "to": room } ] } to join rooms that face each other.';
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse(HOW);
    const extra = Object.keys(req).filter(k => BUILD_MENU.indexOf(k) < 0);
    if (extra.length) return refuse('StarNet computes every tile itself, so these fields are not accepted: ' + extra.slice(0, 8).join(', ') + '. ' + HOW);
    const reqRooms = req.rooms == null ? [] : req.rooms, reqHalls = req.hallways == null ? [] : req.hallways;
    if (!Array.isArray(reqRooms) || reqRooms.length > 24 || !Array.isArray(reqHalls) || reqHalls.length > 24 || !(reqRooms.length + reqHalls.length)) return refuse(HOW);
    const notes = [], live = WM.create(clone(doc)), before = floorFacts(live, P);
    let probe = WM.create(clone(doc));
    const spec = { kind: 'build', parts: [], recruits: [] }, rooms = [], usedNames = {};
    for (let i = 0; i < reqRooms.length; i++) {
      const q = reqRooms[i], nth = 'Room ' + (i + 1);
      if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse(HOW);
      const bad = Object.keys(q).filter(k => ROOM_KEYS.indexOf(k) < 0);
      if (bad.length) return refuse('StarNet computes every tile itself, so a room does not take: ' + bad.slice(0, 8).join(', ') + '. A room takes: ' + ROOM_KEYS.join(', ') + '.');
      const style = styleOf(WM, q); if (!style.ok) return style;
      // what goes in it: zones (by part of the room), or lines (anywhere in it), or nothing yet
      if (q.zones != null && q.lines != null) return refuse(nth + ' takes zones (what goes in each part of it) or lines (workflow lines anywhere in it), not both.');
      let zones = [], lines = [];
      if (q.zones != null) { const z = parseZones(q.zones, env, live, notes); if (!z.ok) return z; zones = z.zones; }
      if (q.lines != null) {
        if (!Array.isArray(q.lines) || !q.lines.length || q.lines.length > 16) return refuse('lines is a list of 1 to 16 workflow lines, each { line | purpose | shape, name, staff, dailyCap, tries }.');
        for (const l of q.lines) {
          if (!l || typeof l !== 'object' || Array.isArray(l)) return refuse('Each of a room\'s lines is an object with: ' + LINE_KEYS.join(', ') + '.');
          const lb = Object.keys(l).filter(k => LINE_KEYS.indexOf(k) < 0);
          if (lb.length) return refuse('A line only takes: ' + LINE_KEYS.join(', ') + '. Not accepted: ' + lb.slice(0, 6).join(', ') + '.');
          const ln = parseLine(l, env, live, notes); if (!ln.ok) return ln;
          lines.push(ln.line);
        }
      }
      // a whole-room style: its floor, walls and furniture from wall to wall, around any lines
      let rstyle = null;
      if (q.style != null) {
        rstyle = RS.resolveRoom ? RS.resolveRoom(q.style) : null;
        if (!rstyle) return refuse('There is no room style "' + String(q.style).slice(0, 40) + '". Styles: ' + (RS.ROOM_ORDER || []).join(', ') + '.');
        if (zones.length) return refuse(nth + ' takes a style (furnished whole) or zones (part by part), not both.');
        if (lines.length && rstyle !== 'works') return refuse(nth + ': lines go in a works room (a conveyor hall), so leave style out or set it to works.');
      }
      const rec = rstyle ? RS.ROOMS[rstyle] : null;
      const need = contentNeed(zones, lines);
      const given = typeof q.name === 'string' ? q.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : '';

      // an EXISTING room, furnished or filled where it stands
      if (q.into != null) {
        if (['size', 'beside', 'side', 'hallway', 'align'].some(k => q[k] != null)) return refuse(nth + ' fills an existing room (into), so it takes no size, beside, side, hallway or align.');
        if (given) return refuse('name names a NEW room; ' + String(q.into).slice(0, 40) + ' keeps its name (plan_restyle renames a room).');
        if (!zones.length && !lines.length && !rec) return refuse(nth + ' names an existing room (into) but nothing to put in it: give a style, zones or lines.');
        const t = roomNamed(probe, q.into); if (!t.ok) return t;
        const T = t.room;
        if (T.rects.length > 1) return refuse(T.name + ' is not a plain rectangle, so it cannot be split into zones. Build a new room instead.');
        const cp = WM.create(clone(probe.serialize())), R = T.rects[0];
        const f = fillRoom(cp, env, T.id, R, zones, lines, zones.length && !need.one ? { fx: 0.5, fy: 0.5, one: false } : { fx: 1, fy: 1, one: true }, T.name, 0);
        if (!f.ok) return f;
        const dr = rec ? dressRoom(cp, env, T.id, rstyle) : null;
        if (dr && !dr.ok) return dr;
        if (dr && !dr.props.length) return refuse(T.name + ' has no clear floor left for ' + rec.name + '.');
        const acc = accentsFor(cp, env, T.id, zones, rec);
        probe = cp;
        spec.parts.push({ hall: null, room: null, roomId: T.id, lines: f.lines, props: f.props.concat(dr ? dr.props : [], acc || []) });
        f.recruits.forEach(rc => spec.recruits.push(Object.assign({ part: spec.parts.length - 1 }, rc)));
        rooms.push({ part: spec.parts.length - 1, name: T.name, existing: true, R, view: f.view, placed: null, dressed: dr ? { style: rstyle, props: dr.props } : null, accents: acc });
        continue;
      }

      // a NEW room: its size, the room it stands beside, the side, the hallway
      const sz = sizeOfRoom(q.size); if (!sz.ok) return sz;
      const sd = sideOf(q.side); if (!sd.ok) return sd;
      const hl = hallOf(q.hallway); if (!hl.ok) return hl;
      let align = null;
      if (q.align != null) { align = { center: 'center', centre: 'center', middle: 'center', start: 'start', end: 'end' }[norm(q.align)]; if (!align) return refuse('align is center, start or end (where along the shared wall the room sits; start is the north or west end).'); }
      const minWH = zones.length > 1 ? DESIGN_MIN_MANY : (zones.length || lines.length) ? DESIGN_MIN_ONE : SIZES.medium;
      const tooSmall = () => refuse((given || nth) + ' at ' + sz.size[0] + ' × ' + sz.size[1] + ' is too small for what goes in it: that needs about ' + Math.max(need.w, minWH[0]) + ' × ' + Math.max(need.h, minWH[1]) + '. Leave size out, or ask for a bigger one.');
      if (sz.size && ((need.hardW || need.w) > sz.size[0] || (need.hardH || need.h) > sz.size[1])) return tooSmall();
      // a conveyor hall with no size asked is a hall: giant, with floor for the lines to come (as a layout's is)
      const hallMin = rstyle === 'works' ? SIZES.giant : minWH;
      const RW = sz.size ? sz.size[0] : Math.max(need.w, minWH[0], hallMin[0]), RH = sz.size ? sz.size[1] : Math.max(need.h, minWH[1], hallMin[1]);
      if (RW > DESIGN_MAX[0] || RH > DESIGN_MAX[1]) return refuse('What goes in ' + (given || nth) + ' needs a ' + RW + ' × ' + RH + ' room, larger than the ' + DESIGN_MAX[0] + ' × ' + DESIGN_MAX[1] + ' StarNet builds at once. Split it into two rooms.');
      const tq = q.beside != null ? roomNamed(probe, q.beside) : { ok: true, room: null };   // no room named: beside whichever keeps the station compact
      if (!tq.ok) return tq;
      const kind = (style.type && style.type.id) || (rec && rec.kind) || 'hab';
      // no name given: a whole-room style names it (LOUNGE, CONVEYOR HALL), else what fills it first (COZY, the line's own name), else ROOM n
      const z0 = zones[0] || lines[0], auto = rstyle && AUTO_NAME[rstyle] ? AUTO_NAME[rstyle] : !z0 ? 'ROOM ' + (live.rooms().filter(r => r.kind !== 'corridor').length + rooms.filter(r => !r.existing).length + 1) : z0.kind === 'style' ? z0.style.toUpperCase() : String(z0.label || z0.plain || 'WORKROOM').toUpperCase();
      const taken = nm => probe.rooms().some(r => r.kind !== 'corridor' && norm(r.name) === norm(nm)) || usedNames[norm(nm)];
      let name = (given || auto).slice(0, 24);
      if (given && taken(name)) return refuse('A room is already called ' + name + '. Give this one another name.');
      for (let k = 2; !given && taken(name) && k < 50; k++) name = (auto.slice(0, 21) + ' ' + k);
      usedNames[norm(name)] = 1;
      const roomSpec = { kind, name, floorStyle: style.floorStyle || (rec && !style.type ? rec.deck.style : undefined), floorMat: style.floorMat || (rec && !style.type ? rec.deck.mat : undefined), walls: rec ? rec.walls : undefined };
      // a size StarNet chose is an estimate: when the contents do not fit it, the room grows and tries again
      const tries = sz.size ? [[RW, RH]] : [[RW, RH], [RW + 2, RH + 1], [RW + 4, RH + 3], [RW + 7, RH + 5]].filter(([w, h], i) => !i || (w <= DESIGN_MAX[0] && h <= DESIGN_MAX[1]));
      let got = null, why = null;
      const onGrid = q.beside == null && q.side == null && q.align == null && q.hallway == null;   // a size asked keeps the grid too, at that size
      for (const [TW, TH] of tries) {
      const grid = onGrid ? gridSpots(WM, probe, TW, TH, hangsOf(env), !!sz.size) : [];
      const pl = roomPlacements(probe, tq.room, TW, TH, { side: sd.side, len: hl.len, align, kind, hangs: hangsOf(env) });
      if (!pl.ok && !grid.length) { why = why || pl; break; }
      let small = false;
      for (const cand of grid.concat(pl.ok ? pl.list : [])) {
        const cp = WM.create(clone(probe.serialize()));
        if (cand.ext) { const h0 = cp.placeHallway({ rect: cand.ext }); if (!h0 || !h0.ok) { why = why || refuse('the concourse could not be lengthened there'); continue; } cp.setDeck(h0.id, CORRIDOR_DECK); }
        if (cand.hall) { const h = cp.placeHallway({ rect: cand.hall }); if (!h || !h.ok) { why = why || refuse('the hallway could not be laid there'); continue; } }
        const a = cp.addRoom(Object.assign({}, roomSpec, { rect: cand.rect }));
        if (!a || !a.ok) { why = why || refuse('the room could not be added there'); continue; }
        if (roomSpec.walls) cp.setWalls(a.id, roomSpec.walls);
        const f = fillRoom(cp, env, a.id, cand.rect, zones, lines, need, name, 0);
        if (!f.ok) { if (!why || f.tooSmall) why = f; if (f.tooSmall) { small = true; break; } continue; }
        const dr = rec ? dressRoom(cp, env, a.id, rstyle) : null;
        if (dr && !dr.ok) { why = why || dr; continue; }
        const acc = accentsFor(cp, env, a.id, zones, rec);
        const part = Object.assign({ hall: cand.hall, room: Object.assign({}, roomSpec, { rect: cand.rect }), roomId: null, lines: f.lines, props: f.props.concat(dr ? dr.props : [], acc || []) }, gridHallTrim(WM, env, probe, cand, kind));
        const t = tryBuild(doc, { kind: 'build', parts: spec.parts.concat([part]) }, env, before);
        if (!t.ok) { why = why || t; continue; }
        got = { cand, f, part, cp, dr, acc }; break;
      }
      if (got || !small) break;
      }
      if (!got && sz.size && why && why.tooSmall) return tooSmall();
      if (!got) return why || refuse('There is no clear space for ' + name + (tq.room ? ' beside ' + tq.room.name : '') + '.');
      probe = got.cp;
      spec.parts.push(got.part);
      got.f.recruits.forEach(rc => spec.recruits.push(Object.assign({ part: spec.parts.length - 1 }, rc)));
      rooms.push({ part: spec.parts.length - 1, name, existing: false, R: got.cand.rect, view: got.f.view, placed: got.cand, word: sz.word || null, dressed: got.dr ? { style: rstyle, props: got.dr.props } : null, accents: got.acc });
    }
    // hallways between rooms that already stand, or that this plan has just added
    const halls = [];
    for (const h of reqHalls) {
      if (!h || typeof h !== 'object' || Array.isArray(h) || h.from == null || h.to == null || Object.keys(h).some(k => k !== 'from' && k !== 'to')) return refuse('Each hallway is { "from": a room, "to": another room }. StarNet lays it straight between them.');
      const A = roomNamed(probe, h.from); if (!A.ok) return A;
      const B = roomNamed(probe, h.to); if (!B.ok) return B;
      if (A.room.id === B.room.id) return refuse('A hallway joins two different rooms.');
      let hb = hallBetween(probe, A.room, B.room, hangsOf(env));
      if (!hb.ok && /do not face each other/.test(hb.error)) hb = hallL(probe, A.room, B.room, hangsOf(env));   // round one corner
      if (!hb.ok) return hb;
      const rects = hb.rects || [hb.rect], ids = [];
      for (const rc of rects) { const r = probe.placeHallway({ rect: rc }); if (!r || !r.ok) return refuse('the hallway could not be laid there'); ids.push(r.id); probe.setDeck(r.id, CORRIDOR_DECK); }
      // a station corridor like a layout's: the deck, and planters and lights where it is long enough
      rects.forEach((rc, k) => { const d = dressHall(probe, env, ids[k], null); spec.parts.push({ hall: rc, hallDeck: CORRIDOR_DECK, room: null, roomId: null, lines: [], props: (d && d.props) || [] }); });
      halls.push({ from: A.room.name, to: B.room.name, corner: rects.length > 1, len: rects.reduce((n, rc) => n + Math.max(rc.x2 - rc.x1, rc.y2 - rc.y1) + 1, 0) });
    }
    const sr = seatRecruits(probe, env, spec, pi => { const p = spec.parts[pi]; return p.roomId || (p.room ? probe.roomAt(p.room.rect.x1, p.room.rect.y1) : null); });
    if (!sr.ok) return sr;
    const t = tryBuild(doc, spec, env, before);
    if (!t.ok) return t;

    // what the card says: each room (where it stands and how it is joined), what is in it, the equipment, what is still to do
    const fp = t.probe, built = t.built, crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean);
    const rp = WM.create(clone(fp.serialize())), deskRooms = [];
    spec.recruits.forEach((rc, i) => {
      const id = '__sb_recruit_' + i, slot = rc.desk ? rp.propAt(rc.desk.x, rc.desk.y) : null;
      const d = slot ? Object.assign(rp.assignPropAgent(slot, id) || {}, { roomId: rp.roomAt(rc.desk.x, rc.desk.y) }) : rp.ensureWorkstation(id);
      if (d && d.ok && d.roomId) { const rm = rp.roomById ? rp.roomById(d.roomId) : null; if (rm && deskRooms.indexOf(rm.name) < 0) deskRooms.push(rm.name); }
      rp.assignPropAgent(built.parts[rc.part].lines[rc.line].idOf[rc.node], id); crewIds.push(id);
    });
    const allLines = [].concat(...rooms.map(r => r.view.filter(v => v.kind === 'line')));
    const lines = [], steps = [], equipProps = [], zonesView = [];
    const roomText = rooms.map(r => {
      const Wd = r.R.x2 - r.R.x1 + 1, Hd = r.R.y2 - r.R.y1 + 1;
      const where = r.existing ? r.name + ' (' + Wd + ' × ' + Hd + ')'
        : r.name + ', a new ' + Wd + ' × ' + Hd + ' room ' + r.placed.side + ' of ' + r.placed.target + (r.placed.len ? ', through a hallway' : ', open to it');
      r.where = where;
      const order = (reqRooms[rooms.indexOf(r)].zones || []).map(z => areaOf(z.area));
      const body = r.view.slice().sort((a, b) => (a.area ? order.indexOf(a.area) : 99) - (b.area ? order.indexOf(b.area) : 99)).map(v => {
        const at = v.area && !(r.view.length === 1 && v.area === 'whole') ? AREA_LABEL[v.area] + ', ' : '';
        if (v.kind === 'style') {
          equipProps.push(...v.props);
          zonesView.push({ rect: v.rect, where: v.area ? AREA_LABEL[v.area].replace(/^the /, '') + (rooms.length > 1 ? ' of ' + r.name : '') : (rooms.length > 1 ? r.name : 'room'), label: env.RoomStyles.STYLES[v.z.style].name });
          return at + env.RoomStyles.STYLES[v.z.style].name + ' (' + piecesText(env, v.props) + ')';
        }
        const bl = built.parts[r.part].lines[v.line], ids = bl.lineIds, rd = readLine(rp, ids, env, crewIds);
        const recruitNodes = new Set(spec.recruits.filter(x => x.part === r.part && x.line === v.line).map(x => x.node));
        const stepsView = v.stepsOut.map(x => ({ step: x.step, role: titleCase(x.role), agent: recruitNodes.has(x.node) ? 'a new recruit' : x.agentId ? nameOf(env, x.agentId) : null, instructions: x.brief }));
        stepsView.forEach(s => steps.push(Object.assign({}, s, { role: s.role + (allLines.length > 1 ? ' on ' + (v.z.label || v.z.plain) : '') })));
        const capP = ids.map(id => fp.propById(id)).find(p => p && p.t === 'intake'), capNow = capP && capP.limits ? capP.limits.maxUsdPerDay : null;
        lines.push({ label: v.z.label, plain: v.z.plain, room: r.name, area: v.area, part: r.part, line: v.line, ready: rd.ready, blocking: rd.blocking, picked: v.z.picked });
        equipProps.push(...ids.map(id => fp.propById(id)).filter(Boolean));
        zonesView.push({ rect: v.area ? v.rect : r.R, where: v.area ? AREA_LABEL[v.area].replace(/^the /, '') + (rooms.length > 1 ? ' of ' + r.name : '') : (rooms.length > 1 ? r.name : 'room'), label: v.z.label || v.z.plain });
        return at + v.z.plain + (v.z.label ? ' ("' + v.z.label + '")' : '') + ': ' + flowText(v.shape.cols, v.runOrder, stepsView)
          + (v.z.graph.nodes.some(n => n.t === 'outbox') ? ' → Outbox' : '') + (capP ? (capNow != null ? ' · daily cap $' + capNow : ' · no daily cap') : '');
      });
      if (r.dressed) {
        equipProps.push(...r.dressed.props);
        const txt = piecesText(env, r.dressed.props).split(', '), pieces = txt.length > 7 ? txt.slice(0, 6).join(', ') + ' and more' : txt.join(', ');
        body.unshift(env.RoomStyles.ROOMS[r.dressed.style].name + (r.dressed.props.length && r.dressed.style !== 'works' ? ' (' + pieces + ')' : ''));
      }
      if (r.accents) body.push(piecesText(env, r.accents) + ' in the corners');
      return where + ': ' + (body.length ? body.join('; ') : 'empty floor, ready for lines and furniture') + '.';
    });
    const equip = equipmentOf(env, equipProps), gains = gainsOf(env, equipProps);
    const blocking = [].concat(...lines.map(l => l.blocking.map(b => (lines.length > 1 ? (l.label || l.plain) + ': ' : '') + b)));
    const hallText = halls.map(h => 'A new hallway' + (h.corner ? ', round one corner,' : '') + ' joins ' + h.from + ' and ' + h.to + '.');
    const summary = roomText.concat(hallText).join(' ')
      + (equip.length ? ' It brings equipment: ' + equip.join(', ') + (gains.length ? '. What agents gain there: ' + gains.join('; ') : '') + '.' : '')
      + (lines.length ? ' ' + (blocking.length ? 'Still to do after building: ' + blocking.join('; ') + '.' : (lines.length > 1 ? 'Its lines will be ready to run.' : 'It will be ready to run.')) : '')
      + (spec.recruits.length ? ' It adds ' + spec.recruits.length + ' crew member' + (spec.recruits.length > 1 ? 's' : '') + ': ' + spec.recruits.map(r => r.role).join(', ') + (deskRooms.length ? ', with a desk in ' + deskRooms.join(' and ') : '') + '. UNDO does not remove agents; DELETE AGENT in a Dossier does.' : '')
      + lines.filter(l => l.picked).map(l => ' Picked for ' + (l.label || l.plain) + ': ' + l.picked + '.').join('');
    const fpd = fp.serialize();
    const preview = previewOf(WM, doc, fpd, zonesView, null);
    for (const r of rooms) if (r.existing) { const pr = preview.rooms[fpd.order.indexOf(spec.parts[r.part].roomId)]; if (pr) pr.mine = true; }
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(fpd), spec, summary, notes, steps,
      rooms: rooms.map(r => ({ name: r.name, where: r.where, existing: r.existing })), hallways: halls,
      where: rooms.map(r => r.where).concat(halls.map(h => 'a hallway between ' + h.from + ' and ' + h.to)).join('; '), lines, preview, line: null } };
  }

  /* ================= STATION LAYOUTS (2026-09-30): a whole station composed the way the hand-built showcases were =========
     Andrew, after seeing two stations laid out by hand ("this is so much better, can the agent reliably do this?"): the
     lead names a PATTERN and the rooms; StarNet composes the floor plan — the corridors, where every room sits, the halls
     that join them — furnishes each room from wall to wall in its style (floor, walls, feature wall, centrepiece, plants),
     and dresses the corridors. Two patterns:
       ring       a corridor loop around the hub room (the bridge) with a spoke in from each side; rooms around the outside
                  of the loop, two to the north, two to the south, one big room east and one west
       concourse  a wide corridor from one side of the hub, rooms on short halls down both sides, a big room at the far end
     Nothing is placed by the model. Added beside what stands (every check of a build holds), or with replace: true the
     whole station is laid out again around the hub (backed up for RESTORE PREVIOUS, like a preset swap). */
  const LAYOUT_KEYS = ['pattern', 'around', 'side', 'rooms'];
  const LAYOUT_ROOM_KEYS = ['name', 'style', 'size', 'lines', 'zones'];
  const PATTERNS = { diamond: 'diamond', ring: 'diamond', loop: 'diamond', circle: 'diamond', hub: 'diamond', star: 'diamond', cross: 'diamond', grid: 'diamond', concourse: 'concourse', corridor: 'concourse', spine: 'concourse', hallway: 'concourse', street: 'concourse', main: 'concourse' };
  const AUTO_NAME = { lounge: 'LOUNGE', cozy: 'DEN', games: 'ARCADE', library: 'LIBRARY', quarters: 'QUARTERS', garden: 'GARDEN', cafe: 'CAFE', desks: 'OFFICE',
    meeting: 'MEETING ROOM', lab: 'LAB', workshop: 'WORKSHOP', comms: 'COMMS', storage: 'STORES', gym: 'GYM', works: 'CONVEYOR HALL' };
  const CORRIDOR_DECK = { style: 'onyx', mat: 'runner' };

  // the tiles INSIDE a room (or hallway) where a doorway opens, and which way is into the room
  function doorTiles(st, g, roomId) {
    const out = [], ox = g.origin.tx, oy = g.origin.ty;
    for (const d of g.doorDefs || []) {
      const a = { x: d[0] + ox, y: d[1] + oy }, b = { x: d[2] + ox, y: d[3] + oy };
      const inA = st.roomAt(a.x, a.y) === roomId, inB = st.roomAt(b.x, b.y) === roomId;
      if (inA === inB) continue;
      const door = inA ? a : b, other = inA ? b : a;
      out.push({ x: door.x, y: door.y, dx: door.x - other.x, dy: door.y - other.y });
    }
    return out;
  }
  // take back any piece nobody can walk up to (and what stands on it), until every solid piece is reachable
  function pruneUnreachable(st, placed) {
    for (let pass = 0; pass < 4; pass++) {
      const g = st.projectGeometry(), o = spawnTile(st.serialize(), g);
      const drop = placed.filter(p => p.block && !sideReachable(g, o, p));
      if (!drop.length) return;
      for (const p of drop) {
        for (const q of placed) if (q !== p && !q.block && q.x >= p.x && q.x < p.x + p.w && q.y >= p.y && q.y < p.y + p.h) { st.removeProp(q.id); q.gone = true; }
        st.removeProp(p.id); p.gone = true;
      }
      for (let i = placed.length - 1; i >= 0; i--) if (placed[i].gone) placed.splice(i, 1);
    }
  }
  /* DRESS A ROOM from wall to wall in a whole-room style (RoomStyles.ROOMS), ON the probe: the feature wall is the one
     opposite the door (north unless a door is there), lined with the style's signature pieces; the centrepiece stands in
     the middle facing it; plants take the corners; accents stand along the side walls. Every doorway keeps a clear lane
     three tiles deep, nothing lands on a belt, and a piece nobody could walk up to is taken back out. Answers the pieces
     placed, in the order they were placed (a lamp after its table), for the build to lay again exactly. */
  // corner plants for a room made only of styled zones (no whole-room recipe, no line: a line's half keeps its floor)
  const ACCENTS = { corners: ['tallplant', 'plant', 'plant', 'tallplant'] };
  function accentsFor(st, env, roomId, zones, rec) {
    if (rec || !zones.length || !zones.every(z => z.kind === 'style')) return null;
    const d = dressRoom(st, env, roomId, ACCENTS);
    return d.ok && d.props.length ? d.props : null;
  }
  function dressRoom(st, env, roomId, styleId) {
    const RS = env.RoomStyles, S = env.PropSprites, rec = styleId && typeof styleId === 'object' ? styleId : RS && RS.ROOMS ? RS.ROOMS[styleId] : null;
    if (!rec) return refuse('there is no room style "' + styleId + '"');
    const rm = st.rooms().find(r => r.id === roomId); if (!rm) return refuse('the room is missing');
    const R = rm.rects[0], W = R.x2 - R.x1 + 1, H = R.y2 - R.y1 + 1;
    const g = st.projectGeometry(), doors = doorTiles(st, g, roomId), reserve = new Set(), onWall = { north: 0, south: 0, west: 0, east: 0 };
    for (const d of doors) {
      onWall[d.dy > 0 ? 'north' : d.dy < 0 ? 'south' : d.dx > 0 ? 'west' : 'east']++;
      for (let k = 0; k < 3; k++) reserve.add((d.x + d.dx * k) + ',' + (d.y + d.dy * k));
    }
    // the feature wall is the south one when the only door is north, unless the centrepiece holds a couch: it is drawn from
    // behind facing north, so mirrored it would turn its back on the TV
    const flip = onWall.north > 0 && !onWall.south && !(rec.centre || []).some(set => set.pieces.some(p => p[0] === 'couch'));
    // ...and a set mirrored north-south turns its chairs with it (a chair below its table faces up at it); a desk keeps its
    // facing, since its north view comes with a chair of its own
    const isChair = isSeatPiece(env), flipFacing = (t, r) => flip && (r === 0 || r === 2) && isChair(t) && S.canRotate && S.canRotate(t) && (!S.facings || S.facings(t).indexOf(2 - r) >= 0) ? 2 - r : r;
    const belts = st.serialize().belts || {}, placed = [];
    // what already covers each tile: a rug ('flat') may lie under furniture, furniture ('solid') excludes anything but
    // what stands on a table
    const occ = new Map(), kindOf = sp => sp && sp.flat ? 'flat' : sp && sp.blocks === false ? 'other' : 'solid';
    const mark = (x, y, w, h, kind) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const k = xx + ',' + yy; if (kind !== 'flat' || !occ.has(k)) occ.set(k, kind); } };
    for (const p of st.props()) mark(p.x, p.y, p.w || 1, p.h || 1, kindOf(S.spec(p.t)));
    for (const k of deskSeats(st, roomId, S).keys()) reserve.add(k);   // a desk's seat row stays clear: it brings its own chair
    const blocks = (sp, x, y) => {
      const flat = !!sp.flat, onTop = !!(sp.stack || sp.mount === 'surface'), solid = sp.blocks !== false;
      for (let yy = y; yy < y + sp.h; yy++) for (let xx = x; xx < x + sp.w; xx++) {
        const k = xx + ',' + yy, o = occ.get(k);
        if (st.roomAt(xx, yy) !== roomId || belts[k] || (solid && reserve.has(k))) return true;
        if (flat ? o === 'flat' : (o && o !== 'flat' && !onTop)) return true;
      }
      return false;
    };
    const add = (t, x, y, r) => {
      // a LEFT/RIGHT twin against a side wall faces into the room (a heavy bag on the west wall faces east)
      { const sf = sideFacing(S, t), s0 = S.spec(t); if (sf != null && s0 && ((sf === 1 && x === R.x1) || (sf === 3 && x + s0.w - 1 === R.x2))) t = twinOf(S, t) || t; }
      const sp = S.spec(t); if (!sp || blocks(sp, x, y)) return false;
      const solid = sp.blocks !== false;
      // a desk needs its own seat row clear, and keeps it clear for what comes after
      const row = isWorkstation(st, t) ? seatRow({ t, x, y, w: sp.w, h: sp.h, r: r || 0 }, S) : [];
      if (row.some(([xx, yy]) => { const k = xx + ',' + yy, o = occ.get(k); return st.roomAt(xx, yy) !== roomId || belts[k] || (o && o !== 'flat'); })) return false;
      const a = st.addProp({ t, x, y, w: sp.w, h: sp.h, r: r || 0, block: solid });
      if (!a || !a.ok) return false;
      for (const [xx, yy] of row) reserve.add(xx + ',' + yy);
      placed.push({ id: a.id, t, x, y, w: sp.w, h: sp.h, r: r || 0, block: solid });
      mark(x, y, sp.w, sp.h, kindOf(sp));
      return true;
    };
    // the feature wall: its groups left, centre and right, each lined up against the wall
    const lineWall = (groups, wall) => {
      if (!groups) return 0;
      let depth = 0;
      const rowOf = h => wall === 'south' ? R.y2 - h + 1 : R.y1;
      // a run of pieces from x0 along the wall; a piece that meets a doorway's lane steps past it rather than being lost
      const run = (list, x0, dir) => {
        let x = x0;
        for (const t of list || []) {
          const s = S.spec(t); if (!s) continue;
          for (;;) {
            const px = dir > 0 ? x : x - s.w + 1;
            if (px < R.x1 + 1 || px + s.w - 1 > R.x2 - 1) return;
            if (add(t, px, rowOf(s.h), 0)) { depth = Math.max(depth, s.h); x = dir > 0 ? px + s.w : px - 1; break; }
            x += dir;
          }
        }
      };
      // the centre group first, so the wall's signature piece (the TV) takes the middle, or the nearest clear stretch of
      // wall beside a doorway there, before the side groups fill in
      const mid = groups.centre || [], ms = mid.map(t => S.spec(t)).filter(Boolean), mw = ms.reduce((n, sp) => n + sp.w, 0);
      if (ms.length) {
        const c0 = R.x1 + ((W - mw) >> 1), offs = [0];
        for (let k = 1; k < W; k++) offs.push(-k, k);
        for (const o of offs) {
          const x0 = c0 + o;
          if (x0 < R.x1 + 1 || x0 + mw - 1 > R.x2 - 1) continue;
          let x = x0, fits = true;
          for (const sp of ms) { if (blocks(sp, x, rowOf(sp.h))) { fits = false; break; } x += sp.w; }
          if (fits) { run(mid, x0, 1); break; }
        }
      }
      run(groups.left, R.x1 + 1, 1);
      run(groups.right, R.x2 - 1, -1);
      return depth;
    };
    const featureWall = flip ? 'south' : 'north';
    const depth = lineWall(rec.feature, featureWall);
    if (rec.front) lineWall(rec.front, flip ? 'north' : 'south');
    // the centrepiece: the largest cluster that fits the floor left, centred, facing the feature wall
    // a doorway on the open side first keeps whole rows clear before it; where that leaves no room for any set (an office 8
    // tall with its door north had no desks), only the doorway's own lane stays clear
    let centred = null;
    for (const roomy of [true, false]) for (const set of rec.centre || []) {
      if (centred) break;
      const top = flip ? R.y1 + 1 + (roomy && onWall.north ? 3 : 0) : R.y1 + depth + 1, bottom = flip ? R.y2 - depth - 1 : R.y2 - 1 - (roomy && onWall.south ? 2 : 0);
      if (set.w > W - 2 || set.h > bottom - top + 1) continue;
      const x0 = R.x1 + ((W - set.w) >> 1), y0 = top + ((bottom - top + 1 - set.h) >> 1);
      const tries = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [-3, 0], [3, 0], [-2, 1], [2, 1], [-2, -1], [2, -1]];
      for (const [dx, dy] of tries) {
        const ax = x0 + dx, ay = y0 + dy;
        const ps = set.pieces.map(([t, x, y, facing]) => { const sp = S.spec(t); return sp ? { t, x: ax + x, y: flip ? ay + set.h - y - sp.h : ay + y, r: flipFacing(t, facing || 0), sp } : null; }).filter(Boolean);
        // every solid piece must have its floor (what stands on a table is checked when its table is down)
        if (ps.some(p => p.sp.blocks !== false && !p.sp.stack && p.sp.mount !== 'surface' && blocks(p.sp, p.x, p.y))) continue;
        const before = placed.length, rank = p => p.sp.flat ? 0 : (p.sp.stack || p.sp.mount === 'surface') ? 2 : 1;
        for (const p of ps.slice().sort((a, b) => rank(a) - rank(b))) add(p.t, p.x, p.y, p.r);
        if (placed.length > before) { centred = set; break; }
      }
      if (centred) break;
    }
    // plants in the corners (the feature wall's corners first), accents along the side walls
    const corners = flip ? [[R.x1, R.y2, 1, -1], [R.x2, R.y2, -1, -1], [R.x1, R.y1, 1, 1], [R.x2, R.y1, -1, 1]] : [[R.x1, R.y1, 1, 1], [R.x2, R.y1, -1, 1], [R.x1, R.y2, 1, -1], [R.x2, R.y2, -1, -1]];
    (rec.corners || []).forEach((t, i) => {
      const s = S.spec(t), c = corners[i]; if (!s || !c) return;
      add(t, c[2] > 0 ? c[0] : c[0] - s.w + 1, c[3] > 0 ? c[1] : c[1] - s.h + 1, 0);
    });
    const cy = (R.y1 + R.y2) >> 1, offs = [0, 2, -2, 4, -4];
    (rec.sides || []).forEach((t, i) => {
      const s = S.spec(t); if (!s) return;
      const west = i % 2 === 0, x = west ? R.x1 : R.x2 - s.w + 1;
      const at = [0, 3, -3, 5, -5][i >> 1] || 0;
      for (const o of offs.map(v => v >> 1)) if (add(t, x, cy + at + o - (s.h >> 1), 0)) break;
    });
    pruneUnreachable(st, placed);
    return { ok: true, props: placed.map(({ id, gone, ...p }) => p), centre: !!centred, featureWall };
  }
  /* DRESS A CORRIDOR: planters, floor lights and benches along its edge rows — the outer edge of a 3-wide corridor, both
     edges of a wider one — never within a tile of a doorway, always two rows clear to walk. A corridor running north-south
     takes one-tile pieces only (a planter would half-block it). */
  function dressHall(st, env, hallId, outer) {
    const S = env.PropSprites, rm = st.rooms().find(r => r.id === hallId); if (!rm) return { ok: true, props: [] };
    const R = rm.rects[0], W = R.x2 - R.x1 + 1, H = R.y2 - R.y1 + 1, horiz = W >= H, thick = horiz ? H : W, len = horiz ? W : H;
    if (thick < 3 || len < 8) return { ok: true, props: [] };
    const g = st.projectGeometry(), doors = doorTiles(st, g, hallId);
    const rows = thick >= 4 ? ['a', 'b'] : [outer === 'north' || outer === 'west' ? 'a' : 'b'];
    const pattern = horiz ? ['industrial_planter', 'arc_floorlight', 'industrial_bench', 'arc_floorlight'] : ['tallplant', 'arc_floorlight', 'plant', 'arc_floorlight'];
    const placed = [];
    for (const row of rows) {
      // a piece keeps clear of every doorway that opens on its own row, and of the tile either side of it
      const line = horiz ? (row === 'a' ? R.y1 : R.y2) : (row === 'a' ? R.x1 : R.x2), near = new Set();
      for (const d of doors) if ((horiz ? d.y : d.x) === line) for (let q = -1; q <= 1; q++) near.add((horiz ? d.x : d.y) + q);
      let k = 0;
      for (let u = 1; u < len - 1; u += 4) {
        const t = pattern[k % pattern.length], s = S.spec(t); if (!s) continue;
        const span = horiz ? s.w : s.h;
        let ok = true;
        for (let q = u; q < u + span; q++) if (near.has((horiz ? R.x1 : R.y1) + q)) ok = false;
        if (!ok) continue;
        const x = horiz ? R.x1 + u : (row === 'a' ? R.x1 : R.x2 - s.w + 1), y = horiz ? (row === 'a' ? R.y1 : R.y2 - s.h + 1) : R.y1 + u;
        const a = st.addProp({ t, x, y, w: s.w, h: s.h, r: 0, block: s.blocks !== false });
        if (a && a.ok) { placed.push({ id: a.id, t, x, y, w: s.w, h: s.h, r: 0, block: s.blocks !== false }); k++; }
      }
    }
    pruneUnreachable(st, placed);
    return { ok: true, props: placed.map(({ id, gone, ...p }) => p) };
  }

  /* THE PATTERNS' GEOMETRY: pure rects around the hub's box B. Each answers { halls: [{ rect, dress, outer }], rooms:
     [{ i, rect, side }] } — halls in the order they are laid, `dress` on the corridors people walk along (not the short
     halls), and every room i of the request in its slot — or a refusal saying how many rooms the pattern holds. */
  /* THE DIAMOND (2026-09-30, after Andrew's test: "good at designing the rooms, terrible at judging where to place them…
     I still want it to keep the diamond shape even with the new rooms"). Every room stands on an EVEN GRID around the
     hub, the same size as the bridge, a hallway apart, and the grid is filled in diamond order — the four sides first,
     then the four corners and the far sides, then the next ring out — each room paired with the one opposite it, so the
     station keeps its diamond at every size. A room added later goes in the next free place of the same grid, so the
     shape holds as the station grows. At the centre, when the space round the hub is clear, a corridor loop with a
     hallway in from each side (the ring). Big rooms (a conveyor hall) take the east and west wings first, then north and
     south, anchored on the grid's inner edge. Each room is joined by a straight hallway to what faces it toward the hub
     (the ring, the hub, or the room one step in). Answers { halls, rooms } laid on `scratch`, or why a room found no place. */
  const CELL = [18, 11], DIAMOND_ROOMS = 40;
  function diamondOrder(maxD) {
    const out = [];
    for (let d = 1; d <= maxD; d++) {
      for (let a = 1; a < d; a++) { const b = d - a; out.push([a, -b], [-a, b], [-a, -b], [a, b]); }
      out.push([0, -d], [0, d], [d, 0], [-d, 0]);
    }
    return out;
  }
  /* the same grid filled toward a shape: "wide" spreads along the rows first (a station wider than it is tall), "tall"
     along the columns; each cost step lists its cells in opposite pairs, so the station stays symmetric as it grows */
  function shapedOrder(shape, maxD) {
    const cost = shape === 'tall' ? (i, j) => 2 * Math.abs(i) + Math.abs(j) : (i, j) => Math.abs(i) + 2 * Math.abs(j), out = [];
    for (let c = 1; c <= maxD * 2; c++) {
      const at = [];
      for (let i = -maxD * 2; i <= maxD * 2; i++) for (let j = -maxD; j <= maxD; j++) if ((i || j) && cost(i, j) === c) at.push([i, j]);
      // pairs: (i, j) with (-i, -j), then its mirror pair, nearest the middle line first
      at.sort((a, b) => (Math.abs(a[1]) - Math.abs(b[1])) || (Math.abs(a[0]) - Math.abs(b[0])) || (b[0] - a[0]) || (a[1] - b[1]));
      const seen = new Set(), k = p => p[0] + ',' + p[1];
      for (const p of at) for (const q of [p, [-p[0], -p[1]], [-p[0], p[1]], [p[0], -p[1]]]) if (cost(q[0], q[1]) === c && !seen.has(k(q))) { seen.add(k(q)); out.push(q); }
    }
    return out;
  }
  function cellName(i, j) {
    const ns = j < 0 ? 'north' : j > 0 ? 'south' : '', ew = i < 0 ? 'west' : i > 0 ? 'east' : '', d = Math.abs(i) + Math.abs(j);
    return (d >= 2 && (!ns || !ew) ? 'far ' : d >= 3 ? 'outer ' : '') + (ns && ew ? ns + '-' + ew : ns || ew);
  }
  function diamondGeometry(scratch, hubId, want, hangs, opts) {
    const hub = scratch.rooms().find(r => r.id === hubId);
    const B = bboxOf(hub), hw = B.x2 - B.x1 + 1, hh = B.y2 - B.y1 + 1, [CW, CH] = (opts && Array.isArray(opts.cell)) ? opts.cell : CELL;
    const PX = ((hw + CW) >> 1) + 10, PY = ((hh + CH) >> 1) + 10;   // a room 10 tiles off the hub: ring 4 out, 3 thick, a 3-tile hall
    const ox = B.x1 + ((hw - CW) >> 1), oy = B.y1 + ((hh - CH) >> 1);
    const halls = [], rooms = [];
    // the ring at the centre, when everything it needs is clear
    const gap = 4, t = 3, X1 = B.x1 - gap - t, X2 = B.x2 + gap + t, Y1 = B.y1 - gap - t, Y2 = B.y2 + gap + t;
    const cx = (B.x1 + B.x2) >> 1, cy = (B.y1 + B.y2) >> 1;
    const ring = [
      { rect: { x1: X1, y1: Y1, x2: X2, y2: Y1 + 2 }, dress: true, outer: 'north' }, { rect: { x1: X1, y1: Y2 - 2, x2: X2, y2: Y2 }, dress: true, outer: 'south' },
      { rect: { x1: X1, y1: Y1 + 3, x2: X1 + 2, y2: Y2 - 3 }, dress: true, outer: 'west' }, { rect: { x1: X2 - 2, y1: Y1 + 3, x2: X2, y2: Y2 - 3 }, dress: true, outer: 'east' },
      { rect: { x1: cx - 1, y1: B.y1 - gap, x2: cx + 2, y2: B.y1 - 1 } }, { rect: { x1: cx - 1, y1: B.y2 + 1, x2: cx + 2, y2: B.y2 + gap } },
      { rect: { x1: B.x2 + 1, y1: cy - 1, x2: B.x2 + gap, y2: cy + 1 } }, { rect: { x1: B.x1 - gap, y1: cy - 1, x2: B.x1 - 1, y2: cy + 1 } }];
    const ringFree = !(opts && opts.ring === false) && ring.every(h => scratch.canPlaceHallway([h.rect]).ok && !neighbourOf(scratch, h.rect, [hub.id]));
    if (ringFree) for (const h of ring) { const a = scratch.placeHallway({ rect: h.rect }); if (!a || !a.ok) return refuse('the ring could not be laid'); halls.push(h); }
    // where a room of w × h stands on cell (i, j): a normal room fills the cell; a big one is anchored on its inner edge
    const cellRect = (i, j) => ({ x1: ox + i * PX, y1: oy + j * PY, x2: ox + i * PX + CW - 1, y2: oy + j * PY + CH - 1 });
    const bigRect = (i, j, w, h) => {
      const c = cellRect(i, j);
      if (j === 0) { const y1 = B.y1 + ((hh - h) >> 1); return i > 0 ? { x1: c.x1, y1, x2: c.x1 + w - 1, y2: y1 + h - 1 } : { x1: c.x2 - w + 1, y1, x2: c.x2, y2: y1 + h - 1 }; }
      const x1 = B.x1 + ((hw - w) >> 1);
      return j > 0 ? { x1, y1: c.y1, x2: x1 + w - 1, y2: c.y1 + h - 1 } : { x1, y1: c.y2 - h + 1, x2: x1 + w - 1, y2: c.y2 };
    };
    // a room asked smaller than the grid's own: centred in its cell, on the cell's inner edge (the side its hallway meets)
    const smallRect = (i, j, w, h) => {
      const c = cellRect(i, j), x1 = c.x1 + ((CW - w) >> 1), y1 = c.y1 + ((CH - h) >> 1);
      if (i) return i > 0 ? { x1: c.x1, y1, x2: c.x1 + w - 1, y2: y1 + h - 1 } : { x1: c.x2 - w + 1, y1, x2: c.x2, y2: y1 + h - 1 };
      return j > 0 ? { x1, y1: c.y1, x2: x1 + w - 1, y2: c.y1 + h - 1 } : { x1, y1: c.y2 - h + 1, x2: x1 + w - 1, y2: c.y2 };
    };
    // the first zone met walking from a room's inner edge toward the hub, along its middle (a re-lay reaches a whole cell: a
    // room smaller than its cell stands back from the next one)
    const reach = opts && opts.reach ? Math.max(PX, PY) : Math.max(PX - CW, PY - CH) + 2;
    const facing = (rect, dx, dy) => {
      const mx = (rect.x1 + rect.x2) >> 1, my = (rect.y1 + rect.y2) >> 1;
      let x = dx > 0 ? rect.x2 + 1 : dx < 0 ? rect.x1 - 1 : mx, y = dy > 0 ? rect.y2 + 1 : dy < 0 ? rect.y1 - 1 : my;
      for (let k = 0; k < reach; k++, x += dx, y += dy) { const id = scratch.roomAt(x, y); if (id) return scratch.rooms().find(r => r.id === id) || null; }
      return null;
    };
    const used = new Set(), key = (i, j) => i + ',' + j;
    let why = '';
    const place = (q, i, j, big) => {
      const rect = big ? bigRect(i, j, q.w, q.h) : q.exact && q.w <= CW && q.h <= CH && (q.w < CW || q.h < CH) ? smallRect(i, j, q.w, q.h) : cellRect(i, j);
      const c = scratch.canPlaceRoom([rect], 'hab');
      if (!c.ok) { why = why || (/^overlaps /.test(c.msg || '') ? c.msg.replace(/^overlaps /, '') + ' is in the way' : (c.msg || 'it does not fit')); return false; }
      const nb = neighbourOf(scratch, rect, []);
      if (nb) { why = why || 'it would stand against ' + nb; return false; }
      const a = scratch.addRoom({ kind: 'hab', name: q.name, rect });
      if (!a || !a.ok) return false;
      const room = scratch.rooms().find(r => r.id === a.id);
      // toward the hub: along the row first (to the room nearer the north-south line), then along the column
      const dirs = [];
      if (i) dirs.push([-Math.sign(i), 0]);
      if (j) dirs.push([0, -Math.sign(j)]);
      for (const [dx, dy] of dirs) {
        const Z = facing(rect, dx, dy);
        if (!Z || Z.id === a.id) continue;
        const hb = hallBetween(scratch, Z, room, hangs);
        if (!hb.ok) { why = why || hb.error; continue; }
        const h = scratch.placeHallway({ rect: hb.rect });
        if (!h || !h.ok) continue;
        halls.push({ rect: hb.rect, dress: true });
        rooms.push({ i: q.i, rect, side: cellName(i, j), cell: [i, j] });
        used.add(key(i, j));
        // a big room covers the next place out along its axis as well
        if (big) { const s = j === 0 ? [Math.sign(i), 0] : [0, Math.sign(j)]; for (let k = 1; k <= 2; k++) used.add(key(i + s[0] * k, j + s[1] * k)); }
        return true;
      }
      scratch.removeRoom(a.id);
      return false;
    };
    const wings = [[1, 0], [-1, 0], [0, -1], [0, 1], [2, 0], [-2, 0], [0, -2], [0, 2]], order = (opts && Array.isArray(opts.order)) ? opts.order : diamondOrder(7);
    for (const q of want.filter(r => r.big)) {
      if (!wings.some(([i, j]) => !used.has(key(i, j)) && place(q, i, j, true))) return refuse('There is no wing of the diamond around ' + hub.name + ' clear for ' + q.name + ' (' + (why || 'every wing is taken') + '). A diamond takes up to four big rooms.');
    }
    const normal = want.filter(r => !r.big);
    let lost = null;
    normal.forEach((q, n) => {
      // the order is a run of opposite pairs: the diamond is symmetric whenever its rooms come in pairs, and a room added
      // later lands exactly where it would have stood had it been asked for with the rest
      why = '';
      if (!order.some(([i, j]) => !used.has(key(i, j)) && place(q, i, j, false)) && !lost) lost = [q.name, why || 'the grid is full'];
    });
    if (lost) return refuse('There is no free place left on the diamond around ' + hub.name + ' for ' + lost[0] + ' (' + lost[1] + ').');
    return { ok: true, halls, rooms, ring: ringFree };
  }
  /* THE NEXT PLACE ON THE GRID for one new room of W × H (the grid's own size when it fits in it, else a big room on a
     wing, never smaller than the grid's own rooms either way; `exact` keeps the size the Commander asked): the room and the one hallway that joins it, as a placement candidate. Empty when the grid has no place left. */
  function gridSpots(WM, st, W, H, hangs, exact) {
    const main = mainRoom(st); if (!main) return [];
    const big = W > CELL[0] || H > CELL[1];
    // a station laid out as a concourse grows down its concourse (its rooms 18 × 10 unless a size was asked)
    const plain = !exact && W <= CELL[0] && H <= CELL[1];
    const cs = concourseSlot(st, plain ? 18 : W, plain ? 10 : H, W > SIZES.large[0] || H > SIZES.large[1]);
    if (cs) return cs;
    let g;
    try { g = diamondGeometry(WM.create(clone(st.serialize())), main.id, [{ i: 0, name: '__grid__', w: exact ? W : Math.max(W, CELL[0]), h: exact ? H : Math.max(H, CELL[1]), big, exact: !!exact }], hangs, { ring: false }); } catch (_) { return []; }
    if (!g || !g.ok || !g.rooms.length || !g.halls.length) return [];
    const hall = g.halls[g.halls.length - 1].rect, len = Math.max(hall.x2 - hall.x1, hall.y2 - hall.y1) + 1;
    return [{ rect: g.rooms[0].rect, hall, side: g.rooms[0].side, target: main.name, targetId: main.id, len, grid: true }];
  }
  // a grid room's hallway trimmed like a layout's: the corridor deck, and dressHall's planters and lights
  function gridHallTrim(WM, env, st, cand, kind) {
    if (!cand || !cand.grid) return {};
    const out = cand.ext ? { hall2: cand.ext, hall2Deck: CORRIDOR_DECK, hall2Props: [] } : {};
    if (!cand.hall && !cand.ext) return out;
    try {
      const cp = WM.create(clone(st.serialize()));
      const e = cand.ext ? cp.placeHallway({ rect: cand.ext }) : null; if (cand.ext && (!e || !e.ok)) return out;
      if (e) cp.setDeck(e.id, CORRIDOR_DECK);
      const h = cand.hall ? cp.placeHallway({ rect: cand.hall }) : null; if (cand.hall && (!h || !h.ok)) return out;
      const r = cp.addRoom({ kind: kind || 'hab', name: '__trim__', rect: cand.rect }); if (!r || !r.ok) return out;
      if (h && cp.setDeck(h.id, CORRIDOR_DECK).ok) { const d = dressHall(cp, env, h.id, null); Object.assign(out, { hallDeck: CORRIDOR_DECK, hallProps: (d && d.props) || [] }); }
      if (e) { const d2 = dressHall(cp, env, e.id, cand.dir === 'east' || cand.dir === 'west' ? 'north' : 'west'); out.hall2Props = (d2 && d2.props) || []; }
      return out;
    } catch (_) { return out; }
  }
  // the station's conveyor halls (a works room, a foundry named for lines), largest clear floor first
  function worksHalls(st) {
    return st.rooms().filter(r => r.kind === 'factory' && (r.floorMat === 'treadway' || /CONVEYOR|WORKS|FACTORY|FOUNDRY|ASSEMBLY|PRODUCTION|LINES?\b|HALL/.test(r.name)))
      .map(r => { const R = r.rects[0]; return { r, free: (R.x2 - R.x1 + 1) * (R.y2 - R.y1 + 1) - st.props().filter(p => st.roomAt(p.x, p.y) === r.id).reduce((n, p) => n + (p.w || 1) * (p.h || 1), 0) }; })
      .sort((a, b) => b.free - a.free).map(x => x.r);
  }
  const CONCOURSE_ROOMS = 24;
  // a concourse's local frame off the hub box B: u along the spine away from the hub, a across it
  function concourseFrame(B, dir) {
    const cw = 4, horiz = dir === 'east' || dir === 'west', lo = horiz ? B.y1 : B.x1, hi = horiz ? B.y2 : B.x2, v1 = lo + ((hi - lo + 1 - cw) >> 1), v2 = v1 + cw - 1;
    const toWorld = (u1, u2, a, b) => dir === 'east' ? { x1: B.x2 + 1 + u1, x2: B.x2 + 1 + u2, y1: a, y2: b } : dir === 'west' ? { x1: B.x1 - 1 - u2, x2: B.x1 - 1 - u1, y1: a, y2: b }
      : dir === 'south' ? { y1: B.y2 + 1 + u1, y2: B.y2 + 1 + u2, x1: a, x2: b } : { y1: B.y1 - 1 - u2, y2: B.y1 - 1 - u1, x1: a, x2: b };
    const toLocal = r => dir === 'east' ? { u1: r.x1 - B.x2 - 1, u2: r.x2 - B.x2 - 1, a1: r.y1, a2: r.y2 } : dir === 'west' ? { u1: B.x1 - 1 - r.x2, u2: B.x1 - 1 - r.x1, a1: r.y1, a2: r.y2 }
      : dir === 'south' ? { u1: r.y1 - B.y2 - 1, u2: r.y2 - B.y2 - 1, a1: r.x1, a2: r.x2 } : { u1: B.y1 - 1 - r.y2, u2: B.y1 - 1 - r.y1, a1: r.x1, a2: r.x2 };
    return { dir, horiz, v1, v2, toWorld, toLocal };
  }
  // the concourse a layout laid off the main room, read back from the floor: its spine (and every stretch that lengthened
  // it), the rooms down each side, the room at its far end — or null when the station has none
  function concourseOf(st) {
    const hub = mainRoom(st); if (!hub) return null;
    const B = bboxOf(hub), halls = st.rooms().filter(r => r.kind === 'corridor' && r.rects.length === 1);
    for (const dir of SIDES) {
      const F = concourseFrame(B, dir), band = l => l.a1 === F.v1 && l.a2 === F.v2;
      let len = -1;
      for (const c of halls) { const l = F.toLocal(c.rects[0]); if (l.u1 === 0 && l.u2 >= 11 && band(l)) { len = l.u2 + 1; break; } }
      if (len < 0) continue;
      for (let more = true; more;) { more = false; for (const c of halls) { const l = F.toLocal(c.rects[0]); if (l.u1 === len && band(l)) { len = l.u2 + 1; more = true; } } }
      const left = [], right = [];
      let end = null;
      for (const r of st.rooms()) {
        if (r.kind === 'corridor' || r.id === hub.id || r.rects.length !== 1) continue;
        const l = F.toLocal(r.rects[0]);
        if (l.u1 === len && l.a1 <= F.v2 && l.a2 >= F.v1) end = r;
        else if (l.u1 >= 0 && l.u2 < len && l.a2 === F.v1 - 4) left.push(Object.assign({ room: r }, l));
        else if (l.u1 >= 0 && l.u2 < len && l.a1 === F.v2 + 4) right.push(Object.assign({ room: r }, l));
      }
      left.sort((a, b) => a.u1 - b.u1); right.sort((a, b) => a.u1 - b.u1);
      return { dir, F, hub, len, left, right, end };
    }
    return null;
  }
  // the next place down a concourse for a W × H room: across from the room that has no twin yet, else a new pair (the
  // left side first), or the far end for a big room; with the stretch the spine must be lengthened by, if any
  function concourseSlot(st, W, H, big) {
    const con = concourseOf(st); if (!con) return null;
    const F = con.F, stub = 3, along = 3, e = F.horiz ? { along: W, across: H } : { along: H, across: W };
    const base = { target: 'the concourse', targetId: con.hub.id, grid: true, concourse: true, dir: con.dir };
    if (big) {
      if (con.end) return [];
      const c = (F.v1 + F.v2) >> 1, a = c - ((e.across - 1) >> 1);
      return [Object.assign({ rect: F.toWorld(con.len, con.len + e.along - 1, a, a + e.across - 1), hall: null, side: 'at the far end', len: 0 }, base)];
    }
    if (con.left.length + con.right.length >= 48) return [];
    const L = con.left, R = con.right;
    let side, u1;
    if (L.length > R.length) { side = 'right'; const m = L[R.length]; u1 = m.u1 + ((m.u2 - m.u1 + 1 - e.along) >> 1); }
    else if (R.length > L.length) { side = 'left'; const m = R[L.length]; u1 = m.u1 + ((m.u2 - m.u1 + 1 - e.along) >> 1); }
    else { side = 'left'; u1 = L.length ? Math.max(...L.map(r => r.u2), ...R.map(r => r.u2)) + 1 + along : along; }
    const u2 = u1 + e.along - 1, hu = u1 + ((e.along - 4) >> 1), need = u2 + 1 + along;
    if (need > con.len && con.end) return [];   // the room at the far end stops the spine
    const rect = side === 'left' ? F.toWorld(u1, u2, F.v1 - stub - e.across, F.v1 - stub - 1) : F.toWorld(u1, u2, F.v2 + stub + 1, F.v2 + stub + e.across);
    const hall = side === 'left' ? F.toWorld(hu, hu + 3, F.v1 - stub, F.v1 - 1) : F.toWorld(hu, hu + 3, F.v2 + 1, F.v2 + stub);
    const name = side === 'left' ? (F.horiz ? 'north' : 'west') : (F.horiz ? 'south' : 'east');
    if (neighbourOf(st, rect, [])) return [];   // it would open onto a room nobody asked it to join
    return [Object.assign({ rect, hall, ext: need > con.len ? F.toWorld(con.len, need - 1, F.v1, F.v2) : null, side: name, len: stub }, base)];
  }
  function concourseGeometry(B, dir, want) {
    if (want.length > CONCOURSE_ROOMS) return refuse('A concourse holds ' + CONCOURSE_ROOMS + ' rooms (' + want.length + ' were asked).');
    const cw = 4, stub = 3, along = 3;
    const horiz = dir === 'east' || dir === 'west';
    // local frame: u runs along the corridor away from the hub (0 = the tile against the hub's wall), v across it
    const lo = horiz ? B.y1 : B.x1, hi = horiz ? B.y2 : B.x2, v1 = lo + ((hi - lo + 1 - cw) >> 1), v2 = v1 + cw - 1;
    const toWorld = (u1, u2, a, b) => {
      if (dir === 'east') return { x1: B.x2 + 1 + u1, x2: B.x2 + 1 + u2, y1: a, y2: b };
      if (dir === 'west') return { x1: B.x1 - 1 - u2, x2: B.x1 - 1 - u1, y1: a, y2: b };
      if (dir === 'south') return { y1: B.y2 + 1 + u1, y2: B.y2 + 1 + u2, x1: a, x2: b };
      return { y1: B.y1 - 1 - u2, y2: B.y1 - 1 - u1, x1: a, x2: b };
    };
    const ext = r => horiz ? { along: r.w, across: r.h } : { along: r.h, across: r.w };
    const endRoom = want.find(r => r.big), sideRooms = want.filter(r => r !== endRoom);
    const rooms = [], halls = [];
    let u = along;
    for (let j = 0; j < sideRooms.length; j += 2) {
      const pair = sideRooms.slice(j, j + 2), span = Math.max(...pair.map(r => ext(r).along));
      pair.forEach((r, q) => {
        const e = ext(r), u1 = u + ((span - e.along) >> 1), u2 = u1 + e.along - 1, hu = u1 + ((e.along - 4) >> 1);
        const left = q === 0;
        const rect = left ? toWorld(u1, u2, v1 - stub - e.across, v1 - stub - 1) : toWorld(u1, u2, v2 + stub + 1, v2 + stub + e.across);
        const hall = left ? toWorld(hu, hu + 3, v1 - stub, v1 - 1) : toWorld(hu, hu + 3, v2 + 1, v2 + stub);
        rooms.push({ i: r.i, rect, side: left ? (horiz ? 'north' : 'west') : (horiz ? 'south' : 'east') });
        halls.push({ rect: hall });
      });
      u += span + along;
    }
    const length = Math.max(u, 12);
    halls.unshift({ rect: toWorld(0, length - 1, v1, v2), dress: true });
    if (endRoom) {
      const e = ext(endRoom), c = (v1 + v2) >> 1, a = c - ((e.across - 1) >> 1);
      rooms.push({ i: endRoom.i, rect: toWorld(length, length + e.along - 1, a, a + e.across - 1), side: 'end' });
    }
    return { ok: true, halls, rooms };
  }

  // a layout's rooms, checked: a style (or lines, or zones), a size, a name
  function parseLayoutRooms(list, env, live, notes, usedNames) {
    const RS = env.RoomStyles, HOW = 'layout.rooms is a list of 1 to ' + DIAMOND_ROOMS + ' rooms, each { name, style, size, lines } (style: ' + RS.ROOM_ORDER.join(', ') + ').';
    if (!Array.isArray(list) || !list.length || list.length > DIAMOND_ROOMS) return refuse(HOW);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (!q || typeof q !== 'object' || Array.isArray(q)) return refuse(HOW);
      const bad = Object.keys(q).filter(k => LAYOUT_ROOM_KEYS.indexOf(k) < 0);
      if (bad.length) return refuse('StarNet places and furnishes every room itself, so a layout room does not take: ' + bad.slice(0, 6).join(', ') + '. It takes: ' + LAYOUT_ROOM_KEYS.join(', ') + '.');
      let style = null;
      if (q.style != null) { style = RS.resolveRoom(q.style); if (!style) return refuse('There is no room style "' + String(q.style).slice(0, 40) + '". Styles: ' + RS.ROOM_ORDER.join(', ') + '.'); }
      else if (typeof q.name === 'string' && q.zones == null && q.lines == null) style = RS.resolveRoom(q.name);   // "Arcade", "Conveyor Hall"
      if (q.zones != null && (q.lines != null || q.style != null)) return refuse('A layout room takes a style (furnished whole), zones (part by part) or lines, not two of them (lines go in a works room: leave style out).');
      let lines = [], zones = [];
      if (q.lines != null) {
        if (!Array.isArray(q.lines) || !q.lines.length || q.lines.length > 16) return refuse('lines is a list of 1 to 16 workflow lines, each { line | purpose | shape, name, staff, dailyCap, tries }.');
        for (const l of q.lines) {
          if (!l || typeof l !== 'object' || Array.isArray(l)) return refuse('Each line is an object with: ' + LINE_KEYS.join(', ') + '.');
          const lb = Object.keys(l).filter(k => LINE_KEYS.indexOf(k) < 0);
          if (lb.length) return refuse('A line only takes: ' + LINE_KEYS.join(', ') + '. Not accepted: ' + lb.slice(0, 6).join(', ') + '.');
          const ln = parseLine(l, env, live, notes); if (!ln.ok) return ln;
          lines.push(ln.line);
        }
        if (style && style !== 'works') return refuse('Lines go in a works room (a conveyor hall): leave style out, or set it to works.');
        style = 'works';
      }
      if (q.zones != null) { const z = parseZones(q.zones, env, live, notes); if (!z.ok) return z; zones = z.zones; }
      if (!style && !zones.length) return refuse('Room ' + (i + 1) + ' of the layout needs a style (' + RS.ROOM_ORDER.join(', ') + '), zones, or lines.');
      const sz = sizeOfRoom(q.size); if (!sz.ok) return sz;
      const def = style === 'works' ? SIZES.giant : style === 'garden' ? [20, 15] : [18, 10];
      const need = contentNeed(zones, lines);
      let w = sz.size ? sz.size[0] : Math.max(def[0], need.w), h = sz.size ? sz.size[1] : Math.max(def[1], need.h);
      if (sz.size && (need.hardW || need.w) > w) return refuse('Room ' + (i + 1) + ' at ' + w + ' × ' + h + ' is too small for what goes in it. Leave size out, or ask for a bigger one.');
      if (w > DESIGN_MAX[0] || h > DESIGN_MAX[1]) return refuse('What goes in room ' + (i + 1) + ' needs more than the ' + DESIGN_MAX[0] + ' × ' + DESIGN_MAX[1] + ' StarNet builds at once.');
      const given = typeof q.name === 'string' ? q.name.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24) : '';
      const taken = nm => live.rooms().some(r => r.kind !== 'corridor' && norm(r.name) === norm(nm)) || usedNames[norm(nm)];
      let name = given || (style ? AUTO_NAME[style] : 'ROOM ' + (i + 1));
      if (given && taken(name)) return refuse('A room is already called ' + name + '. Give this one another name.');
      for (let k = 2; !given && taken(name) && k < 50; k++) name = (style ? AUTO_NAME[style] : 'ROOM').slice(0, 21) + ' ' + k;
      usedNames[norm(name)] = 1;
      const big = style === 'works' || lines.length > 0 || w * h >= 24 * 14;
      out.push({ i, name, style, zones, lines, w, h, big, need, exact: !!sz.size });
    }
    return { ok: true, rooms: out };
  }

  /* A WHOLE LAYOUT (station.plan's `layout`): the pattern's geometry is laid on a probe, every room filled (lines first,
     then its style from wall to wall, or its zones) and every corridor dressed; then the same checks as any build. */
  /* RE-LAY WHAT STANDS (Andrew 10-02, after a hand-moved station came out as overlapping corridor spaghetti: "completely
     change orientation of the rooms … more spread out … a wider better shape … more hallways connecting everything"):
     every room stays with everything in it (furniture, lines, desks: the same ids, agents and wiring) and moves onto the
     diamond grid round the main room, nearest rooms first; every old hallway is taken up, the grid's own corridors are
     laid and lit, and grid neighbours are joined so the station meshes instead of branching. Deterministic: the plan runs
     it on a copy, the build runs it again on the station, and the two must match exactly. */
  /* A DESK BRINGS ITS OWN CHAIR (Andrew 10-02, two chairs side by side under every desk: "the chairs are built in to the
     desk as long as the agent's assigned"): a workstation (any computer piece) draws a chair on the row in front of it the
     moment an agent works it, so that row stays clear — a placed chair there means two chairs. The row is the side the desk
     faces, exactly as world.js deskSeat seats it: a remastered desk turned to a facing it has seats on that side (r: 1 west,
     2 north, 3 east; m swaps west and east), every other workstation on its south row. */
  const isWorkstation = (st, t) => !!(st && typeof st.capForProp === 'function' && st.capForProp(t) === 'computer');
  function seatRow(p, S) {
    const w = p.w || 1, h = p.h || 1, out = [], r = (p.r | 0) & 3;
    const turned = r && (p.t === 'desk' || p.t === 'desk2') && S && S.facings && S.facings(p.t).indexOf(r) >= 0;
    const side = !turned ? 0 : p.m && (r === 1 || r === 3) ? 4 - r : r;
    const row = (side) => { if (side === 0) for (let x = p.x; x < p.x + w; x++) out.push([x, p.y + h]); else if (side === 2) for (let x = p.x; x < p.x + w; x++) out.push([x, p.y - 1]);
      else if (side === 1) for (let y = p.y; y < p.y + h; y++) out.push([p.x - 1, y]); else for (let y = p.y; y < p.y + h; y++) out.push([p.x + w, y]); };
    row(side);
    return out;
  }
  function deskSeats(st, roomId, S) {
    const out = new Map();   // "x,y" -> the desk whose seat it is
    for (const p of st.props()) if (isWorkstation(st, p.t) && (roomId == null || st.roomAt(p.x, p.y) === roomId)) for (const [x, y] of seatRow(p, S)) out.set(x + ',' + y, p);
    return out;
  }
  // a solid piece standing on a desk's seat: [{ piece, desk }]
  function blockedSeats(st, env) {
    const seats = deskSeats(st, null, env && env.PropSprites), out = [];
    for (const q of st.props()) {
      if (q.block === false || isWorkstation(st, q.t)) continue;
      for (let y = q.y; y < q.y + (q.h || 1); y++) for (let x = q.x; x < q.x + (q.w || 1); x++) { const d = seats.get(x + ',' + y); if (d && !out.some(o => o.piece.id === q.id)) out.push({ piece: q, desk: d }); }
    }
    return out;
  }
  const isSeatPiece = env => t => { const sp = env && env.PropSprites && env.PropSprites.spec ? env.PropSprites.spec(t) : null; return !!(sp && sp.use && sp.use.kind === 'seat'); };
  // which way a piece at p faces toward target q (r: 0 south, 1 west, 2 north, 3 east)
  function facingToward(p, q) {
    const pw = p.w || 1, ph = p.h || 1, qw = q.w || 1, qh = q.h || 1;
    const dx = (q.x + qw / 2) - (p.x + pw / 2), dy = (q.y + qh / 2) - (p.y + ph / 2);
    // beside a side (a chair along a long table): face straight into that side, never along the table
    const overX = p.x < q.x + qw && q.x < p.x + pw, overY = p.y < q.y + qh && q.y < p.y + ph;
    if (overX && !overY) return dy > 0 ? 0 : 2;
    if (overY && !overX) return dx > 0 ? 3 : 1;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 0 : 2);
  }
  // a piece drawn facing one way that ships as a LEFT (‹) and a RIGHT (›) entry (recliner / recliner_r, telescope, camera
  // rig, bench press …): 1 when it faces west, 3 east, else null; and its twin
  function sideFacing(S, t) {
    const c = S && S.CATALOG ? S.CATALOG.find(p => p.id === t) : null, l = c ? String(c.label || '') : '';
    return !c || !twinOf(S, t) ? null : /‹/.test(l) ? 1 : /›/.test(l) ? 3 : null;
  }
  function twinOf(S, t) { const tw = /_r$/.test(t) ? t.slice(0, -2) : t + '_r'; return S && S.spec && S.spec(tw) ? tw : null; }
  // which way a placed piece faces (r 0 south, 1 west, 2 north, 3 east): its r, or for a twin its side (flipped by m)
  function facingOf(S, p) { const side = sideFacing(S, p.t); return side != null ? (p.m ? 4 - side : side) : (p.r | 0) & 3; }
  // q stands right beside p along a side (not only a corner touching): the table a chair is pulled up to
  function besideSide(p, q) {
    const pw = p.w || 1, ph = p.h || 1, qw = q.w || 1, qh = q.h || 1;
    const overX = p.x < q.x + qw && q.x < p.x + pw, overY = p.y < q.y + qh && q.y < p.y + ph;
    return (overX && (p.y + ph === q.y || q.y + qh === p.y)) || (overY && (p.x + pw === q.x || q.x + qw === p.x));
  }
  const isTableFor = (st, env) => q => { const sp = env && env.PropSprites && env.PropSprites.spec ? env.PropSprites.spec(q.t) : null; return !!((sp && sp.surface) || isWorkstation(st, q.t)); };
  // a seat right beside a table or desk and turned away from every one of them: turn it toward the first it can face
  function faceItsTable(st, env, id) {
    const S = env && env.PropSprites, c = st.propById(id);
    if (!c || !S || !isSeatPiece(env)(c.t) || !(S.canRotate && S.canRotate(c.t))) return null;
    const near = st.props().filter(q => q.id !== c.id && isTableFor(st, env)(q) && besideSide(c, q)); if (!near.length) return null;
    const want = near.map(q => facingToward(c, q)), r = (c.r | 0) & 3; if (want.indexOf(r) >= 0) return null;
    const k = want.findIndex(d => !S.facings || S.facings(c.t).indexOf(d) >= 0); if (k < 0) return null;
    const box = S.footprintAt ? S.footprintAt(c.t, want[k]) : null, f = st.faceProp(c.id, want[k], box || undefined);
    return f && f.ok ? { dir: ['south', 'west', 'north', 'east'][want[k]], table: near[k] } : null;
  }
  /* WHAT A DESIGNER WOULD SEE WRONG IN A ROOM (the lead's eyes beyond the picture): a piece on a desk's seat, a seat turned
     away from the table or desk right beside it. Plain sentences, the first few. */
  function roomIssues(st, env, roomId) {
    const out = [], nm = t => pieceName(env, t), isSeat = isSeatPiece(env), at = (x, y) => '(' + x + ', ' + y + ')';
    for (const b of blockedSeats(st, env)) if (st.roomAt(b.piece.x, b.piece.y) === roomId)
      out.push('the ' + nm(b.piece.t) + ' at ' + at(b.piece.x, b.piece.y) + ' stands on the seat of the ' + nm(b.desk.t) + ' at ' + at(b.desk.x, b.desk.y) + ': a desk draws its own chair when an agent works it, so ' + (isSeat(b.piece.t) ? 'that makes two chairs. Take it up.' : 'its agent would have nowhere to sit. Move it.'));
    const here = st.props().filter(p => st.roomAt(p.x, p.y) === roomId), S = env && env.PropSprites;
    for (const c of here) {
      if (!isSeat(c.t) || !(S && S.canRotate && S.canRotate(c.t))) continue;
      const near = here.filter(q => q !== c && isTableFor(st, env)(q) && besideSide(c, q));
      if (!near.length) continue;
      const want = near.map(q => facingToward(c, q)), r = (c.r | 0) & 3;
      if (want.indexOf(r) < 0) out.push('the ' + nm(c.t) + ' at ' + at(c.x, c.y) + ' faces ' + ['south', 'west', 'north', 'east'][r] + ', away from the ' + nm(near[0].t) + ' beside it: turn it toward it ({ op: "rotate", prop, toward: the ' + nm(near[0].t) + ' }).');
    }
    // a seat or a couch with its face to the wall right in front of it
    const DIRS = ['south', 'west', 'north', 'east'];
    for (const c of here) {
      const sp = S && S.spec ? S.spec(c.t) : null, kind = sp && sp.use && sp.use.kind;
      // only where the facing is certain: a chair that turns, or a LEFT/RIGHT twin (the couch is drawn from behind)
      if (!(kind === 'seat' && S.canRotate && S.canRotate(c.t)) && sideFacing(S, c.t) == null) continue;
      const f = facingOf(S, c), w = c.w || 1, h = c.h || 1, front = [];
      if (f === 0) for (let x = c.x; x < c.x + w; x++) front.push([x, c.y + h]); else if (f === 2) for (let x = c.x; x < c.x + w; x++) front.push([x, c.y - 1]);
      else if (f === 1) for (let y = c.y; y < c.y + h; y++) front.push([c.x - 1, y]); else for (let y = c.y; y < c.y + h; y++) front.push([c.x + w, y]);
      if (front.every(([x, y]) => st.roomAt(x, y) !== roomId)) out.push('the ' + nm(c.t) + ' at ' + at(c.x, c.y) + ' faces ' + DIRS[f] + ', straight into the wall: ' + (sideFacing(S, c.t) != null || (S.canRotate && S.canRotate(c.t)) ? 'turn it to face the room ({ op: "rotate", prop, toward: what it should face })' : 'it does not turn, so move it off that wall') + '.');
    }
    return out.slice(0, 12);
  }
  /* HALLWAYS THAT LEAD NOWHERE: a group of hallways (hallways touching each other) that reaches fewer than two rooms. A room
     moved away leaves its hallway like that; a refit that leaves one is refused, and the map marks any that stand. */
  // two zones share an edge (not only a corner): flush, open to each other
  const roomsTouch = (a, b) => a.rects.some(p => b.rects.some(q => (p.x1 <= q.x2 && q.x1 <= p.x2 && (p.y2 + 1 === q.y1 || q.y2 + 1 === p.y1)) || (p.y1 <= q.y2 && q.y1 <= p.y2 && (p.x2 + 1 === q.x1 || q.x2 + 1 === p.x1))));
  function strandedHalls(st) {
    const all = st.rooms(), halls = all.filter(r => r.kind === 'corridor'), rooms = all.filter(r => r.kind !== 'corridor'), touching = roomsTouch;
    const seen = new Set(), out = [];
    for (const h of halls) {
      if (seen.has(h.id)) continue;
      const group = [], reach = new Set(), queue = [h];
      seen.add(h.id);
      while (queue.length) {
        const g = queue.shift(); group.push(g.id);
        for (const n of halls) if (!seen.has(n.id) && touching(g, n)) { seen.add(n.id); queue.push(n); }
        for (const r of rooms) if (touching(g, r)) reach.add(r.id);
      }
      if (reach.size < 2) out.push(...group);
    }
    return out;
  }
  function rearrangeOnto(st, env, opts) {
    const WM = env.WorldModel, hub = mainRoom(st), hangs = hangsOf(env);
    if (!hub) return refuse('There is no main room to lay the station out around.');
    const halls0 = st.rooms().filter(r => r.kind === 'corridor');
    const inHall = (x, y) => { const id = st.roomAt(x, y); return halls0.some(h => h.id === id); };
    const onHall = p => halls0.some(h => touchesRoom(p, h));
    const busy = st.props().find(p => onHall(p) && (MACHINE_T.test(p.t) || p.agentId));
    if (busy) return refuse('A line or a desk stands in a hallway (' + pieceName(env, busy.t) + ' at (' + busy.x + ', ' + busy.y + ')), so re-laying the station would cut it. Move it into a room first.');
    const belt = Object.keys(st.serialize().belts || {}).find(k => { const [x, y] = k.split(',').map(Number); return inHall(x, y); });
    if (belt) return refuse('A belt runs through a hallway at (' + belt.replace(',', ', ') + '), so re-laying the station would cut its line. Take it up or move the line into a room first.');
    // rooms joined open plan (flush, no hallway between) move as ONE, so a line or a piece across the join stays whole; the
    // rooms joined that way to the main room stay where they are, with it
    const rooms0 = st.rooms().filter(r => r.kind !== 'corridor'), groupOf = new Map(), groups = [];
    for (const r of rooms0) {
      if (groupOf.has(r.id)) continue;
      const g = [r], q = [r]; groupOf.set(r.id, g); groups.push(g);
      while (q.length) { const a = q.shift(); for (const b of rooms0) if (!groupOf.has(b.id) && roomsTouch(a, b)) { groupOf.set(b.id, g); g.push(b); q.push(b); } }
    }
    // a group that is not one rectangle (an L) re-lays as its rooms, each with its own hallway: the diamond's hallway meets
    // the middle of a group's box, which an L leaves as empty floor (the rooms were then unreachable, or a hallway opened
    // onto nothing). Only a group a piece stands across, or a belt runs in, stays whole
    const beltAt = Object.keys(st.serialize().belts || {}).map(k => { const [x, y] = k.split(',').map(Number); return { x, y }; });
    for (const g of groups.slice()) {
      if (g.length < 2 || g === groupOf.get(hub.id)) continue;
      const B = g.map(bboxOf).reduce((a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) }));
      const tiles = g.reduce((n, r) => n + r.rects.reduce((m, q) => m + (q.x2 - q.x1 + 1) * (q.y2 - q.y1 + 1), 0), 0);
      if (tiles === (B.x2 - B.x1 + 1) * (B.y2 - B.y1 + 1)) continue;
      if (st.props().some(p => g.filter(r => touchesRoom(p, r)).length > 1) || beltAt.some(t => g.some(r => touchesRoom(t, r)))) continue;
      groups.splice(groups.indexOf(g), 1, ...g.map(r => { const one = [r]; groupOf.set(r.id, one); return one; }));
    }
    const home = groupOf.get(hub.id), HB = bboxOf(hub), hx = (HB.x1 + HB.x2) / 2, hy = (HB.y1 + HB.y2) / 2, area = r => { const B = bboxOf(r); return (B.x2 - B.x1 + 1) * (B.y2 - B.y1 + 1); };
    const order = groups.filter(g => g !== home).map(g => {
      const B = g.map(bboxOf).reduce((a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) }));
      const lead = g.slice().sort((a, b) => area(b) - area(a) || (a.id < b.id ? -1 : 1))[0];
      return { g, lead, name: g.map(r => r.name).join(' + '), B, w: B.x2 - B.x1 + 1, h: B.y2 - B.y1 + 1, d: Math.hypot((B.x1 + B.x2) / 2 - hx, (B.y1 + B.y2) / 2 - hy) };
    }).sort((a, b) => a.d - b.d || (a.lead.id < b.lead.id ? -1 : 1));
    if (!order.length) return refuse('There are no rooms besides ' + hub.name + (home.length > 1 ? ' and the rooms open to it' : '') + ' to re-lay.');
    if (order.length > DIAMOND_ROOMS) return refuse('A diamond holds up to ' + DIAMOND_ROOMS + ' rooms round its main room; this station has ' + order.length + '.');
    // the grid's cell is the station's own room size (up to 30 × 18; a bigger room, a conveyor hall, takes a wing), so a
    // station of large rooms re-lays as well as one of the default size
    const fit = order.filter(o => o.w <= 30 && o.h <= 18), cell = [Math.max(CELL[0], ...fit.map(o => o.w)), Math.max(CELL[1], ...fit.map(o => o.h))];
    // where each room goes: the diamond worked out on a copy that holds the main room (and what is open to it) alone
    const scratch = WM.create(clone(st.serialize()));
    for (const r of scratch.rooms()) if (!home.some(h => h.id === r.id)) scratch.removeRoom(r.id);
    const geo = diamondGeometry(scratch, hub.id, order.map((o, i) => ({ i, name: '__R' + i, w: o.w, h: o.h, big: o.w > cell[0] || o.h > cell[1], exact: true })), hangs,
      Object.assign({ cell, reach: true }, opts && (opts.shape === 'wide' || opts.shape === 'tall') ? { order: shapedOrder(opts.shape, 7) } : {}));
    if (!geo.ok) return refuse(String(geo.error).replace(/__R(\d+)/g, (m, i) => order[+i] ? order[+i].name : m).replace('A diamond takes up to four big rooms.', 'A diamond takes up to four rooms bigger than 30 × 18.'));
    // 1. the old hallways go, with what dressed them
    const hallPieces = st.props().filter(onHall).length;
    for (const h of halls0) { const x = st.removeRoom(h.id); if (!x || !x.ok) return refuse('the hallway ' + h.name + ' could not be taken up (' + wmMsg(x) + ')'); }
    // 2. every room to its place at once (WorldModel.moveRooms checks only where they all end up: rooms passing each other,
    //    or half a station still far out while the rest has moved in, never block a sound result); rooms open to each other
    //    move by the same step
    const placed = order.map((o, i) => { const at = geo.rooms.find(x => x.i === i) || {}; return { id: o.lead.id, name: o.name, members: o.g, B: o.B, to: at.rect, cell: at.cell }; });
    if (placed.some(t => !t.to)) return refuse('The diamond had no place for every room, so nothing was changed.');
    if (typeof st.moveRooms !== 'function') return refuse('this page cannot move several rooms at once; reload it');
    const mv = st.moveRooms([].concat(...placed.map(t => t.members.map(m => ({ id: m.id, dx: t.to.x1 - t.B.x1, dy: t.to.y1 - t.B.y1 })))));
    if (!mv || !mv.ok) return refuse('The rooms could not be moved onto the new layout (' + wmMsg(mv) + '). Nothing was changed.');
    // 3. the grid's corridors: the ring round the main room and one hallway in to each room
    const laid = [];
    for (const h of geo.halls) {
      const a = st.placeHallway({ rect: h.rect }); if (!a || !a.ok) return refuse('a corridor of the new layout could not be laid (' + wmMsg(a) + '). Nothing was changed.');
      st.setDeck(a.id, CORRIDOR_DECK); laid.push({ id: a.id, dress: h.dress ? (h.outer || null) : undefined });
    }
    // 4. neighbours on the grid are joined as well, where a straight hallway fits clean
    let links = 0;
    if (!(opts && opts.links === false)) {
      const at = new Map(placed.filter(t => t.cell).map(t => [t.cell.join(','), t.id]));
      const joined = (a, b) => [...zoneNeighbours(st, a)].some(z => { const zr = st.rooms().find(r => r.id === z); return zr && zr.kind === 'corridor' && zoneNeighbours(st, z).has(b); });
      for (const t of placed) {
        if (!t.cell) continue;
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          const other = at.get((t.cell[0] + di) + ',' + (t.cell[1] + dj)); if (!other || joined(t.id, other)) continue;
          const A = st.rooms().find(r => r.id === t.id), Bm = st.rooms().find(r => r.id === other);
          const hb = hallBetween(st, A, Bm, hangs); if (!hb || !hb.ok) continue;
          if (!st.canPlaceHallway([hb.rect]).ok || neighbourOf(st, hb.rect, [A.id, Bm.id])) continue;
          const a = st.placeHallway({ rect: hb.rect }); if (!a || !a.ok) continue;
          st.setDeck(a.id, CORRIDOR_DECK); laid.push({ id: a.id, dress: null }); links++;
        }
      }
    }
    // 5. every new corridor planted and lit
    for (const h of laid) if (h.dress !== undefined) dressHall(st, env, h.id, h.dress);
    return { ok: true, rooms: placed.reduce((n, t) => n + t.members.length, 0), stay: home.length - 1, oldHalls: halls0.length, hallPieces, halls: laid.length, links, hub: hub.name, shape: (opts && opts.shape) || 'even' };
  }
  function planRearrange(doc, q, env) {
    const WM = env.WorldModel, P = env.Pipeline;
    // { rearrange: "diamond" | "wide" | "tall" } or { rearrange: { pattern, shape, links } }: a wide station by default (it is
    // shown on a wide screen, and "too thin" is the complaint that asked for this)
    const HOW = 'rearrange re-lays every room on the diamond grid: { rearrange: "diamond" } (wide, the default), or { rearrange: { shape: "wide" | "tall" | "even", links: false } } (links: false leaves out the hallways between neighbouring rooms).';
    const o = q && typeof q === 'object' && !Array.isArray(q) ? q : { pattern: q === true ? 'diamond' : q };
    const word = String(o.pattern == null ? 'diamond' : o.pattern).toLowerCase().trim();
    const shapeWord = String(o.shape == null ? (/^(wide|tall|even)$/.test(word) ? word : 'wide') : o.shape).toLowerCase().trim();
    // "ring" / "grid" are not re-lay shapes (they passed and built a diamond anyway — QA 2026-10-02): refuse with the HOW
    if (!/^(diamond|wide|tall|even)$/.test(word) || !/^(wide|tall|even)$/.test(shapeWord)) return refuse(HOW);
    const links = o.links !== false, shape = shapeWord;
    const live = WM.create(clone(doc)), probe = WM.create(clone(doc)), before = floorFacts(live, P);
    const r = rearrangeOnto(probe, env, { links, shape });
    if (!r.ok) return r;
    // nothing the Commander built stops working: the lines route as before, and every room can still be walked into
    const after = floorFacts(probe, P), newErr = [...after.errs].filter(e => !before.errs.has(e));
    if (newErr.length) return refuse('Re-laying the station would leave ' + newErr.length + (newErr.length === 1 ? ' routing problem' : ' routing problems') + ' on its lines (' + [...new Set(newErr.map(e => e.split(':')[0]))].join(', ') + '), so nothing was changed.');
    // a line warning a line did not have (a source cut off from its bays …), judged by machine, not by tile (every tile moved)
    const lineSig = s => { const m = {}; for (const e of (P.compileRoutingPlan(s.projectGeometry()).errors || [])) { const k = e.code + ':' + (e.propId || ''); m[k] = (m[k] || 0) + 1; } return m; };
    const sb = lineSig(live), sa = lineSig(probe), cutLines = Object.keys(sa).filter(k => sa[k] > (sb[k] || 0));
    if (cutLines.length) return refuse('Re-laying the station would cut ' + (cutLines.length === 1 ? 'a line' : cutLines.length + ' lines') + ' (' + [...new Set(cutLines.map(k => k.split(':')[0]))].join(', ') + '), so nothing was changed.');
    const wa = walkableRooms(probe), cut = probe.rooms().filter(x => x.kind !== 'corridor' && !wa.has(x.id)).map(x => x.name);
    if (cut.length) return refuse('Re-laid, ' + cut.join(', ') + (cut.length > 1 ? ' could not be' : ' could not be') + ' reached from ' + r.hub + ', so nothing was changed.');
    const lost = strandedHalls(probe);
    if (lost.length) return refuse('Re-laid, ' + lost.length + (lost.length === 1 ? ' hallway would lead' : ' hallways would lead') + ' nowhere, so nothing was changed.');
    const loose = probe.props().find(p => { for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) if (!probe.roomAt(x, y)) return true; return false; });
    if (loose) return refuse('Re-laid, the ' + pieceName(env, loose.t) + ' at (' + loose.x + ', ' + loose.y + ') would stand partly outside every room, so nothing was changed. Move it wholly into one room first.');
    const summary = 'RE-LAY the station as ' + (shape === 'even' ? 'a diamond' : 'a ' + shape + ' diamond') + ' round ' + r.hub + ': ' + (r.rooms === 1 ? 'its one room moves' : 'all ' + r.rooms + ' rooms move') + ' onto an even grid with everything in them (furniture, lines, desks and agents stay as they are'
      + (r.stay ? '; ' + (r.stay === 1 ? 'the room' : 'the ' + r.stay + ' rooms') + ' open to ' + r.hub + ' stay with it' : '') + '), the '
      + r.oldHalls + ' old ' + (r.oldHalls === 1 ? 'hallway is' : 'hallways are') + ' taken up' + (r.hallPieces ? ' with ' + (r.hallPieces === 1 ? 'the piece' : 'the ' + r.hallPieces + ' pieces') + ' standing in them' : '') + ' and ' + r.halls + ' new ones laid, planted and lit' + (r.links ? ', ' + r.links + ' of them joining neighbouring rooms so the station meshes' : '') + '. One UNDO in Build mode takes all of it back.';
    return { ok: true, plan: { floorSig: sigOf(doc), resultSig: sigOf(probe.serialize()), spec: { kind: 'rearrange', opts: { links, shape } }, summary, notes: [], steps: [], line: null, where: 'the station re-laid as ' + (shape === 'even' ? 'a diamond' : 'a ' + shape + ' diamond'), rooms: [],
      preview: previewOf(WM, doc, probe.serialize(), [], null) } };
  }
  function planLayout(doc, req, env) {
    const WM = env.WorldModel, P = env.Pipeline, RS = env.RoomStyles;
    if (!RS || !RS.ROOMS) return refuse('the room styles are not loaded on this page');
    const HOW = 'Send { "layout": { "pattern": "ring" or "concourse", "rooms": [ { name, style, size, lines } ] } }, and "replace": true to lay out the whole station again around its main room.';
    const extra = Object.keys(req).filter(k => k !== 'layout' && k !== 'replace');
    if (extra.length) return refuse('A layout plans the whole floor, so leave out: ' + extra.slice(0, 6).join(', ') + '. ' + HOW);
    const L = req.layout;
    if (!L || typeof L !== 'object' || Array.isArray(L)) return refuse(HOW);
    const bad = Object.keys(L).filter(k => LAYOUT_KEYS.indexOf(k) < 0);
    if (bad.length) return refuse('StarNet computes every tile itself, so a layout does not take: ' + bad.slice(0, 6).join(', ') + '. It takes: ' + LAYOUT_KEYS.join(', ') + '.');
    const pattern = PATTERNS[norm(L.pattern)] || (L.pattern == null ? 'diamond' : null);
    if (!pattern) return refuse('pattern is diamond (rooms on an even grid all round the main room, a corridor loop at its centre) or concourse (a wide corridor with rooms down both sides and a big room at the end).');
    if (req.replace != null && typeof req.replace !== 'boolean') return refuse('replace is true (lay out the whole station again) or left out (add the layout beside what stands).');
    const replace = req.replace === true;
    const sd = sideOf(L.side); if (!sd.ok) return sd;
    // the floor it lands on: as it stands, or (replace) the main room alone, with everything beyond it cleared
    let base = clone(doc);
    const live0 = WM.create(clone(doc)), hubQ = L.around != null ? roomNamed(live0, L.around) : { ok: true, room: mainRoom(live0) };
    if (!hubQ.ok) return hubQ;
    if (!hubQ.room) return refuse('There is no room to lay the station out around.');
    if (replace && hubQ.room.id !== (mainRoom(live0) || {}).id) return refuse('replace lays the whole station out again around its main room (' + (mainRoom(live0) || {}).name + '), so leave around out.');
    let stripped = null;
    if (replace) {
      const cp = WM.create(clone(doc));
      for (const r of cp.rooms()) if (r.id !== hubQ.room.id) cp.removeRoom(r.id);
      stripped = cp.serialize();
      const ids = new Set(stripped.props.map(p => p.id));
      if (Array.isArray(stripped.links)) stripped.links = stripped.links.filter(l => l && l.from && l.to && (l.from.prop == null || ids.has(l.from.prop)) && (l.to.prop == null || ids.has(l.to.prop)));
      // exactly what station.build will do first: the page's own replaceLayout (it gives every agent that owned a desk one)
      const bp = WM.create(clone(doc)), rl = bp.replaceLayout(clone(stripped));
      if (!rl || !rl.ok) return refuse(hubQ.room.name + ' could not be kept as it stands (' + ((rl && (rl.msg || rl.error)) || 'it did not validate') + '), so nothing was changed.');
      base = bp.serialize();
    }
    const live = WM.create(clone(base)), notes = [], usedNames = {};
    if (pattern === 'diamond' && L.side != null) notes.push('A diamond goes all the way round its room, so side was left out.');
    const pr = parseLayoutRooms(L.rooms, env, live, notes, usedNames); if (!pr.ok) return pr;
    // on the diamond every room but a big one is the grid's own size, so the station reads as one consistent plan
    if (pattern === 'diamond') for (const q of pr.rooms) if (!q.big) { q.w = CELL[0]; q.h = CELL[1]; }
    if (replace && pr.rooms.some(r => [].concat(...r.lines.map(l => l.staff || []), ...r.zones.map(z => z.staff || [])).some(s => s && /^(new|recruit)/i.test(String(s.agent || ''))))) return refuse('A layout that replaces the station cannot recruit; staff the lines with the crew you have, or recruit after it is built.');
    const hub = live.rooms().find(r => r.id === hubQ.room.id), B = bboxOf(hub);
    // a concourse that stands grows: its rooms go down it, in its next places, never into a second concourse
    const con = !replace && pattern === 'concourse' ? concourseOf(live) : null;
    if (con && con.hub.id === hub.id) {
      if (L.side != null && L.side !== con.dir) notes.push('The station already has a concourse running ' + con.dir + ', so the new rooms go down it.');
      const asRooms = L.rooms.map(q => { const o = {}; for (const k of ['name', 'style', 'size', 'lines', 'zones']) if (q && q[k] != null) o[k] = q[k]; return o; });
      const g = planBuild(doc, { rooms: asRooms }, env);
      if (!g.ok) return g;
      g.plan.summary = asRooms.length + (asRooms.length === 1 ? ' more room' : ' more rooms') + ' down the CONCOURSE ' + con.dir + ' from ' + hub.name + ', in its next places: ' + g.plan.summary;
      g.plan.notes = notes.concat(g.plan.notes || []);
      return g;
    }
    const before = floorFacts(live, P);
    // the geometry: the ring round the hub, or the concourse off the side asked (else the first side it fits)
    const dirs = pattern === 'diamond' ? [null] : sd.side ? [sd.side] : SIDES.slice().sort((a, b) => { const free = s => placementsOn(live, hub, s, 12, 8, 3, null, 'hab').list.length ? 0 : 1; return free(a) - free(b); });
    let laid = null, why = null;
    for (const dir of dirs) {
      const geo = pattern === 'diamond' ? diamondGeometry(WM.create(clone(base)), hub.id, pr.rooms, hangsOf(env)) : concourseGeometry(B, dir, pr.rooms);
      if (!geo.ok) return geo;
      const probe = WM.create(clone(base)), hallIds = [], roomIds = {};
      let fail = null;
      for (const h of geo.halls) {
        const c = probe.canPlaceHallway([h.rect]);
        if (!c.ok) { fail = /^overlaps /.test(c.msg || '') ? c.msg.replace(/^overlaps /, '') + ' is in the way' : (c.msg || 'a corridor does not fit'); break; }
        const a = probe.placeHallway({ rect: h.rect }); if (!a || !a.ok) { fail = 'a corridor could not be laid'; break; }
        probe.setDeck(a.id, CORRIDOR_DECK); hallIds.push(a.id);
      }
      for (const r of fail ? [] : geo.rooms) {
        const q = pr.rooms.find(x => x.i === r.i), rec = q.style ? RS.ROOMS[q.style] : null;
        const c = probe.canPlaceRoom([r.rect], (rec && rec.kind) || 'hab');
        if (!c.ok) { fail = /^overlaps /.test(c.msg || '') ? c.msg.replace(/^overlaps /, '') + ' is in the way of ' + q.name : (c.msg || q.name + ' does not fit'); break; }
        const a = probe.addRoom({ kind: (rec && rec.kind) || 'hab', name: q.name, rect: r.rect, floorStyle: rec ? rec.deck.style : undefined, floorMat: rec ? rec.deck.mat : undefined });
        if (!a || !a.ok) { fail = q.name + ' could not be added'; break; }
        if (rec && rec.walls) probe.setWalls(a.id, rec.walls);
        roomIds[r.i] = a.id;
      }
      // nothing touches what it was not meant to: a room touches only its own hall (or, at a concourse's end, the corridor)
      if (!fail) for (const r of geo.rooms) {
        const mine = new Set([roomIds[r.i]].concat(hallIds));
        const other = neighbourOf(probe, r.rect, [...mine]);
        if (other) { fail = pr.rooms.find(x => x.i === r.i).name + ' would stand against ' + other; break; }
      }
      if (fail) { why = why || (pattern === 'diamond' ? 'The diamond around ' + hub.name + ' could not be laid (' + fail + ').' : 'A concourse ' + dir + ' of ' + hub.name + ' does not fit (' + fail + ').'); continue; }
      laid = { geo, probe, hallIds, roomIds, dir };
      break;
    }
    if (!laid) return refuse(why + (replace ? '' : ' Use replace: true to lay out the whole station again around ' + hub.name + (pattern === 'diamond' ? '.' : ', or the diamond pattern.')));
    // fill every room (lines first, then its style or zones), then dress the corridors
    const probe = laid.probe, parts = [], recruits = [], view = [];
    laid.geo.halls.forEach((h, j) => parts.push({ hall: h.rect, hallDeck: CORRIDOR_DECK, room: null, roomId: null, lines: [], props: [], dress: h.dress ? h.outer || null : undefined, hallId: laid.hallIds[j] }));
    for (const r of laid.geo.rooms) {
      const q = pr.rooms.find(x => x.i === r.i), id = laid.roomIds[r.i], rec = q.style ? RS.ROOMS[q.style] : null;
      let lines = [], props = [], fillView = [];
      if (q.lines.length || q.zones.length) {
        const f = fillRoom(probe, env, id, r.rect, q.zones, q.lines, q.zones.length && !q.need.one ? { fx: 0.5, fy: 0.5, one: false } : { fx: 1, fy: 1, one: true }, q.name, 0);
        if (!f.ok) return f.tooSmall ? refuse(q.name + ': ' + f.error) : f;
        lines = f.lines; props = f.props.slice(); fillView = f.view;
        f.recruits.forEach(rc => recruits.push(Object.assign({ part: parts.length }, rc)));
      }
      let dressed = null;
      if (rec) { dressed = dressRoom(probe, env, id, q.style); if (!dressed.ok) return dressed; props = props.concat(dressed.props); }
      const accents = q.lines.length || q.zones.length ? accentsFor(probe, env, id, q.zones, rec) : null;
      if (accents) props = props.concat(accents);
      parts.push({ hall: null, room: { kind: (rec && rec.kind) || 'hab', name: q.name, rect: r.rect, floorStyle: rec ? rec.deck.style : undefined, floorMat: rec ? rec.deck.mat : undefined, walls: rec ? rec.walls : undefined }, roomId: null, lines, props });
      view.push({ q, r, part: parts.length - 1, fillView, dressed, accents });
    }
    for (const p of parts) if (p.dress !== undefined) { const d = dressHall(probe, env, p.hallId, p.dress); p.props = d.props; }
    for (const p of parts) { delete p.dress; delete p.hallId; }
    const spec = { kind: 'build', parts, recruits };
    const sr = seatRecruits(probe, env, spec, pi => { const p = parts[pi]; return p.room ? probe.roomAt(p.room.rect.x1, p.room.rect.y1) : null; });
    if (!sr.ok) return sr;
    const t = tryBuild(base, spec, env, before);
    if (!t.ok) return refuse('The layout did not pass its checks (' + t.error + '), so nothing would be built. Try fewer or smaller rooms, or the other pattern.');
    const fp = t.probe;
    /* a replaced station seats its crew ACCORDINGLY: the desks the page's replaceLayout gave the agents whose rooms are
       gone (the main room's first free spots), and every specialist's desk when the main room holds a pile of them (more
       than 3, as summons leave), move to tidy rows in the rooms of the new layout, two to a room, the rooms where desks
       belong first (an office, a lab, a library…). The lead keeps its desk on the bridge; a bridge with a desk or two
       stays as it was. station.build makes the same moves after the build. */
    const moves = [], reseated = [];
    if (replace) {
      const DESK = /^(desk|desk2)$/, was = new Map();
      for (const p of live0.props()) if (p.agentId && DESK.test(p.t)) was.set(p.agentId, live0.roomAt(p.x, p.y));
      const onBridge = fp.props().filter(p => p.agentId && DESK.test(p.t) && fp.roomAt(p.x, p.y) === hub.id), pile = onBridge.length > 3;
      const moved = onBridge.filter(p => p.agentId !== env.heroId && (pile || (was.has(p.agentId) && was.get(p.agentId) !== hub.id)));
      if (moved.length) {
        const PREFER = ['desks', 'lab', 'library', 'comms', 'workshop', 'meeting', 'works', 'cafe', 'lounge', 'cozy', 'storage', 'quarters', 'garden', 'games', 'gym'];
        const rank = v => { const k = PREFER.indexOf(v.q.style); return k < 0 ? 99 : k; };
        const targets = view.slice().sort((a, b) => rank(a) - rank(b)).map(v => fp.roomAt(v.r.rect.x1, v.r.rect.y1)).filter(Boolean);
        const scratch = WM.create(clone(fp.serialize()));
        let k = 0;
        for (const rid of targets) {
          if (k >= moved.length) break;
          for (const d of recruitDesks(scratch, env, rid, Math.min(2, moved.length - k))) {   // two to a room: spread, never a pile
            const p = moved[k++], m = { id: p.id, dx: d.x - p.x, dy: d.y - p.y };
            const r = fp.moveProp(m.id, m.dx, m.dy);
            if (r && r.ok) { moves.push(m); const rm = fp.rooms().find(x => x.id === rid); if (rm && reseated.indexOf(rm.name) < 0) reseated.push(rm.name); }
          }
        }
      }
    }
    // the card: the pattern, then each room where it sits and what is in it
    const built = t.built, crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean), lines = [], steps = [];
    const short = props => { const txt = piecesText(env, props), parts2 = txt.split(', '); return parts2.length > 7 ? parts2.slice(0, 6).join(', ') + ' and more' : txt; };
    view.sort((a, b) => a.q.i - b.q.i);
    const roomText = view.map(v => {
      const Wd = v.r.rect.x2 - v.r.rect.x1 + 1, Hd = v.r.rect.y2 - v.r.rect.y1 + 1, at = v.r.side === 'end' ? 'at the far end' : v.r.side;
      const bits = [];
      if (v.dressed) bits.push(env.RoomStyles.ROOMS[v.q.style].name + (v.q.style === 'works' && !v.q.lines.length ? ', its floor kept for workflow lines' : ''));
      for (const fv of v.fillView) {
        if (fv.kind === 'style') { bits.push(AREA_LABEL[fv.area] + ', ' + env.RoomStyles.STYLES[fv.z.style].name); continue; }
        const bl = built.parts[v.part].lines[fv.line], rd = readLine(fp, bl.lineIds, env, crewIds);
        lines.push({ label: fv.z.label, plain: fv.z.plain, room: v.q.name, part: v.part, line: fv.line, ready: rd.ready, blocking: rd.blocking, picked: fv.z.picked });
        const stepsView = fv.stepsOut.map(x => ({ step: x.step, role: titleCase(x.role), agent: x.agentId ? nameOf(env, x.agentId) : null, instructions: x.brief }));
        stepsView.forEach(s => steps.push(Object.assign({}, s, { role: s.role + ' on ' + (fv.z.label || fv.z.plain) })));
        bits.push(fv.z.plain + (fv.z.label ? ' ("' + fv.z.label + '")' : '') + ': ' + flowText(fv.shape.cols, fv.runOrder, stepsView));
      }
      if (v.accents) bits.push(piecesText(env, v.accents) + ' in the corners');
      const brief = view.length > 4, pieces = !brief && v.dressed && v.dressed.props.length && v.q.style !== 'works' ? ' (' + short(v.dressed.props) + ')' : '';
      const size = brief && Wd === CELL[0] && Hd === CELL[1] ? '' : ', ' + Wd + ' × ' + Hd;
      return v.q.name + ' ' + at + size + ': ' + bits.join('; ') + pieces;
    });
    const wasRooms = live0.rooms().filter(x => x.kind !== 'corridor').length - 1, wasProps = live0.props().length - live.props().length;
    const head = pattern === 'diamond'
      ? (laid.geo.ring ? 'A DIAMOND around ' + hub.name + ': a corridor loop round it with a hallway in from each side, and ' + view.length + ' rooms on an even grid round the loop, each on its own planted, lit hallway. '
        : view.length + (view.length === 1 ? ' room' : ' rooms') + ' on the diamond grid around ' + hub.name + ', each in the next free place of the grid, on its own planted, lit hallway. ')
      : 'A CONCOURSE ' + laid.dir + ' from ' + hub.name + ': a wide corridor, planted and lit, and ' + view.length + (view.length === 1 ? ' room. ' : ' rooms. ');
    const blocking = [].concat(...lines.map(l => l.blocking.map(b => (lines.length > 1 ? (l.label || l.plain) + ': ' : '') + b)));
    const summary = head + (view.length > 4 && pattern === 'diamond' ? 'Every room is 18 × 11 unless it says. ' : '') + roomText.join('. ') + '.'
      + (replace ? ' It replaces everything beyond ' + hub.name + ' (' + wasRooms + (wasRooms === 1 ? ' room' : ' rooms') + ' and ' + wasProps + ' props); ' + hub.name + ', agents and conversations stay, and every agent keeps a desk' + (reseated.length ? ' (' + moves.length + (moves.length === 1 ? ' desk moves' : ' desks move') + ' to ' + reseated.join(', ') + ')' : '') + '. Your current layout is backed up: RESTORE PREVIOUS in Build → Presets brings it back.' : '')
      + (lines.length ? ' ' + (blocking.length ? 'Still to do after building: ' + blocking.join('; ') + '.' : 'Its lines will be ready to run.') : '');
    const fpd = fp.serialize();
    const preview = previewOf(WM, doc, fpd, [], null);
    const roomsOut = view.map(v => ({ name: v.q.name, style: v.q.style || null, where: v.r.side, existing: false }));
    const plan = { floorSig: sigOf(doc), resultSig: sigOf(fpd), summary, notes, steps, rooms: roomsOut, hallways: [], lines, preview, line: null,
      where: (pattern === 'diamond' ? 'the diamond around ' : 'a concourse ' + laid.dir + ' of ') + hub.name, layout: { pattern, replace } };
    plan.spec = replace ? { kind: 'relayout', stripped, build: spec, pattern, moves } : spec;
    if (replace) plan.preset = { id: 'layout-' + pattern, name: 'your new ' + pattern.toUpperCase() + ' layout' };
    return { ok: true, plan };
  }

  /* A ROOM DESCRIBED PART BY PART (station.plan_room's zones, 2026-09-29): one room of the spatial builder. `where` names an
     existing room to furnish; else a new room, sized for its zones, goes beside the main room on the side that keeps the
     station compact, joined by a hallway. */
  function planDesign(doc, req, env) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse('Send the request as an object with: ' + DESIGN_MENU.join(', ') + '.');
    const extra = Object.keys(req).filter(k => DESIGN_MENU.indexOf(k) < 0);
    if (extra.length) return refuse('StarNet chooses every position and piece of furniture itself, so these fields are not accepted with zones: ' + extra.slice(0, 8).join(', ') + '. Use only: ' + DESIGN_MENU.join(', ') + '.');
    const into = req.where != null && !/^(a )?new( room)?$/i.test(String(req.where).trim());
    const room = { zones: req.zones };
    for (const k of ['type', 'floorStyle', 'floorMat', 'beside', 'side', 'hallway', 'size']) if (req[k] !== undefined) room[k] = req[k];
    if (into) room.into = req.where;
    if (req.name !== undefined) room.name = req.name;
    return planBuild(doc, { rooms: [room] }, env);
  }

  /* THE MAP (station.map): what the lead needs to SEE before it builds — every room's place and size, what joins it to
     what, what stands in it, which sizes of room fit on each of its sides, and the floor drawn in characters. x grows
     east, y grows south; north is the back wall (the top). Pure: it reads a doc and changes nothing. */
  // everything a BUILD MODE edit can name: every piece (its type, size and rules), room types, floors, walls, bay roles, lines, line edits
  function catalogOf(env) {
    const WM = env.WorldModel, S = env.PropSprites, RS = env.RoomStyles;
    const pieces = ((S && S.CATALOG) || []).map(c => { const sp = S.spec(c.id) || {}, rule = (S.ruleFor && S.ruleFor(c.id)) || {}; const o = { t: c.id, name: String(c.label || c.id).toLowerCase(), w: c.w, h: c.h, cat: c.cat };
      if (rule.mount) o.mount = rule.mount; if (sp.flat) o.flat = true; if (sp.stack) o.onTables = true; if (sp.surface) o.table = true; if (S.canRotate && S.canRotate(c.id)) o.turns = true; if (S.canMirror && S.canMirror(c.id)) o.flips = true; { const sf = sideFacing(S, c.id); if (sf != null) o.faces = sf === 1 ? 'west' : 'east'; } if (c.user) o.yours = true; if (MACHINE_T.test(c.id)) o.machine = true; return o; });
    const K = WM.ROOM_KINDS || {};
    return { pieces, roomTypes: Object.keys(K).filter(k => k !== 'corridor'), floorStyles: Object.keys(WM.FLOOR_STYLES || {}), floorMats: Object.keys(WM.FLOOR_MATERIALS || {}), wallMats: Object.keys(WM.WALL_MATERIALS || {}), hullMats: Object.keys(WM.HULL_MATERIALS || {}),
      roomStyles: RS && RS.ROOM_ORDER ? RS.ROOM_ORDER.slice() : [], bayRoles: Object.keys(WM.BAY_ROLES || {}), lines: catalog(WM).map(l => l.id), lineEdits: env.LineEdit && env.LineEdit.OPS ? Object.keys(env.LineEdit.OPS) : [],
      rules: 'r turns a piece (0 faces south, 1 west, 2 north, 3 east) when it turns; a mount wall piece hangs on a room\'s back (north) edge; a mount surface piece stands on a table; an onTables piece may; a flat piece (a rug) lies under others. w × h is the piece facing south; turned east or west it swaps.' };
  }
  // one room tile by tile: every piece with its id, every belt, the doorways, and the room drawn
  function roomDetail(st, env, ref) {
    const t = roomNamed(st, ref); if (!t.ok) return t;
    const r = t.room, B = bboxOf(r), S = env.PropSprites, g = st.projectGeometry(), belts = st.serialize().belts || {};
    const here = st.props().filter(p => st.roomAt(p.x, p.y) === r.id);
    const pieces = here.map(p => { const o = { id: p.id, t: p.t, name: pieceName(env, p.t), x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 }; if (p.r) o.r = p.r; if (p.m) o.m = 1; if (sideFacing(S, p.t) != null) o.faces = facingOf(S, p) === 1 ? 'west' : 'east'; if (p.agentId) o.agent = nameOf(env, p.agentId); if (p.role) o.role = p.role; if (p.label) o.label = p.label; if (p.brief) o.brief = String(p.brief).slice(0, 120); if (p.hands) o.hands = p.hands; if (p.limits) o.budget = { perDay: p.limits.maxUsdPerDay, perJob: p.limits.maxUsdPerMessage, stages: p.limits.maxHops }; if (p.projectRoot) o.folder = String(p.projectRoot).replace(/\\/g, '/').split('/').pop(); for (const k of ['routes', 'def', 'maxIter', 'when', 'done', 'esc', 'timeoutMin', 'connectorId', 'pluginId']) if (p[k] != null) o[k] = p[k]; if (p.block === false) o.walkOver = true; return o; });
    const beltList = Object.keys(belts).map(k => { const [x, y] = k.split(',').map(Number); return [x, y, belts[k]]; }).filter(([x, y]) => st.roomAt(x, y) === r.id);
    const doors = doorTiles(st, g, r.id).map(d => [d.x, d.y]);
    const mark = {}; for (const p of here) for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) mark[x + ',' + y] = MACHINE_T.test(p.t) ? 'M' : p.agentId ? 'A' : p.block === false ? '_' : '#';
    for (const [x, y] of beltList) if (!mark[x + ',' + y]) mark[x + ',' + y] = '=';
    for (const [x, y] of doors) mark[x + ',' + y] = 'D';
    const drawing = [];
    for (let y = B.y1; y <= B.y2; y++) { let row = ''; for (let x = B.x1; x <= B.x2; x++) row += st.roomAt(x, y) !== r.id ? ' ' : mark[x + ',' + y] || '.'; drawing.push(row); }
    const K = (env.WorldModel.ROOM_KINDS || {})[r.kind] || {};
    return { ok: true, map: { room: r.name, type: K.label || r.kind, rects: r.rects.map(q => ({ x: q.x1, y: q.y1, w: q.x2 - q.x1 + 1, h: q.y2 - q.y1 + 1 })), floor: [r.floorStyle || 'default', r.floorMat || 'default'].join(' / '),
      pieces, belts: beltList, doorways: doors, drawing, origin: { x: B.x1, y: B.y1 }, issues: roomIssues(st, env, r.id),
      legend: 'drawing row 0 is y = ' + B.y1 + ', column 0 is x = ' + B.x1 + '; . clear floor, # a piece, _ a piece you walk over (a rug), A an agent\'s seat, M a workflow machine, = a belt, D a doorway' } };
  }
  function mapOf(doc, env, opts) {
    const WM = env && env.WorldModel, P = env && env.Pipeline;
    if (!WM || !doc) return refuse('the station builder is not loaded on this page');
    if (opts && opts.catalog) return env.PropSprites ? { ok: true, map: catalogOf(env) } : refuse('the piece catalog is not loaded on this page');
    if (opts && opts.room != null) return env.PropSprites ? roomDetail(WM.create(clone(doc)), env, opts.room) : refuse('the piece catalog is not loaded on this page');
    const st = WM.create(clone(doc)), all = st.rooms(), rooms = all.filter(r => r.kind !== 'corridor'), halls = all.filter(r => r.kind === 'corridor');
    const main = mainRoom(st), touching = (a, b) => a.rects.some(p => b.rects.some(q => (p.x1 <= q.x2 && q.x1 <= p.x2 && (p.y2 + 1 === q.y1 || q.y2 + 1 === p.y1)) || (p.y1 <= q.y2 && q.y1 <= p.y2 && (p.x2 + 1 === q.x1 || q.x2 + 1 === p.x1))));
    const MACHINE = MACHINE_T, KIND = WM.ROOM_KINDS || {};
    let comps = [];
    try { comps = P && P.lineComponents ? P.lineComponents(st.projectGeometry()) : []; } catch (_) { comps = []; }
    const out = rooms.map(r => {
      const B = bboxOf(r), props = st.props().filter(p => st.roomAt(p.x, p.y) === r.id);
      const joined = new Set();
      for (const o of rooms) if (o !== r && touching(r, o)) joined.add(o.name + ' (open to it)');
      const seen = new Set(), queue = halls.filter(h => touching(r, h));
      while (queue.length) { const h = queue.shift(); if (seen.has(h)) continue; seen.add(h); for (const n of halls) if (!seen.has(n) && touching(h, n)) queue.push(n); }
      for (const h of seen) for (const o of rooms) if (o !== r && touching(h, o)) joined.add(o.name + ' (through a hallway)');
      const lineLabels = props.filter(p => p.t === 'intake').map(p => p.label || 'an unnamed line');
      const tiles = r.rects.reduce((s, q) => s + (q.x2 - q.x1 + 1) * (q.y2 - q.y1 + 1), 0), usedTiles = props.filter(p => p.block !== false).reduce((s, p) => s + (p.w || 1) * (p.h || 1), 0);
      const fits = {};
      for (const side of ['north', 'south', 'east', 'west']) fits[side] = Object.keys(SIZES).filter(k => placementsOn(st, r, side, SIZES[k][0], SIZES[k][1], HALL_LEN, null, 'hab', hangsOf(env)).list.length);
      return { name: r.name, main: r === main || undefined, type: (KIND[r.kind] && KIND[r.kind].label) || r.kind, x: B.x1, y: B.y1, w: B.x2 - B.x1 + 1, h: B.y2 - B.y1 + 1,
        joinedTo: [...joined], machines: props.filter(p => MACHINE.test(p.t)).length, furniture: props.filter(p => !MACHINE.test(p.t)).length, lines: lineLabels,
        clearFloor: Math.round(100 * (tiles - usedTiles) / Math.max(1, tiles)) + '%', roomForANewRoom: fits };
    });
    // the floor in characters: each room its letter, hallways '+', space for nothing
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of all) { const b = bboxOf(r); x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', letter = {}, step = (x2 - x1 + 1) > 120 ? 2 : 1, rows = [];
    rooms.forEach((r, i) => { letter[r.id] = LETTERS[i % 26]; });
    for (let y = y1; y <= y2; y += step) { let row = ''; for (let x = x1; x <= x2; x += step) { const id = st.roomAt(x, y); row += !id ? ' ' : letter[id] || '+'; } rows.push(row.replace(/\s+$/, '')); }
    // every hallway by name (the name a refusal gives it) and what it joins, so the lead can take one up or route round it
    const nowhere = new Set(strandedHalls(st));
    const hallList = halls.map(h => { const B = bboxOf(h); return Object.assign({ name: h.name, x: B.x1, y: B.y1, w: B.x2 - B.x1 + 1, h: B.y2 - B.y1 + 1, joins: rooms.filter(o => touching(h, o)).map(o => o.name) }, nowhere.has(h.id) ? { leadsNowhere: true } : {}); });
    return { ok: true, map: { main: main ? main.name : null, rooms: out, hallways: halls.length, halls: hallList,
      sizes: 'small 12 × 8, medium 18 × 11, large 24 × 14, giant 36 × 20',
      reading: 'x grows east, y grows south; north is the back wall (the top of the drawing). roomForANewRoom lists the sizes that fit on each side of a room, joined by a hallway.',
      legend: rooms.map(r => letter[r.id] + ' = ' + r.name).join(', ') + (halls.length ? ', + = a hallway' : '') + (step > 1 ? ' (one character is 2 × 2 tiles)' : ''),
      drawing: rows } };
  }

  function apply(st, pl, env) {
    const WM = env && env.WorldModel;
    if (!WM || !env.Pipeline || !env.WorkflowLine) return refuse('the station builder is not loaded on this page');
    if (!pl || !pl.spec || !pl.floorSig || !pl.resultSig) return refuse('There is no such plan. Plan the line again.');
    if (!st || !st.transact) return refuse('the station is not ready');
    if (sigOf(st.serialize()) !== pl.floorSig) return refuse('Your station changed since this plan was made, so nothing was built. Plan it again.');
    let built = null;
    const recruited = [], recruits = pl.spec.recruits || [];
    if (recruits.length && typeof env.recruit !== 'function') return refuse('Recruiting is not available on this page, so nothing was built. Plan it again without "new".');
    if (pl.spec.kind === 'undo') {
      const u = st.undo();
      if (!u || !u.ok) return refuse('There was nothing to undo.');
      if (sigOf(st.serialize()) !== pl.resultSig) { try { st.redo(); } catch (_) {} return refuse('That undo did not bring the station back exactly as it was before the build, so it was put back. The Commander can press UNDO in Build mode.'); }
      return { ok: true, kind: 'edit', summary: pl.summary, where: pl.where, rooms: [], hallways: [], lines: [], roomIds: [] };
    }
    const r = st.transact(() => {
      const b = pl.spec.kind === 'refit' ? (() => { const ran = refitAll(st, env, pl.spec.ops || [], pl.spec.res || null); return ran.ok ? { ok: true, ids: [] } : ran; })()
        : pl.spec.kind === 'rearrange' ? (() => { const x = rearrangeOnto(st, env, pl.spec.opts || {}); return x.ok ? { ok: true, ids: [] } : x; })() : buildInto(st, pl.spec, WM);
      if (!b.ok) return b;
      if (sigOf(st.serialize()) !== pl.resultSig) return refuse('The build did not match its plan, so nothing was changed. Plan it again.');
      // recruits come AFTER the exact-match check (their ids are minted now), inside the same undo step: each one's desk
      // and its seat on the step are floor edits UNDO takes back; the agent itself is not (DELETE AGENT in its Dossier)
      for (const rc of recruits) {
        let a = null;
        const before = new Set(st.props().map(p => p.id));
        try { a = env.recruit(rc.role); } catch (_) { a = null; }
        if (!a || !a.id) return refuse('StarNet could not recruit a ' + rc.role + ', so nothing was built.');
        recruited.push({ id: a.id, name: a.name || a.id, role: rc.role });
        if (rc.desk) {
          const slot = st.propAt(rc.desk.x, rc.desk.y), sp = slot ? st.propById(slot) : null;
          if (sp && sp.t === 'desk' && !sp.agentId) {
            const own = st.props().find(p => p.agentId === a.id && p.id !== slot && !before.has(p.id) && /^(desk|desk2)$/.test(p.t));
            const kept = st.props().find(p => p.agentId === a.id && p.id !== slot && before.has(p.id));
            if (kept) st.removeProp(slot);   // it adopted a desk that already stood: that one is its own, the new one goes
            else { if (own) st.removeProp(own.id); const d = st.assignPropAgent(slot, a.id); if (!d || !d.ok) return refuse('The new ' + rc.role + ' could not be given its desk by the line, so nothing was built.'); }
          }
        }
        const pid = rc.propIndex != null ? b.ids[rc.propIndex] : (((((b.parts || [])[rc.part] || {}).lines || [])[rc.line] || {}).idOf || {})[rc.node];
        const s = st.assignPropAgent(pid, a.id);
        if (!s || !s.ok) return refuse('The new ' + rc.role + ' could not be seated at its step, so nothing was built.');
      }
      built = b;
      return { ok: true };
    });
    if (!r || !r.ok || !built) {
      const kept = recruited.length ? ' ' + recruited.map(x => x.name).join(', ') + (recruited.length > 1 ? ' were' : ' was') + ' recruited and stays on the crew (DELETE AGENT in a Dossier removes an agent).' : '';
      return refuse(((r && r.error) || 'The build failed, so nothing was changed.') + kept, { recruited });
    }
    const crewIds = (env.crew || []).map(a => a && a.id).filter(Boolean);
    if (pl.spec.kind === 'build') {
      for (const x of recruited) crewIds.push(x.id);
      const lines = (pl.lines || []).map(l => { const ln = ((built.parts[l.part] || {}).lines || [])[l.line], rl = ln ? readLine(st, ln.lineIds, env, crewIds) : { ready: false, blocking: [] }; return { label: l.label || null, room: l.room, lineId: rl.comp ? rl.comp.key : null, ready: rl.ready, blocking: rl.blocking }; });
      return { ok: true, kind: 'build', summary: pl.summary, rooms: pl.rooms || [], hallways: pl.hallways || [], where: pl.where, lines, roomIds: built.parts.map(p => p.roomId).filter(Boolean), recruited };
    }
    if (pl.spec.kind === 'edit' || pl.spec.kind === 'refit' || pl.spec.kind === 'rearrange') return { ok: true, kind: 'edit', summary: pl.summary, rooms: [], hallways: [], where: pl.where, lines: [], roomIds: pl.spec.restyle ? [pl.spec.restyle.roomId] : [] };
    if (pl.spec.kind === 'swap' || pl.spec.kind === 'relayout') return { ok: true, kind: 'swap', summary: pl.summary, rooms: pl.rooms || [], where: pl.where, lines: pl.lines || [], preset: pl.preset, roomIds: [] };
    if (pl.spec.kind === 'rooms' || pl.spec.kind === 'restyle') {
      const lines = (built.parts || []).filter(p => p.lineIds && p.lineIds.length).map(p => { const rl = readLine(st, p.lineIds, env, crewIds); return { lineId: rl.comp ? rl.comp.key : null, ready: rl.ready, blocking: rl.blocking }; });
      return { ok: true, kind: pl.spec.kind, summary: pl.summary, rooms: pl.rooms || [], where: pl.where, lines,
        roomIds: pl.spec.kind === 'restyle' ? [pl.spec.roomId] : (built.parts || []).map(p => p.roomId) };
    }
    for (const x of recruited) crewIds.push(x.id);
    const rd = readLine(st, built.ids, env, crewIds), first = st.props().find(p => p.id === built.ids[0]);
    return { ok: true, summary: pl.summary, line: pl.line, where: pl.where, steps: pl.steps, intakeId: built.intakeId, roomIds: first ? [st.roomAt(first.x, first.y)].filter(Boolean) : [],
      lineKey: rd.comp ? rd.comp.key : null, ready: rd.ready, blocking: rd.blocking, recruited };
  }

  return { strandedHalls, MENU, STEP_KEYS, ROOM_MENU, STYLE_MENU, DESIGN_MENU, ZONE_KEYS, ROOM_KEYS, LINE_KEYS, LAYOUT_KEYS, LAYOUT_ROOM_KEYS, AREAS, SIZES, EDIT_KEYS, catalog, resolveLine, plan, planRoom, planRestyle, planEdit, planUndo, planDesign, planBuild, planLayout, mapOf, lineRef, roomPlacements, dressRoom, shapeGraph, areaOf, apply, sigOf };
});
