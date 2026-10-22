/* AGENT OS — ghostline.js : the GHOST PROJECTION (guided workflows Phase 3, 2026-08-05).

   While a compiled line is INCOMPLETE — uncrewed docks, or an intake nothing feeds (the SAME
   truth the finish-the-line card reads: unbound bays from the compiled plan + the server-proven
   feed state) — one clearly-projected crate loops the route so the user WATCHES the workflow
   they are building before it exists: in at the INTAKE mouth, sorted by the real junction rules,
   consumed at the dock a real crate would stop at, handed off along the chain, out at the OUTBOX.

   THE SEAM (why a DEDICATED Conveyor instance, not a payload flag on the real one): the real
   conveyor IS telemetry — world.js reads its peekBoxes()/boxCount() into _dbg, its onDeliver
   drives delivery beats and the finish-the-line retirement, and its backpressure physics space
   REAL crates. A ghost sharing that instance could block a real crate (MIN_GAP against a
   projection = physics lying) and would ride through every count. A separate instance makes the
   split structural: nothing that reads the real belt can ever see a ghost. The only thing shared
   is the DRAW path (payload.ghost selects the dashed projection art in conveyor.js), so the
   ghost rides with the exact same motion physics on the exact same junction decisions.

   TRUTHFUL TELEMETRY: every caption speaks in WOULD-language and the crate is visually
   unmistakable (hollow dashed outline, faint interior, no shadow, no work tag) — a viewer can
   never mistake the projection for real work. The projection stands down the INSTANT a real
   crate rides (real telemetry owns the belt), while the tutorial coaches, and while REFIT's
   first-ride narration is armed; it resumes when the line goes incomplete again.

   ROUTE TRUTH: the ghost follows the COMPILED plan exactly — the engine's chooseExit mirrors
   pipeline.resolveTarget (filters route by the ghost's tag; the tag alternates per loop pass
   over the line's real filter tags, so every lane gets shown — deterministic, no RNG), and the
   chain continuation spawns from the consumed dock's ship hookup with the producer stamped on
   it, so "a dock never eats its own output" holds for projections exactly as for real crates
   (mirrors pipeline.chainNext — locked by test/ghostline.test.js).

   DETERMINISM: injected nowMs/dtMs only — no Math.random, no Date.now, no wall clock. Two
   identical tick sequences produce identical trajectories (scanned by test/lint-determinism.js). */
'use strict';

const GhostLine = (() => {
  const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const LANE_ORDER = ['E', 'S', 'W', 'N'];   // fixed order — mirrors pipeline.js/conveyor.js exactly
  const key = (x, y) => x + ',' + y;
  const SPAWN_DELAY_MS = 900;    // line just went incomplete -> first ghost (a beat, not a jump-scare)
  const LOOP_PAUSE_MS = 2600;    // pass ended -> next pass (the loop breathes; captions get read)
  const CHAIN_BEAT_MS = 600;     // dock consumed the ghost -> the handoff ghost ships from its hookup
  const NOTE_MS = 3000;          // caption life (rise + fade)
  const MAX_LOG = 60;            // bounded event log (headless tests + CDP readouts)
  const GHOST_COL = '#8fd8e8';   // the projection phosphor — pale scanner cyan, no real cargo uses it
  const ARROW = { E: '▸', W: '◂', N: '▴', S: '▾' };

  // lane fan — EXACT mirror of pipeline.js internals (fixed LANE_ORDER => deterministic walks)
  function outLanes(map, x, y) {
    const lanes = [];
    for (const d of LANE_ORDER) { const v = DIRV[d], nb = map[key(x + v[0], y + v[1])]; if (nb && nb !== OPP[d]) lanes.push(d); }
    return lanes;
  }
  function nextTiles(map, junctions, t) {
    if (!map[key(t.x, t.y)]) return [];
    const dirs = junctions[key(t.x, t.y)] ? outLanes(map, t.x, t.y) : [map[key(t.x, t.y)]];
    const out = [];
    for (const d of dirs) { const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1]; if (map[key(nx, ny)]) out.push({ x: nx, y: ny }); }
    return out;
  }
  /* flood forward from `start`, fanning ALL junction lanes, mirroring pipeline.chainWalk's consume
     rule: a FOREIGN dock stop is terminal (found), the walker's OWN tiles are ridden through, an
     outbox mouth is noted. Answers "what can this hookup's lane reach?" for ship-tile preference. */
  function reachFrom(map, junctions, stops, selfOwner, outSet, start) {
    const seen = {}, q = [start];
    seen[key(start.x, start.y)] = true;
    let dock = false, outbox = false;
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y), owner = stops[k];
      if (owner && owner !== selfOwner) { dock = true; continue; }   // a foreign dock consumes — terminal
      if (outSet[k]) outbox = true;
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return { dock, outbox };
  }

  function create() {
    let engine = null;               // the DEDICATED Conveyor instance (never the caller's)
    let cands = [];                  // per-line precompiled ghost routes (caller frame)
    let cur = null;                  // the candidate being projected right now
    let projecting = false;          // truth for peek(): this selected line's projection has begun
    let pass = 0, nextSpawnAt = 0, pendingChain = null, nid = 0, tnow = 0;
    const notes = [];                // {x, y, text, t0} — WOULD-captions (caller-frame tiles)
    const log = [];                  // bounded event log for tests/CDP proofs

    const push = ev => { log.push(ev); if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG); };
    // below: the caption hangs UNDER its tile — a dock's nameplate / nag owns the space above it (2026-09-28 retest:
    // "◇ YOUR WRITER WOULD RUN IT" printed across the NOVA plate the moment a bay was crewed)
    const note = (x, y, text, below) => { notes.push({ x, y, text, t0: tnow, below: !!below }); if (notes.length > 6) notes.shift(); };
    function ensureEngine() {
      if (!engine && typeof Conveyor !== 'undefined') engine = Conveyor.create({ onDeliver, onAdvance });
      return engine;
    }
    function clearRide() {
      if (engine) engine.reset();
      notes.length = 0; pendingChain = null; nextSpawnAt = 0;
    }

    /* ---------- context: precompile each incomplete-able line's ghost route data ----------
       plan/comps arrive in the compiler's LOCAL frame; `offset` rebases every stored tile into
       the CALLER's frame (world.js: {0,0}; REFIT: cacheGeo.origin) so tick/draw share the exact
       frame of the belts + junctions the caller already hands its real conveyor. */
    function setContext(inp) {
      const plan = inp && inp.plan, comps = (inp && inp.comps) || [];
      const o = (inp && inp.offset) || { tx: 0, ty: 0 };
      cands = [];
      // a non-deployable plan (cycle / dup agent) projects NOTHING — a ghost on a looping line
      // would ride forever, previewing a workflow the sidecar refuses to run.
      if (!plan || !plan.belts || (plan.errors || []).some(e => !e.warn)) { if (cur) { cur = null; clearRide(); projecting = false; } return; }
      const map = plan.belts, junctions = plan.junctions || {};
      const rb = t => ({ x: t.x + o.tx, y: t.y + o.ty });
      for (const c of comps) {
        if (!c.bays.length || !c.intakes.length || !c.beltCount) continue;
        // STOPS (local first): every BOUND bay from the plan's own truth, plus every UNBOUND
        // bay's hookup ring — the ghost stops at the dock a real crate WOULD stop at once crewed.
        const stopsL = {};
        for (const k in (plan.bayTileToAgent || {})) stopsL[k] = plan.bayTileToAgent[k];
        const dockMeta = {}, ringOf = {};
        for (const b of c.bays) {
          const owner = b.agentId || ('g#' + b.propId);
          dockMeta[owner] = { role: b.role || null, propId: b.propId, bound: !!b.agentId };
          const ring = [];
          // an UNBOUND bay stops the ghost only where the plan hooks it (plan.unboundBayTile — on a linked floor, the ring
          // tiles of its own links; a belt that merely passes it rides on, conveyor-links phase B)
          const ubt = plan.unboundBayTile || null;
          for (let yy = b.y - 1; yy <= b.y + (b.h || 1); yy++)
            for (let xx = b.x - 1; xx <= b.x + (b.w || 1); xx++) {
              const k = key(xx, yy);
              if (!map[k] || (!b.agentId && ubt && ubt[k] !== b.propId)) continue;
              ring.push({ x: xx, y: yy }); if (!b.agentId && !stopsL[k]) stopsL[k] = owner;
            }
          ringOf[owner] = ring;
        }
        // OUTBOX mouths on this line (the ship-out caption + ship-tile preference)
        const outL = {};
        for (const ob of (plan.outs || [])) { const k = key(ob.tile.x, ob.tile.y); if (c.tiles[k]) outL[k] = true; }
        // SPAWN: the intake mouth whose lane actually reaches a dock (mirror of resolveTarget's
        // walk-every-mouth-in-ring-order rule); fall back to the first mouth.
        let spawn = null, firstMouth = null;
        for (const s of (plan.sources || [])) {
          if (c.props.indexOf(s.propId) < 0) continue;
          const mouths = (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
          for (const mt of mouths) {
            if (!firstMouth) firstMouth = mt;
            if (!spawn && reachFrom(map, junctions, stopsL, null, outL, mt).dock) spawn = mt;
          }
        }
        spawn = spawn || firstMouth;
        if (!spawn) continue;   // no feed mouth on a belt — nothing can ride, nothing to project
        // TAGS: the line's real filter route tags, sorted, + 'general' (the default lane) — the
        // pass counter cycles them so every filter lane gets shown. Deterministic, no RNG.
        const tagSet = {};
        for (const jk in junctions) {
          const j = junctions[jk];
          if (!c.tiles[jk] || j.kind !== 'filter' || !j.routes) continue;
          for (const tg in j.routes) tagSet[tg] = true;
        }
        const tags = Object.keys(tagSet).sort(); tags.push('general');
        // SHIP hookup per dock (chain continuation spawn) — pipeline.shipFrom's preference,
        // mirrored: a lane that reaches a FOREIGN dock > a lane that reaches an OUTBOX > the
        // first hookup (a real dock's product ships out even onto a dead-end lane).
        const ship = {};
        for (const owner in ringOf) {
          let viaDock = null, viaOut = null, first = null;
          for (const t of ringOf[owner]) {
            const r = reachFrom(map, junctions, stopsL, owner, outL, t);
            if (!first) first = t;
            if (r.dock && !viaDock) viaDock = t;
            if (r.outbox && !viaOut) viaOut = t;
          }
          const pickT = viaDock || viaOut || first;
          if (pickT) ship[owner] = rb(pickT);
        }
        // rebase stops/outs into the caller frame
        const stops = {}, outSet = {};
        for (const k in stopsL) { const p = k.split(','); stops[(+p[0] + o.tx) + ',' + (+p[1] + o.ty)] = stopsL[k]; }
        for (const k in outL) { const p = k.split(','); outSet[(+p[0] + o.tx) + ',' + (+p[1] + o.ty)] = true; }
        cands.push({ key: c.key, crewLeft: c.bays.filter(b => !b.agentId).length, hasIntake: c.intakes.length > 0,
          spawn: rb(spawn), stops, outSet, dockMeta, ship, tags });
      }
      // the projected line may have dissolved/completed under this recompile
      if (cur && !cands.some(c => c.key === cur.key)) { cur = null; clearRide(); projecting = false; }
      else if (cur) cur = cands.find(c => c.key === cur.key);   // adopt the recompiled route data
    }

    /* ---------- the loop ---------- */
    function tick(dtMs, nowMs, belts, junctions, opt) {
      tnow = nowMs;
      const e = ensureEngine(); if (!e) return;
      const blocked = !!(opt && opt.blocked);
      const feed = (opt && opt.feed) || { known: false, fed: false };
      // the line to project: FIRST candidate with work left — the exact incompleteness truth the
      // finish-the-line card reads (unbound docks, or a provably unfed intake).
      let sel = null;
      for (const c of cands) { if (c.crewLeft > 0 || (c.hasIntake && feed.known && !feed.fed && !(opt && opt.fedLines && opt.fedLines[c.key]))) { sel = c; break; } }
      if (!sel || blocked) {
        // STOP INSTANTLY: the line completed, real telemetry owns the belt, or a coach is up.
        if (e.boxCount() || notes.length || pendingChain) clearRide();
        projecting = false;
        cur = sel;   // keep the selection so an unblock resumes without a rebuild
        nextSpawnAt = 0;
        return;
      }
      if (!cur || cur.key !== sel.key) { clearRide(); projecting = false; pass = 0; nextSpawnAt = nowMs + SPAWN_DELAY_MS; }
      cur = sel;
      if (pendingChain && nowMs >= pendingChain.at) { e.enqueueAt(pendingChain.x, pendingChain.y, pendingChain.payload); pendingChain = null; }
      if (!pendingChain && e.boxCount() === 0) {
        if (!nextSpawnAt) nextSpawnAt = nowMs + (pass === 0 ? SPAWN_DELAY_MS : LOOP_PAUSE_MS);
        else if (nowMs >= nextSpawnAt) {
          const tag = cur.tags[pass % cur.tags.length];
          e.enqueueAt(cur.spawn.x, cur.spawn.y, { ghost: true, tag, workitemId: 'ghost-' + (++nid) });
          note(cur.spawn.x, cur.spawn.y, '◇ A MESSAGE WOULD ARRIVE HERE');
          push({ kind: 'spawn', tile: { x: cur.spawn.x, y: cur.spawn.y }, tag, pass });
          projecting = true;
          pass++; nextSpawnAt = 0;
        }
      }
      e.tick(dtMs, nowMs, belts, junctions, cur.stops);
      projecting = e.boxCount() > 0 || !!pendingChain;
      if (projecting) nextSpawnAt = 0;
      else if (!nextSpawnAt || nextSpawnAt <= nowMs) nextSpawnAt = nowMs + LOOP_PAUSE_MS;
    }

    // the engine consumed a ghost — at a dock (chain on) or off the open end (ship out / fade)
    function onDeliver(bx, x, y) {
      if (!cur) return;
      const p = bx.payload || {};
      const owner = cur.stops[key(x, y)];
      if (owner && owner !== p.fromAgentId) {
        const meta = cur.dockMeta[owner] || null;
        const who = (meta && meta.role) ? 'YOUR ' + meta.role : 'THE AGENT HERE';
        note(x, y, '◇ ' + who + ' WOULD RUN IT', true);
        push({ kind: 'dock', owner, tile: { x, y }, tag: p.tag || 'general' });
        // CHAIN: the dock's output becomes the next stage's input — a new ghost from its ship
        // hookup, producer stamped on it (a dock never eats its own output — engine physics).
        const ship = cur.ship[owner];
        if (ship) pendingChain = { at: tnow + CHAIN_BEAT_MS, x: ship.x, y: ship.y,
          payload: { ghost: true, tag: p.tag || 'general', fromAgentId: owner, workitemId: 'ghost-' + (++nid) } };
        return;
      }
      if (cur.outSet[key(x, y)]) { note(x, y, '◇ THE RESULT WOULD SHIP OUT HERE'); push({ kind: 'out', tile: { x, y } }); }
      else push({ kind: 'end', tile: { x, y } });
    }
    // a junction decided for the ghost — caption the decision the engine ACTUALLY made (WOULD-voice)
    function onAdvance(bx, info) {
      if (!info || !info.tile) return;
      if (info.kind === 'filter') {
        note(info.tile.x, info.tile.y, '◇ IT WOULD SORT HERE — ' + String(info.tag || 'general').toUpperCase() + ' ' + (ARROW[info.lane] || ''));
        push({ kind: 'sort', tile: info.tile, tag: info.tag, lane: info.lane });
      } else if (info.kind === 'split') {
        // a split with a JOINER downstream runs every branch (the compiled `fanout`); without one, jobs take turns
        note(info.tile.x, info.tile.y, info.fanout ? '◇ EVERY BRANCH WOULD GET A COPY' : '◇ JOBS WOULD TAKE TURNS HERE');
        push({ kind: 'split', tile: info.tile, lane: info.lane });
      }
    }

    /* ---------- draw: the ghost crate (conveyor.js projection art) + the WOULD-captions ----------
       `say` (optional) is the caller's label arbiter: when provided, each live caption is OFFERED as
       say(box, paint) — box = the label's rect in the caller's pixel frame, paint = a callback that
       draws it — instead of painted directly, so the caller's one-voice law can mute the projection
       while any higher layer speaks. Omitted (world.js, tests) → the classic direct paint.
       A CAPTION IS A PLATE (2026-09-30): it was bare cyan text with a glow, laid over machines and belts — hard to read and
       easy to lose. It is a small dark plate now, edged with a DASHED hairline in the projection's cyan (dashed = projected,
       the same way the ghost crate is a hologram), holding plain text; it is fully lit for most of its life and fades at the
       end. `fit` (optional) lets the caller keep a plate on its visible glass: fit(box) answers the box to use.
       `say` answering false means it declined to paint that caption: its spot is then free for the next one. */
    function draw(ctx, nowMs, T, fontPx, say, fit) {
      if (!engine) return;
      engine.drawBoxes(ctx, nowMs, T);
      if (!notes.length) return;
      const fs = fontPx || 8;
      const font = fs + "px 'VT323','Courier New',monospace";
      const padX = fs * 0.45, padY = fs * 0.18, ph = fs + padY * 2;
      // the plate: above the tile (rising as it appears), or under it (a dock caption — its nameplate owns the space above)
      /* LAID OUT, NEVER PILED (walk 10-14 #13: two captions printed on top of each other; one crossed the hull into space).
         A caption drawn this frame is never covered by a later one: the later one tries the other side of its tile, then one
         plate further out on either side. `fit(box, note)` is the caller's keep-it-on-the-station clamp; it may answer null
         where a spot is taken by something real. With no clear spot a caption sits this pass out — it is only a projection. */
      const placed = [];
      const over = (a, o) => a.x < o.x + o.w && a.x + a.w > o.x && a.y < o.y + o.h && a.y + a.h > o.y;
      const boxOf = (n, rise) => {
        ctx.save(); ctx.font = font;
        const w = ctx.measureText(n.text).width + padX * 2;
        ctx.restore();
        const b = { x: (n.x + 0.5) * T - w / 2, y: n.below ? (n.y + 1) * T + 3 : n.y * T - 3 - rise - ph, w, h: ph };
        const above = n.y * T - 3 - rise - ph, below = (n.y + 1) * T + 3;
        const ys = n.below ? [b.y, above, below + ph + 2, above - ph - 2] : [b.y, below, above - ph - 2, below + ph + 2];
        for (const y of ys) {
          const c = fit ? fit({ x: b.x, y, w, h: ph }, n) : { x: b.x, y, w, h: ph };
          if (c && !placed.some(o => over(c, o))) return c;
        }
        return null;
      };
      const paintNote = (n, k, b) => {
        const tf = ctx.getTransform ? ctx.getTransform() : null, px1 = 1 / ((tf && tf.a) || 1);   // one screen pixel, in the caller's frame
        ctx.save();
        ctx.globalAlpha = k < 0.12 ? k / 0.12 : k > 0.75 ? (1 - k) / 0.25 : 1;
        ctx.fillStyle = 'rgba(4,6,8,0.86)'; ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = GHOST_COL; ctx.lineWidth = px1;
        if (ctx.setLineDash) ctx.setLineDash([3 * px1, 2 * px1]);
        ctx.strokeRect(b.x + px1 / 2, b.y + px1 / 2, b.w - px1, b.h - px1);
        ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = GHOST_COL;
        ctx.fillText(n.text, b.x + b.w / 2, b.y + b.h / 2 + fs * 0.06);
        ctx.restore();
      };
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i], k = (nowMs - n.t0) / NOTE_MS;
        if (k >= 1 || k < 0) { notes.splice(i, 1); continue; }
        const b = boxOf(n, n.below ? 0 : Math.min(1, k * 4) * 3);
        if (!b) continue;
        // a caption holds its spot unless the arbiter says it was NOT painted (answers false) — then the next one may have it;
        // an arbiter that paints later (BUILD MODE's voice queue answers nothing) keeps the spot reserved
        if (say) { if (say(b, paintNote.bind(null, n, k, b)) !== false) placed.push(b); } else { paintNote(n, k, b); placed.push(b); }
      }
    }

    function reset() { clearRide(); cur = null; projecting = false; pass = 0; }
    // readout for headless tests + CDP proof scripts — the EXACT state the projection runs on
    function peek() {
      return { projecting, lineKey: cur ? cur.key : null, pass,
        candidates: cands.map(c => ({ key: c.key, crewLeft: c.crewLeft, hasIntake: c.hasIntake, tags: c.tags })),
        boxes: engine ? engine.peekBoxes() : [],
        notes: notes.map(n => ({ x: n.x, y: n.y, text: n.text })),
        pending: !!cur && !projecting && nextSpawnAt > tnow,
        pendingChain: !!pendingChain, log: log.slice() };
    }
    return { setContext, tick, draw, reset, peek };
  }

  /* ---------- ON THE STATION: where a WOULD-caption may sit (walk 10-14 #13, review 10-14) ----------
     One law for the live floor (world.js) and BUILD MODE (build.js): a caption crossed the hull into space, and the first
     cut held it inside the bounding box of every room — on a cross-shaped station mostly empty space between the wings.
     `rooms` = roomBoxes(...) in the caller's px frame. A caption sits in its OWN room across when it fits (a caption wider
     than its room stays centred on its tile and may run on over the floor beside it); `slide(box)` is the caller's keep-it-on-
     the-visible-glass step (it may move the box across, and answers false for a spot off the glass); then every part of the
     caption must be over some room's body (its tiles plus the north wall face standing above them), and it must overlap its
     own tile across, so its "HERE" stays beside the machine it names. Answers the moved box, or null: that spot is off the
     station — the caller's draw() tries the caption's next spot. */
  function roomBoxes(rects, T, ox, oy, wallUp) {
    return (rects || []).map(r => ({
      floor: { x: (r.x1 + ox) * T + 2, y: (r.y1 + oy) * T + 2, w: (r.x2 - r.x1 + 1) * T - 4, h: (r.y2 - r.y1 + 1) * T - 4 },
      body: { x: (r.x1 + ox) * T, y: (r.y1 + oy) * T - (wallUp || 0), w: (r.x2 - r.x1 + 1) * T, h: (r.y2 - r.y1 + 1) * T + (wallUp || 0) }
    }));
  }
  function onStation(b, n, rooms, T, slide) {
    if (!b || !rooms || !rooms.length) return b;
    const px = n ? (Math.floor(n.x) + 0.5) * T : b.x + b.w / 2, py = n ? (Math.floor(n.y) + 0.5) * T : b.y + b.h / 2;
    let room = null, bd = Infinity;
    for (const r of rooms) {
      const f = r.floor, dx = Math.max(f.x - px, 0, px - f.x - f.w), dy = Math.max(f.y - py, 0, py - f.y - f.h), d = dx * dx + dy * dy;
      if (d < bd) { bd = d; room = f; }   // the room holding its tile (distance 0), else the nearest one
    }
    if (room && b.w <= room.w) b.x = Math.max(room.x, Math.min(room.x + room.w - b.w, b.x));
    if (slide && slide(b) === false) return null;
    if (n && (b.x >= (Math.floor(n.x) + 1) * T || b.x + b.w <= Math.floor(n.x) * T)) return null;
    // rooms are tile-aligned: a probe every half tile along the top and bottom edges finds any gap between them
    const over = (x, y) => rooms.some(r => x >= r.body.x && x <= r.body.x + r.body.w && y >= r.body.y && y <= r.body.y + r.body.h);
    const x2 = b.x + b.w - 0.5, ys = [b.y + 0.5, b.y + b.h - 0.5];
    for (let x = b.x + 0.5; ; x = Math.min(x2, x + T / 2)) {
      for (const y of ys) if (!over(x, y)) return null;
      if (x >= x2) break;
    }
    return b;
  }

  return { create, roomBoxes, onStation };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GhostLine;
